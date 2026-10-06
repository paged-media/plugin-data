/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// The page lower — the ONLY place the bundle calls host.document.mutate. The
// engine (Rust) resolves + lowers to the IR; the host-model translator (pure)
// shapes the mutations; this drives the host writes. The table path lowers to a
// NATIVE table via the `insertTable` op (D-02 retired); if the host is too old
// to support it, it degrades to the spec §2.2 fallback (tab-aligned text +
// drawn rules) into the same frame.

import type { BundleHost, ElementId, Mutation, PageId } from "@paged-media/plugin-api";
import {
  barcodeToMutations,
  bindingMetadata,
  createRuleCellStyle,
  dataSetBatch,
  defaultPlacement,
  idmlFit,
  insertFieldMutation,
  makeEnvelope,
  placeImageMutation,
  paragraphRanges,
  placeableUri,
  ruleMutations,
  tableCellInserts,
  tableInsertMutation,
  tableInsertSpec,
  toRuleApplication,
  visibilityToMutations,
  type BarcodePlacement,
  type DataSetPlan,
  type IdmlFit,
  type ImageReference,
  type LoweredBarcode,
  type LoweredImage,
  type LoweredTable,
  type LoweredVariable,
  type LoweredVisibility,
  type RuleResult,
  type RuleTarget,
} from "../../data-host-model/src";

/** What one command's lowerings share: the active page, read once. */
export interface LowerContext {
  page?: Promise<PageId | null>;
  /** The scene tree indexed by raw id, built once (see `sceneIndex`). */
  scene?: Promise<Map<string, ElementId> | null>;
  /** Variable placements collected while the command runs, written together
   *  by `commitLoweredVariables` as ONE batch (one undo step). Absent: each
   *  variable is placed by its own mutate. */
  variables?: VariablePlacement[];
  /** Set when an already-placed variable asked for a field refresh: the
   *  command refreshes once at its end instead of once per variable. */
  refreshFields?: boolean;
}

/** One variable a command places: the engine's lowering and the field key
 *  (the binding id). */
export interface VariablePlacement {
  variable: LoweredVariable;
  key: string;
}

/** The active page id, read once per command when a context is given. */
function pageFor(host: BundleHost, ctx?: LowerContext): Promise<PageId | null> {
  if (!ctx) return activePageId(host);
  return (ctx.page ??= activePageId(host));
}

/** The text frame (and its story) a batch minted, from the outcome's
 *  `minted` list: the entry named `handle` by a `bindCreated`, else the first
 *  text frame. (Core 0.67 reports `handle: null` even for a named element,
 *  so the name alone cannot find it; every batch here mints one frame.) */
function mintedFrame(
  outcome: { minted?: readonly { handle: string | null; element: ElementId; storyId: string | null }[] },
  handle: string,
): { element: ElementId; storyId: string | null } | null {
  const minted = outcome.minted ?? [];
  return (
    minted.find((m) => m.handle === handle) ??
    minted.find((m) => m.element.kind === "textFrame") ??
    null
  );
}

/** The table id of a minted table element (`{ story_id, table_id }`). */
function tableIdOf(created: ElementId): string {
  const id = created.id as unknown;
  if (typeof id === "string") return id;
  if (id && typeof id === "object" && "table_id" in id) return String((id as { table_id: unknown }).table_id);
  return "";
}

/** The active page id (meta first, else the first page). */
async function activePageId(host: BundleHost): Promise<PageId | null> {
  const meta = await host.document.meta();
  if (meta.activePage) return meta.activePage;
  const pages = await host.document.collection<{ selfId: string }>("pages");
  return pages.length > 0 ? (pages[0].selfId as unknown as PageId) : null;
}

/** Raw frame id from a created ElementId. */
function frameIdOf(id: ElementId): string | null {
  if (id.kind === "textFrame" || id.kind === "rectangle") return id.id as string;
  return null;
}

/** What a lowering records in the metadata label of the content it creates:
 *  the binding it came from, the hash of that binding's definition, and the
 *  hash of the saved session part it was lowered under. The label is written
 *  through `mutate`, so it follows undo with the content. */
export interface LowerStamp {
  binding: string;
  def: string | null;
  session: string | null;
}

