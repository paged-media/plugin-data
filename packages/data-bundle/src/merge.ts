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

// The Data Merge writer (campaign Wave 5). The engine plans the merge
// (`DataEngine.plan_merge`, data-lower/src/merge.rs: InDesign's closed-form
// Single / Multiple Record layout, verified against the recordings in
// conformance/indesign-merge); this file reads the record TEMPLATE off a page,
// turns the plan into mutations and measures the result for overset.
//
// What the host lets a plugin do, measured against real core (protocol 67):
//
// - A frame, its text, its formatting and its metadata label go in ONE batch:
//   `insertTextFrame` + `bindCreated` names it, and `$h:<handle>` addresses the
//   frame AND its story in later children (insertText, a storyRange
//   setElementProperty, setPluginMetadata).
// - A page minted in a batch cannot be named (`bindCreated` refuses: "nothing
//   to name"), so a merge that needs new pages costs TWO undo steps: the pages,
//   then everything on them. One step when the merge fits the template page.
// - Template frames cannot be copied: `duplicateElements` refuses a story that
//   holds a hyperlink, and every InDesign Data Merge placeholder IS a
//   HyperlinkTextSource; `duplicatePage` copies a frame but SHARES its story
//   with the original (a copy edited edits both). So merged frames are minted
//   fresh at the planned bounds, and the template's story-level formatting is
//   copied onto each (`setElementProperty` over the story range). Per-run
//   formatting inside the template is not copied yet.
// - There is no plugin door that creates a second document, so "merge to a new
//   document" is a documented gap: the merge writes into the current document,
//   either CONSUMING the template page (its merge frames are replaced, the
//   output starts on it — what InDesign's new document holds) or KEEPING it
//   (the output goes on new pages after it).
// - Headless core reports no overset (it lays out without fonts), so overset is
//   MEASURED (DM-7): the engine lists each template frame's words, the host
//   measures them (`host.text.measureString`), and the engine wraps every
//   merged text and compares its lines × leading with the frame. A host that
//   does report a story overset is believed as well.

import type { BundleHost, ElementId, Mutation, PageId } from "@paged-media/plugin-api";

import { BINDING_KEY, makeEnvelope, type IdmlFit } from "../../data-host-model/src";

// ── the engine contract (data-lower/src/merge.rs, camelCase serde) ──────────

/** `[top, left, bottom, right]`, page coordinates (pt). */
export type Bounds = [number, number, number, number];

export type RecordsPerPage =
  | { mode: "single" }
  | {
      mode: "multiple";
      arrange?: "rows" | "columns";
      rowSpacingPt?: number;
      columnSpacingPt?: number;
    };

export type MergeFrameContent = { kind: "text"; text: string } | { kind: "image"; field: string };

export interface MergeTemplateFrame {
  id: string;
  bounds: Bounds;
  content: MergeFrameContent;
}

export interface MergeSpec {
  marginBox: Bounds;
  frames: MergeTemplateFrame[];
  recordsPerPage: RecordsPerPage;
  removeBlankLines?: boolean;
}

export interface MergedFrame {
  template: number;
  bounds: Bounds;
  text?: string;
  image?: string;
}

export interface MergedRecord {
  record: number;
  page: number;
  row: number;
  column: number;
  frames: MergedFrame[];
}

export interface MergePlan {
  rows: number;
  columns: number;
  perPage: number;
  pageCount: number;
  records: MergedRecord[];
  fields: string[];
  missingFields: string[];
  diagnostics: string[];
}

/** The slice of the wasm engine the merge needs. */
export interface MergeEngine {
  plan_merge(query: string, spec: unknown): unknown;
  /** The distinct words of the plan's texts per template frame. */
  merge_words(plan: unknown, frames: number): unknown;
  /** `boolean[][]`: per record, per frame, overset (DM-7). */
  merge_overset(plan: unknown, metrics: unknown): unknown;
}

/** One template frame's measured font, as `merge_overset` reads it. */
export interface FrameMetrics {
  leadingPt: number;
  advances: Record<string, number>;
}

// ── the template, as read off a page ────────────────────────────────────────

/** One story-level property copied from a template text frame onto every
 *  merged copy (`setElementProperty` over the whole story range). */
export interface CopiedProperty {
  path: string;
  value: unknown;
}

