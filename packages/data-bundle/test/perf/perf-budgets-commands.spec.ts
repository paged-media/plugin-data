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

// PERF BUDGETS — the paged.data COMMANDS, against the real core host, the real
// data-js wasm and (where the command queries) real DuckDB. Feature
// `data.perf.gates`.
//
// THE RULES (the same rules as the plugin-draw, image, sheets and web budgets):
//  · a budget is a COUNT — host door calls, mutates, batch ops, undo steps,
//    wasm calls, cells across the boundary, engine resolves / sorts / sort-key
//    allocations — never a duration;
//  · it is the MEASURED value (2026-10-05), pinned exactly: a count that DROPS
//    fails too, so the commit that earns a saving lowers the pin with it, and
//    a pin is never raised;
//  · a behaviour assertion stands beside every budget, so an implementation
//    that got "cheaper" by not doing the work cannot pass;
//  · wall clock and bytes are printed (PERF_SHOW=1), trended, never gated.
//
// Each scenario names the expensive path it exercises (AS FOUND).

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";


import { countingHost, type WorkLog } from "./counting-host";
import {
  BUDGET_TIMEOUT_MS,
  openDataHost,
  bootCountedDuck,
  bootCountedEngine,
  expectBudget,
  measure,
  printTable,
  productCsv,
  report,
  RUN_BUDGETS,
  sessionOver,
  undoMark,
  undoSteps,
  type CountedDuck,
  type CountedEngine,
  type Measured,
} from "./harness";

vi.setConfig({ testTimeout: BUDGET_TIMEOUT_MS });

const PLUGIN = "media.paged.data";

/** Settle the reply observers (placeholdersRead counts on reply). */
const settle = () => new Promise((r) => setTimeout(r, 0));

function resetAll(work: WorkLog, engine: CountedEngine, duck: CountedDuck | null): void {
  work.reset();
  engine.reset();
  duck?.reset();
}

/** A fresh text frame on the fixture page; its story id. */
async function newStory(h: HeadlessHost, bounds: [number, number, number, number]): Promise<string> {
  const fr = await h.host.document.mutate({ op: "insertTextFrame", args: { pageId: "usp" as never, bounds } });
  expect(fr.applied).toBe(true);
  const [top, left, bottom, right] = bounds;
  const hit = await h.host.document.hitTest("usp" as never, [(left + right) / 2, (top + bottom) / 2]);
  expect(hit?.storyId).toBeTruthy();
  return hit!.storyId as string;
}

async function ourFields(h: HeadlessHost) {
  return (await h.host.document.placeholders()).filter((p) => p.plugin === PLUGIN);
}

