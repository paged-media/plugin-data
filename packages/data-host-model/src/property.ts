// ADR 558 — the universal property binding's host translation. The engine
// (data-js `resolve_properties_at`) has ALREADY evaluated and coerced every
// value against the target's schema row; this turns those decided triples
// into `host.objects` ops. Data in, ops out (CLAUDE.md hard rule): the only
// choices made here are the two the engine cannot make — which document
// objects a selector names today, and which swatch a colour is.

import type { Mutation, ObjectOp } from "@paged-media/plugin-api";

/** `data-core` `TargetRef`: `"host"` or `{ selector }`. */
export type TargetRef = "host" | { selector: string };

/** `data-core` `PropValue` (untagged). */
export type PropValue = null | boolean | number | string | number[];

/** A colour the host resolves to a swatch (`data-core` `ColorIntent`). */
export interface ColorIntent {
  name: string;
  spec?: { space: "RGB" | "CMYK" | string; value: number[] };
}

/** `data-core` `PropertyOutcome`. */
export type PropertyOutcome =
  | { outcome: "write"; value: PropValue; color?: ColorIntent }
  | { outcome: "keep"; reason: string }
  | { outcome: "fail"; message: string };

/** `data-lower` `LoweredProperty`. */
export interface LoweredProperty {
  target: TargetRef;
  path: string;
  outcome: PropertyOutcome;
}

/** One binding's lowering for an apply (`data-js` `PropertyApply`). */
export interface PropertyApply {
  binding: string;
  property: LoweredProperty;
}

/** A document swatch as the `swatches` collection lists it. */
export interface SwatchRow {
  selfId: string;
  name: string;
}

/** What one apply turns into. */
export interface PropertyPlan {
  /** Every `set`, for ONE `host.objects.batch`. */
  ops: ObjectOp[];
  /** Which binding each op came from (`ops[i]` ← `bindings[i]`). */
  bindings: string[];
  /** Swatches to create first (a literal colour no swatch has yet). */
  mint: Mutation[];
  /** `binding → why nothing was written` (keep, fail, no target). */
  skipped: Record<string, string>;
  /** `binding → number of objects written`. */
  written: Record<string, number>;
}

/** The label key every paged.data label lives under (the engine's caller
 *  gate allows exactly one key per plugin, `x-paged:<plugin id>`). */
export const DATA_LABEL_KEY = "x-paged:media.paged.data";

/** The durable selector of the page item carrying object id `oid` in its
 *  label (ADR 559: never a raw `Self`, which InDesign renumbers). */
export function oidSelector(oid: string): string {
  return `frame[label.${DATA_LABEL_KEY}*="\\"oid\\":\\"${oid}\\""]`;
}

/** The oid an {@link oidSelector} names, or null. */
export function oidOfSelector(selector: string): string | null {
  const m = /\\"oid\\":\\"([A-Za-z0-9_-]+)\\"/.exec(selector);
  return m ? m[1]! : null;
}

/** The selector string a target ref resolves through (`host` → the oid). */
export function targetSelector(target: TargetRef, hostOid?: string | null): string | null {
  if (target === "host") return hostOid ? oidSelector(hostOid) : null;
  return target.selector;
}

/** Find the swatch a colour intent names: by self id, by name, or as
 *  `Color/<name>` (InDesign's `Self` for a named colour). */
export function findSwatch(intent: ColorIntent, swatches: readonly SwatchRow[]): SwatchRow | null {
  return (
    swatches.find((s) => s.selfId === intent.name) ??
    swatches.find((s) => s.name === intent.name) ??
    swatches.find((s) => s.selfId === `Color/${intent.name}`) ??
    null
  );
}

/** The `createSwatch` for a literal colour no swatch has, under the name
 *  InDesign gives an unnamed colour (`R=255 G=0 B=0`). */
export function mintSwatch(intent: ColorIntent): Mutation | null {
  if (!intent.spec) return null;
  return {
    op: "createSwatch",
    args: {
      spec: {
        selfId: `Color/${intent.name}`,
        name: intent.name,
        space: intent.spec.space,
        value: intent.spec.value,
        model: "Process",
      },
    },
  } as Mutation;
}

