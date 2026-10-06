// Wave 6 query lane, pure parts: the builders' SQL, the guard's lexer,
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
import { checkQuery, diagnoseDuckDBError, positionOf, previewSql, trimSql } from "../query/sql";
import { ALLOWED, REFUSED } from "../../test/guard-matrix";

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

describe("the query guard's lexer and allow-list [data.security.gates]", () => {
  it("refuses every reach in the shared security matrix", () => {
    for (const [sql, why] of REFUSED) {
      const v = checkQuery(sql);
      expect(v?.kind, sql).toBe("Guard");
      expect(v?.message, sql).toMatch(why);
    }
  });

  it("admits every ordinary query in the shared matrix", () => {
    for (const [sql] of ALLOWED) expect(checkQuery(sql), sql).toBeNull();
  });

  it("reads strings, quoted names and comments the way DuckDB does", () => {
    // Statement words inside strings, quoted names and comments are data.
    expect(checkQuery("SELECT 'DROP TABLE x; read_csv(1)' AS s FROM t")).toBeNull();
    expect(checkQuery('SELECT "update", "set" FROM t')).toBeNull();
    expect(checkQuery("SELECT 1 /* outer /* nested ; */ still comment ; */ FROM t")).toBeNull();
    // A bare statement word is refused, with a hint and a position.
    expect(checkQuery("SELECT update FROM t")).toMatchObject({
      kind: "Guard",
      message: expect.stringMatching(/UPDATE is not allowed.*"update"/),
      line: 1,
      column: 8,
    });
  });

  it("knows FROM inside function arguments and IS DISTINCT FROM is not a table", () => {
    expect(checkQuery("SELECT extract(year FROM d), substring(s FROM 2 FOR 3), trim(BOTH 'x' FROM s) FROM t")).toBeNull();
    expect(checkQuery("SELECT * FROM t WHERE a IS NOT DISTINCT FROM 'x'")).toBeNull();
    // …but a subquery inside such a call has a real FROM.
    expect(checkQuery("SELECT substring((FROM read_csv('x') SELECT 'a') FROM 1) FROM t")?.message).toMatch(
      /read_csv\(\)/,
    );
  });

  it("refuses unbalanced brackets, so the text cannot escape the preview wrapper", () => {
    const escape = "SELECT 1) AS a, read_csv('x') AS b, (SELECT 1";
    expect(checkQuery(escape)?.message).toMatch(/unbalanced brackets/);
    expect(checkQuery("SELECT (1")?.message).toMatch(/unbalanced brackets/);
    expect(checkQuery("SELECT [1, 2)")?.message).toMatch(/unbalanced brackets/);
  });

  it("allows list and struct literals and commas in a join condition", () => {
    expect(checkQuery("SELECT [1, 2], {'a': 1, 'b': 2} FROM t")).toBeNull();
    expect(checkQuery("SELECT * FROM a JOIN b ON (a.x, a.y) = (b.x, b.y), c")).toBeNull();
    expect(checkQuery("SELECT * FROM a JOIN b USING (x, y) ORDER BY 1, 2")).toBeNull();
    expect(checkQuery("SELECT * FROM a JOIN b ON a.x = b.x, read_csv('y')")?.message).toMatch(/read_csv/);
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