describe.skipIf(!RUN_BUDGETS)("perf budgets — data commands [data.perf.gates]", () => {
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
  const sharedDuck = async () => (duck ??= await bootCountedDuck());

  // ── W1: import a CSV, lower a 500-row table ───────────────────────────────
  // AS FOUND: the import is one DuckDB registration; the lower re-runs EVERY
  // query (refreshData) and re-ingests its full result — 500 rows × 3 columns
  // as 1 500 `{t, v}` objects serde-decoded by the wasm — then mints a frame,
  // finds its story by hitTest (D-16), inserts the table and fills every cell
  // in one batch.
  // Wave 4 (persistence): +1 consent read — the session snapshot reports remote-source consent.
  const W1_IMPORT: Measured = {
    hostCalls: 1,
    hostReads: 0,
    mutates: 0,
    mutationOps: 0,
    undoSteps: null,
    placeholdersRead: 0,
    wasmCalls: 2,
    cellsIn: 0,
    resolves: 0,
    stabilizeCalls: 0,
    keyAllocs: 0,
    fingerprints: 0,
    duckQueries: 0,
  };
  // Wave 4 (persistence): +1 parts.write (the session part), +1 supports, +1 log; +1 payload +1 sync_report to build it (one payload, shared with the lowered label's definition hash).
  // Wave 2: frame + table + cells + label are ONE batch addressed by C-15
  // handles (`$h:frame`, `$h:table`), and the minted frame comes back in
  // `minted` — no hitTest (D-16). hostCalls 11 → 7, reads 3 → 2, mutates
  // 4 → 1, undo steps 4 → 1.
  // Column door (Wave 2): the result crosses as typed column buffers — begin + one push per column + finish (+4 wasm calls) instead of 1 500 `{t, v}` cells (cellsIn 0; bytes in 41.5 KB → 16.9 KB).
  // Wave 7 (row diff): +1 wasmCalls — mark_rows_applied, the row diff's "before" snapshot, once per command that writes the document from data.
  // Wave 6 (query guard): +1 DuckDB statement — the first refresh asks DuckDB's
  // parser about the query once (`json_serialize_sql`, query/sql.ts guardQuery).
  // Guard fix (browser): -1 — the guard is a TypeScript lexer that asks DuckDB
  // nothing (json_serialize_sql trapped in the browser worker); the config
  // lock is boot cost (LOCKDOWN_SQL in bootDuckDB). duckQueries 2 → 1.
  // Wave 5 (update in place): +1 read — document.tree, to find a table this
  // binding lowered before and swap it inside its own frame.
  const W1_LOWER: Measured = {
    hostCalls: 8,
    hostReads: 3,
    mutates: 1,
    mutationOps: 1506,
    undoSteps: 1,
    placeholdersRead: 0,
    wasmCalls: 9,
    cellsIn: 0,
    resolves: 1,
    stabilizeCalls: 1,
    // Was 9 840 (sort keys built per comparison); in-place since Wave 2.
    keyAllocs: 0,
    fingerprints: 0,
    duckQueries: 1,
  };
  it("W1 imports a 500-row CSV and lowers it as one table [data.perf.gates]", async () => {
    h = await openDataHost();
    const { host, work } = countingHost(h.host);
    const engine = await bootCountedEngine();
    const d = await sharedDuck();
    const s = await sessionOver(host, engine, d);
    resetAll(work, engine, d);

    let t0 = performance.now();
    await s.registerCsvSource("products_w1", productCsv(500));
    await settle();
    const importMs = performance.now() - t0;
    const imp = measure(work, engine, d, null);
    expect(s.getState().sources).toEqual(["products_w1"]);
    report("W1.import-csv-500", imp, { ms: importMs, bytesIn: engine.log.bytesIn, bytesOut: engine.log.bytesOut, detail: {} }, work, engine);

    s.addQuery("q1", "SELECT sku, name, price FROM products_w1", "recordStream");
    s.addTableBinding("t1", "region", "q1", [
      { header: "SKU", expr: "sku" },
      { header: "Name", expr: "UPPER(name)" },
      { header: "Price", expr: "CURRENCY(price)" },
    ]);
    const mark = await undoMark(h);
    resetAll(work, engine, d);
    t0 = performance.now();
    await s.lowerAll();
    await settle();
    const lowerMs = performance.now() - t0;
    const lowerWork = work.snapshot();
    const bytes = { bytesIn: engine.log.bytesIn, bytesOut: engine.log.bytesOut };
    const pre = measure(lowerWork, engine, d, null);
    // Behaviour: one table of 501 rows (header + 500) × 3, every cell filled —
    // the frame, the table, 1,503 cells and the label in ONE batch (the two
    // bindCreated names are not counted), which applied: the minted frame is
    // selected.
    expect(lowerWork.mutations.map((m) => `${m.op}(${m.ops})`)).toEqual([`batch(${2 + 501 * 3 + 1})`]);
    expect(s.getState().status).toBe("ready");
    expect(h.host.selection.get().map((e) => e.kind)).toEqual(["textFrame"]);
    const undo = await undoSteps(h, mark);
    const low = { ...pre, undoSteps: undo };
    report("W1.lower-table-500", low, { ms: lowerMs, ...bytes, detail: {} }, lowerWork, engine);
    expectBudget("W1.import", imp, W1_IMPORT);
    expectBudget("W1.lower", low, W1_LOWER);
  });

  // ── W2: refresh 100 fields in one story ───────────────────────────────────
  // AS FOUND: one placeholders() read, then ONE awaited setFieldValue mutate
  // per changed field — 100 rebuilds and 100 undo steps for one refresh, and
  // two wasm calls per field (sync_state + resolve_lowered).
  // Wave 2: the writes are ONE back-to-front batch (one rebuild, one undo
  // step), and the engine decides every field in ONE `refresh_field_values`
  // call. hostCalls 102 → 3, mutates 100 → 1, undo 89 (unreachable) → 1,
  // wasm calls 200 → 1.
  // Wave 7 (row diff): +1 wasmCalls — mark_rows_applied, the row diff's "before" snapshot, once per command that writes the document from data.
  const W2: Measured = {
    hostCalls: 3,
    hostReads: 1,
    mutates: 1,
    mutationOps: 100,
    undoSteps: 1,
    placeholdersRead: 100,
    wasmCalls: 2,
    cellsIn: 0,
    resolves: 100,
    stabilizeCalls: 0,
    keyAllocs: 0,
    fingerprints: 0,
    duckQueries: 0,
  };
  it("W2 refreshes 100 fields in one story [data.perf.gates]", async () => {
    h = await openDataHost();
    const { host, work } = countingHost(h.host);
    const engine = await bootCountedEngine();
    const d = await sharedDuck();
    const s = await sessionOver(host, engine, d);
    // One record, columns c0..c99; field k reads column k.
    const N = 100;
    const header = Array.from({ length: N }, (_, i) => `c${i}`).join(",");
    const row = Array.from({ length: N }, (_, i) => `value-${i}`).join(",");
    await s.registerCsvSource("wide_w2", `${header}\n${row}\n`);
    s.addQuery("q1", "SELECT * FROM wide_w2", "recordStream");
    for (let i = 0; i < N; i++) s.addVariableBinding(`v${i}`, "anchor", "q1", `c${i}`);
    await s.refreshData();
    // The fields are already in ONE story, stale ("x"), separated by spaces.
    // The spaces go in first and each field is inserted INTO them: a space
    // inserted at a field's start would join the field's run (the core
    // defect pinned in field-offsets-real-core.spec.ts), and the field write
    // would then erase it. (The Wave 1 fixture did that; its "89 undo steps,
    // history exhausted" was that defect, not a bounded history.)
    const story = await newStory(h, [100, 100, 600, 500]);
    await h.host.document.mutate({ op: "insertText", args: { storyId: story, offset: 0, text: " ".repeat(N - 1) } });
    for (let i = N - 1; i >= 0; i--) {
      const ins = await h.host.document.mutate({
        op: "insertField",
        args: { storyId: story, offset: i, field: { placeholder: { plugin: PLUGIN, key: `v${i}`, value: "x" } } },
      } as never);
      expect(ins.applied).toBe(true);
    }
    expect((await ourFields(h)).map((f) => f.key)).toEqual(Array.from({ length: N }, (_, i) => `v${i}`));

    const mark = await undoMark(h);
    resetAll(work, engine, d);
    const t0 = performance.now();
    const written = await s.refreshFields();
    await settle();
    const ms = performance.now() - t0;
    const snap = work.snapshot();
    const pre = measure(snap, engine, d, null);
    const bytes = { bytesIn: engine.log.bytesIn, bytesOut: engine.log.bytesOut };
    // Behaviour: every field now shows its column's value.
    expect(written).toBe(N);
    const after = await ourFields(h);
    expect(after.every((f) => f.value === `value-${f.key.slice(1)}`)).toBe(true);
    // ...and the separators between them survived the writes.
    const text = await h.host.document.storyContent(story);
    expect(text?.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("")).toBe(
      Array.from({ length: N }, (_, i) => `value-${i}`).join(" "),
    );
    // One undo step takes the whole refresh back.
    const m = { ...pre, undoSteps: await undoSteps(h, mark) };
    expect((await ourFields(h)).every((f) => f.value === "x")).toBe(true);
    report("W2.refresh-100-fields", m, { ms, ...bytes, detail: {} }, snap, engine);
    expectBudget("W2", m, W2);
  });

  // ── W3: preview-step 20 records ───────────────────────────────────────────
  // AS FOUND: every step re-reads ALL placeholders (the offset is valid only
  // until the next edit) and writes one setFieldValue — one undo step per step.
  // Wave 2: the field read is re-used while the document-change count shows
  // the preview's own write as the only change (one copy per story, so the
  // write moved no address): one read for the 20 steps. hostCalls 40 → 21,
  // reads and fields read 20 → 1. One write per step stays — each step is
  // its own preview state, one undo step each.
  const W3: Measured = {
    hostCalls: 21,
    hostReads: 1,
    mutates: 20,
    mutationOps: 20,
    undoSteps: 20,
    placeholdersRead: 1,
    wasmCalls: 20,
    cellsIn: 0,
    resolves: 20,
    // RAISED 0 → 1, the one budget that went up (oracle defect DP-4): record N
    // was record N of DuckDB's DELIVERY order, so the same rows delivered in
    // another order previewed a different record. Record N is now record N of
    // the stabilized order — one sort per result content, cached, shared by
    // all 20 steps (and by every table / flow over the same result).
    stabilizeCalls: 1,
    keyAllocs: 0,
    fingerprints: 0,
    duckQueries: 0,
  };
  it("W3 steps the preview through 20 records [data.perf.gates]", async () => {
    h = await openDataHost();
    const { host, work } = countingHost(h.host);
    const engine = await bootCountedEngine();
    const d = await sharedDuck();
    const s = await sessionOver(host, engine, d);
    await s.registerCsvSource("products_w3", productCsv(20));
    s.addQuery("q1", "SELECT sku, name FROM products_w3", "recordStream");
    s.addVariableBinding("v_name", "anchor", "q1", "UPPER(name)");
    await s.refreshData();
    await s.previewRecord("v_name", 0); // places the field once

    const mark = await undoMark(h);
    resetAll(work, engine, d);
    const t0 = performance.now();
    for (let r = 1; r <= 20; r++) await s.previewRecord("v_name", r % 20);
    await settle();
    const ms = performance.now() - t0;
    const snap = work.snapshot();
    const pre = measure(snap, engine, d, null);
    const bytes = { bytesIn: engine.log.bytesIn, bytesOut: engine.log.bytesOut };
    // Behaviour: one field, now at record 0 again (step 20 wraps to 0).
    const fields = await ourFields(h);
    expect(fields.length).toBe(1);
    expect(fields[0]!.value).toBe("ITEM 0");
    const m = { ...pre, undoSteps: await undoSteps(h, mark) };
    report("W3.preview-20-records", m, { ms, ...bytes, detail: {} }, snap, engine);
    expectBudget("W3", m, W3);
  });

  // ── W4: one QR barcode lower ──────────────────────────────────────────────
  // AS FOUND: the frame box is read once, the symbol is ONE batch of
  // insertPath modules (one undo step) — the batching is already right; the
  // cost is the module count (one path per dark module). 673 since the DB-2
  // fix (format information, dark module): the symbol, not the work, changed.
  // Wave 4 (persistence): +1 parts.write, +1 log; +1 payload +1 sync_report to build the session part.
  // Wave 5 (update in place): +1 read — document.tree, to find the previous
  // symbol's modules by their label and remove them in the same batch.
  const W4: Measured = {
    hostCalls: 9,
    hostReads: 5,
    mutates: 1,
    mutationOps: 673,
    undoSteps: 1,
    placeholdersRead: 0,
    wasmCalls: 3,
    cellsIn: 0,
    resolves: 1,
    stabilizeCalls: 0,
    keyAllocs: 0,
    fingerprints: 0,
    duckQueries: 0,
  };
  it("W4 lowers one QR barcode into its frame [data.perf.gates]", async () => {
    h = await openDataHost();
    const { host, work } = countingHost(h.host);
    const engine = await bootCountedEngine();
    const d = await sharedDuck();
    const s = await sessionOver(host, engine, d);
    await s.registerCsvSource("products_w4", productCsv(3));
    s.addQuery("q1", "SELECT sku FROM products_w4", "recordStream");
    const rect = await h.host.document.mutate({ op: "insertFrame", args: { pageId: "usp" as never, bounds: [100, 100, 244, 244] } });
    if (!rect.applied) throw new Error("insertFrame refused");
    const rectId = (rect.createdId as { id: string }).id;
    s.addBarcodeBinding("bc", rectId, "q1", "qr", "sku");
    await s.refreshData();

    const mark = await undoMark(h);
    resetAll(work, engine, d);
    const t0 = performance.now();
    await s.lowerBinding("bc");
    await settle();
    const ms = performance.now() - t0;
    const snap = work.snapshot();
    const pre = measure(snap, engine, d, null);
    const bytes = { bytesIn: engine.log.bytesIn, bytesOut: engine.log.bytesOut };
    // Behaviour: one batch of vector modules, applied.
    expect(snap.mutations.length).toBe(1);
    expect(snap.mutations[0]!.op).toBe("batch");
    expect(snap.mutations[0]!.ops).toBeGreaterThan(100);
    expect(s.getState().status).toBe("ready");
    const m = { ...pre, undoSteps: await undoSteps(h, mark) };
    report("W4.barcode-qr", m, { ms, ...bytes, detail: { modules: snap.mutations[0]!.ops } }, snap, engine);
    expectBudget("W4", m, W4);
  });

  // ── W5: lowerAll with 20 bindings ─────────────────────────────────────────
  // AS FOUND: refreshData re-runs the query and re-ingests; then each of the
  // 20 variables places its field in a FRESH frame: meta + pages + insertText-
  // Frame + elementGeometry + meta + hitTest + insertField — two undo steps
  // and five reads per variable (D-16: the minted story is not addressable).
  // Wave 2: the active page is read once per command (meta + collection),
  // and each variable's frame + field are ONE batch whose `storyId` is
  // `$h:frame` (C-15) — no elementGeometry, no hitTest (D-16). Per variable:
  // 2 supports, selection.get, one mutate, one log. hostCalls 240 → 102,
  // reads 120 → 2, mutates 40 → 20, undo steps 40 → 20.
  // Column door (Wave 2): begin + per-column push + finish replace one `{t, v}` ingest of 150 cells.
  // Wave 7 (row diff): +1 wasmCalls — mark_rows_applied, the row diff's "before" snapshot, once per command that writes the document from data.
  // Wave 6 (query guard): +1 DuckDB statement — `json_serialize_sql` once for the
  // one query on its first refresh (query/sql.ts guardQuery).
  // Guard fix (browser): -1 — the guard asks DuckDB nothing now (a TypeScript
  // lexer; the config lock is boot cost). duckQueries 2 → 1.
  // Wave 9: the command plans every variable first and places them in ONE
  // batch (each fresh frame named by `bindCreated`, its field addressing the
  // frame's story as `$h:v<i>`): 2 reads, one supports, one caret probe,
  // selection.get, one mutate, one log. hostCalls 102 → 7, mutates 20 → 1,
  // undo steps 20 → 1.
  const W5: Measured = {
    hostCalls: 7,
    hostReads: 2,
    mutates: 1,
    mutationOps: 40,
    undoSteps: 1,
    placeholdersRead: 0,
    wasmCalls: 26,
    cellsIn: 0,
    resolves: 20,
    stabilizeCalls: 0,
    keyAllocs: 0,
    fingerprints: 0,
    duckQueries: 1,
  };
  it("W5 lowers 20 variable bindings at once [data.perf.gates]", async () => {
    h = await openDataHost();
    const { host, work } = countingHost(h.host);
    const engine = await bootCountedEngine();
    const d = await sharedDuck();
    const s = await sessionOver(host, engine, d);
    await s.registerCsvSource("products_w5", productCsv(50));
    s.addQuery("q1", "SELECT sku, name, price FROM products_w5", "recordStream");
    for (let i = 0; i < 20; i++) s.addVariableBinding(`v${i}`, "anchor", "q1", `CONCAT(sku, " #${i}")`);

    const mark = await undoMark(h);
    resetAll(work, engine, d);
    const t0 = performance.now();
    await s.lowerAll();
    await settle();
    const ms = performance.now() - t0;
    const snap = work.snapshot();
    const pre = measure(snap, engine, d, null);
    const bytes = { bytesIn: engine.log.bytesIn, bytesOut: engine.log.bytesOut };
    // Behaviour: twenty fields, each with its own binding's value.
    const fields = await ourFields(h);
    expect(fields.map((f) => f.key).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `v${i}`).sort());
    expect(fields.every((f) => (f.value ?? "").endsWith(` #${f.key.slice(1)}`))).toBe(true);
    const m = { ...pre, undoSteps: await undoSteps(h, mark) };
    report("W5.lowerAll-20-bindings", m, { ms, ...bytes, detail: {} }, snap, engine);
    expectBudget("W5", m, W5);
  });

  // ── PROBE (not a budget): can the wire carry a refresh as ONE batch? ──────
  // The candidate "refreshFields becomes one batched mutate" needs core
  // to apply several setFieldValue ops, written back to front, in one batch.
  it("PROBE: core applies a back-to-front batch of setFieldValue as ONE undo step [data.perf.gates]", async () => {
    h = await openDataHost();
    const story = await newStory(h, [100, 100, 200, 300]);
    for (let i = 0; i < 3; i++) {
      await h.host.document.mutate({
        op: "insertField",
        args: { storyId: story, offset: i, field: { placeholder: { plugin: PLUGIN, key: `k${i}`, value: "x" } } },
      } as never);
    }
    const before = await ourFields(h);
    const mark = await undoMark(h);
    const out = await h.host.document.mutate({
      op: "batch",
      args: {
        ops: [...before].reverse().map((f) => ({
          op: "setFieldValue",
          args: { storyId: f.storyId, offset: f.offset, value: `${f.key.toUpperCase()}-long` },
        })),
      },
    } as never);
    expect(out.applied).toBe(true);
    expect((await ourFields(h)).map((f) => f.value)).toEqual(["K0-long", "K1-long", "K2-long"]);
    expect(await undoSteps(h, mark)).toBe(1);
  });
});
