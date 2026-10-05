// PERF BUDGETS — the typed column door (Wave 2, engine side). Same rules as
// perf-budgets-commands.spec.ts: counts are pinned as measured, lowered only
// in the commit that earns them, a behaviour assertion beside each.
//
// A 500-row DuckDB result crosses as typed buffers (one push per column) and
// the same result re-delivered is recognised before anything is decoded. The
// session's refresh path is switched to this door by the TS optimisation
// round; this spec pins what the door itself costs.

import { afterAll, describe, expect, it, vi } from "vitest";

import { ingestColumnBatch } from "../../src/engine";
import {
  BUDGET_TIMEOUT_MS,
  bootCountedDuck,
  bootCountedEngine,
  productCsv,
  RUN_BUDGETS,
  type CountedDuck,
} from "./harness";

vi.setConfig({ testTimeout: BUDGET_TIMEOUT_MS });

describe.skipIf(!RUN_BUDGETS)("perf budgets — the column door [data.perf.gates]", () => {
  let duck: CountedDuck | null = null;
  afterAll(async () => {
    await duck?.handle.close();
  });

  it("C1 ingests a 500-row result as 3 typed columns, then skips an unchanged re-delivery [data.perf.gates]", async () => {
    duck = await bootCountedDuck();
    await duck.handle.registerCsv("products_c1", productCsv(500));
    const sql = "SELECT sku, name, price FROM products_c1";
    const batch = await duck.handle.queryColumns(sql);
    const engine = await bootCountedEngine();
    engine.engine.define_query({ id: "q", sql, params: [], shape: { shape: "recordStream" } });

    engine.reset();
    const first = ingestColumnBatch(engine.engine, "q", batch);
    const c1 = engine.counters();
    const calls1 = { ...engine.log.calls };
    const bytes1 = engine.log.bytesIn;

    engine.reset();
    const again = ingestColumnBatch(engine.engine, "q", await duck.handle.queryColumns(sql));
    const c2 = engine.counters();
    const calls2 = { ...engine.log.calls };

    // Behaviour: the door delivers the SAME data the {t, v} door would.
    const reference = await bootCountedEngine();
    reference.engine.define_query({ id: "q", sql, params: [], shape: { shape: "recordStream" } });
    reference.engine.ingest_result("q", await duck.handle.query(sql));
    expect(engine.engine.result_token!("q")).toBe(reference.engine.result_token!("q"));
    expect(first).toBe("changed");
    expect(again).toBe("unchanged");

    // First delivery: 5 wasm calls (begin + 3 pushes + finish), 1 500 cells
    // decoded in the engine, 0 per-cell JS objects.
    expect(calls1).toEqual({ begin_columns: 1, push_utf8: 2, push_f64: 1, finish_columns: 1 });
    expect(c1.ingest_cells).toBe(1500);
    expect(engine.log.cellsIn).toBe(0);
    // Re-delivery of unchanged data: the same 5 calls, NOTHING decoded or
    // ingested, the engine's content hash not even recomputed.
    expect(calls2).toEqual(calls1);
    expect(c2.ingest_cells).toBe(0);
    expect(c2.content_hashes).toBe(0);
    // Trend: typed bytes vs the {t, v} JSON of the same result.
    // eslint-disable-next-line no-console
    console.log(`PERF C1 column door: ${bytes1} B typed vs ${JSON.stringify(await duck.handle.query(sql)).length} B as {t, v} JSON`);
  });
});
