// Pure translators for the §9.8 visibility lane and the §9.9 data-set apply
// (the Illustrator "Variables / data sets" feature set). ZERO binding/data-set
// semantics live here (CLAUDE.md hard rule): the Rust engine has ALREADY decided
// every shown/hidden verdict, captured value and applicability note; this turns
// those decided values into host Mutations. Data in, mutations out.
//
// The one architectural claim this file makes is about UNDO SHAPE, and it is
// measured rather than asserted (`variables.test.ts`): switching a data set is
// ONE `batch` mutation — one undo step — no matter how many variables move.
// The alternative (a mutate per variable) would make a 12-variable data set
// twelve presses of ⌘Z, which is not what "switch data set" means to a user.

import type { ElementId, Mutation, Value } from "@paged-media/plugin-api";

import { setFieldValueMutation } from "./fields";
import type { LoweredVisibility } from "./lowered";

// ── §9.8 — the visibility variable ──────────────────────────────────────────

/** The element kinds a visibility variable can address. `setElementProperty`
 *  carries a typed `ElementId`, so the bundle must know the bound element's
 *  KIND — it reads it from the live scene tree (`host.document.tree()`) or from
 *  the selection that created the binding. There is no "id only" form of the op
 *  and inventing one here would be a lie about the wire. */
export type VisibilityTargetKind =
  | "textFrame"
  | "rectangle"
  | "oval"
  | "polygon"
  | "graphicLine"
  | "group";

/** Address a raw Self id as a typed `ElementId` of a known kind. */
export function visibilityTarget(kind: VisibilityTargetKind, id: string): ElementId {
  return { kind, id } as ElementId;
}

/** The `setElementProperty` mutation that shows/hides a bound element (§9.8).
 *  Uses core's OWN `elementVisible` property — the element's real visibility,
 *  the same one the Layers panel and the IDML `Visible` attribute drive. Never a
 *  parallel visibility system, never a delete-and-reinsert (which would destroy
 *  the element identity every other binding is anchored to). */
export function visibilityMutation(target: ElementId, visible: boolean): Mutation {
  return {
    op: "setElementProperty",
    args: {
      elementId: target,
      path: "elementVisible",
      value: { type: "bool", value: visible } satisfies Value,
    },
  };
}

/** Translate a lowered visibility decision into mutations (§9.8). Returns an
 *  EMPTY array for `visible: null` — the `Leave` missing policy, whose whole
 *  point is that nothing is written. Pure: the engine decided; this shapes. */
export function visibilityToMutations(
  lowered: LoweredVisibility,
  target: ElementId,
): Mutation[] {
  if (lowered.visible === null) return [];
  return [visibilityMutation(target, lowered.visible)];
}

// ── §9.9 — applying a data set ──────────────────────────────────────────────

/** One planned write from the engine's `apply_data_set` (mirrors the Rust
 *  `DataSetApply`). `applicable: false` rows carry the reason and are NEVER
 *  turned into a mutation — an honest skip beats a fabricated write. */
export interface DataSetApply {
  variable: string;
  kind: "text" | "image" | "visibility" | "graphData";
  text?: string;
  href?: string;
  visible?: boolean;
  applicable: boolean;
  note?: string;
}

/** Where each applicable variable's value has to land in the document. The
 *  engine knows WHAT to write; only the host knows WHERE, so the bundle resolves
 *  these addresses (placeholder offsets from `placeholders()`, element ids from
 *  the scene tree) and hands them in. Keyed by variable name (= binding id). */
export interface DataSetTargets {
  /** `variable → {storyId, offset}` of its placeholder field (text variables). */
  fields?: Record<string, { storyId: string; offset: number }>;
  /** `variable → the bound rectangle's raw Self id` (image variables). */
  frames?: Record<string, string>;
  /** `variable → the bound element` (visibility variables). */
  elements?: Record<string, ElementId>;
  /** The IDML fitting to apply on an image swap (default `Proportionally`). */
  fit?: string;
}

/** The result of planning a data-set application: the ops, plus an honest list
 *  of what was skipped and why. The caller SHOWS the skips — a data set that
 *  half-applied in silence is the failure mode this type exists to prevent. */
export interface DataSetPlan {
  ops: Mutation[];
  /** `variable → reason` for every row that produced no mutation. */
  skipped: Record<string, string>;
}

/** Plan a data-set application as mutations (§9.9). One op per applicable
 *  variable with a resolved target:
 *
 *  - `text`       → `setFieldValue` at the variable's placeholder field (the
 *                   D-01 lane — the anchor survives, only content changes);
 *  - `image`      → `placeImage` on the bound rectangle (the D-14 lane, through
 *                   the core asset mechanism — never `plugin-image`, §2.1);
 *  - `visibility` → `setElementProperty elementVisible` (§9.8).
 *
 *  A `graphData` row, an `applicable: false` row, or a row whose target the host
 *  could not resolve is SKIPPED with its reason recorded. Pure. The caller wraps
 *  `ops` in a single `batch` (see `dataSetBatch`) so the switch is one undo step.
 */
export function dataSetPlan(
  applies: readonly DataSetApply[],
  targets: DataSetTargets,
): DataSetPlan {
  const ops: Mutation[] = [];
  const skipped: Record<string, string> = {};
  const fit = targets.fit ?? "Proportionally";

  for (const a of applies) {
    if (!a.applicable) {
      skipped[a.variable] = a.note ?? "not applicable";
      continue;
    }
    switch (a.kind) {
      case "text": {
        const field = targets.fields?.[a.variable];
        if (!field) {
          skipped[a.variable] =
            "no placeholder field for this variable is present in the document " +
            "(place the variable once, then data sets drive it)";
          continue;
        }
        ops.push(setFieldValueMutation(field.storyId, field.offset, a.text ?? null));
        break;
      }
      case "image": {
        const frameId = targets.frames?.[a.variable];
        if (!frameId) {
          skipped[a.variable] = "no bound rectangle for this image variable";
          continue;
        }
        if (!a.href) {
          skipped[a.variable] = "the captured reference is not URI-addressable";
          continue;
        }
        ops.push({ op: "placeImage", args: { elementId: frameId, uri: a.href, fit } });
        break;
      }
      case "visibility": {
        const el = targets.elements?.[a.variable];
        if (!el) {
          skipped[a.variable] = "no bound element for this visibility variable";
          continue;
        }
        if (a.visible === undefined) {
          skipped[a.variable] = "no captured visibility value";
          continue;
        }
        ops.push(visibilityMutation(el, a.visible));
        break;
      }
      case "graphData":
        skipped[a.variable] =
          a.note ?? "graph-data variables are carried through the library, never applied";
        break;
    }
  }
  return { ops, skipped };
}

/** Wrap a plan's ops as ONE batch — the undo-shape claim, in one place.
 *  `null` when the plan produced no ops (nothing to commit; the caller must not
 *  send an empty batch and burn an undo step on a no-op). */
export function dataSetBatch(plan: DataSetPlan): Mutation | null {
  if (plan.ops.length === 0) return null;
  return { op: "batch", args: { ops: plan.ops } };
}