/** One template frame plus what the writer needs to reproduce it. */
export interface TemplateFrameInfo {
  element: ElementId;
  /** The template's story (text frames). */
  storyId: string | null;
  /** Story-level formatting to copy, styles first. */
  format: CopiedProperty[];
  /** The text's font, size and leading, for overset measurement. */
  font: { family: string; style: string | null; sizePt: number; leadingPt: number };
}

export interface MergeTemplate {
  pageId: PageId;
  /** `frames[i]` describes `spec.frames[i]`. */
  frames: TemplateFrameInfo[];
  spec: Omit<MergeSpec, "recordsPerPage" | "removeBlankLines">;
}

/** The properties a merged copy takes over from its template story. Styles
 *  come first so the overrides after them win. */
export const COPIED_TEXT_PATHS = [
  "appliedParagraphStyle",
  "appliedCharacterStyle",
  "characterFontFamily",
  "characterFontStyle",
  "characterFontSize",
  "characterLeading",
  "characterTracking",
  "characterFillColor",
  "paragraphJustification",
  "paragraphSpaceBefore",
  "paragraphSpaceAfter",
  "paragraphLeftIndent",
  "paragraphRightIndent",
  "paragraphFirstLineIndent",
] as const;

/** InDesign's default when a story says nothing: 12 pt, auto leading 120 %. */
const DEFAULT_SIZE_PT = 12;
const AUTO_LEADING = 1.2;

/** UTF-8 length — the host's text offsets are UTF-8 bytes of the runs plus one
 *  per paragraph boundary, which is exactly the byte length of the text with
 *  `\n` between paragraphs. */
export function textOffsetLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A story's text in the planner's convention: runs joined, paragraphs (and
 *  forced line breaks, which arrive as `\n` inside runs) separated by `\n`. */
export function storyText(content: { paragraphs: { runs: { text: string }[] }[] }): string {
  return content.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
}

/** Every element of one page, in z-order, from the scene tree. Pages are
 *  addressed by document order (the tree's page rows carry no id). */
export function pageElements(
  tree: readonly { kind: string; id?: ElementId | null; children?: readonly unknown[] }[],
  pageIndex: number,
): ElementId[] {
  let index = 0;
  const out: ElementId[] = [];
  type Node = { kind: string; id?: ElementId | null; children?: readonly Node[] };
  const walkItems = (nodes: readonly Node[]) => {
    for (const n of nodes) {
      if (n.id) out.push(n.id);
      else if (n.children) walkItems(n.children);
    }
  };
  const walk = (nodes: readonly Node[]): boolean => {
    for (const n of nodes) {
      if (n.kind === "Page") {
        if (index === pageIndex) {
          walkItems(n.children ?? []);
          return true;
        }
        index += 1;
      } else if (n.children && walk(n.children)) {
        return true;
      }
    }
    return false;
  };
  walk(tree as readonly Node[]);
  return out;
}

/** Apply an IDML item transform `[a b c d e f]` to bounds (axis-aligned). */
function transformBounds(b: Bounds, t: number[] | null | undefined): Bounds {
  if (!t) return b;
  const [a, bb, c, d, e, f] = t;
  const pts = [
    [b[1], b[0]],
    [b[3], b[0]],
    [b[1], b[2]],
    [b[3], b[2]],
  ].map(([x, y]) => [a * x + c * y + e, bb * x + d * y + f]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...ys), Math.min(...xs), Math.max(...ys), Math.max(...xs)];
}

const HAS_PLACEHOLDER = /<<[^<>]+>>/;

export interface ReadTemplateOptions {
  /** The template page (default: the active page, else the first). */
  pageId?: PageId;
  /** Image placeholders: rectangle raw id → field name (`photo` / `@photo`). */
  imageFields?: Record<string, string>;
  /** Restrict the template to these frames (default: every text frame on the
   *  page whose story holds a `<<field>>`, plus the image placeholders). */
  frames?: ElementId[];
}

/**
 * Read the record template off a page: its merge frames (page-local bounds,
 * text, formatting) and its margin box.
 *
 * Page-local bounds: `elementGeometry` answers raw bounds plus an item
 * transform in SPREAD space, and the spread origin of a page is not on any
 * read door. It is recovered from one text frame: `hitTest` (page-local in,
 * page-local `frameBounds` out) is asked at that frame's centre under the
 * usual page placements (single page centred on the spread, left or right of
 * a facing spread, spread origin), and the answer that names the frame back
 * fixes the offset for the whole page.
 */
