// Wave 6 — local import and the query lane against REAL DuckDB (the shipped
// bin/duckdb-engine.wasm through the Node blocking build) and the REAL data-js
// wasm (its XLSX reader). A session is built with both boots pointed at the
// Node builds; nothing else is faked. The host is a minimal stub: these
// specs never write the document.
//
// Gate: skips when DuckDB or the data-js wasm is missing, EXCEPT under
// REQUIRE_REAL_DUCKDB=1, where a missing piece is a failure.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { DataSourceSession } from "../src/session";
import { bootRealDuckDB, bootRealEngine, DATA_JS_WASM, REQUIRE_REAL_DUCKDB } from "./real-duckdb";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "..", "..", "conformance", "sources");
const XLSX = readFileSync(join(FIXTURES, "products.xlsx"));
const PARQUET = readFileSync(join(FIXTURES, "products.parquet"));

const probe = await bootRealDuckDB();
const ready = probe.handle !== undefined && existsSync(DATA_JS_WASM);

async function loadSessionModule() {
  vi.resetModules();
  vi.doMock("../src/engine", async (orig) => ({
    ...(await orig<typeof import("../src/engine")>()),
    bootEngine: (today: number) => bootRealEngine(today),
  }));
  vi.doMock("../src/query/duckdb", async (orig) => ({
    ...(await orig<typeof import("../src/query/duckdb")>()),
    bootDuckDB: async () => {
      const b = await bootRealDuckDB();
      if (!b.handle) throw new Error(b.error);
      return b.handle;
    },
  }));
  return import("../src/session");
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const stubHost = {
  log: silent,
  supports: () => false,
  parts: { write: async () => {}, read: async () => null, list: async () => [] },
  network: { consentedOrigins: () => [], requestConsent: async () => ({ granted: [], denied: [], remembered: false }) },
  document: {},
} as never;

describe.skipIf(!ready && !REQUIRE_REAL_DUCKDB)(
  "local import into real DuckDB [data.source.adapters]",
  () => {
    let mod: Awaited<ReturnType<typeof loadSessionModule>>;
    let s: DataSourceSession;
    beforeAll(async () => {
      expect(ready, `real DuckDB and the data-js wasm must be available: ${probe.error ?? ""}`).toBe(true);
      mod = await loadSessionModule();
    });
    const fresh = () => (s = mod.createSession(stubHost, 0));

    it("JSON — an array of objects and newline-delimited records become tables [data.source.adapters]", async () => {
      fresh();
      const arr = new TextEncoder().encode(
        JSON.stringify([
          { sku: "A-1", price: 9.99, tags: ["x"] },
          { sku: "B-2", price: 19.5, tags: [] },
        ]),
      );
      expect(await s.importFile("catalog.json", arr)).toEqual({ source: "catalog", format: "json" });
      const nd = new TextEncoder().encode('{"id":1,"name":"a"}\n{"id":2,"name":"b"}\n');
      expect(await s.importFile("events.ndjson", nd)).toMatchObject({ source: "events", format: "json" });

      expect(await s.describeSource("catalog")).toEqual([
        { name: "sku", type: "VARCHAR" },
        { name: "price", type: "DOUBLE" },
        { name: "tags", type: "VARCHAR[]" },
      ]);
      const p = await s.previewQuery("SELECT sku, price FROM catalog ORDER BY sku");
      expect(p.diagnostic).toBeNull();
      expect(p.rows).toEqual([
        ["A-1", "9.99"],
        ["B-2", "19.5"],
      ]);
      const e = await s.previewQuery("SELECT count(*) AS n FROM events");
      expect(e.rows).toEqual([["2"]]);
      expect(s.getState().sources).toEqual(["catalog", "events"]);
      expect(s.getState().files.map((f) => [f.source, f.format, f.fileName])).toEqual([
        ["catalog", "json", "catalog.json"],
        ["events", "json", "events.ndjson"],
      ]);
    });

    it("Parquet — types come from the file: DECIMAL keeps its scale, DATE stays a date [data.source.adapters]", async () => {
      fresh();
      expect(await s.importFile("products.parquet", PARQUET)).toEqual({
        source: "products",
        format: "parquet",
      });
      expect(await s.describeSource("products")).toEqual([
        { name: "sku", type: "VARCHAR" },
        { name: "price", type: "DECIMAL(10,2)" },
        { name: "qty", type: "INTEGER" },
        { name: "launched", type: "DATE" },
      ]);
      const p = await s.previewQuery("SELECT * FROM products ORDER BY sku");
      expect(p.rows).toEqual([
        ["A-1", "9.99", "3", "2026-01-15"],
        ["B-2", "19.50", "10", "2026-02-01"],
        ["C-3", "7.00", null, null],
      ]);
      expect(p.total).toBe(3);
    });

    it("XLSX — the first sheet by default, typed per column; another sheet on request [data.source.adapters]", async () => {
      fresh();
      const r = await s.importFile("products.xlsx", XLSX);
      expect(r).toEqual({
        source: "products",
        format: "xlsx",
        sheet: "Products",
        sheets: ["Products", "Prices"],
      });
      expect((await s.describeSource("products")).map((c) => `${c.name}:${c.type}`)).toEqual([
        "sku:VARCHAR",
        "price:DOUBLE",
        "qty:BIGINT",
        "launched:DATE",
        "updated:TIMESTAMP",
        "active:BOOLEAN",
        "note:VARCHAR",
        "column_8:VARCHAR",
        "sku_2:VARCHAR",
      ]);
      const p = await s.previewQuery(
        "SELECT sku, price, qty, launched, updated, active FROM products ORDER BY sku",
      );
      expect(p.rows).toEqual([
        ["A-1", "9.99", "3", "2026-01-15", "2026-01-15 09:30:00", "true"],
        ["B-2", "19.5", "10", "2026-02-01", "2026-02-01 00:00:00", "false"],
        ["C-3", "7.0", null, null, "2026-03-01 18:45:15", "true"],
        ["D-4", null, "5", "2026-04-01", null, null],
      ]);
      // The #DIV/0! cell is NULL and said so.
      expect(s.getState().diagnostics.map((d) => d.message)).toContain(
        "1 error cell(s) in products.xlsx were read as empty",
      );

      expect(await s.selectSheet("products", "Prices")).toMatchObject({ sheet: "Prices" });
      expect((await s.previewQuery("SELECT * FROM products ORDER BY region")).rows).toEqual([
        ["de", "1.19"],
        ["en", "1.0"],
      ]);
      expect(s.getState().files[0]).toMatchObject({ source: "products", sheet: "Prices" });
    });

    it("an unknown extension and a corrupt workbook are visible errors [data.source.adapters]", async () => {
      fresh();
      const odd = await s.importFile("notes.txt", new Uint8Array([1]));
      expect(odd.error).toMatch(/not a file the data plugin imports/);
      const bad = await s.importFile("broken.xlsx", new TextEncoder().encode("not a zip"));
      expect(bad.error).toMatch(/not a readable \.xlsx workbook/);
      const errors = s.getState().diagnostics.filter((d) => d.source === "import" && d.level === "error");
      expect(errors).toHaveLength(2);
      expect(s.getState().sources).toEqual([]);
    });
  },
);

describe.skipIf(!ready && !REQUIRE_REAL_DUCKDB)("the query lane over real DuckDB [data.query.seam]", () => {
  let s: DataSourceSession;
  beforeAll(async () => {
    expect(ready).toBe(true);
    const mod = await loadSessionModule();
    s = mod.createSession(stubHost, 0);
    await s.importFile("products.parquet", PARQUET);
  });

  it("the guard refuses file and URL reads, other statements and several statements [data.security.gates]", async () => {
    const cases: [string, RegExp][] = [
      ["SELECT * FROM read_csv('https://example.com/x.csv')", /read_csv\(\) reads files or URLs/],
      ["SELECT * FROM 'https://example.com/x.parquet'", /not an imported source table/],
      ["SELECT (SELECT count(*) FROM read_text('/etc/hosts'))", /read_text\(\) reads files/],
      ["DROP TABLE products", /only a SELECT query/],
      ["SELECT 1; SELECT 2", /exactly one SELECT/],
      ["ATTACH 'x.db' AS x", /only a SELECT query/],
    ];
    for (const [sql, why] of cases) {
      const p = await s.previewQuery(sql);
      expect(p.diagnostic?.kind, sql).toBe("Guard");
      expect(p.diagnostic?.message, sql).toMatch(why);
      expect(await s.saveQuery("bad", sql), sql).toMatchObject({ kind: "Guard" });
    }
    expect(s.listQueries()).toEqual([]);
    // range() reads nothing and is allowed.
    expect((await s.previewQuery("SELECT * FROM range(3)")).rows).toEqual([["0"], ["1"], ["2"]]);
  });

  it("DuckDB errors come back with their class and position in the query as written [data.query.seam]", async () => {
    const parse = await s.previewQuery("SELECT sku\nFORM products");
    expect(parse.diagnostic).toMatchObject({ kind: "Parser", line: 2 });
    const bind = await s.previewQuery("SELECT sku,\n  nope FROM products");
    expect(bind.diagnostic).toMatchObject({ kind: "Binder", line: 2, column: 3 });
    expect(bind.diagnostic!.message).toMatch(/"nope" not found/);
    const cat = await s.previewQuery("SELECT * FROM missing");
    expect(cat.diagnostic).toMatchObject({ kind: "Catalog", line: 1, column: 15 });
  });

  it("a saved query is defined on the engine and a refresh ingests it [data.query.seam]", async () => {
    expect(await s.saveQuery("cheap", "SELECT sku, price FROM products WHERE price < 10;")).toBeNull();
    expect(s.listQueries()).toEqual([
      { id: "cheap", sql: "SELECT sku, price FROM products WHERE price < 10" },
    ]);
    await s.refreshData();
    expect(await s.recordCount("cheap")).toBe(2);
    // A query that stops working is reported per query, not swallowed.
    s.addQuery("broken", "SELECT nope FROM products", "recordStream");
    await s.refreshData();
    const q = s.getState().diagnostics.filter((d) => d.source === "query");
    expect(q.at(-1)?.message).toMatch(/query "broken" failed — Binder:/);
    expect(await s.recordCount("cheap")).toBe(2);
  });

  it("builder SQL runs as built [data.query.seam]", async () => {
    const { buildSql } = await import("../src/query/builder");
    const filtered = buildSql({
      source: "products",
      columns: ["sku", "price"],
      filters: [
        { column: "price", op: ">=", value: "9.99" },
        { column: "sku", op: "contains", value: "b" },
      ],
      sort: [{ column: "price", dir: "desc" }],
    });
    expect((await s.previewQuery(filtered)).rows).toEqual([["B-2", "19.50"]]);
    const grouped = buildSql({
      source: "products",
      groupBy: ["launched"],
      aggregates: [{ fn: "count" }, { fn: "sum", column: "qty" }],
      filters: [{ column: "launched", op: "is not empty" }],
      sort: [{ column: "launched", dir: "asc" }],
    });
    const g = await s.previewQuery(grouped);
    expect(g.diagnostic).toBeNull();
    expect(g.columns.map((c) => c.name)).toEqual(["launched", "count", "sum_qty"]);
    expect(g.rows).toEqual([
      ["2026-01-15", "1", "3"],
      ["2026-02-01", "1", "10"],
    ]);
  });
});