/** Where a table binding's previous lowering lives, for an update in place. */
export interface LoweredTableAt {
  frame: ElementId;
  storyId: string;
  tableId: string;
}

/** How a re-lower replaces what an earlier lowering made (`relower.ts`). */
export interface TableReplace {
  /** Swap the table inside this frame and story. */
  inPlace?: LoweredTableAt;
  /** Removals (duplicates older lowerings left) that ride the same batch. */
  clear?: Mutation[];
  /** Told where the table now is, for the next update in place. */
  onTable?: (at: LoweredTableAt) => void;
}

/** Commit a lowered dynamic table to a fresh page frame as ONE batch — one
 *  rebuild and one undo step: the frame, the native table in its story, every
 *  cell, and the binding label. The batch names what it mints (C-15
 *  `bindCreated`), so the table addresses the frame's story as `$h:frame`
 *  and the cells address the table as `$h:table`; the ids come back in
 *  `minted`. No hitTest (D-16) and no second read.
 *
 *  If core refuses the `insertTable` child (a host without native tables),
 *  the §2.2 degradation — tab-aligned text plus drawn rules — goes into a
 *  fresh frame instead, also as one batch. Returns the created frame's id,
 *  or null on any failure (mutate-never-throws: outcomes are checked). */
export async function commitLoweredTable(
  host: BundleHost,
  table: LoweredTable,
  stamp?: LowerStamp,
  ctx?: LowerContext,
  replace?: TableReplace,
): Promise<string | null> {
  const envelopeEarly = makeEnvelope({ kind: "table", region: table.region, ...(stamp ?? {}) });
  // UPDATE IN PLACE (Wave 5): the table this binding lowered before is
  // swapped inside its own frame and story — deleteTable, insertTable, cells,
  // label — as one batch, so the user's frame (moved, resized) stays and no
  // duplicate appears. Duplicates older lowerings left go in the same batch.
  if (replace?.inPlace) {
    const { frame, storyId, tableId } = replace.inPlace;
    const ops: Mutation[] = [
      ...(replace.clear ?? []),
      { op: "deleteTable", args: { storyId, tableId } },
      tableInsertMutation(storyId, tableInsertSpec(table)),
      { op: "bindCreated", args: { handle: "table" } } as Mutation,
      ...tableCellInserts(table, storyId, "$h:table"),
      bindingMetadata(frame, envelopeEarly),
    ];
    const outcome = await host.document.mutate({ op: "batch", args: { ops } });
    if (outcome.applied) {
      const t = (outcome.minted ?? []).find((m) => m.element.kind === "table")?.element;
      const id = t ? tableIdOf(t) : "";
      if (id) replace.onTable?.({ frame, storyId, tableId: id });
      return frame.id as string;
    }
    host.log.warn(`lower: replacing the table in place was refused (${String(errorText(outcome.error))}) — placing it afresh`);
  }
  const pageId = await pageFor(host, ctx);
  if (!pageId) {
    host.log.warn("lower: no page to place the data table into");
    return null;
  }
  const placement = defaultPlacement(pageId, table.bounds);
  const envelope = makeEnvelope({ kind: "table", region: table.region, ...(stamp ?? {}) });
  const [top, left] = placement.bounds;
  const FRAME = "$h:frame";
  const frameRef = { kind: "textFrame", id: FRAME } as unknown as ElementId;
  const head: Mutation[] = [
    { op: "insertTextFrame", args: { pageId, bounds: placement.bounds } },
    { op: "bindCreated", args: { handle: "frame" } } as Mutation,
  ];
  const label = bindingMetadata(frameRef, envelope);

  // NATIVE: frame, table, cells, label.
  const TABLE_CHILD = head.length;
  const native: Mutation[] = [
    ...head,
    tableInsertMutation(FRAME, tableInsertSpec(table)),
    { op: "bindCreated", args: { handle: "table" } } as Mutation,
    ...tableCellInserts(table, FRAME, "$h:table"),
    label,
  ];
  if (replace?.clear?.length) native.unshift(...replace.clear);
  const tableChild = TABLE_CHILD + (replace?.clear?.length ?? 0);
  let outcome = await host.document.mutate({ op: "batch", args: { ops: native } });
  if (!outcome.applied) {
    const child = failedBatchChild(outcome.error);
    if (child !== tableChild) {
      host.log.warn(`lower: the table batch was rejected (${String(errorText(outcome.error))})`);
      return null;
    }
    // FALLBACK — no native table: the §2.2 degradation (D-02 fallback).
    host.log.info("lower: insertTable unsupported — degrading to tab-text + drawn rules (D-02)");
    const degraded: Mutation[] = [
      ...(replace?.clear ?? []),
      ...head,
      ...table.rules.map(
        (r): Mutation => ({
          op: "insertLine",
          args: {
            pageId,
            start: [left + r.x1Pt, top + r.y1Pt] as [number, number],
            end: [left + r.x2Pt, top + r.y2Pt] as [number, number],
          },
        }),
      ),
      ...(table.text.length > 0
        ? [{ op: "insertText", args: { storyId: FRAME, offset: 0, text: table.text } } as Mutation]
        : []),
      label,
    ];
    outcome = await host.document.mutate({ op: "batch", args: { ops: degraded } });
    if (!outcome.applied) {
      host.log.warn(`lower: the degraded table batch was rejected (${String(errorText(outcome.error))})`);
      return null;
    }
  }
  const minted = mintedFrame(outcome, "frame");
  const frame = minted?.element ?? null;
  const frameId = frame ? frameIdOf(frame) : null;
  if (!frame || !frameId) {
    host.log.warn("lower: the batch applied but did not report the frame it minted");
    return null;
  }
  const t = (outcome.minted ?? []).find((m) => m.element.kind === "table")?.element;
  const tableId = t ? tableIdOf(t) : "";
  if (tableId && minted?.storyId) replace?.onTable?.({ frame, storyId: minted.storyId, tableId });
  await host.selection.set([frame]);
  return frameId;
}

