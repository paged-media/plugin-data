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

const PARQUET = readFileSync(join(__dirname, "..", "..", "..", "conformance", "sources", "products.parquet"));

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

    it.fails("DEFECT: a Parquet import autoloads DuckDB's parquet extension from extensions.duckdb.org, which the editor's CSP refuses [data.source.adapters]", async () => {
      const out = await inPage<{ rows?: unknown; error?: string }>(
        `try {
           await L.loadIntoDuckDB(d, "products", "parquet", new Uint8Array(arg), () => null);
           return { rows: (await d.rows("SELECT count(*) FROM products")).rows };
         } catch (e) { return { error: String(e && e.message || e) }; }`,
        [...PARQUET],
      );
      expect(out.error).toBeUndefined();
      expect(lane!.offOrigin).toEqual([]);
    });
  },
);
