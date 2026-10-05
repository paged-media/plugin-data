// Wave 6 query lane, pure parts: the builders' SQL, the guard's AST walk,
// DuckDB error text → diagnostics, file naming and quoting. The same SQL is
// run against real DuckDB in test/sources-real.spec.ts.

import { describe, expect, it } from "vitest";

import { buildSql, valueLiteral } from "../query/builder";
import {
  formatOfFile,
  quoteIdent,
  quoteLiteral,
  sourceNameOf,
  virtualFileName,
} from "../query/import";
import { diagnoseDuckDBError, findForbiddenReach, positionOf, previewSql, trimSql } from "../query/sql";

describe("file names and quoting [data.source.adapters]", () => {
  it("maps extensions to formats, case-insensitively", () => {
    expect(formatOfFile("A.CSV")).toBe("csv");
    expect(formatOfFile("x.tsv")).toBe("tsv");
    expect(formatOfFile("feed.jsonl")).toBe("json");
    expect(formatOfFile("feed.ndjson")).toBe("json");
    expect(formatOfFile("p.parquet")).toBe("parquet");
    expect(formatOfFile("Budget 2026.xlsx")).toBe("xlsx");
    expect(formatOfFile("old.xls")).toBeNull();
    expect(formatOfFile("noext")).toBeNull();
  });

  it("names a source after the file stem, as an identifier", () => {
    expect(sourceNameOf("Budget 2026.xlsx")).toBe("Budget_2026");
    expect(sourceNameOf("/tmp/dir/2026-sales.csv")).toBe("_2026_sales");
    expect(sourceNameOf(".parquet")).toBe("data");
  });

  it("quotes identifiers and literals so a name can never become SQL", () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(virtualFileName("s", "xlsx")).toBe("paged_src_s.xlsx.json");
  });
});

describe("query builders [data.query.seam]", () => {
  it("builds a filtered, sorted, limited SELECT", () => {
    expect(
      buildSql({
        source: "products",
        columns: ["sku", "price"],
        filters: [
          { column: "price", op: ">", value: "10" },
          { column: "sku", op: "starts with", value: "A'" },
          { column: "note", op: "is empty" },
          { column: "", op: "=", value: "ignored" },
        ],
        sort: [
          { column: "price", dir: "desc" },
          { column: "sku", dir: "asc" },
        ],
        limit: 5,
      }),
    ).toBe(
      [
        'SELECT "sku", "price"',
        'FROM "products"',
        `WHERE "price" > 10 AND starts_with(CAST("sku" AS VARCHAR), 'A''') AND ("note" IS NULL OR CAST("note" AS VARCHAR) = '')`,
        'ORDER BY "price" DESC, "sku" ASC',
        "LIMIT 5",
      ].join("\n"),
    );
  });

  it("groups with a row count by default, and named aggregates", () => {
    expect(buildSql({ source: "t", groupBy: ["region"] })).toBe(
      'SELECT "region", count(*) AS "count"\nFROM "t"\nGROUP BY "region"',
    );
    expect(
      buildSql({
        source: "t",
        groupBy: ["region", "year"],
        aggregates: [{ fn: "sum", column: "amount" }, { fn: "avg" }],
      }),
    ).toBe(
      'SELECT "region", "year", sum("amount") AS "sum_amount", count(*) AS "count"\nFROM "t"\nGROUP BY "region", "year"',
    );
  });

  it("compares a numeric-looking value as a number and anything else as text", () => {
    expect(valueLiteral("12.5")).toBe("12.5");
    expect(valueLiteral("-3")).toBe("-3");
    expect(valueLiteral("1e3")).toBe("1e3");
    expect(valueLiteral("12 items")).toBe("'12 items'");
    expect(valueLiteral("x'); DROP TABLE t; --")).toBe("'x''); DROP TABLE t; --'");
  });
});

describe("the query guard's AST walk [data.security.gates]", () => {
  const base = (name: string, extra: Record<string, string> = {}) => ({
    type: "BASE_TABLE",
    table_name: name,
    schema_name: "",
    catalog_name: "",
    ...extra,
  });
  const fn = (name: string) => ({ type: "TABLE_FUNCTION", function: { function_name: name } });

  it("admits plain tables and the pure table functions", () => {
    expect(findForbiddenReach([{ node: { from_table: base("products") } }])).toBeNull();
    expect(findForbiddenReach([{ node: { from_table: base("t", { schema_name: "main" }) } }])).toBeNull();
    expect(findForbiddenReach([{ from_table: fn("range") }, { x: fn("UNNEST") }])).toBeNull();
  });

  it("refuses file/URL readers, path-like tables and other catalogs, at any depth", () => {
    expect(findForbiddenReach({ a: { b: [fn("read_csv")] } })).toMatch(/read_csv\(\)/);
    expect(findForbiddenReach({ deep: [[{ from_table: fn("read_parquet") }]] })).toMatch(/read_parquet/);
    expect(findForbiddenReach(base("https://x/y.csv"))).toMatch(/not an imported source table/);
    expect(findForbiddenReach(base("data.csv"))).toMatch(/"data.csv"/);
    expect(findForbiddenReach(base("t", { catalog_name: "other" }))).toMatch(/"other.t"/);
    expect(findForbiddenReach(base("t", { schema_name: "information_schema" }))).toMatch(
      /information_schema\.t/,
    );
  });
});

describe("DuckDB error text → diagnostics [data.query.seam]", () => {
  it("reads the class, the message and the caret, shifted back by the wrapper", () => {
    const err = new Error(
      'Binder Error: Referenced column "zz" not found in FROM clause!\nCandidate bindings: "t.a"\nLINE 2: SELECT zz FROM t\n               ^',
    );
    expect(diagnoseDuckDBError(err, 1)).toEqual({
      kind: "Binder",
      message: 'Referenced column "zz" not found in FROM clause!\nCandidate bindings: "t.a"',
      line: 1,
      column: 8,
    });
  });

  it("keeps a message without a position as it is", () => {
    expect(diagnoseDuckDBError("Error: IO Error: No files found")).toEqual({
      kind: "IO",
      message: "No files found",
    });
    expect(diagnoseDuckDBError(new Error("boom"))).toEqual({ kind: "Error", message: "boom" });
  });

  it("puts the user's query on its own line in a preview", () => {
    expect(previewSql("SELECT 1;  \n", 10)).toBe("SELECT * FROM (\nSELECT 1\n) AS paged_preview LIMIT 10");
    expect(trimSql("  SELECT 1 ;;\n")).toBe("SELECT 1");
    expect(positionOf("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
  });
});