/** The index of the batch child a rejected batch names, or null. Core rolls a
 *  failed batch back and says which child failed:
 *  `Mutation::Batch child 3 (setFieldValue): … — batch rolled back`. */
export function failedBatchChild(error: unknown): number | null {
  const m = /Batch child (\d+)/.exec(errorText(error));
  return m ? Number(m[1]) : null;
}

/** A host error as text (a string, an Error, or the wire's error object). */
function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error) ?? "";
  } catch {
    return String(error);
  }
}

/** Read the user's text caret (C-9, `host.text.caret()`, published in
 *  plugin-api since 0.2.30-canary.0), or null when the host has no caret door /
 *  no active text caret. Never throws: an older or partial host can answer
 *  `supports` without injecting the surface, and a caret inside a table cell
 *  answers `null` on purpose so cell-local offsets never leak as story-local.
 *
 *  OFFSET CONVENTION — an open core question, not fixed here. The caret
 *  answers in the `ContentSelection` convention (UTF-8 bytes of the runs plus
 *  one synthetic `\n` per paragraph boundary), while `insertField`,
 *  `setFieldValue` and `placeholders()` count CHARS with no paragraph
 *  separators (core paged-mutate apply/path_topology.rs). The two agree only
 *  in the first paragraph of ASCII text; elsewhere a caret offset passed
 *  straight to `insertField` lands early. */
function readCaret(host: BundleHost): { storyId: string; offset: number } | null {
  try {
    if (!host.supports("text.caret@1")) return null;
    const text = host.text as BundleHost["text"] | undefined;
    if (!text || typeof text.caret !== "function") return null;
    return text.caret() ?? null;
  } catch {
    return null;
  }
}

/** Where a NEW variable field goes: a `{story, offset}` in existing text, or
 *  `{mint}` — a fresh text frame on that page, minted in the same batch as
 *  the field.
 *
 *  Precedence, best first:
 *   1. **the user's caret** (C-9) — a real insertion point, which is what
 *      "insert a variable here" has always meant (see [`readCaret`] for the
 *      offset-convention caveat).
 *   2. the SELECTED text frame's story, at offset 0.
 *   3. a fresh text frame minted on the active page, at offset 0.
 *
 *  A field placed at story start is a real tagged run either way — it survives
 *  edits and re-resolves live; only WHERE a new field first lands differs. */