/**
 * Plan one apply: every `write` becomes one `set` per object its target
 * names (`targets`: selector → addresses, resolved by the caller through
 * `host.objects.query`), a colour becomes the swatch it names (minted when a
 * literal colour has none). `keep`, `fail` and unresolved targets are skipped
 * with a reason — never guessed.
 */
export function planProperties(
  applies: readonly PropertyApply[],
  targets: ReadonlyMap<string, readonly string[]>,
  swatches: readonly SwatchRow[],
  hostOids: Readonly<Record<string, string>> = {},
): PropertyPlan {
  const plan: PropertyPlan = { ops: [], bindings: [], mint: [], skipped: {}, written: {} };
  const minted = new Set<string>();
  const known = [...swatches];
  for (const { binding, property } of applies) {
    const o = property.outcome;
    if (o.outcome === "keep") {
      plan.skipped[binding] = o.reason;
      continue;
    }
    if (o.outcome === "fail") {
      plan.skipped[binding] = o.message;
      continue;
    }
    const selector = targetSelector(property.target, hostOids[binding]);
    const addresses = selector ? targets.get(selector) : undefined;
    if (!selector || !addresses) {
      plan.skipped[binding] = "the target was not resolved";
      continue;
    }
    if (addresses.length === 0) {
      plan.skipped[binding] = `the target ${selector} names no object in this document`;
      continue;
    }
    let value: unknown = o.value;
    if (o.color) {
      const found = findSwatch(o.color, known);
      if (found) {
        value = found.selfId;
      } else {
        const create = mintSwatch(o.color);
        if (!create) {
          plan.skipped[binding] = `no swatch named "${o.color.name}" in this document`;
          continue;
        }
        const selfId = `Color/${o.color.name}`;
        if (!minted.has(selfId)) {
          plan.mint.push(create);
          minted.add(selfId);
          known.push({ selfId, name: o.color.name });
        }
        value = selfId;
      }
    }
    for (const address of addresses) {
      plan.ops.push({ op: "set", address, path: property.path, value });
      plan.bindings.push(binding);
    }
    plan.written[binding] = addresses.length;
  }
  return plan;
}

// ── labels (ADR 559) ────────────────────────────────────────────────────────

/** Escape every non-ASCII character of a JSON text as `\uXXXX` (surrogate
 *  pairs as two escapes). InDesign re-encodes non-BMP characters in a label
 *  as `<?AID xxxx?>` processing text; an ASCII-only value comes back
 *  byte-exact (the 2026-10-06 round-trip survey). */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Undo InDesign's label re-encoding: every `<?AID xxxx?>` (one UTF-16 code
 *  unit, hex) back to its character. Safe on any text. */
export function decodeAid(text: string): string {
  return text.replace(/<\?AID ([0-9a-fA-F]{4})\?>/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** The `data` object of one of our label values, or null. */
export function labelData(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeAid(value)) as { v?: unknown; data?: unknown };
    return typeof parsed.v === "number" && parsed.data && typeof parsed.data === "object"
      ? (parsed.data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The keys the binding persistence owns in an element label; every other
 *  key (a lowered content's `kind` / `binding` / `def` / `session`) is kept. */
export const PERSIST_KEYS = ["oid", "bind", "queries", "sources", "extra"] as const;

/** Merge the persistence keys into an existing label's data (one label per
 *  element — ADR 559 point 3), or remove them (`patch` null). Returns the
 *  label value to write, or null when nothing of ours is left. */
export function mergeLabel(
  existing: Record<string, unknown> | null,
  patch: Record<string, unknown> | null,
): string | null {
  const data: Record<string, unknown> = { ...(existing ?? {}) };
  for (const k of PERSIST_KEYS) delete data[k];
  if (patch) Object.assign(data, patch);
  return Object.keys(data).length === 0 ? null : asciiJson({ v: 1, data });
}
