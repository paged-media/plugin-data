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

// The 1M-row DuckDB lane — TRENDED, not gated (feature `data.perf.gates`).
//
// The records cited a "1M-row CSV → grouped RecordSet < 1.5 s" gate that did
// not exist. This lane makes the measurement exist; it asserts behaviour only
// and prints the wall clock for the record (docs/design/perf-baseline-
// 2026-10-05.md). It is opt-in (`PERF_DUCKDB_1M=1`) because it allocates a
// ~40 MB CSV and, in the full-materialise step, four million JS cells.
//
// Steps, each timed:
//  1. ingest — register the CSV text and load it into a DuckDB table through
//     the bundle's own handle (registerFileText + insertCSVFromPath);
//  2. grouped query — GROUP BY over the 1M rows, materialised as a RecordSet
//     (the path the cited gate describes);
//  3. full materialise — SELECT * of all 1M rows through recordset.ts (Arrow →
//     `{t, v}` per cell), then the engine's ingest_result (serde decode of
//     every cell) — the boundary price a refresh pays today for a 1M result.

import { describe, expect, it, vi } from "vitest";

import { bootCountedDuck, bootCountedEngine, HAVE_DUCK, HAVE_ENGINE } from "./harness";

const RUN = process.env.PERF_DUCKDB_1M === "1";
const ROWS = Number(process.env.PERF_DUCKDB_ROWS ?? 1_000_000);

vi.setConfig({ testTimeout: 600_000 });

function csv(n: number): string {
  const parts: string[] = ["sku,name,price,cat\n"];
  for (let i = 0; i < n; i++) {
    parts.push(`SKU-${(i * 7919) % n},item ${i},${(i % 10_000) * 0.25},cat-${i % 100}\n`);
  }
  return parts.join("");
}

describe.skipIf(!RUN || !HAVE_DUCK || !HAVE_ENGINE)("DuckDB 1M-row lane (trended) [data.perf.gates]", () => {
  it(`ingests ${ROWS} rows, groups them, and materialises them across the boundary [data.perf.gates]`, async () => {
    const duck = await bootCountedDuck();
    const text = csv(ROWS);
    const mb = (text.length / 1e6).toFixed(1);

    let t = performance.now();
    await duck.handle.registerCsv("big", text);
    const ingestMs = performance.now() - t;

    t = performance.now();
    const grouped = await duck.handle.query(
      "SELECT cat, count(*) AS n, sum(price) AS total FROM big GROUP BY cat ORDER BY cat",
    );
    const groupMs = performance.now() - t;
    expect(grouped.row_count).toBe(100);
    expect(grouped.columns[1]!.reduce((s, v) => s + Number((v as { v: number }).v), 0)).toBe(ROWS);

    t = performance.now();
    const all = await duck.handle.query("SELECT * FROM big");
    const materialiseMs = performance.now() - t;
    expect(all.row_count).toBe(ROWS);

    const engine = await bootCountedEngine();
    engine.engine.define_query({ id: "q", sql: "", params: [], shape: { shape: "recordStream" } });
    t = performance.now();
    engine.engine.ingest_result("q", all);
    const engineIngestMs = performance.now() - t;
    expect(engine.counters().ingest_cells).toBe(ROWS * 4);

    // eslint-disable-next-line no-console
    console.log(
      `PERF duckdb-${ROWS} ${JSON.stringify({
        csvMB: Number(mb),
        ingestMs: Math.round(ingestMs),
        groupedQueryMs: Math.round(groupMs),
        materialiseMs: Math.round(materialiseMs),
        engineIngestMs: Math.round(engineIngestMs),
        groupedTotalMs: Math.round(ingestMs + groupMs),
      })}`,
    );
    await duck.handle.close();
  });
});