async function variableInsertionPoint(
  host: BundleHost,
  ctx?: LowerContext,
): Promise<{ storyId: string; offset: number } | { mint: PageId } | null> {
  const caret = readCaret(host);
  if (caret) {
    host.log.info(
      `lower: inserting at the user's caret (story ${caret.storyId}, offset ${caret.offset})`,
    );
    return caret;
  }

  // Selection: a selected text frame's story is the natural anchor.
  let selected: readonly ElementId[] = [];
  try {
    selected = host.selection.get();
  } catch {
    selected = [];
  }
  for (const el of selected) {
    if (el.kind === "textFrame") {
      const hit = await frameStory(host, el.id as string);
      if (hit) return { storyId: hit, offset: 0 };
    }
  }

  // Else a fresh frame on the active page. The frame and the field go in ONE
  // batch: `bindCreated` names the frame and a `storyId` of `$h:<name>`
  // addresses the story it mints (C-15), so this is one undo step and needs
  // no hitTest to find the new story (D-16, closed by core's handles).
  const pageId = await pageFor(host, ctx);
  return pageId ? { mint: pageId } : null;
}

/** Resolve an EXISTING frame's story via the hitTest read door (the frame's
 *  center, on the frame's own page). */
async function frameStory(host: BundleHost, frameId: string): Promise<string | null> {
  const geom = await host.document.elementGeometry([
    { kind: "textFrame", id: frameId } as ElementId,
  ]);
  const g = geom[0] as { bounds?: [number, number, number, number]; pageId?: string } | undefined;
  if (!g?.bounds || !g.pageId) return null;
  const [top, left, bottom, right] = g.bounds;
  const hit = await host.document.hitTest(g.pageId as PageId, [(left + right) / 2, (top + bottom) / 2]);
  return hit?.storyId ?? null;
}

/** Place a lowered variable as a tagged placeholder FIELD (D-01, protocol v43).
 *  Inserts an `insertField` with the `placeholder` FieldKind keyed by the
 *  BINDING id (so the refresh loop resolves `{plugin, key}` back to the binding)
 *  carrying the engine-resolved display as the initial value. Returns the
 *  `{storyId, offset}` the field landed at, or null on any failure
 *  (mutate-never-throws). The refresh loop (`refreshFields` in the session)
 *  re-enumerates `placeholders()` and `setFieldValue`s changed values.
 *
 *  `bindingKey` is the field key; `targetStoryId` (when supplied) pins the story
 *  — the caret still supplies the OFFSET within it when the caret is in that
 *  story (see `variableInsertionPoint` for the full precedence + the honest
 *  status of the D-01 caret residual). Every path is ONE mutate. */
export async function commitLoweredVariable(
  host: BundleHost,
  variable: LoweredVariable,
  bindingKey: string,
  targetStoryId?: string | null,
  ctx?: LowerContext,
): Promise<{ storyId: string; offset: number } | null> {
  if (!host.supports("document.placeholders@1")) {
    host.log.info(
      `variable "${variable.target}" resolved to "${variable.text}"; the host ` +
        "predates the placeholder field model (document.placeholders@1) — placement skipped",
    );
    return null;
  }
  let point: { storyId: string; offset: number } | { mint: PageId } | null;
  if (targetStoryId) {
    // A caller-pinned story still honors the caret's OFFSET, but only when the
    // caret is actually inside that story — using a foreign story's offset would
    // insert at an arbitrary point in the pinned one.
    const caret = readCaret(host);
    point = {
      storyId: targetStoryId,
      offset: caret && caret.storyId === targetStoryId ? caret.offset : 0,
    };
  } else {
    point = await variableInsertionPoint(host, ctx);
  }
  if (!point) {
    host.log.warn(`variable "${variable.target}": no target story to place the field into`);
    return null;
  }
  // The HideParagraph missing policy resolves to a null value (the field shows
  // its <key> token).
  const value = variable.hidden ? null : variable.text;
  if ("mint" in point) {
    const placement = defaultPlacement(point.mint, { widthPt: 160, heightPt: 60 });
    const outcome = await host.document.mutate({
      op: "batch",
      args: {
        ops: [
          { op: "insertTextFrame", args: { pageId: point.mint, bounds: placement.bounds } },
          { op: "bindCreated", args: { handle: "frame" } } as Mutation,
          insertFieldMutation("$h:frame", 0, bindingKey, value),
        ],
      },
    });
    const storyId = outcome.applied ? (mintedFrame(outcome, "frame")?.storyId ?? null) : null;
    if (!storyId) {
      host.log.warn(`variable "${variable.target}": the frame + field batch was rejected`);
      return null;
    }
    host.log.info(`variable "${variable.target}" placed as field "${bindingKey}" in a new frame (story ${storyId})`);
    return { storyId, offset: 0 };
  }
  const { storyId, offset } = point;
  const outcome = await host.document.mutate(insertFieldMutation(storyId, offset, bindingKey, value));
  if (!outcome.applied) {
    host.log.warn(`variable "${variable.target}": insertField rejected`);
    return null;
  }
  host.log.info(`variable "${variable.target}" placed as field "${bindingKey}" in story ${storyId}`);
  return { storyId, offset };
}

