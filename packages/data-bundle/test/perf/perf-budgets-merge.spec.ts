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

// PERF BUDGET — Data Merge (campaign Wave 5), through the SESSION over the real
// stack: real core with InDesign's own long-record-set template, the real
// data-js wasm, real DuckDB with the fixture CSV imported as a user would.
//
// W8: 57 records, Multiple Records, two columns, columns first, 3 pages —
// the merge the plan budgets. Behaviour beside the budget: the merged texts
// are InDesign's (conformance/indesign-merge/recorded/long-record-set.json) on
// the same pages, and a SECOND merge replaces the first instead of adding to
// it (update in place: same page count, same frame count).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { pageElements } from "../../src/merge";
import { countingHost } from "./counting-host";
import {
  BUDGET_TIMEOUT_MS,
  bootCountedDuck,
  bootCountedEngine,
  expectBudget,
  LABELLED,
  onLabelled,
  measure,
  openDataHost,
  printTable,
  report,
  RUN_BUDGETS,
  sessionOver,
  undoStepsSince,
  type CountedDuck,
  type Measured,
} from "./harness";

vi.setConfig({ testTimeout: BUDGET_TIMEOUT_MS });

const LANE = fileURLToPath(new URL("../../../../conformance/indesign-merge/", import.meta.url));
const ID = "long-record-set";
const normalise = (s: string) => s.replace(/\r/g, "\n").replace(/﻿/g, "");

// W8 as measured at introduction (Wave 5):
//  · two mutates = two undo steps: the page batch (3 ops: remove the
//    template frame, 2 × duplicatePage — a page minted in a batch cannot be
//    named, Wave 8 row), then ONE content batch of 399 ops = 57 records × 7
//    (insertTextFrame, bindCreated, insertText, the template's story
//    formatting, setPluginMetadata);
//  · host calls 148: 133 text.measureString — one per distinct word of the
//    merged texts (DM-7 overset; there is no batch measure door) — and 15
//    others, 13 of them reads: pages ×4, stories, meta, tree ×2,
//    elementGeometry, storyContent, elementProperties, hitTest (template and
//    re-merge plan reads);
//  · wasm 4: query_record_count, plan_merge, merge_words, merge_overset. The
//    query already ran (refreshData before the merge): no DuckDB statement.
//
// W8 on protocol 69 (LABELLED, harness.ts), where the merge consumes the
// whole batch:
//  · ONE mutate, ONE undo step: pages and content in one batch, each page
//    minted by duplicatePage named by bindCreated and addressed as `$h:p<i>`
//    (core ADR 128). mutates 2 → 1, undo steps 2 → 1.
//  · host calls 148 → 18: the 133 words are measured by ONE
//    text.measureStrings call (one face and size in this template; D-27);
//    one pages read fewer (no pages-then-content round trip): reads 13 → 12;
//    the session change the batch is labelled with is written first
//    (parts.write ×2, wasm +2: payload, sync_report).
//  · mutation ops 402 → 403: the label op rides the batch.
const W8: Measured = onLabelled({
  hostCalls: 148,
  hostReads: 13,
  mutates: 2,
  mutationOps: 402,
  undoSteps: 2,
  placeholdersRead: 0,
  wasmCalls: 4,
  cellsIn: 0,
  resolves: 0,
  stabilizeCalls: 0,
  keyAllocs: 0,
  fingerprints: 0,
  duckQueries: 0,
}, { hostCalls: 18, hostReads: 12, mutates: 1, mutationOps: 403, undoSteps: 1, wasmCalls: 6 });

describe.skipIf(!RUN_BUDGETS)("perf budgets — Data Merge [data.perf.gates]", () => {
  let h: HeadlessHost | null = null;
  let duck: CountedDuck | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });
  afterAll(async () => {
    printTable();
    await duck?.handle.close();
  });

  it("W8 merges 57 records, two columns, columns first, over 3 pages [data.perf.gates] [data.lower.merge-writer]", async () => {
    h = await openDataHost();
    await h.load(readFileSync(join(LANE, "templates", `${ID}.idml`)));
    const { host, work } = countingHost(h.host);
    const engine = await bootCountedEngine();
    duck ??= await bootCountedDuck();
    const s = await sessionOver(host, engine, duck);
    await s.registerCsvSource("lrs", readFileSync(join(LANE, "csv", `${ID}.csv`), "utf8"));
    s.addQuery("q", "SELECT * FROM lrs", "recordStream");
    await s.refreshData();
    // The undo mark: a paragraph style, not a page item — a consumed template
    // page is duplicated, and a frame on it would be copied onto every page.
    const markReply = (await h.host.editor.client.mutate({
      op: "createParagraphStyle",
      args: { name: "undo mark" },
    } as never)) as { payload?: { appliedSeq?: number } };
    const mark = markReply.payload!.appliedSeq!;

    const options = {
      query: "q",
      recordsPerPage: { mode: "multiple", arrange: "columns", rowSpacingPt: 6, columnSpacingPt: 12 } as const,
      template: "consume" as const,
    };
    work.reset();
    engine.reset();
    duck.reset();
    const t0 = performance.now();
    const r = await s.mergeRecords(options);
    const ms = performance.now() - t0;
    const snap = work.snapshot();
    const pre = measure(snap, engine, duck, null);

    // ── behaviour: InDesign's pages and texts ──────────────────────────────
    expect(r.ok, r.diagnostics.join("; ")).toBe(true);
    expect(r.mutateCalls).toBe(LABELLED ? 1 : 2);
    const rec = JSON.parse(readFileSync(join(LANE, "recorded", `${ID}.json`), "utf8"));
    const pages = await h.host.document.collection<{ selfId: string }>("pages");
    expect(pages.length).toBe(rec.merged.page_count);
    const tree = await h.host.document.tree();
    for (let p = 0; p < pages.length; p++) {
      const frames = pageElements(tree, p).filter((e) => e.kind === "textFrame");
      const geoms = await h.host.document.elementGeometry(frames);
      const texts: string[] = [];
      for (const g of geoms) {
        const c = await h.host.document.storyContent((g as { storyId: string }).storyId);
        const t = c!.paragraphs.map((x) => x.runs.map((y) => y.text).join("")).join("\n");
        texts.push(t);
      }
      expect(texts.sort(), `page ${p + 1}`).toEqual(
        rec.merged.pages[p].text_frames.map((t: { text: string }) => normalise(t.text)).sort(),
      );
    }

    // ── a second merge replaces the first (no duplicates) ──────────────────
    const r2 = await s.mergeRecords(options);
    expect(r2.ok, r2.diagnostics.join("; ")).toBe(true);
    expect((await h.host.document.collection("pages")).length).toBe(rec.merged.page_count);
    const all = await h.host.document.tree();
    const count = Array.from({ length: rec.merged.page_count }, (_, p) =>
      pageElements(all, p).filter((e) => e.kind === "textFrame").length,
    ).reduce((a, b) => a + b, 0);
    expect(count).toBe(57);

    // Two undo steps per merge: undo the re-merge, then the merge.
    const back = await undoStepsSince(h, mark);
    expect(back.reached).toBe(true);
    const m: Measured = { ...pre, undoSteps: back.steps / 2 };
    report("W8.merge-57", m, { ms, bytesIn: engine.log.bytesIn, bytesOut: engine.log.bytesOut, detail: {} }, snap, engine);
    expectBudget("W8", m, W8);
  });
});