export async function readMergeTemplate(
  host: BundleHost,
  opts: ReadTemplateOptions = {},
): Promise<{ template: MergeTemplate | null; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  const pages = await host.document.collection<{
    selfId: string;
    index: number;
    sizePt: [number, number];
    marginTopPt: number;
    marginLeftPt: number;
    marginBottomPt: number;
    marginRightPt: number;
  }>("pages");
  let pageId = opts.pageId;
  if (!pageId) {
    const meta = await host.document.meta();
    pageId = (meta.activePage ?? pages[0]?.selfId) as PageId | undefined;
  }
  const pageIndex = pages.findIndex((p) => p.selfId === pageId);
  if (!pageId || pageIndex < 0) {
    return { template: null, diagnostics: ["merge: no template page"] };
  }
  const page = pages[pageIndex];
  const [pw, ph] = page.sizePt;

  const imageFields = opts.imageFields ?? {};
  const candidates =
    opts.frames ??
    pageElements(await host.document.tree(), pageIndex).filter(
      (e) => e.kind === "textFrame" || (e.kind === "rectangle" && (e.id as string) in imageFields),
    );
  if (candidates.length === 0) {
    return { template: null, diagnostics: ["merge: the template page has no frames"] };
  }
  const geoms = await host.document.elementGeometry(candidates);

  // The text frames and their stories.
  type Raw = { element: ElementId; spread: Bounds; storyId: string | null; text: string | null };
  const raws: Raw[] = [];
  for (const g of geoms) {
    const spread = transformBounds(g.bounds as Bounds, g.itemTransform as number[] | null);
    if (g.id.kind === "textFrame") {
      const storyId = (g as { storyId?: string | null }).storyId ?? null;
      const content = storyId ? await host.document.storyContent(storyId) : null;
      const text = content ? storyText(content) : "";
      if (!opts.frames && !HAS_PLACEHOLDER.test(text)) continue;
      raws.push({ element: g.id, spread, storyId, text });
    } else if (g.id.kind === "rectangle" && (g.id.id as string) in imageFields) {
      raws.push({ element: g.id, spread, storyId: null, text: null });
    }
  }
  const firstText = raws.find((r) => r.text !== null);
  if (!firstText) {
    return { template: null, diagnostics: ["merge: no text frame with a <<field>> on the template page"] };
  }

  // Recover the page's spread origin from one confirmed hit.
  let origin: [number, number] | null = null;
  const s = firstText.spread;
  const cx = (s[1] + s[3]) / 2;
  const cy = (s[0] + s[2]) / 2;
  for (const [ox, oy] of [
    [-pw / 2, -ph / 2],
    [-pw, -ph / 2],
    [0, -ph / 2],
    [0, 0],
  ]) {
    const hit = await host.document.hitTest(pageId, [cx - ox, cy - oy]);
    if (hit?.frameId === (firstText.element.id as string) && hit.frameBounds) {
      origin = [s[1] - hit.frameBounds.left, s[0] - hit.frameBounds.top];
      break;
    }
  }
  if (!origin) {
    return {
      template: null,
      diagnostics: ["merge: could not locate the template frames on their page (hitTest found no frame)"],
    };
  }
  const local = (b: Bounds): Bounds => [b[0] - origin![1], b[1] - origin![0], b[2] - origin![1], b[3] - origin![0]];

  const frames: MergeTemplateFrame[] = [];
  const infos: TemplateFrameInfo[] = [];
  for (const r of raws) {
    if (r.text !== null) {
      const format = await copiedProperties(host, r.storyId, r.text);
      frames.push({ id: r.element.id as string, bounds: local(r.spread), content: { kind: "text", text: r.text } });
      infos.push({ element: r.element, storyId: r.storyId, format, font: fontOf(format) });
    } else {
      const field = imageFields[r.element.id as string];
      frames.push({ id: r.element.id as string, bounds: local(r.spread), content: { kind: "image", field } });
      infos.push({
        element: r.element,
        storyId: null,
        format: [],
        font: { family: "", style: null, sizePt: DEFAULT_SIZE_PT, leadingPt: DEFAULT_SIZE_PT * AUTO_LEADING },
      });
    }
  }
  if (frames.length !== raws.length) diagnostics.push("merge: some template frames were skipped");
  return {
    template: {
      pageId,
      frames: infos,
      spec: {
        marginBox: [page.marginTopPt, page.marginLeftPt, ph - page.marginBottomPt, pw - page.marginRightPt],
        frames,
      },
    },
    diagnostics,
  };
}