/** Place every collected variable of one command as ONE batch — one rebuild
 *  and one undo step (perf budget W5). The insertion point is planned once
 *  for the command (caret, else the selected frame's story, else fresh frames
 *  on the active page); with fresh frames every variable mints its own frame,
 *  named `v<i>` by `bindCreated`, and its field addresses the frame's story as
 *  `$h:v<i>`, exactly as the one-variable path does. Fields placed at the same
 *  point land in the order a run of single inserts would leave them.
 *
 *  If core refuses the batch (it rolls back whole), every variable is placed
 *  on its own instead, so one bad field cannot lose the rest. Returns where
 *  each placed key landed. */
export async function commitLoweredVariables(
  host: BundleHost,
  items: readonly VariablePlacement[],
  ctx?: LowerContext,
): Promise<Map<string, { storyId: string; offset: number }>> {
  const placed = new Map<string, { storyId: string; offset: number }>();
  if (items.length === 0) return placed;
  if (items.length === 1) {
    const one = await commitLoweredVariable(host, items[0]!.variable, items[0]!.key, null, ctx);
    if (one) placed.set(items[0]!.key, one);
    return placed;
  }
  if (!host.supports("document.placeholders@1")) {
    host.log.info(
      `${items.length} variables resolved; the host predates the placeholder field model ` +
        "(document.placeholders@1) — placement skipped",
    );
    return placed;
  }
  const point = await variableInsertionPoint(host, ctx);
  if (!point) {
    host.log.warn(`${items.length} variables: no target story to place the fields into`);
    return placed;
  }
  const ops: Mutation[] = [];
  items.forEach((it, i) => {
    const value = it.variable.hidden ? null : it.variable.text;
    if ("mint" in point) {
      const placement = defaultPlacement(point.mint, { widthPt: 160, heightPt: 60 });
      ops.push(
        { op: "insertTextFrame", args: { pageId: point.mint, bounds: placement.bounds } },
        { op: "bindCreated", args: { handle: `v${i}` } } as Mutation,
        insertFieldMutation(`$h:v${i}`, 0, it.key, value),
      );
    } else {
      ops.push(insertFieldMutation(point.storyId, point.offset, it.key, value));
    }
  });
  const outcome = await host.document.mutate({ op: "batch", args: { ops } });
  if (!outcome.applied) {
    host.log.warn(
      `lower: the ${items.length}-variable batch was refused (${String(errorText(outcome.error))}) — placing each on its own`,
    );
    for (const it of items) {
      const one = await commitLoweredVariable(host, it.variable, it.key, null, ctx);
      if (one) placed.set(it.key, one);
    }
    return placed;
  }
  if ("mint" in point) {
    // Core may report `handle: null` for a named element; the frames were
    // minted in item order, so the i-th text frame is the i-th variable's.
    const frames = (outcome.minted ?? []).filter((m) => m.element.kind === "textFrame");
    items.forEach((it, i) => {
      const m = (outcome.minted ?? []).find((x) => x.handle === `v${i}`) ?? frames[i];
      if (m?.storyId) placed.set(it.key, { storyId: m.storyId, offset: 0 });
    });
  } else {
    for (const it of items) placed.set(it.key, { storyId: point.storyId, offset: point.offset });
  }
  host.log.info(`lower: ${placed.size} variable(s) placed as fields in one batch`);
  return placed;
}

