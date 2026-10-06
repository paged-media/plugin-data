// The query guard's security matrix in the Node lane, over real DuckDB (the
// shipped engine through DuckDB's Node runtime). The browser lane
// (test/duckdb-browser.spec.ts) proves the same matrix in the shipped
// worker; both lanes import the matrix from test/guard-matrix.ts.
import { beforeAll, describe, expect, it } from "vitest";
import type { DuckDBHandle } from "../src/query/duckdb";
import { loadIntoDuckDB } from "../src/query/import";
import { checkQuery } from "../src/query/sql";
import { ALLOWED, FIXTURE_CSV, REFUSED } from "./guard-matrix";
import { bootRealDuckDB, REQUIRE_REAL_DUCKDB } from "./real-duckdb";

const boot = await bootRealDuckDB();
const ready = boot.handle !== undefined;

describe.skipIf(!ready && !REQUIRE_REAL_DUCKDB)("the query guard over real DuckDB in Node [data.security.gates]", () => {
  let d: DuckDBHandle;
  beforeAll(async () => {
    expect(boot.handle, boot.error).toBeDefined();
    d = boot.handle!;
    for (const [name, text] of Object.entries(FIXTURE_CSV)) {
      await loadIntoDuckDB(d, name, "csv", new TextEncoder().encode(text), () => {
        throw new Error("no xlsx here");
      });
    }
  });

  it("refuses every reach outside the source tables", () => {
    for (const [sql, why] of REFUSED) {
      const v = checkQuery(sql);
      expect(v?.kind, sql).toBe("Guard");
      expect(v?.message, sql).toMatch(why);
    }
  });

  it("admits ordinary queries — joins, CTEs, aggregates — and DuckDB runs them", async () => {
    for (const [sql, rows] of ALLOWED) {
      expect(checkQuery(sql), sql).toBeNull();
      expect((await d.rows(sql)).rows, sql).toEqual(rows);
    }
  });

  it("the engine lock: no statement changes a setting, and imports still work after it", async () => {
    for (const sql of [
      "SET enable_external_access = true",
      "SET lock_configuration = false",
      "RESET lock_configuration",
      "PRAGMA enable_external_access = true",
      "SET autoinstall_known_extensions = true",
    ]) {
      await expect(d.exec(sql), sql).rejects.toThrow(/configuration has been locked/);
    }
    await loadIntoDuckDB(d, "late", "csv", new TextEncoder().encode("a,b\n1,2\n"), () => {
      throw new Error("no xlsx here");
    });
    expect((await d.rows("SELECT * FROM late")).rows).toEqual([["1", "2"]]);
  });
});
