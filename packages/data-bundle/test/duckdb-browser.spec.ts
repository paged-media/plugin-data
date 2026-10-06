// The query lane in a REAL browser: the shipped eh worker + engine, booted by
// the bundle's own bootDuckDB in headless Chromium, served with the editor's
// headers (cross-origin isolated, CSP connect-src 'self'). See
// test/browser-lane.ts for why this lane exists: the Wave 6 guard passed
// every Node spec and trapped on every refresh in the editor.
//
// Opt-in like the other real lanes: skips without playwright-core or a
// Chromium; REQUIRE_REAL_BROWSER=1 makes that a failure.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REQUIRE_REAL_DUCKDB } from "./real-duckdb";
import { REQUIRE_REAL_BROWSER, startBrowserLane, type BrowserLane } from "./browser-lane";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED, FIXTURE_CSV, REFUSED } from "./guard-matrix";

const SOURCES = join(__dirname, "..", "..", "..", "conformance", "sources");
const PARQUET = readFileSync(join(SOURCES, "products.parquet"));
const XLSX = readFileSync(join(SOURCES, "products.xlsx"));

let lane: BrowserLane | undefined;
let why = "";
beforeAll(async () => {
  const r = await startBrowserLane();
  lane = r.lane;
  why = r.error ?? "";
}, 60_000);
afterAll(async () => {
  await lane?.close();
});

const REQUIRED = REQUIRE_REAL_BROWSER || REQUIRE_REAL_DUCKDB;

/** Boot DuckDB in the page, import the fixture tables, run `body` there. */
async function inPage<T>(body: string, arg?: unknown): Promise<T> {
  if (!lane) throw new Error(`the browser lane did not start: ${why}`);
  return lane.page.evaluate(
    async ({ body, arg, csv }: { body: string; arg: unknown; csv: Record<string, string> }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const L = (window as any).lane;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      if (!w.duck) {
        w.duck = await L.bootDuckDB();
        for (const [name, text] of Object.entries(csv)) {
          await L.loadIntoDuckDB(w.duck, name, "csv", new TextEncoder().encode(text), () => {
            throw new Error("no xlsx here");
          });
        }
      }
      // eslint-disable-next-line no-new-func
      return new Function("L", "d", "arg", `return (async () => { ${body} })();`)(L, w.duck, arg);
    },
    { body, arg, csv: FIXTURE_CSV },
  );
}