/** Resolve a raw Self id to a typed `ElementId` from the live scene tree
 *  (§9.8). `setElementProperty` carries a KIND, and a binding payload stores
 *  only the id, so the kind has to come from the document. The scene tree is the
 *  read door that answers it; when the host has none (or the element is gone —
 *  deleted artwork), we return null and the caller SKIPS, never guessing
 *  `rectangle` and writing a property at a wrong address. With a context, the
 *  tree is read and indexed once for every element the command resolves. */
export async function resolveElementId(
  host: BundleHost,
  rawId: string,
  ctx?: LowerContext,
): Promise<ElementId | null> {
  const index = await (ctx ? (ctx.scene ??= sceneIndex(host)) : sceneIndex(host));
  return index?.get(rawId) ?? null;
}

/** One pass over the live scene tree: every element by its raw id (the first
 *  occurrence wins), or null when the host has no tree. */
export async function sceneIndex(host: BundleHost): Promise<Map<string, ElementId> | null> {
  let roots: SceneNode[] = [];
  try {
    roots = (await host.document.tree()) as SceneNode[];
  } catch {
    return null;
  }
  const index = new Map<string, ElementId>();
  const stack: SceneNode[] = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    const id = node.id;
    if (id && typeof id.id === "string" && !index.has(id.id)) index.set(id.id, id as ElementId);
    if (node.children) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  return index;
}

/** The shape of a scene-tree node this bundle reads (the SDK type, narrowed to
 *  the two members we walk). */
interface SceneNode {
  id?: { kind: string; id: unknown } | null;
  children?: SceneNode[];
}

/** Apply a lowered visibility decision to its bound element (§9.8 — the
 *  Illustrator "visibility variable"). Writes core's OWN `elementVisible`
 *  property, so the result is the same visibility the Layers panel toggles and
 *  the IDML `Visible` attribute carries — never a parallel system, and never a
 *  delete (which would destroy the element identity every other binding on that
 *  frame is anchored to).
 *
 *  Returns true when a write was applied. `visible: null` (the `Leave` missing
 *  policy) applies NOTHING and returns false — the honest arm.
 *
 *  `elementId` may be given by a caller that already knows the kind (the panel
 *  binds from the selection); absent, it is resolved from the scene tree. */
export async function commitLoweredVisibility(
  host: BundleHost,
  lowered: LoweredVisibility,
  elementId?: ElementId | null,
  ctx?: LowerContext,
): Promise<boolean> {
  if (lowered.visible === null) {
    host.log.info(
      `visibility "${lowered.target}": the missing policy is Leave — nothing written ` +
        "(an unresolved binding never blanks artwork)",
    );
    return false;
  }
  const target = elementId ?? (await resolveElementId(host, lowered.target, ctx));
  if (!target) {
    host.log.warn(
      `visibility "${lowered.target}": the bound element is not in the document ` +
        "(deleted, or the host exposes no scene tree) — nothing written",
    );
    return false;
  }
  const muts = visibilityToMutations(lowered, target);
  if (muts.length === 0) return false;
  const outcome = await host.document.mutate(muts[0]);
  if (!outcome.applied) {
    host.log.warn(`visibility "${lowered.target}": setElementProperty rejected`);
    return false;
  }
  host.log.info(
    `visibility "${lowered.target}" set to ${lowered.visible ? "shown" : "hidden"}`,
  );
  return true;
}

/** Commit a planned data-set application as ONE undoable batch (§9.9).
 *
 *  This is the undo-shape decision, made in one place and measured in
 *  `data-host-model/src/__tests__/variables.test.ts`: switching a data set moves
 *  N variables but costs the user ONE ⌘Z, because every write goes in a single
 *  `batch`. Returns `{applied, skipped}` — the count written and the per-variable
 *  reasons for everything that was not, which the panel SHOWS. A data set that
 *  half-applies in silence is the failure this reports its way out of. */
