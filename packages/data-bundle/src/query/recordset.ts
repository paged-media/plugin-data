// Pure Arrow → RecordSet conversion — the Rust side of the seam consumes this
// exact JSON shape (`data-core::RecordSet` serde: schema + columnar values +
// row_count; values are tagged `{t,v}` per `data-core::Value`). DuckDB-WASM
// returns Arrow; the TS query layer materialises it here so `data-js`'s
// `ingest_result` can decode it. Kept pure (takes an Arrow-like table) so it is
// unit-testable WITHOUT booting DuckDB.

/** A tagged value matching `data-core::Value` serde (`tag="t", content="v"`). */
export type ValueJson =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "number"; v: number }
  | { t: "text"; v: string }
  | { t: "date"; v: number }
  | { t: "datetime"; v: number };

/** A field logical type matching `data-core::FieldType` serde (lowercase). */
export type FieldTypeJson =
  | "bool"
  | "int"
  | "float"
  | "text"
  | "date"
  | "datetime"
  | "bytes"
  | "null";

export interface FieldJson {
  name: string;
  ty: FieldTypeJson;
  nullable: boolean;
}

/** The `data-core::RecordSet` serde shape (note `row_count` snake_case). */
export interface RecordSetJson {
  schema: { fields: FieldJson[] };
  columns: ValueJson[][];
  row_count: number;
}

/** The slice of an Arrow `Table` this converter needs (so a fake satisfies it
 *  in tests). DuckDB-WASM's `conn.query()` returns a compatible object. */
export interface ArrowLikeField {
  name: string;
  type: unknown;
}
export interface ArrowLikeColumn {
  toArray(): ArrayLike<unknown>;
}
export interface ArrowLikeTable {
  numRows: number;
  schema: { fields: ArrowLikeField[] };
  getChildAt(index: number): ArrowLikeColumn | null;
}

/** Map an Arrow field's type to our logical field type by its string form
 *  (robust across DuckDB-WASM Arrow versions). */
export function classifyType(field: ArrowLikeField): FieldTypeJson {
  const s = String((field.type as { toString?(): string })?.toString?.() ?? field.type ?? "")
    .toLowerCase();
  if (/utf8|string|char|varchar/.test(s)) return "text";
  if (/bool/.test(s)) return "bool";
  if (/timestamp|datetime/.test(s)) return "datetime";
  if (/date/.test(s)) return "date";
  if (/float|double|decimal|real/.test(s)) return "float";
  if (/int/.test(s)) return "int";
  return "text";
  // NOTE: Arrow Decimal columns (DB-attach, M1) carry an UNSCALED integer +
  // a scale; `Number(raw)` reads the unscaled value, so a Decimal price would
  // need scale division. The M0 path is CSV/Parquet → DOUBLE (handled), so
  // Decimal scale handling rides with the M1 DB-attach source (BREAKAGE — see
  // data.source.db-attach, planned). Proven by test-integration/pipeline.e2e.mjs.
}

/** Wrap one raw Arrow cell as a tagged `ValueJson` for the given field type. */
export function cellToValue(raw: unknown, ty: FieldTypeJson): ValueJson {
  if (raw === null || raw === undefined) return { t: "null" };
  switch (ty) {
    case "bool":
      return { t: "bool", v: Boolean(raw) };
    case "int":
    case "float":
      return { t: "number", v: Number(raw) };
    case "date":
      return { t: "date", v: Number(raw) };
    case "datetime":
      return { t: "datetime", v: Number(raw) };
    default:
      return { t: "text", v: String(raw) };
  }
}

/** Materialise an Arrow table into the columnar `RecordSetJson` the engine
 *  ingests. */
export function arrowToRecordSet(table: ArrowLikeTable): RecordSetJson {
  const fields: FieldJson[] = table.schema.fields.map((f) => ({
    name: f.name,
    ty: classifyType(f),
    nullable: true,
  }));
  const columns: ValueJson[][] = fields.map((f, i) => {
    const raw = table.getChildAt(i)?.toArray() ?? [];
    return Array.from(raw, (cell) => cellToValue(cell, f.ty));
  });
  return { schema: { fields }, columns, row_count: table.numRows };
}
