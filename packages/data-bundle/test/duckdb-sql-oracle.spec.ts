// The DuckDB SQL oracle lane (docs/design/oracles.md). The native duckdb CLI
// recorded every case in conformance/duckdb-sql/cases.json into
// conformance/duckdb-sql/recorded/results.json (record.mjs, same engine
// version as the shipped duckdb-wasm). Here the same SQL runs through the
// SHIPPED path — bin/duckdb-engine.wasm → Arrow → src/query/recordset.ts →
// data-js ingest — and every cell is compared with the native answer.
//
// The expected RecordSet cell is derived from the native (type, VARCHAR text)
// by the data-core contract: Date = days since 1970-01-01, DateTime = ms since
// the epoch (UTC, sub-ms truncated), every number an f64, BLOB = bytes, and
// the types data-core has no kind for (TIME, INTERVAL, UUID, LIST, STRUCT)
// = text in DuckDB's own rendering.
//
// Known mismatches are pinned as it.fails("DEFECT …") so they fail loudly the
// day they are fixed. GATE: skips without DuckDB, fails under
// REQUIRE_REAL_DUCKDB=1.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FieldTypeJson, RecordSetJson, ValueJson } from "../src/query/recordset";
import { BIN, PKG, tryBootNodeDuckDB } from "./duckdb-node-boot";
import { bootEngine } from "./pipeline-parts.mjs";

const REQUIRE = process.env.REQUIRE_REAL_DUCKDB === "1";
const LANE = join(PKG, "..", "..", "conformance", "duckdb-sql");
const recorded = JSON.parse(readFileSync(join(LANE, "recorded", "results.json"), "utf8")) as {
  engine: { version: string; source_id: string };
  tables: Record<string, Array<{ name: string; type: string }>>;
  results: Array<{ id: string; sql: string; columns: Array<{ name: string; type: string }>; rows: Array<Array<string | null>> }>;
};

/** Where the shipped answer differs from native DuckDB today: each defect
 *  names the case columns it explains. Those columns are carved out of the
 *  case's own test (so any OTHER disagreement in the case still fails) and
 *  checked by an it.fails pin that goes red the day the defect is fixed. */
const DEFECTS: Array<{ id: string; what: string; cases: Record<string, string[]>; ingest?: string[] }> = [
  // DQ-1 … DQ-4 were fixed in Wave 2 (recordset.ts reads Arrow's raw
  // buffers by type id; duckdb.ts casts the kind-less types to VARCHAR). New
  // disagreements are pinned here the same way.
];

// ── the contract: native (type, text) → expected RecordSet cell ─────────────

const INT = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT)$/;

export function expectedType(duckType: string): FieldTypeJson {
  if (duckType === "BOOLEAN") return "bool";
  if (INT.test(duckType)) return "int";
  if (/^(DOUBLE|FLOAT|DECIMAL)/.test(duckType)) return "float";
  if (duckType === "DATE") return "date";
  if (/^TIMESTAMP/.test(duckType)) return "datetime";
  if (duckType === "BLOB") return "bytes";
  return "text";
}