export async function commitDataSet(
  host: BundleHost,
  plan: DataSetPlan,
): Promise<{ applied: number; skipped: Record<string, string> }> {
  const batch = dataSetBatch(plan);
  if (!batch) {
    host.log.info("data set: nothing applicable to write");
    return { applied: 0, skipped: plan.skipped };
  }
  const outcome = await host.document.mutate(batch);
  if (!outcome.applied) {
    host.log.warn("data set: the apply batch was rejected — nothing changed");
    return { applied: 0, skipped: plan.skipped };
  }
  host.log.info(
    `data set applied: ${plan.ops.length} variable(s) in one undo step` +
      (Object.keys(plan.skipped).length > 0
        ? `; skipped ${Object.keys(plan.skipped).join(", ")}`
        : ""),
  );
  return { applied: plan.ops.length, skipped: plan.skipped };
}

/** A short human description of a resolved image reference. */
function describeRef(r: ImageReference): string {
  switch (r.ref) {
    case "uri":
      return r.uri;
    case "path":
      return r.path;
    case "assetId":
      return `asset:${r.id}`;
    case "bytes":
      return `<${r.bytes.length} bytes>`;
    case "none":
      return "(none)";
  }
}

/** Place a lowered image onto its bound rectangle (D-14, protocol v43). The
 *  engine resolved + classified the reference and applied the missing policy;
 *  this drives the `placeImage` mutation through the core asset mechanism (never
 *  `plugin-image`, §2.1). `elementId` is the bound RECTANGLE's raw Self id
 *  (placeImage is Rectangle-only — the IDML `<FrameFittingOption>` nests there).
 *  `fitOverride` lets the bindings panel pick an explicit IDML
 *  `FittingOnEmptyFrame` value; absent, the engine `ImgFit` maps via `idmlFit`.
 *  Returns true on a placed image, false on a skipped/missing/unplaceable
 *  reference (honest — no fake placement, no grey-X). */
export async function commitLoweredImage(
  host: BundleHost,
  image: LoweredImage,
  elementId: string,
  fitOverride?: IdmlFit,
): Promise<boolean> {
  if (image.status !== "present") {
    host.log.info(`image "${image.target}": ${image.status} (missing policy applied — nothing placed)`);
    return false;
  }
  const uri = placeableUri(image.reference);
  if (!uri) {
    host.log.info(
      `image "${image.target}" resolved to ${describeRef(image.reference)} — ` +
        "not a URI-addressable reference (inline bytes / assetId need the asset-store " +
        "door); placement skipped, never faked",
    );
    return false;
  }
  const fit = fitOverride ?? idmlFit(image.fit);
  const outcome = await host.document.mutate(placeImageMutation(elementId, uri, fit));
  if (!outcome.applied) {
    host.log.warn(`image "${image.target}": placeImage rejected on ${elementId}`);
    return false;
  }
  host.log.info(`image "${image.target}" placed on ${elementId} (uri ${uri}, fit ${fit})`);
  return true;
}

/** Commit a lowered barcode to the page as native VECTOR modules (spec §9.7).
 *  The engine has already encoded the symbology and scaled its module grid into
 *  the bound frame's content box; this drives one `insertPath` closed filled
 *  rect per dark module (the VECTOR lane — resolution-independent, no
 *  asset-store door; raster is BLOCKED because placeImage needs a resolvable
 *  uri). `elementId` (when given) is the bound rectangle's Self id — its
 *  page-coordinate top-left is read so the modules land inside it; without one,
 *  the symbol lands at a default page inset. The whole symbol is ONE undoable
 *  batch with the binding envelope. Returns the number of modules drawn (0 when
 *  the value was empty — the missing policy, never a fake symbol). */
