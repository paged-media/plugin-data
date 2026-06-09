// THE load-bearing translator (spec §9; degradation D-02): the engine has
// ALREADY computed the lowered IR (column/row geometry, formatted cell text,
// grid rules); this turns that pure data into host Mutations. ZERO
// binding/expression semantics live here (CLAUDE.md hard rule) — it is
// arithmetic over already-decided geometry plus the host mutation vocabulary.
//
// TWO-PHASE (mirrors plugin-sheet S-03). The wire has no `insertTable` op, and
// `insertText` keys off a `storyId` that exists only AFTER the frame applies.
// So the table lower degrades to the spec §2.2 fallback — tab-aligned text in a
// text frame + drawn rules — split across two phases:
//
//   Phase 1 (`tableToMutations`): a `batch` of insertTextFrame + an insertLine
//     per grid rule + setPluginMetadata writing the binding envelope onto the
//     batch-created frame (the `$created` sentinel). ONE undoable step.
//   Phase 2 (the caller, lower.ts): resolve the frame's storyId, then
//     `insertText` the tab/newline-joined `text` this function also returns.

import type { ElementId, Mutation } from "@paged-media/plugin-api";

import { BINDING_KEY } from "./binding";
import type { LoweredTable } from "./lowered";
import type { Placement } from "./placement";

/** The batch-created sentinel: an `insertTextFrame` mints a textFrame, and a
 *  later op in the SAME batch addresses it by this placeholder id. The host
 *  resolves `$created` to the just-minted frame; the metadata gate verifies the
 *  key is this plugin's own namespace. */
const CREATED_FRAME: ElementId = { kind: "textFrame", id: "$created" };

/** Phase-1 batch + the phase-2 text to pour once the new frame's story id is
 *  known. */
export interface TableLowerResult {
  /** One undoable `batch`: frame + rules + binding metadata. */
  batch: Mutation;
  /** The cells joined tab-within-row, newline-between-rows (the D-02 text). */
  text: string;
}

/** Translate a lowered table + a resolved placement + the binding envelope into
 *  the phase-1 batch and the phase-2 text. Pure: no host import beyond wire
 *  TYPES. */
export function tableToMutations(
  table: LoweredTable,
  placement: Placement,
  bindingJson: string,
): TableLowerResult {
  const { pageId, bounds } = placement;
  const [top, left] = bounds;

  const ops: Mutation[] = [];

  // (1) The frame itself.
  ops.push({ op: "insertTextFrame", args: { pageId, bounds } });

  // (2) One drawn line per grid rule. The IR carries content-space coordinates
  // (offsets from the region's top-left, §9.6); add the frame's [top, left]
  // page origin.
  for (const rule of table.rules) {
    ops.push({
      op: "insertLine",
      args: {
        pageId,
        start: [left + rule.x1Pt, top + rule.y1Pt],
        end: [left + rule.x2Pt, top + rule.y2Pt],
      },
    });
  }

  // (3) The binding envelope, written onto the batch-created frame via the
  // `$created` sentinel. ONE undo removes the frame, its rules, AND the binding.
  ops.push({
    op: "setPluginMetadata",
    args: { elementId: CREATED_FRAME, key: BINDING_KEY, value: bindingJson },
  });

  return {
    batch: { op: "batch", args: { ops } },
    text: table.text,
  };
}

/** Stamp the binding envelope onto an existing element (the variable path: at
 *  M0 there is no tagged-placeholder content model — BREAKAGE D-01 — so a
 *  variable binding records its envelope on its anchor element; in-run text
 *  replacement lands with D-01). */
export function bindingMetadata(element: ElementId, bindingJson: string): Mutation {
  return {
    op: "setPluginMetadata",
    args: { elementId: element, key: BINDING_KEY, value: bindingJson },
  };
}