function days(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

function millis(ts: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(ts);
  if (!m) throw new Error(`unparsed timestamp ${ts}`);
  const ms = Number((m[7] ?? "").padEnd(3, "0").slice(0, 3));
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + ms;
}

function num(text: string): number {
  if (text === "inf") return Infinity;
  if (text === "-inf") return -Infinity;
  if (text === "nan") return NaN;
  return Number(text);
}

export function expectedCell(duckType: string, text: string | null): ValueJson | { t: "bytes"; v: number[] } {
  if (text === null) return { t: "null" };
  switch (expectedType(duckType)) {
    case "bool":
      return { t: "bool", v: text === "true" };
    case "int":
    case "float":
      return { t: "number", v: num(text) };
    case "date":
      return { t: "date", v: days(text) };
    case "datetime":
      return { t: "datetime", v: millis(text) };
    case "bytes":
      return { t: "bytes", v: Array.from(new TextEncoder().encode(text)) };
    default:
      return { t: "text", v: text };
  }
}

function sameCell(a: unknown, b: unknown): boolean {
  const x = a as { t: string; v?: unknown };
  const y = b as { t: string; v?: unknown };
  if (x?.t !== y?.t) return false;
  if (typeof x.v === "number" && typeof y.v === "number") return Object.is(x.v, y.v);
  return JSON.stringify(x.v) === JSON.stringify(y.v);
}

/** Every disagreement between the shipped RecordSet and the native answer. */
export function compare(
  rs: RecordSetJson,
  rec: (typeof recorded.results)[number],
  only: (column: string) => boolean = () => true,
): string[] {
  const out: string[] = [];
  if (rs.row_count !== rec.rows.length) out.push(`row_count ${rs.row_count} ≠ native ${rec.rows.length}`);
  rec.columns.forEach((col, c) => {
    if (!only(col.name)) return;
    const field = rs.schema.fields[c];
    if (!field) return void out.push(`column ${col.name} missing`);
    if (field.name !== col.name) out.push(`column ${c} named ${field.name} ≠ ${col.name}`);
    const ty = expectedType(col.type);
    if (field.ty !== ty) out.push(`${col.name} (${col.type}) typed ${field.ty} ≠ ${ty}`);
    rec.rows.forEach((row, r) => {
      const want = expectedCell(col.type, row[c]);
      const got = rs.columns[c]?.[r];
      if (!sameCell(got, want))
        out.push(`${col.name}[${r}] (${col.type} "${row[c]}") = ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
    });
  });
  return out;
}

// ── boot ────────────────────────────────────────────────────────────────────

const boot = await tryBootNodeDuckDB();
const engineBuilt = existsSync(join(BIN, "data_js_bg.wasm"));
const duck = boot.duck;
if (duck) {
  for (const file of readdirSync(join(LANE, "csv")).filter((f) => f.endsWith(".csv")).sort())
    await duck.handle.registerCsv(basename(file, ".csv"), readFileSync(join(LANE, "csv", file), "utf8"));
}

if (REQUIRE) {
  describe("DuckDB SQL oracle — REQUIRED (REQUIRE_REAL_DUCKDB=1) [data.query.seam]", () => {
    it("DuckDB boots over the shipped engine", () => {
      expect(boot.error, boot.error).toBeUndefined();
    });
  });
}

describe.skipIf(!duck)("DuckDB SQL oracle: shipped duckdb-wasm vs native duckdb [data.query.seam]", () => {
  it("the shipped engine is the recorded native engine version", () => {
    const [v] = duck!.raw("SELECT version() AS v, (SELECT source_id FROM pragma_version()) AS s");
    expect({ version: v.v, source_id: v.s }).toEqual(recorded.engine);
  });

  for (const [name, columns] of Object.entries(recorded.tables)) {
    it(`registerCsv detects the native column types for ${name}.csv`, () => {
      const got = duck!.raw(`DESCRIBE "${name}"`).map((c) => ({ name: c.column_name, type: c.column_type }));
      expect(got).toEqual(columns);
    });
  }

  for (const rec of recorded.results) {
    const pinned = new Set(DEFECTS.flatMap((d) => d.cases[rec.id] ?? []));
    it(`${rec.id} matches native${pinned.size ? ` (except pinned ${[...pinned].join(", ")})` : ""}`, async () => {
      const rs = await duck!.handle.query(rec.sql);
      expect(compare(rs, rec, (c) => !pinned.has(c))).toEqual([]);
    });
  }

  for (const d of DEFECTS) {
    for (const [id, cols] of Object.entries(d.cases)) {
      it.fails(`DEFECT ${d.id}: ${d.what} [${id}: ${cols.join(", ")}]`, async () => {
        const rec = recorded.results.find((r) => r.id === id)!;
        const rs = await duck!.handle.query(rec.sql);
        expect(compare(rs, rec, (c) => cols.includes(c))).toEqual([]);
      });
    }
  }
});

describe.skipIf(!duck || !engineBuilt)("DuckDB SQL oracle: data-js ingests every result [data.query.seam]", () => {
  for (const rec of recorded.results) {
    const pin = DEFECTS.find((d) => d.ingest?.includes(rec.id));
    const title = `${rec.id}: ingest_result decodes, counts and maps the native types`;
    (pin ? it.fails : it)(pin ? `DEFECT ${pin.id}: ${title}` : title, async () => {
      const rs = await duck!.handle.query(rec.sql);
      const engine = await bootEngine();
      engine.define_source({ id: "s", kind: { kind: "inlineSeed", table: "s" }, capability: "inline" });
      engine.define_query({ id: "q", sql: rec.sql, params: [], shape: { shape: "recordStream" } });
      engine.ingest_result("q", rs);
      expect(engine.query_record_count("q")).toBe(rec.rows.length);
      const mappings = engine.query_mappings("q") as Array<{ column: string; fieldType: string }>;
      expect(mappings.map((m) => [m.column, m.fieldType])).toEqual(
        rs.schema.fields.map((f) => [f.name, f.ty]),
      );
    });
  }
});

describe.skipIf(!duck || !engineBuilt)("DECIMAL keeps its declared scale through the engine (DM-8) [data.query.seam]", () => {
  it("a bare DECIMAL(10,2) field displays 1234.50, a DOUBLE 1234.5 [data.query.seam]", async () => {
    const sql = "SELECT 1234.50::DECIMAL(10,2) AS dec, 1234.50::DOUBLE AS dbl";
    const rs = await duck!.handle.query(sql);
    expect(rs.schema.fields.map((f) => f.scale)).toEqual([2, undefined]);
    const engine = await bootEngine();
    engine.define_query({ id: "q", sql, params: [], shape: { shape: "recordStream" } });
    engine.ingest_result("q", rs);
    const text = (id: string, expr: string) => {
      engine.define_binding({ id, kind: "variable", target: id, query: "q", expr, missing: { missing: "blank" } });
      return (engine.resolve_lowered(id) as { text: string }).text;
    };
    expect(text("a", "dec")).toBe("1234.50");
    // DuckDB sniffs a CSV "1234.50" as DOUBLE: the scale is gone before the
    // engine sees it — still DM-8 in the InDesign lane.
    expect(text("b", "dbl")).toBe("1234.5");
  });
});
