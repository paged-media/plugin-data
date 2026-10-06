// The Data Merge writer against the REAL stack and the InDesign recordings
// (docs/design/oracles.md §2; campaign Wave 5, gated by the Wave 3 lane).
//
// Each fixture's template — the IDML InDesign itself wrote
// (conformance/indesign-merge/templates/<id>.idml) — is opened in real core,
// the CSV is ingested into the real data-js engine with every field as TEXT
// (as Data Merge reads it), and src/merge.ts merges it into the document
// (`consume`: the template page becomes the first output page, as in
// InDesign's merged document). The document is then READ BACK through the
// host — independently of the plan — and compared with recorded/<id>.json:
//
// - the page count;
// - on every page, as many text frames as InDesign made, and at the centre
//   of each recorded frame a frame of ours whose page-local bounds are the
//   recorded ones within ±0.5 pt and whose story text is the recorded text
//   (normalised: \r → \n, U+FEFF removed; an InDesign overset frame shows only
//   what fits, so ours must start with it);
// - the overset flag of every record (DM-7, measured by the writer);
// - on every page the placed image names.
//
// Then every mutate the merge made is undone, and the template is back.
//
// Gate: skips without canvas-wasm or the data-js wasm, EXCEPT under
// REQUIRE_REAL_CORE=1, where a missing piece is a failure.

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BundleHost, ElementId, PageId } from "@paged-media/plugin-api";
import { createHeadlessHost, defineBundle, type HeadlessHost } from "@paged-media/plugin-sdk";

import manifestJson from "../manifest.json";
import { mergeRecords, pageElements, readMergeTemplate, type RecordsPerPage } from "../src/merge";
import { documentLabelDoors, engineHasDocumentLabels } from "../src/doors";
import { ENGINE_ANCHOR, ENGINE_PROTOCOL, REQUIRE_REAL_CORE } from "./real-core";
import { bootRealEngine, DATA_JS_WASM } from "./real-duckdb";

const LANE = fileURLToPath(new URL("../../../conformance/indesign-merge/", import.meta.url));
const spec = JSON.parse(readFileSync(join(LANE, "fixtures.json"), "utf8"));
const TODAY = 20613;
const TOL = 0.5;

/** DEFECT (core, Wave 8 row): the IDML import moves a paragraph mark that
 *  sits between two adjacent HyperlinkTextSource elements two characters
 *  into the second one — `<<name>><Br/><<subtitle>>` reads back as
 *  `<<name>><<\nsubtitle>>`. Every Data Merge placeholder is such a source,
 *  so a template whose lines are bare placeholders is misread. */
const BR_BETWEEN_PLACEHOLDERS = new Set(["empty-field-lines", "overset"]);

const ready = ENGINE_ANCHOR !== null && existsSync(DATA_JS_WASM);
const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** RFC 4180, enough for the fixtures (quotes, doubled quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** The CSV as a data-core RecordSet, every field TEXT, an empty field null. */
function textRecordSet(id: string) {
  const [header, ...rows] = parseCsv(readFileSync(join(LANE, "csv", `${id}.csv`), "utf8"));
  return {
    schema: { fields: header.map((name) => ({ name, ty: "text", nullable: true })) },
    columns: header.map((_, c) =>
      rows.map((r) => (r[c] === "" ? { t: "null" } : { t: "text", v: r[c] })),
    ),
    row_count: rows.length,
  };
}

const normalise = (s: string) => s.replace(/\r/g, "\n").replace(/﻿/g, "");
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= TOL);

/** A host in this plugin's namespace (labels go under x-paged:media.paged.data). */
async function openTemplate(id: string): Promise<{ h: HeadlessHost; host: BundleHost }> {
  const h = await createHeadlessHost({ console: silent, resolveFrom: ENGINE_ANCHOR! } as Parameters<
    typeof createHeadlessHost
  >[0]);
  await h.load(readFileSync(join(LANE, "templates", `${id}.idml`)));
  let captured: BundleHost | null = null;
  h.loadBundle(
    defineBundle({
      manifest: manifestJson as never,
      activate(host) {
        captured = host;
        return { dispose() {} };
      },
    }),
  );
  return { h, host: captured! };
}

function mergeOptions(fx: any): { recordsPerPage: RecordsPerPage; removeBlankLines: boolean } {
  const m = fx.merge;
  return {
    recordsPerPage:
      m.recordsPerPage === "multiple"
        ? {
            mode: "multiple",
            arrange: m.arrangeBy === "columns" ? "columns" : "rows",
            rowSpacingPt: m.rowSpacing ?? 0,
            columnSpacingPt: m.columnSpacing ?? 0,
          }
        : { mode: "single" },
    removeBlankLines: m.removeBlankLines === true,
  };
}

/** The story text of the frame at a page-local point, with its bounds. */
async function frameAt(host: BundleHost, pageId: PageId, b: number[]) {
  const hit = await host.document.hitTest(pageId, [(b[1] + b[3]) / 2, (b[0] + b[2]) / 2]);
  if (!hit?.frameId || !hit.storyId || !hit.frameBounds) return null;
  const content = await host.document.storyContent(hit.storyId);
  const f = hit.frameBounds;
  return {
    frameId: hit.frameId,
    storyId: hit.storyId,
    bounds: [f.top, f.left, f.bottom, f.right],
    text: content ? content.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n") : "",
  };
}

