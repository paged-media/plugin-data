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
  defaultPlacement,
  idmlFit,
  insertFieldMutation,
  makeEnvelope,
  placeImageMutation,
  placeableUri,
  ruleMutations,
  tableCellInserts,
  tableInsertMutation,
  tableInsertSpec,
  toRuleApplication,
  type BarcodePlacement,
  type IdmlFit,
  type ImageReference,
  type LoweredBarcode,
  type LoweredImage,
  type LoweredTable,
  type LoweredVariable,
  type RuleResult,
  type RuleTarget,
} from "@paged-media/data-host-model";

/** The frame center, page-local pt, from `[top, left, bottom, right]`. */
function center(bounds: [number, number, number, number]): [number, number] {
  const [top, left, bottom, right] = bounds;
  return [(left + right) / 2, (top + bottom) / 2];
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

/** The string table id from an `insertTable` outcome's created element. The
 *  platform's ElementId/table-address shape is in flight (the table-content
 *  rework), so the id may be a plain string or a `{ table_id }` locator —
 *  handle both until it settles. Returns "" when neither shape is present. */
function tableIdOf(created: ElementId): string {
  const id = created.id as unknown;
  if (typeof id === "string") return id;
  if (id && typeof id === "object" && "table_id" in id) {
    return String((id as { table_id: unknown }).table_id);
  }
  return "";
}

/** Commit a lowered dynamic table to a fresh page frame (the degraded tab-text +
 *  rules path, D-02). Returns the created frame's id, or null on any failure
 *  (mutate-never-throws: outcomes are checked, not caught). */
export async function commitLoweredTable(
  host: BundleHost,
  table: LoweredTable,
): Promise<string | null> {
  const pageId = await activePageId(host);
  if (!pageId) {
    host.log.warn("lower: no page to place the data table into");
    return null;
  }
  const placement = defaultPlacement(pageId, table.bounds);
  const envelope = makeEnvelope({ kind: "table", region: table.region });
  const [top, left] = placement.bounds;

  // Phase 1 — the frame (both the native + degraded paths attach to its story).
  const frameOutcome = await host.document.mutate({
    op: "insertTextFrame",
    args: { pageId, bounds: placement.bounds },
  });
  if (!frameOutcome.applied || !frameOutcome.createdId) {
    host.log.warn("lower: insertTextFrame rejected");
    return null;
  }
  const createdFrame = frameOutcome.createdId;
  const frameId = frameIdOf(createdFrame);
  if (!frameId) {
    host.log.warn("lower: created element is not a frame target");
    return null;
  }

  // Resolve the new frame's story via the hitTest read door.
  const hit = await host.document.hitTest(pageId, center(placement.bounds));
  const storyId = hit?.storyId ?? null;
  if (!storyId) {
    host.log.warn("lower: could not resolve the created frame's story");
    return frameId;
  }

  // Phase 2 — NATIVE: insert the table, then fill its cells by (tableId,row,col).
  const tableOutcome = await host.document.mutate(tableInsertMutation(storyId, tableInsertSpec(table)));
  const tableId = tableOutcome.applied && tableOutcome.createdId ? tableIdOf(tableOutcome.createdId) : "";
  if (tableId) {
    const cells = tableCellInserts(table, storyId, tableId);
    if (cells.length > 0) {
      const filled = await host.document.mutate({ op: "batch", args: { ops: cells } });
      if (!filled.applied) host.log.warn("lower: native table cell fill rejected");
    }
    await host.document.mutate(bindingMetadata(createdFrame, envelope));
    await host.selection.set([createdFrame]);
    return frameId;
  }

  // FALLBACK — the host has no `insertTable`: the §2.2 degradation (tab-aligned
  // text + drawn rules) poured into the SAME frame (D-02 fallback).
  host.log.info("lower: insertTable unsupported — degrading to tab-text + drawn rules (D-02)");
  const ruleOps: Mutation[] = table.rules.map((r) => ({
    op: "insertLine",
    args: {
      pageId,
      start: [left + r.x1Pt, top + r.y1Pt] as [number, number],
      end: [left + r.x2Pt, top + r.y2Pt] as [number, number],
    },
  }));
  if (ruleOps.length > 0) await host.document.mutate({ op: "batch", args: { ops: ruleOps } });
  if (table.text.length > 0) {
    await host.document.mutate({ op: "insertText", args: { storyId, offset: 0, text: table.text } });
  }
  await host.document.mutate(bindingMetadata(createdFrame, envelope));
  await host.selection.set([createdFrame]);
  return frameId;
}

/** Resolve a story to place a variable field into. Prefers the host SELECTION
 *  (the bound text frame), else a fresh text frame on the active page whose
 *  minted story becomes the anchor.
 *
 *  CARET-POSITION GAP (honest, D-01): the SDK exposes NO caret/selection-offset
 *  read for a bundle — `placeholders()` gives run-start offsets but there is no
 *  "the user's caret is at offset N" door. So a freshly-placed field always
 *  lands at the STORY START (offset 0), not at an in-text caret. The field is a
 *  real tagged run either way (it survives edits, re-resolves live); only WHERE
 *  a NEW field is first inserted is coarse. Tracked as the D-01 caret residual:
 *  a caret-read door (or an edit-context insertion point) closes it. */
async function variableTargetStory(host: BundleHost): Promise<string | null> {
  // Selection first: a selected text frame's story is the natural anchor.
  let selected: readonly ElementId[] = [];
  try {
    selected = host.selection.get();
  } catch {
    selected = [];
  }
  for (const el of selected) {
    if (el.kind === "textFrame") {
      const hit = await frameStory(host, el.id as string);
      if (hit) return hit;
    }
  }
  // Else mint a fresh frame on the active page and use its story.
  const pageId = await activePageId(host);
  if (!pageId) return null;
  const placement = defaultPlacement(pageId, { widthPt: 160, heightPt: 60 });
  const frameOutcome = await host.document.mutate({
    op: "insertTextFrame",
    args: { pageId, bounds: placement.bounds },
  });
  if (!frameOutcome.applied || !frameOutcome.createdId) return null;
  const frameId = frameIdOf(frameOutcome.createdId);
  if (!frameId) return null;
  return frameStory(host, frameId);
}

/** Resolve a frame's story id via the hitTest read door (the frame's center). */
async function frameStory(host: BundleHost, frameId: string): Promise<string | null> {
  const geom = await host.document.elementGeometry([
    { kind: "textFrame", id: frameId } as ElementId,
  ]);
  const bounds = geom[0]?.bounds;
  if (!bounds) return null;
  const pageId = await activePageId(host);
  if (!pageId) return null;
  const [top, left, bottom, right] = bounds as [number, number, number, number];
  const hit = await host.document.hitTest(pageId, [(left + right) / 2, (top + bottom) / 2]);
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
 *  `bindingKey` is the field key; `targetStoryId` (when supplied) is the
 *  selected frame's story, else a fresh frame is minted (see
 *  `variableTargetStory` for the caret gap). */
export async function commitLoweredVariable(
  host: BundleHost,
  variable: LoweredVariable,
  bindingKey: string,
  targetStoryId?: string | null,
): Promise<{ storyId: string; offset: number } | null> {
  if (!host.supports("document.placeholders@1")) {
    host.log.info(
      `variable "${variable.target}" resolved to "${variable.text}"; the host ` +
        "predates the placeholder field model (document.placeholders@1) — placement skipped",
    );
    return null;
  }
  const storyId = targetStoryId ?? (await variableTargetStory(host));
  if (!storyId) {
    host.log.warn(`variable "${variable.target}": no target story to place the field into`);
    return null;
  }
  // CARET GAP: insert at story start (offset 0) — no caret-read door (see
  // variableTargetStory). The HideParagraph missing policy resolves to a null
  // value (the field shows its <key> token).
  const offset = 0;
  const value = variable.hidden ? null : variable.text;
  const outcome = await host.document.mutate(insertFieldMutation(storyId, offset, bindingKey, value));
  if (!outcome.applied) {
    host.log.warn(`variable "${variable.target}": insertField rejected`);
    return null;
  }
  host.log.info(`variable "${variable.target}" placed as field "${bindingKey}" in story ${storyId}`);
  return { storyId, offset };
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
): Promise<number> {
  if (barcode.modules.length === 0) {
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
    kind: "barcode",
    target: barcode.target,
    symbology: barcode.symbology,
  });
  const ops = barcodeToMutations(barcode, placement, envelope);
  if (ops.length === 0) return 0;

  const outcome = await host.document.mutate({ op: "batch", args: { ops } });
  if (!outcome.applied) {
    host.log.warn(`barcode "${barcode.target}": insertPath batch rejected`);
    return 0;
  }
  host.log.info(
    `barcode "${barcode.target}" (${barcode.symbology}) drawn as ${barcode.modules.length} ` +
      "vector modules" +
      (barcode.text ? ` (HRI "${barcode.text}")` : ""),
  );
  return barcode.modules.length;
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
  if (application.apply.kind === "table" && target.kind === "tableColumn") {
    await host.document.mutate(createRuleCellStyle(application.apply.name));
  }
  const muts = ruleMutations(application, target);
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