/** The story-level formatting of a template text frame (whole-story range;
 *  a property that varies inside the story reads as mixed and is skipped). */
async function copiedProperties(
  host: BundleHost,
  storyId: string | null,
  text: string,
): Promise<CopiedProperty[]> {
  if (!storyId) return [];
  const props = await host.document.elementProperties({
    kind: "storyRange",
    id: { story_id: storyId, start: 0, end: textOffsetLength(text) },
  } as ElementId);
  const entries = (props?.entries ?? []) as { path: string; value?: { value?: unknown } | null }[];
  const out: CopiedProperty[] = [];
  for (const path of COPIED_TEXT_PATHS) {
    const e = entries.find((x) => x.path === path);
    const v = e?.value;
    if (!v || v.value === null || v.value === undefined || v.value === "") continue;
    out.push({ path, value: v });
  }
  return out;
}

function fontOf(format: CopiedProperty[]): TemplateFrameInfo["font"] {
  const get = (p: string) => (format.find((f) => f.path === p)?.value as { value?: unknown } | undefined)?.value;
  const size = typeof get("characterFontSize") === "number" ? (get("characterFontSize") as number) : DEFAULT_SIZE_PT;
  const leading = typeof get("characterLeading") === "number" ? (get("characterLeading") as number) : size * AUTO_LEADING;
  const family = typeof get("characterFontFamily") === "string" ? (get("characterFontFamily") as string) : "";
  const style = typeof get("characterFontStyle") === "string" ? (get("characterFontStyle") as string) : null;
  return { family, style, sizePt: size, leadingPt: leading };
}

// ── the writer (pure) ───────────────────────────────────────────────────────

export interface MergeWriteOptions {
  /** `consume`: the template page holds the first output page and its merge
   *  frames are removed (InDesign's merged document). `keep`: the template
   *  stays as it is and the output goes on new pages after it. */
  template: "consume" | "keep";
  /** Resolves a relative image reference (Data Merge reads it relative to
   *  the data source). Absolute paths and URIs pass through. */
  imageBase?: string;
  /** IDML fitting for image fields (default `Proportionally`, centred by the
   *  host, which is Data Merge's "fit proportionally, centre"). */
  fit?: IdmlFit;
  /** The id every merged element is labelled with, so a re-merge finds and
   *  replaces them (`relower.ts`). */
  mergeId: string;
  /** Mutations that clear a previous run of this merge (`relower.ts`); they
   *  ride the first batch, so a re-merge is no extra undo step. */
  clear?: Mutation[];
}

/** The page mutations: what has to exist before anything can be placed.
 *  `null` when the merge fits the template page (one undo step in all). */
export function pageMutations(
  plan: Pick<MergePlan, "pageCount">,
  template: MergeTemplate,
  opts: Pick<MergeWriteOptions, "template" | "clear">,
): Mutation | null {
  const ops: Mutation[] = [];
  if (opts.template === "consume") {
    if (plan.pageCount <= 1) return null;
    ops.push(...(opts.clear ?? []));
    // Remove the merge frames first so the page copies come out empty.
    ops.push(...removeTemplateFrames(template));
    for (let i = 1; i < plan.pageCount; i++) {
      ops.push({ op: "duplicatePage", args: { page: template.pageId } });
    }
  } else {
    ops.push(...(opts.clear ?? []));
    for (let i = 0; i < plan.pageCount; i++) {
      ops.push({ op: "insertPage", args: { afterPageId: template.pageId, masterId: null } });
    }
  }
  return ops.length === 0 ? null : { op: "batch", args: { ops } };
}

function removeTemplateFrames(template: MergeTemplate): Mutation[] {
  return template.frames.map((f) => ({ op: "deleteFrame", args: { frameId: f.element.id as string } }));
}

/** Resolve an image reference against `imageBase`. */
export function imageUri(ref: string, base?: string): string {
  if (!base || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("/")) return ref;
  return base.endsWith("/") ? base + ref : `${base}/${ref}`;
}

