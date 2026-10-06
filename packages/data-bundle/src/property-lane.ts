// ADR 558 — committing property bindings. The engine decided every value
// (`resolve_properties_at`); `data-host-model` `planProperties` turned the
// decisions into `set` ops; this resolves what only the live document knows
// (which objects a selector names, which swatches exist) and commits the lot
// as ONE `host.objects.batch` — one undo step per apply.
//
// Host calls per apply (the count budget, `property-real-core.spec.ts`):
// one `objects.query` per DISTINCT target selector, one `swatches` read when
// a value is a colour, and one `objects.batch`. A literal colour that no
// swatch has yet adds one `createSwatch` batch BEFORE the apply (a second
// undo step, first use only): `host.objects` has no core `create` until
// core's `Set` lands (ADR 132).

import type { BundleHost, Mutation, ObjectsSurface } from "@paged-media/plugin-api";

import {
  planProperties,
  targetSelector,
  type PropertyApply,
  type SwatchRow,
} from "../../data-host-model/src";

export interface PropertyLaneResult {
  /** Objects written. */
  applied: number;
  /** Engine undo steps the apply took (0, 1, or 2 with a swatch mint). */
  undoSteps: number;
  /** `binding → why it wrote nothing` (keep, fail, no target, refused). */
  skipped: Record<string, string>;
  /** `binding → objects written`. */
  written: Record<string, number>;
  /** Host calls made (the count budget). */
  calls: number;
}

/** `host.objects`, when this host has the object model (plugin-sdk ≥ 0.2.42). */
export function objectsOf(host: BundleHost): ObjectsSurface | null {
  const objects = (host as { objects?: ObjectsSurface }).objects;
  if (!objects || typeof objects.batch !== "function") return null;
  try {
    return typeof host.supports === "function" && !host.supports("objects@1") ? null : objects;
  } catch {
    return objects;
  }
}

export const NO_OBJECT_MODEL =
  "this host has no object model (host.objects, plugin-sdk 0.2.42) — property bindings cannot be written here";

/**
 * Commit one apply's property writes. `hostOids` maps a binding carried by
 * its element's label (`target: "host"`) to that element's oid.
 */
export async function commitProperties(
  host: BundleHost,
  applies: readonly PropertyApply[],
  hostOids: Readonly<Record<string, string>> = {},
  label = "Apply data",
): Promise<PropertyLaneResult> {
  const result: PropertyLaneResult = { applied: 0, undoSteps: 0, skipped: {}, written: {}, calls: 0 };
  const objects = objectsOf(host);
  if (!objects) {
    for (const a of applies) result.skipped[a.binding] = NO_OBJECT_MODEL;
    return result;
  }
  const writes = applies.filter((a) => a.property.outcome.outcome === "write");
  // 1. Which objects each distinct selector names today.
  const targets = new Map<string, string[]>();
  for (const a of writes) {
    const sel = targetSelector(a.property.target, hostOids[a.binding]);
    if (!sel || targets.has(sel)) continue;
    result.calls++;
    try {
      targets.set(sel, await objects.query(sel));
    } catch (err) {
      result.skipped[a.binding] = `the target ${sel} could not be resolved: ${String(err)}`;
    }
  }
  // 2. The swatches, once, when a value is a colour.
  let swatches: SwatchRow[] = [];
  if (writes.some((a) => a.property.outcome.outcome === "write" && a.property.outcome.color)) {
    result.calls++;
    try {
      swatches = [...(await host.document.collection<SwatchRow>("swatches"))];
    } catch {
      swatches = [];
    }
  }
  const plan = planProperties(applies, targets, swatches, hostOids);
  Object.assign(result.skipped, plan.skipped);
  // 3. Swatches first (a separate step until host.objects can create them).
  if (plan.mint.length > 0) {
    result.calls++;
    const minted = await host.document.mutate(
      plan.mint.length === 1 ? plan.mint[0]! : ({ op: "batch", args: { ops: plan.mint } } as Mutation),
    );
    if (minted.applied) result.undoSteps++;
    else host.log.warn(`property bindings: the new swatches were refused (${String(minted.error)})`);
  }
  // 4. ONE batch. A refused op names its index: that binding is reported and
  // the batch is sent again without it (nothing landed — it is all or nothing).
  let ops = plan.ops;
  let bindings = plan.bindings;
  while (ops.length > 0) {
    result.calls++;
    const out = await objects.batch(ops, { label });
    if (out.applied) {
      result.undoSteps += out.undoSteps;
      result.applied = ops.length;
      for (const b of bindings) result.written[b] = (result.written[b] ?? 0) + 1;
      break;
    }
    const failed = out.index !== undefined ? bindings[out.index] : undefined;
    if (failed === undefined) {
      for (const b of new Set(bindings)) result.skipped[b] = `the host refused the apply: ${out.reason ?? out.code ?? "unknown"}`;
      break;
    }
    result.skipped[failed] = `the host refused ${ops[out.index!]!.op === "set" ? (ops[out.index!] as { path: string }).path : "the write"}: ${out.reason ?? out.code}`;
    const keep = bindings.map((b) => b !== failed);
    ops = ops.filter((_, i) => keep[i]);
    bindings = bindings.filter((_, i) => keep[i]);
  }
  return result;
}
