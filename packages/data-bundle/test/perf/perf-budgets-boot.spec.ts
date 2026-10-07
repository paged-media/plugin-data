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

// PERF BUDGETS — paged.data's BOOT and its REFLOW subscription. Feature
// `data.perf.gates`. The rules are in
// `perf-budgets-commands.spec.ts` and bind here too.

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { BundleHost } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import manifest from "../../manifest.json";
import { openRealHost } from "../real-core";
import { countingHost, type WorkLog } from "./counting-host";
import {
  BUDGET_TIMEOUT_MS,
  bootCountedDuck,
  bootCountedEngine,
  expectBudget,
  onLabelled,
  measure,
  openDataHost,
  printTable,
  productCsv,
  report,
  RUN_BUDGETS,
  sessionOver,
  type CountedDuck,
  type Measured,
} from "./harness";

vi.setConfig({ testTimeout: BUDGET_TIMEOUT_MS });

const settle = () => new Promise((r) => setTimeout(r, 0));

// Protocol 69 (LABELLED, harness.ts): the session version is named in the
// document label (doc-label.ts), so a write from data carries the label op
// (+1 mutation op, same undo step) and first writes the session change it
// is labelled with: the session part and its content-addressed version
// (parts.write ×2, or +1 where the command already flushed), and buildPersisted's
// payload + sync_report (+2 wasm) where nothing flushed before.
// W6: the debounced session write lands inside the 200-event window, and
// writes the version part too (+1). W7: the restore reads the document label
// first (getDocumentMetadata) and the session probes the engine once per
// document (supports + meta): +4 calls, +2 reads.
describe.skipIf(!RUN_BUDGETS)("perf budgets — boot and reflow [data.perf.gates]", () => {
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

  // ── W6: 200 reflow events on a record-flow chain ──────────────────────────
  // AS FOUND (Wave 1): every reflow event re-reads the chain (frameChain +
  // elementGeometry) and re-paginates the WHOLE flow — a resolve, a full
  // stabilize sort of every record — with no debounce or coalescing: 200
  // resize events cost 200 full re-paginations, even though only the last one
  // is ever shown.
  // Wave 4 (persistence): +1 parts.write +1 supports, +1 payload +1 sync_report — one session write for the whole burst.
  // Wave 2: the subscription coalesces the burst — one chain read and one
  // pagination once it is quiet. hostCalls 402 → 4, reads 400 → 2, wasm
  // calls 202 → 3, resolves / sorts 200 → 1, sort keys 665,600 → 3,328.
  const W6: Measured = onLabelled({
    hostCalls: 4,
    hostReads: 2,
    mutates: 0,
    mutationOps: 0,
    undoSteps: null,
    placeholdersRead: 0,
    wasmCalls: 3,
    cellsIn: 0,
    // Was 200 resolves and 200 sorts: every reflow event re-paginated. The
    // TS debounce coalesces the burst into one; the engine caches the
    // stabilized order per result content.
    resolves: 1,
    stabilizeCalls: 1,
    // Was 665 600: stabilize built two Vec<u8> keys per column per
    // comparison. Wave 2 (engine) compares values in place.
    keyAllocs: 0,
    fingerprints: 0,
    duckQueries: 0,
  }, { hostCalls: 5 });
  it("W6 re-paginates a record flow across 200 reflow events [data.perf.gates]", async () => {
    h = await openDataHost();
    const { host, work } = countingHost(h.host);
    const engine = await bootCountedEngine();
    duck ??= await bootCountedDuck();
    const s = await sessionOver(host, engine, duck);
    await s.registerCsvSource("products_w6", productCsv(200));
    s.addQuery("q1", "SELECT sku, name, price FROM products_w6", "recordStream");
    await s.refreshData();
    // Record flow has no session define method yet; define it on the
    // engine directly, the way the pipeline parts do.
    (engine.engine as unknown as { define_template(t: unknown): void }).define_template({
      id: "tmpl",
      fields: [{ label: "", expr: "name" }],
      lineHeightPt: 3, // 200 records × 3 pt fit the two frames
    });
    engine.engine.define_binding({
      id: "rf",
      kind: "recordFlow",
      chain: "chain",
      query: "q1",
      template: "tmpl",
      options: { groupBy: [], repeatHeader: false, continuedMarker: false },
    });
    // A two-frame chain.
    const a = await h.host.document.mutate({ op: "insertTextFrame", args: { pageId: "usp" as never, bounds: [50, 50, 400, 250] } });
    const b = await h.host.document.mutate({ op: "insertTextFrame", args: { pageId: "usp" as never, bounds: [50, 300, 400, 500] } });
    if (!a.applied || !b.applied) throw new Error("frames refused");
    const fa = (a.createdId as { id: string }).id;
    const fb = (b.createdId as { id: string }).id;
    expect((await h.host.document.mutate({ op: "linkFrames", args: { from: fa, to: fb } })).applied).toBe(true);
    const story = (await h.host.document.hitTest("usp" as never, [150, 200]))!.storyId as string;
    expect((await h.host.document.frameChain(story)).length).toBe(2);

    const flows: { placed: number; frames: unknown[] }[] = [];
    // The debounce runs on timers the test holds: the burst is fired, then
    // the clock is let go once.
    const held: (() => void)[] = [];
    const timers = {
      setTimeout: (fn: () => void) => held.push(fn),
      clearTimeout: (n: unknown) => {
        held[(n as number) - 1] = () => {};
      },
    };
    const sub = s.subscribeChainReflow("rf", story, (flow) => flows.push(flow as never), { timers });
    engine.reset();
    work.reset();
    duck.reset();
    const t0 = performance.now();
    for (let i = 1; i <= 200; i++) {
      // Grow frame A by one point per event (a drag-resize's stream).
      const out = await h.host.document.mutate({ op: "resizeFrame", args: { frameId: fa, bounds: [50, 50, 400 + i, 250] } });
      expect(out.applied).toBe(true);
      await settle();
    }
    await settle();
    expect(flows.length).toBe(0); // nothing while the burst runs
    for (const fn of held.splice(0)) fn();
    for (let i = 0; i < 20 && flows.length === 0; i++) await settle();
    const ms = performance.now() - t0;
    sub.dispose();
    const snap = work.snapshot();
    const m = measure(snap, engine, duck, null);
    // Behaviour: the burst re-paginated ONCE, over the settled chain, and that
    // flow places all 200.
    expect(flows.length).toBe(1);
    expect(flows[0]!.placed).toBe(200);
    report("W6.reflow-200-events", m, { ms, bytesIn: engine.log.bytesIn, bytesOut: engine.log.bytesOut, detail: { repaginations: flows.length } }, snap, engine);
    expectBudget("W6", m, W6);
  });

  // ── W7: cold boot ─────────────────────────────────────────────────────────
  // What activate costs the host, and that it boots NO wasm (both engines are
  // lazy: the first command pays). The engine and DuckDB boot times are the
  // first-command price, trended.
  // Wave 4 (persistence): restore on open: +1 parts.read, onDidChange (document switch), onWillSave (flush before save), editor.client.subscribe, +1 log.
  // Wave 6 (sources and query): +5 — contribute.panel (Data query),
  // supports("contribute.importer@1"), contribute.importer (JSON/Parquet),
  // contribute.command (editQuery), contribute.menu (Data ▸ Query…).
  // Wave 5 (Data Merge): +2 — contribute.command (mergeRecords),
  // contribute.menu (Data ▸ Merge records into the document).
  // Object model (ADR 323/558/559): +4 — supports("contribute.objectModel@1"),
  // contribute.objectModel, contribute.command (bindProperty), and ONE
  // document.tree read: a document without a session part may carry its
  // bindings in labels (an InDesign save drops parts). The document label the
  // open already read is reused, not read again.
  // SDK 0.2.44 / protocol 71 (ADR 559): +2 (measured on 0.70 and 0.71) —
  // the session asks once, as it starts, whether variables are text
  // variables (supports("objects@1") + objects.kinds()), so no command pays
  // for it. The pre-69 base moves by the same two calls (not runnable here).
  // ADR 323 §4 ("Data objects" schema panel): +2 — supports("contribute.
  // schemaPanel@1") and contribute.schemaPanel; its lists start with the
  // first READY session, so activation pays nothing else for them.
  const W7: Measured = onLabelled({
    hostCalls: 41,
    hostReads: 2,
    mutates: 0,
    mutationOps: 0,
    undoSteps: null,
    placeholdersRead: 0,
    wasmCalls: 0,
    cellsIn: 0,
    resolves: 0,
    stabilizeCalls: 0,
    keyAllocs: 0,
    fingerprints: 0,
    duckQueries: 0,
  }, { hostCalls: 45, hostReads: 4 });
  it("W7 activates without booting either engine [data.perf.gates]", async () => {
    h = await openRealHost();
    let work: WorkLog | null = null;
    const boots = { engine: 0, duck: 0 };
    vi.resetModules();
    vi.doMock("../../src/engine", async (orig) => ({
      ...(await orig<typeof import("../../src/engine")>()),
      bootEngine: async () => {
        boots.engine += 1;
        throw new Error("activate must not boot the engine");
      },
    }));
    vi.doMock("../../src/query/duckdb", async (orig) => ({
      ...(await orig<typeof import("../../src/query/duckdb")>()),
      bootDuckDB: async () => {
        boots.duck += 1;
        throw new Error("activate must not boot DuckDB");
      },
    }));
    const { activate } = await import("../../src/activate");
    const t0 = performance.now();
    const bundle = h.loadBundle({
      manifest: manifest as never,
      activate: (raw: BundleHost) => {
        const c = countingHost(raw);
        work = c.work;
        return activate(c.host);
      },
    } as never);
    const activateMs = performance.now() - t0;
    await settle();
    const snap = work!.snapshot();
    const m = measure(snap, null, null, null);
    // Behaviour: four React panels and the "Data objects" schema panel, the
    // commands and the importer registered, no engine booted.
    expect(h.panelsContributed().length).toBe(5);
    expect(h.schemaPanelsContributed().map((p) => p.id)).toEqual(["media.paged.data.panel.objects"]);
    expect(h.importersContributed().map((c) => c.id)).toEqual(["media.paged.data.importer.table"]);
    expect(h.contributions.filter((c) => c.kind === "command").length).toBeGreaterThanOrEqual(7);
    expect(boots).toEqual({ engine: 0, duck: 0 });

    // The first command's price: boot the data-js wasm and DuckDB (trended).
    let t1 = performance.now();
    await bootCountedEngine();
    const engineMs = performance.now() - t1;
    t1 = performance.now();
    const fresh = await bootCountedDuck();
    const duckMs = performance.now() - t1;
    await fresh.handle.close();
    report("W7.cold-boot", m, { ms: activateMs, bytesIn: 0, bytesOut: 0, detail: { engineBootMs: Math.round(engineMs), duckBootMs: Math.round(duckMs) } }, snap, null);
    bundle.dispose();
    expectBudget("W7", m, W7);
  });
});