/** The content batch: every record's frames, text, formatting, images and
 *  labels, on `pages[plan page]`. With `consume` and a single output page the
 *  template frames are removed here too, so the whole merge is one step. */
export function contentMutation(
  plan: Pick<MergePlan, "pageCount" | "records">,
  template: MergeTemplate,
  pages: readonly PageId[],
  opts: MergeWriteOptions,
): Mutation {
  const ops: Mutation[] = [];
  if (opts.template === "consume" && plan.pageCount <= 1) {
    ops.push(...(opts.clear ?? []), ...removeTemplateFrames(template));
  }
  const fit = opts.fit ?? "Proportionally";
  for (const rec of plan.records) {
    const pageId = pages[rec.page];
    for (const f of rec.frames) {
      const h = `m${rec.record}f${f.template}`;
      // `createdPage`: this frame sits on a page the merge added, so a
      // re-merge may remove that page with it (relower.ts).
      const createdPage = opts.template === "keep" || rec.page > 0;
      const label = makeEnvelope({
        kind: "merge",
        merge: opts.mergeId,
        record: rec.record,
        frame: f.template,
        ...(createdPage ? { createdPage } : {}),
      });
      const info = template.frames[f.template];
      if (f.text !== undefined) {
        const frame: ElementId = { kind: "textFrame", id: `$h:${h}` } as ElementId;
        ops.push({ op: "insertTextFrame", args: { pageId, bounds: f.bounds } });
        ops.push({ op: "bindCreated", args: { handle: h } });
        if (f.text.length > 0) {
          ops.push({ op: "insertText", args: { storyId: `$h:${h}`, offset: 0, text: f.text } });
          const range = {
            kind: "storyRange",
            id: { story_id: `$h:${h}`, start: 0, end: textOffsetLength(f.text) },
          } as ElementId;
          for (const p of info?.format ?? []) {
            ops.push({
              op: "setElementProperty",
              args: { elementId: range, path: p.path, value: p.value },
            } as Mutation);
          }
        }
        ops.push({ op: "setPluginMetadata", args: { elementId: frame, key: BINDING_KEY, value: label } });
      } else {
        const frame: ElementId = { kind: "rectangle", id: `$h:${h}` } as ElementId;
        ops.push({ op: "insertFrame", args: { pageId, bounds: f.bounds } });
        ops.push({ op: "bindCreated", args: { handle: h } });
        if (f.image) {
          ops.push({ op: "placeImage", args: { elementId: `$h:${h}`, uri: imageUri(f.image, opts.imageBase), fit } });
        }
        ops.push({ op: "setPluginMetadata", args: { elementId: frame, key: BINDING_KEY, value: label } });
      }
    }
  }
  return { op: "batch", args: { ops } };
}

// ── the orchestration ───────────────────────────────────────────────────────

export interface MergeOptions extends Omit<MergeWriteOptions, "mergeId"> {
  query: string;
  recordsPerPage: RecordsPerPage;
  removeBlankLines?: boolean;
  mergeId?: string;
}

export interface MergedFrameResult {
  element: ElementId;
  storyId: string | null;
  overset: boolean;
}

export interface MergeResult {
  ok: boolean;
  plan: MergePlan | null;
  /** The output pages, in plan order. */
  pages: PageId[];
  records: { record: number; page: number; frames: MergedFrameResult[] }[];
  /** Records with an overset text frame. */
  overset: number[];
  /** `host.document.mutate` calls (= undo steps) the merge took. */
  mutateCalls: number;
  diagnostics: string[];
}

function failed(diagnostics: string[], mutateCalls = 0, plan: MergePlan | null = null): MergeResult {
  return { ok: false, plan, pages: [], records: [], overset: [], mutateCalls, diagnostics };
}

/**
 * Merge a query's records into the document through a template read with
 * [`readMergeTemplate`]. Plans in the engine, writes in at most two mutates
 * (pages, then content), then measures every merged text for overset.
 */