export async function commitLoweredBarcode(
  host: BundleHost,
  barcode: LoweredBarcode,
  elementId?: string | null,
  stamp?: LowerStamp,
  replace?: BarcodeReplace,
): Promise<number> {
  if (barcode.modules.length === 0) {
    // An empty value still takes the old symbol away.
    if (replace?.clear?.length) {
      const o = await host.document.mutate({ op: "batch", args: { ops: replace.clear } });
      if (o.applied) replace.onMinted?.([]);
    }
    host.log.info(
      `barcode "${barcode.target}" resolved to no value (missing policy) — nothing drawn`,
    );
    return 0;
  }
  const pageId = await activePageId(host);
  if (!pageId) {
    host.log.warn("barcode: no page to draw onto");
    return 0;
  }

  // Page origin: the bound rectangle's top-left if one is given, else a default
  // inset. The engine modules are content-space offsets from this origin (§9.6).
  let topPt = 36;
  let leftPt = 36;
  if (elementId) {
    const geom = await host.document.elementGeometry([
      { kind: "rectangle", id: elementId } as ElementId,
    ]);
    const bounds = geom[0]?.bounds as [number, number, number, number] | undefined;
    if (bounds) {
      [topPt, leftPt] = bounds;
    }
  }

  const placement: BarcodePlacement = { pageId, topPt, leftPt };
  const envelope = makeEnvelope({
    ...(stamp ?? {}),
    kind: "barcode",
    target: barcode.target,
    symbology: barcode.symbology,
  });
  // UPDATE IN PLACE (Wave 5): the previous symbol's modules are removed in
  // the same batch the new one is drawn in — one undo step, never a pile.
  const ops = [...(replace?.clear ?? []), ...barcodeToMutations(barcode, placement, envelope)];
  if (ops.length === 0) return 0;

  const outcome = await host.document.mutate({ op: "batch", args: { ops } });
  if (!outcome.applied) {
    host.log.warn(`barcode "${barcode.target}": insertPath batch rejected`);
    return 0;
  }
  replace?.onMinted?.((outcome.minted ?? []).map((m) => m.element));
  host.log.info(
    `barcode "${barcode.target}" (${barcode.symbology}) drawn as ${barcode.modules.length} ` +
      "vector modules" +
      (barcode.text ? ` (HRI "${barcode.text}")` : ""),
  );
  return barcode.modules.length;
}

/** How a barcode re-lower replaces its previous symbol (`relower.ts`). */
export interface BarcodeReplace {
  /** Removes the previous symbol's modules; rides the drawing batch. */
  clear?: Mutation[];
  /** Told every element the new symbol minted (all its modules). */
  onMinted?: (ids: ElementId[]) => void;
}

/** Apply a data-driven formatting rule to the document (D-13, spec §9.5). The
 *  engine (`evaluate_rule`) already decided WHICH records fired WHICH style — the
 *  data-driven half; this drives the host mutations that apply the named
 *  DOCUMENT style (never a parallel styling system, never a literal). For a
 *  table rule it mints the cell style once (idempotent) then writes one per-cell
 *  `appliedCellStyle` over the fired rows of `target`; a paragraph/character rule
 *  emits one `applyStyle` over the target story range. Returns the count of
 *  applied style writes (0 when the rule fired on nothing or the target kind does
 *  not match the action). */
export async function commitRule(
  host: BundleHost,
  result: RuleResult,
  target: RuleTarget,
): Promise<number> {
  const application = toRuleApplication(result);
  // A table rule needs its named cell style to exist before the per-cell apply.
  // A style picked from the document's own cell styles already does.
  if (application.apply.kind === "table" && target.kind === "tableColumn") {
    let exists = false;
    try {
      const styles = await host.document.collection<{ selfId: string }>("cellStyles");
      exists = styles.some((st) => st.selfId === application.apply.name);
    } catch {
      // no collection read: mint it (idempotent at the host)
    }
    if (!exists) await host.document.mutate(createRuleCellStyle(application.apply.name));
  }
  // A per-record paragraph rule addresses paragraphs by their live ranges.
  let paragraphs: ReturnType<typeof paragraphRanges> = [];
  if (target.kind === "storyParagraphs") {
    try {
      const story = await host.document.storyContent(target.storyId);
      paragraphs = story ? paragraphRanges(story.paragraphs) : [];
    } catch (err) {
      host.log.warn(`rule (scope "${result.scope}"): the story could not be read (${String(err)})`);
    }
  }
  const muts = ruleMutations(application, target, paragraphs);
  if (muts.length === 0) {
    host.log.info(
      `rule (scope "${result.scope}") fired on ${result.fires.length}/${result.total} records ` +
        "but produced no applicable mutations for the given target",
    );
    return 0;
  }
  const outcome = await host.document.mutate({ op: "batch", args: { ops: muts } });
  if (!outcome.applied) {
    host.log.warn(`rule (scope "${result.scope}"): style application batch rejected`);
    return 0;
  }
  host.log.info(
    `rule (scope "${result.scope}") applied style "${application.apply.name}" to ` +
      `${muts.length} target(s) (${result.fires.length}/${result.total} records fired)`,
  );
  return muts.length;
}