describe.skipIf(!REQUIRED && process.env.PAGED_BROWSER_LANE === "0")(
  "the query lane in the shipped browser worker [data.security.gates]",
  () => {
    it("the lane starts (fails under REQUIRE_REAL_BROWSER / REQUIRE_REAL_DUCKDB when it cannot)", (ctx) => {
      if (!lane && !REQUIRED) ctx.skip();
      expect(lane, why).toBeDefined();
    });

    it("the guard admits a SELECT over a source table, and it runs [data.query.seam]", async (ctx) => {
      if (!lane && !REQUIRED) ctx.skip();
      const out = await inPage<{ verdict: unknown; rows: unknown }>(
        `const verdict = await L.guard(d, "SELECT name FROM people ORDER BY name");
         const rows = (await d.rows("SELECT name FROM people ORDER BY name")).rows;
         return { verdict, rows };`,
      );
      expect(out.verdict).toBeNull();
      expect(out.rows).toEqual([["Ada"], ["Grace"]]);
      expect(lane!.errors.filter((e) => /out of bounds|signature mismatch|RuntimeError/.test(e))).toEqual([]);
      // The guard reaches nothing outside the page's origin (it used to
      // autoload DuckDB's json extension from extensions.duckdb.org).
      expect(lane!.offOrigin).toEqual([]);
    });

    it("refuses every reach outside the source tables [data.security.gates]", async (ctx) => {
      if (!lane && !REQUIRED) ctx.skip();
      const verdicts = await inPage<(null | { kind: string; message: string })[]>(
        `const out = [];
         for (const sql of arg) out.push(await L.guard(d, sql));
         return out;`,
        REFUSED.map(([sql]) => sql),
      );
      REFUSED.forEach(([sql, msg], i) => {
        expect(verdicts[i]?.kind, sql).toBe("Guard");
        expect(verdicts[i]?.message, sql).toMatch(msg);
      });
      expect(lane!.offOrigin).toEqual([]);
    });

    it("admits ordinary queries — joins, CTEs, aggregates — and DuckDB runs them [data.query.seam]", async (ctx) => {
      if (!lane && !REQUIRED) ctx.skip();
      const out = await inPage<{ verdict: unknown; rows: unknown; error?: string }[]>(
        `const out = [];
         for (const sql of arg) {
           const verdict = await L.guard(d, sql);
           try { out.push({ verdict, rows: (await d.rows(sql)).rows }); }
           catch (e) { out.push({ verdict, rows: null, error: String(e && e.message || e) }); }
         }
         return out;`,
        ALLOWED.map(([sql]) => sql),
      );
      ALLOWED.forEach(([sql, rows], i) => {
        expect(out[i].verdict, sql).toBeNull();
        expect(out[i].error, sql).toBeUndefined();
        expect(out[i].rows, sql).toEqual(rows);
      });
    });

    it("the engine lock: no statement changes a setting, and imports still work after it [data.security.gates]", async (ctx) => {
      if (!lane && !REQUIRED) ctx.skip();
      const out = await inPage<{ set: string[]; late: unknown }>(
        `const set = [];
         for (const sql of ["SET enable_external_access = true", "SET lock_configuration = false",
                            "RESET lock_configuration", "PRAGMA enable_external_access = true",
                            "SET autoinstall_known_extensions = true"]) {
           try { await d.exec(sql); set.push("ran: " + sql); } catch (e) { set.push(String(e && e.message || e)); }
         }
         await L.loadIntoDuckDB(d, "late", "csv", new TextEncoder().encode("a,b\\n1,2\\n"), () => null);
         return { set, late: (await d.rows("SELECT * FROM late")).rows };`,
      );
      for (const m of out.set) expect(m).toMatch(/configuration has been locked/);
      expect(out.late).toEqual([["1", "2"]]);
    });

    // DuckDB-WASM 1.29.0's eh build has neither json nor parquet built in;
    // DuckDB loads them on first use. They used to come from
    // extensions.duckdb.org, which the editor's CSP refuses (the worker
    // trapped "unreachable"); bootDuckDB now points DuckDB at the bundle's own
    // bin/duckdb-ext, so they load same-origin.
    it("JSON imports — an array of objects and newline-delimited records — load json from bin/duckdb-ext [data.source.adapters]", async () => {
      const out = await inPage<{ arr?: unknown; nd?: unknown; error?: string }>(
        `try {
           const enc = new TextEncoder();
           await L.loadIntoDuckDB(d, "catalog", "json",
             enc.encode('[{"sku":"A-1","price":9.99,"tags":"x"},{"sku":"B-2","price":19.5,"tags":null}]'), () => null);
           await L.loadIntoDuckDB(d, "events", "json",
             enc.encode('{"id":1,"at":"2026-01-15"}\\n{"id":2,"at":"2026-02-01"}\\n'), () => null);
           return {
             arr: (await d.rows("SELECT sku, CAST(price AS VARCHAR), tags FROM catalog ORDER BY sku")).rows,
             nd: (await d.rows("SELECT id, CAST(at AS VARCHAR), typeof(at) FROM events ORDER BY id")).rows,
           };
         } catch (e) { return { error: String(e && e.message || e) }; }`,
      );
      expect(out.error).toBeUndefined();
      expect(out.arr).toEqual([
        ["A-1", "9.99", "x"],
        ["B-2", "19.5", null],
      ]);
      expect(out.nd).toEqual([
        ["1", "2026-01-15", "DATE"],
        ["2", "2026-02-01", "DATE"],
      ]);
      expect(lane!.served).toContain("/bin/duckdb-ext/v1.1.1/wasm_eh/json.duckdb_extension.wasm");
      expect(lane!.offOrigin).toEqual([]);
      expect(lane!.errors.filter((e) => /unreachable|RuntimeError|Content Security Policy/.test(e))).toEqual([]);
    });

    it("a Parquet import loads parquet from bin/duckdb-ext: DECIMAL keeps its scale, DATE stays a date [data.source.adapters]", async () => {
      const out = await inPage<{ types?: unknown; rows?: unknown; error?: string }>(
        `try {
           await L.loadIntoDuckDB(d, "products", "parquet", new Uint8Array(arg), () => null);
           return {
             types: (await d.rows("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'products' ORDER BY ordinal_position")).rows,
             rows: (await d.rows("SELECT sku, CAST(price AS VARCHAR), qty, CAST(launched AS VARCHAR) FROM products ORDER BY sku")).rows,
           };
         } catch (e) { return { error: String(e && e.message || e) }; }`,
        [...PARQUET],
      );
      expect(out.error).toBeUndefined();
      expect(out.types).toEqual([
        ["sku", "VARCHAR"],
        ["price", "DECIMAL(10,2)"],
        ["qty", "INTEGER"],
        ["launched", "DATE"],
      ]);
      expect(out.rows).toEqual([
        ["A-1", "9.99", "3", "2026-01-15"],
        ["B-2", "19.50", "10", "2026-02-01"],
        ["C-3", "7.00", null, null],
      ]);
      expect(lane!.served).toContain("/bin/duckdb-ext/v1.1.1/wasm_eh/parquet.duckdb_extension.wasm");
      expect(lane!.offOrigin).toEqual([]);
      expect(lane!.errors.filter((e) => /unreachable|RuntimeError|Content Security Policy/.test(e))).toEqual([]);
    });

    it("an XLSX import (the data engine reads the sheet, DuckDB's read_json the records) runs in the worker [data.source.adapters]", async () => {
      const out = await inPage<{ rows?: unknown; sheet?: unknown; error?: string }>(
        `try {
           const e = await L.bootEngine(Date.UTC(2026, 9, 6) / 86400000);
           const r = await L.loadIntoDuckDB(d, "xl", "xlsx", new Uint8Array(arg), (b, sh) => e.xlsx_import(b, sh));
           return {
             sheet: r.sheet,
             rows: (await d.rows("SELECT sku, CAST(price AS VARCHAR), qty, CAST(launched AS VARCHAR), active FROM xl ORDER BY sku")).rows,
           };
         } catch (e) { return { error: String(e && e.message || e) }; }`,
        [...XLSX],
      );
      expect(out.error).toBeUndefined();
      expect(out.sheet).toBe("Products");
      expect(out.rows).toEqual([
        ["A-1", "9.99", "3", "2026-01-15", "true"],
        ["B-2", "19.5", "10", "2026-02-01", "false"],
        ["C-3", "7.0", null, null, "true"],
        ["D-4", null, "5", "2026-04-01", null],
      ]);
      expect(lane!.offOrigin).toEqual([]);
    });

    it("the whole lane made no request outside its origin, and loaded extensions only from bin/duckdb-ext [data.security.gates]", () => {
      expect(lane!.offOrigin).toEqual([]);
      const ext = lane!.served.filter((p) => p.includes("duckdb_extension"));
      expect(ext.every((p) => p.startsWith("/bin/duckdb-ext/v1.1.1/wasm_eh/")), ext.join(", ")).toBe(true);
    });
  },
);