describe.skipIf(!ready && !REQUIRE_REAL_CORE)(
  "Data Merge writer vs the InDesign recordings, real core + engine [data.lower.merge-writer]",
  () => {
    const hosts: HeadlessHost[] = [];
    afterEach(() => {
      while (hosts.length) hosts.pop()!.dispose();
    });

    for (const id of BR_BETWEEN_PLACEHOLDERS) {
      it.fails(`DEFECT core: ${id}'s template reads back with its line break inside the next placeholder [data.lower.merge-writer]`, async () => {
        const fx = (spec.fixtures as any[]).find((f) => f.id === id);
        const { h, host } = await openTemplate(id);
        hosts.push(h);
        const { template } = await readMergeTemplate(host);
        expect(template!.spec.frames[0].content).toEqual({
          kind: "text",
          text: fx.frames.find((f: any) => f.kind === "text").lines.join("\n"),
        });
      });
    }

    for (const fx of spec.fixtures as any[]) {
      it(`${fx.id}: pages, frames, texts, overset and images match InDesign; undo restores the template [data.lower.merge-writer]`, async () => {
        expect(ready, "real core and the data-js wasm must be available").toBe(true);
        const rec = JSON.parse(readFileSync(join(LANE, "recorded", `${fx.id}.json`), "utf8"));
        const { h, host } = await openTemplate(fx.id);
        hosts.push(h);
        const engine = await bootRealEngine(TODAY);
        engine.define_query({ id: "q", sql: "", params: [], shape: { shape: "recordStream" } });
        engine.ingest_result("q", textRecordSet(fx.id));

        // The template, read off the page, is the one the fixture describes.
        const tree = await host.document.tree();
        const rects = pageElements(tree, 0).filter((e) => e.kind === "rectangle");
        const imageFrame = fx.frames.find((f: any) => f.kind === "image");
        const imageFields: Record<string, string> = {};
        if (imageFrame) imageFields[rects[0].id as string] = imageFrame.field;
        const { template, diagnostics } = await readMergeTemplate(host, { imageFields });
        expect(diagnostics).toEqual([]);
        expect(template).not.toBeNull();
        expect(template!.spec.frames.map((f) => f.bounds.every((v, i) => Math.abs(v - fx.frames.find((x: any) => x.kind === f.content.kind).bounds[i]) <= TOL))).toEqual(
          template!.spec.frames.map(() => true),
        );
        const textFrame = template!.spec.frames.find((f) => f.content.kind === "text")!;
        const expected = fx.frames.find((f: any) => f.kind === "text").lines.join("\n");
        if ((textFrame.content as { text: string }).text !== expected) {
          // Only where the core import defect below is pinned; the writer is
          // then checked on the template text InDesign holds.
          expect(BR_BETWEEN_PLACEHOLDERS.has(fx.id), `template text of ${fx.id}`).toBe(true);
          textFrame.content = { kind: "text", text: expected };
        }

        // Page handles: detected as the session detects them (a v69 engine
        // behind an SDK with the label doors), and right about the engine.
        const pageHandles = await engineHasDocumentLabels(host);
        expect(pageHandles).toBe(ENGINE_PROTOCOL >= 69 && documentLabelDoors(host) !== null);
        const result = await mergeRecords(host, engine, template!, {
          query: "q",
          ...mergeOptions(fx),
          template: "consume",
          imageBase: join(LANE, "images"),
          pageHandles,
        });
        expect(result.diagnostics.filter((d) => !d.includes("overset"))).toEqual([]);
        expect(result.ok).toBe(true);
        // One undo step when the merge fits the template page or the engine
        // names the pages it mints in the batch (protocol 69); two otherwise.
        expect(result.mutateCalls).toBe(rec.merged.page_count > 1 && !pageHandles ? 2 : 1);

        // ── read back, independently of the plan ─────────────────────────
        const pages = await host.document.collection<{ selfId: string }>("pages");
        expect(pages.length).toBe(rec.merged.page_count);
        const links = await host.document.collection<{ hostSelfId: string; uri: string }>("links");
        const after = await host.document.tree();
        const oversetByStory = new Map<string, boolean>();
        for (const r of result.records) for (const f of r.frames) if (f.storyId) oversetByStory.set(f.storyId, f.overset);

        for (let p = 0; p < pages.length; p++) {
          const page = rec.merged.pages[p];
          const pageId = pages[p].selfId as PageId;
          const items = pageElements(after, p);
          expect(items.filter((e) => e.kind === "textFrame").length, `page ${p + 1} text frames`).toBe(page.text_frames.length);
          for (const tf of page.text_frames) {
            const ours = await frameAt(host, pageId, tf.bounds);
            expect(ours, `page ${p + 1}: no frame at ${tf.bounds}`).not.toBeNull();
            expect(near(ours!.bounds, tf.bounds), `page ${p + 1}: ${ours!.bounds} vs ${tf.bounds}`).toBe(true);
            const theirs = normalise(tf.text);
            if (tf.overset) expect(ours!.text.startsWith(theirs.trimEnd())).toBe(true);
            else expect(ours!.text).toBe(theirs);
            expect(oversetByStory.get(ours!.storyId) ?? false, `overset of "${theirs.slice(0, 20)}"`).toBe(tf.overset);
          }
          const rectIds = new Set(items.filter((e) => e.kind === "rectangle").map((e) => e.id as string));
          const names = links
            .filter((l) => rectIds.has(l.hostSelfId))
            .map((l) => l.uri.split("/").pop())
            .sort();
          const recorded = page.rectangles.map((r: any) => r.graphic?.name).filter(Boolean).sort();
          expect(names, `page ${p + 1} images`).toEqual(recorded);
        }

        // ── undo restores the template ──────────────────────────────────────
        for (let i = 0; i < result.mutateCalls; i++) await host.document.undo();
        expect((await host.document.collection("pages")).length).toBe(1);
        const restored = pageElements(await host.document.tree(), 0) as ElementId[];
        expect(restored.map((e) => e.id).sort()).toEqual(
          template!.frames.map((f) => f.element.id as string).sort(),
        );
      });
    }
  },
);