export async function mergeRecords(
  host: BundleHost,
  engine: MergeEngine,
  template: MergeTemplate,
  opts: MergeOptions,
): Promise<MergeResult> {
  const diagnostics: string[] = [];
  let plan: MergePlan;
  try {
    plan = engine.plan_merge(opts.query, {
      ...template.spec,
      recordsPerPage: opts.recordsPerPage,
      removeBlankLines: opts.removeBlankLines ?? false,
    }) as MergePlan;
  } catch (e) {
    return failed([`merge: ${String(e)}`]);
  }
  diagnostics.push(...plan.diagnostics);
  if (plan.records.length === 0) return { ...failed([...diagnostics, "merge: no records"], 0, plan), ok: true };
  const mergeId = opts.mergeId ?? `merge-${opts.query}`;
  const wopts: MergeWriteOptions = { ...opts, mergeId };

  // 1. Pages.
  let mutateCalls = 0;
  const before = (await host.document.collection<{ selfId: string }>("pages")).map((p) => p.selfId);
  const pagesOp = pageMutations(plan, template, wopts);
  if (pagesOp) {
    mutateCalls += 1;
    const o = await host.document.mutate(pagesOp);
    if (!o.applied) return failed([...diagnostics, `merge: adding pages was refused: ${errorText(o.error)}`], mutateCalls, plan);
  }
  const after = (await host.document.collection<{ selfId: string }>("pages")).map((p) => p.selfId);
  const at = after.indexOf(template.pageId);
  const pages: PageId[] = (
    wopts.template === "consume"
      ? after.slice(at, at + plan.pageCount)
      : after.slice(at + 1, at + 1 + plan.pageCount)
  ) as PageId[];
  const added = after.filter((p) => !before.includes(p)).length;
  if (pages.length !== plan.pageCount || added !== (wopts.template === "consume" ? plan.pageCount - 1 : plan.pageCount)) {
    return failed([...diagnostics, `merge: expected ${plan.pageCount} output pages, found ${pages.length}`], mutateCalls, plan);
  }

  // 2. Content.
  mutateCalls += 1;
  const o = await host.document.mutate(contentMutation(plan, template, pages, wopts));
  if (!o.applied) return failed([...diagnostics, `merge: the content batch was refused: ${errorText(o.error)}`], mutateCalls, plan);
  // Minted in creation order, one per record frame. The handle names each;
  // where a host reports it null, the position does.
  const order = plan.records.flatMap((rec) => rec.frames.map((f) => `m${rec.record}f${f.template}`));
  const minted = new Map((o.minted ?? []).map((m, i) => [m.handle ?? order[i] ?? "", m]));

  // 3. Overset (DM-7): the engine lists the words, the host measures them at
  // each template frame's font, the engine wraps and compares. A host that
  // lays out with fonts and reports a story overset is believed as well.
  const words = engine.merge_words(plan, template.frames.length) as string[][];
  const metrics: FrameMetrics[] = [];
  for (let i = 0; i < template.frames.length; i++) {
    const font = template.frames[i].font;
    const advances: Record<string, number> = {};
    for (const w of words[i] ?? []) {
      advances[w] = (await host.text.measureString(font.family, font.style, w, font.sizePt)).advance;
    }
    metrics.push({ leadingPt: font.leadingPt, advances });
  }
  const measured = engine.merge_overset(plan, metrics) as boolean[][];
  const reported = new Set(
    (await host.document.collection<{ selfId: string; overset?: boolean }>("stories"))
      .filter((s) => s.overset)
      .map((s) => s.selfId),
  );
  const records: MergeResult["records"] = [];
  const overset: number[] = [];
  plan.records.forEach((rec, r) => {
    const frames: MergedFrameResult[] = [];
    rec.frames.forEach((f, k) => {
      const m = minted.get(`m${rec.record}f${f.template}`);
      if (!m) {
        diagnostics.push(`merge: record ${rec.record} frame ${f.template} was not minted`);
        return;
      }
      const over = (measured[r]?.[k] ?? false) || (m.storyId !== null && reported.has(m.storyId));
      frames.push({ element: m.element, storyId: m.storyId, overset: over });
    });
    if (frames.some((f) => f.overset)) overset.push(rec.record);
    records.push({ record: rec.record, page: rec.page, frames });
  });
  if (overset.length > 0) diagnostics.push(`merge: ${overset.length} record(s) overset`);
  return { ok: true, plan, pages, records, overset, mutateCalls, diagnostics };
}

function errorText(e: unknown): string {
  try {
    return typeof e === "string" ? e : JSON.stringify(e);
  } catch {
    return String(e);
  }
}
