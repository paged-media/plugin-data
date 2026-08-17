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

// The REAL engine boot (audit P4): boots the actual data-js wasm-bindgen
// artifact in Node (initSync over bytes — the sheets S-10 bundle-realm
// pattern) and drives a real slice of the pipeline: define source/query/
// binding → ingest a CSV-shaped RecordSet → resolve → lower, with the DSL
// kernels (CURRENCY/UPPER/CONCAT/IF/DATEFMT/TODAY/LEN) evaluated by the
// Rust engine, not a mock. Every other bundle test runs against fake
// hosts/engines; before this spec the wasm booted on NOBODY's vitest.
//
// DUAL-GATED (the plugin-sheets engine-real pattern): when
// packages/data-bundle/bin/data_js_bg.wasm has not been built
// (scripts/build-wasm.sh), the suite SKIPS locally — the pure-TS vitest
// lane stays green without a Rust toolchain. In CI the vitest workflow
// BUILDS the artifact and sets REQUIRE_REAL_ENGINE=1, under which a
// missing artifact FAILS the suite instead of skipping it — the skip gate
// can never silently drop the real boot out of CI.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin");
const WASM = join(BIN, "data_js_bg.wasm");
const built = existsSync(WASM);

// Injected `today` serial (days since 1970-01-01): 2026-06-09 —
// deterministic; TODAY() reads it, never the wall clock.
const TODAY = 20613;

async function bootReal() {
  const glue = await import(/* @vite-ignore */ join(BIN, "data_js.js"));
  glue.initSync({ module: readFileSync(WASM) });
  return { glue, engine: new glue.DataEngine(TODAY) };
}

// The tiny product catalog both tests feed the engine — the same recipe
// shape the bundle's session builds (and pipeline.e2e.mjs Part A proves).
// skus are lower-case so UPPER() has real work to do.
function defineCatalog(engine: {
  define_source(s: unknown): void;
  define_query(q: unknown): void;
}) {
  engine.define_source({
    id: "products",
    kind: { kind: "inlineSeed", table: "products" },
    capability: "inline",
  });
  engine.define_query({
    id: "q1",
    sql: "SELECT sku, price FROM products ORDER BY sku",
    params: [],
    shape: { shape: "recordStream" },
  });
}

const RECORDS = {
  schema: {
    fields: [
      { name: "sku", ty: "text", nullable: true },
      { name: "price", ty: "float", nullable: true },
    ],
  },
  columns: [
    [
      { t: "text", v: "a-1" },
      { t: "text", v: "b-2" },
    ],
    [
      { t: "number", v: 9.99 },
      { t: "number", v: 19.99 },
    ],
  ],
  row_count: 2,
};

// The CI half of the dual gate: REQUIRE_REAL_ENGINE=1 turns "artifact
// missing" from a skip into a hard failure with a build pointer.
if (process.env.REQUIRE_REAL_ENGINE === "1" && !built) {
  describe("real data engine (wasm artifact) — REQUIRED", () => {
    it("FAILS: REQUIRE_REAL_ENGINE=1 but the wasm artifact is missing", () => {
      throw new Error(
        `REQUIRE_REAL_ENGINE=1 but ${WASM} is missing — ` +
          "build it with `bash scripts/build-wasm.sh` (CI must build the " +
          "artifact before running vitest; skipping is not allowed here)",
      );
    });
  });
}

describe.skipIf(!built)("real data engine (wasm artifact)", () => {
  it("boots, ingests a CSV-shaped RecordSet, and lowers a formatted table", async () => {
    const { engine } = await bootReal();
    defineCatalog(engine);
    engine.define_binding({
      id: "t1",
      kind: "table",
      region: "r1",
      query: "q1",
      columns: [
        { header: "SKU", expr: "UPPER(sku)", style: null },
        { header: "Price", expr: "CURRENCY(price)", style: null },
      ],
      options: { header_row: true, group_by: [] },
    });
    engine.ingest_result("q1", RECORDS);

    // The count crosses the boundary from the REAL ingest, not a mock.
    expect(engine.query_record_count("q1")).toBe(2);

    const lowered = engine.resolve_lowered("t1") as {
      kind: string;
      rows: Array<{ header: boolean }>;
      text: string;
    };
    // Header + 2 data rows; the cell text is the Rust kernels' output:
    // UPPER upcased the skus, CURRENCY formatted the floats (en locale).
    expect(lowered.kind).toBe("table");
    expect(lowered.rows.length).toBe(3);
    expect(lowered.rows[0].header).toBe(true);
    expect(lowered.text).toBe("SKU\tPrice\nA-1\t$9.99\nB-2\t$19.99");

    // The recipe registered for real: session metadata counts it.
    const meta = engine.metadata() as { sourceCount: number; bindingCount: number };
    expect(meta.sourceCount).toBe(1);
    expect(meta.bindingCount).toBe(1);
    engine.free();
  });

  it("evaluates DSL functions through the real engine (variable bindings)", async () => {
    const { engine } = await bootReal();
    defineCatalog(engine);
    engine.ingest_result("q1", RECORDS);

    // One variable binding per expression; each resolves over record 0
    // (sku "a-1", price 9.99). Expected texts are the Rust kernels' real
    // outputs — parse → eval → format entirely inside the wasm module.
    const cases: Array<[string, string]> = [
      ["CONCAT(UPPER(sku), \" @ \", CURRENCY(price))", "A-1 @ $9.99"],
      ["IF(price > 10, \"premium\", \"budget\")", "budget"],
      // TODAY() reads the injected serial (2026-06-09) — proves the
      // constructor's `today` threads through to the temporal kernels.
      ["DATEFMT(TODAY(), \"DD/MM/YYYY\")", "09/06/2026"],
      ["LEN(TRIM(sku))", "3"],
    ];
    cases.forEach(([expr], i) => {
      engine.define_binding({
        id: `v${i}`,
        kind: "variable",
        target: `ph${i}`,
        query: "q1",
        expr,
        missing: { missing: "blank" },
      });
    });
    for (const [i, [expr, expected]] of cases.entries()) {
      const v = engine.resolve_lowered(`v${i}`) as { kind: string; text: string };
      expect(v.kind).toBe("variable");
      expect(v.text, expr).toBe(expected);
    }
    engine.free();
  });

  it("is deterministic: a second boot over the same recipe lowers identically", async () => {
    const run = async () => {
      const { engine } = await bootReal();
      defineCatalog(engine);
      engine.define_binding({
        id: "t1",
        kind: "table",
        region: "r1",
        query: "q1",
        columns: [
          { header: "SKU", expr: "sku", style: null },
          { header: "Price", expr: "CURRENCY(price)", style: null },
        ],
        options: { header_row: true, group_by: [] },
      });
      engine.ingest_result("q1", RECORDS);
      const out = JSON.stringify(engine.resolve_lowered("t1"));
      engine.free();
      return out;
    };
    const [a, b] = [await run(), await run()];
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});
