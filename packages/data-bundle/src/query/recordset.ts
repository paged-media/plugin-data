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

// Pure Arrow → engine conversion — the TS half of the §6.1 seam. DuckDB-WASM
// returns Arrow; this file reads it ONCE per column into a typed, columnar
// form (`DecodedColumn`) and hands that over in one of two shapes:
//
//  · `arrowToColumns` — typed column buffers (Float64Array / Int32Array /
//    one UTF-8 buffer + offsets, an Arrow-layout validity bitmap), which
//    `data-js` ingests with one copy per column (`ingestColumnBatch`);
//  · `arrowToRecordSet` — the `data-core::RecordSet` serde JSON (`{t, v}` per
//    cell), the original seam, kept for tests and for engines without the
//    column door.
//
// Both come from the same reader, so they can never disagree. The reader
// takes the raw buffers of a real Arrow vector (`vector.data[]`) and falls
// back to per-row `get()` / `toArray()` for anything else (a fake in a test,
// a sliced chunk, a type with no buffer path). Kept pure (no DuckDB) so it is
// unit-testable.
//
// Type contract (the DuckDB SQL oracle, docs/design/oracles.md): Date = days
// since 1970-01-01, DateTime = ms since the epoch (UTC, sub-ms floored), every
// number an f64, BLOB = bytes, HUGEINT an int. The types data-core has no kind
// for (TIME, INTERVAL, LIST, STRUCT, MAP, …) are text in DuckDB's own
// rendering: `needsText` names them and the DuckDB handle casts them to
// VARCHAR in SQL (duckdb.ts), so this reader sees text.

/** A tagged value matching `data-core::Value` serde (`tag="t", content="v"`). */
export type ValueJson =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "number"; v: number }
  | { t: "text"; v: string }
  | { t: "date"; v: number }
  | { t: "datetime"; v: number }
  | { t: "bytes"; v: number[] };

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
/** One Arrow `Data` chunk — the raw buffers of a real vector. */
export interface ArrowLikeChunk {
  length: number;
  offset: number;
  nullCount: number;
  values?: ArrayLike<unknown> & { length: number };
  nullBitmap?: Uint8Array;
  valueOffsets?: Int32Array;
}
export interface ArrowLikeColumn {
  toArray(): ArrayLike<unknown>;
  /** Per-row read that honours the validity bitmap (Arrow `Vector.get`).
   *  Optional so a plain fake satisfies the interface. */
  get?(index: number): unknown;
  /** Null slots in the column (Arrow `Vector.nullCount`). */
  nullCount?: number;
  /** The raw chunks of a real Arrow vector. */
  data?: ArrowLikeChunk[];
}
export interface ArrowLikeTable {
  numRows: number;
  schema: { fields: ArrowLikeField[] };
  getChildAt(index: number): ArrowLikeColumn | null;
}

// apache-arrow's `Type` enum (stable across the 1x versions DuckDB-WASM uses).
const T = {
  Int: 2,
  Float: 3,
  Binary: 4,
  Utf8: 5,
  Bool: 6,
  Decimal: 7,
  Date: 8,
  Time: 9,
  Timestamp: 10,
  Interval: 11,
  List: 12,
  Struct: 13,
  Union: 14,
  FixedSizeBinary: 15,
  FixedSizeList: 16,
  Map: 17,
  Duration: 18,
  LargeBinary: 19,
  LargeUtf8: 20,
} as const;

interface ArrowType {
  typeId?: number;
  unit?: number;
  scale?: number;
  precision?: number;
  bitWidth?: number;
  isSigned?: boolean;
  toString?(): string;
}

function typeOf(field: ArrowLikeField): ArrowType | null {
  const t = field.type as ArrowType | null;
  return t && typeof t === "object" && typeof t.typeId === "number" ? t : null;
}

function typeText(field: ArrowLikeField): string {
  return String((field.type as { toString?(): string })?.toString?.() ?? field.type ?? "").toLowerCase();
}

/** Arrow types data-core has no kind for: TIME, INTERVAL, DURATION and the
 *  nested types. They cross as TEXT in DuckDB's own rendering — the DuckDB
 *  handle casts them to VARCHAR in SQL before reading (oracle defect DQ-4). */
export function needsText(field: ArrowLikeField): boolean {
  const t = typeOf(field);
  if (t) {
    return [T.Time, T.Interval, T.Duration, T.List, T.Struct, T.Union, T.FixedSizeList, T.Map].includes(
      t.typeId as never,
    );
  }
  const s = typeText(field);
  return /^(time(?!stamp)|interval|duration|list|struct|map|union|fixedsizelist)/.test(s);
}

/** Map an Arrow field's type to our logical field type: by the Arrow type id
 *  for a real vector, by its string form for a fake. */
export function classifyType(field: ArrowLikeField): FieldTypeJson {
  const t = typeOf(field);
  if (t) {
    switch (t.typeId) {
      case T.Int:
        return "int";
      case T.Float:
        return "float";
      case T.Decimal:
        // DuckDB exports HUGEINT as Decimal(38, 0) (oracle defect DQ-3). A
        // declared DECIMAL(38,0) reads the same; its values are integers too.
        return t.scale === 0 && t.precision === 38 ? "int" : "float";
      case T.Bool:
        return "bool";
      case T.Date:
        return "date";
      case T.Timestamp:
        return "datetime";
      case T.Binary:
      case T.LargeBinary:
      case T.FixedSizeBinary:
        return "bytes";
      default:
        return "text";
    }
  }
  const s = typeText(field);
  if (needsText(field)) return "text";
  if (/utf8|string|char|varchar/.test(s)) return "text";
  if (/bool/.test(s)) return "bool";
  if (/timestamp|datetime/.test(s)) return "datetime";
  if (/date/.test(s)) return "date";
  if (/binary|blob|bytes/.test(s)) return "bytes";
  if (/float|double|decimal|real/.test(s)) return "float";
  if (/int/.test(s)) return "int";
  return "text";
}

/** The scale of an Arrow Decimal field, or null for any other type. Arrow JS
 *  stores a decimal as its UNSCALED integer (`get` returns a big-number view
 *  whose `String()` is that integer), so the scale is needed to read it. */
export function decimalScale(field: ArrowLikeField): number | null {
  const t = field.type as { typeId?: unknown; scale?: unknown; toString?(): string } | null;
  if (!t || typeof t !== "object") return null;
  const isDecimal =
    t.typeId === T.Decimal || /^decimal/i.test(String(t.toString?.() ?? ""));
  return isDecimal && typeof t.scale === "number" ? t.scale : null;
}

/** An unscaled decimal integer (as its decimal string) at `scale` → the
 *  nearest number. Built as a decimal string and parsed once, so it rounds
 *  like the decimal does instead of dividing an already-rounded double. */
export function decimalToNumber(unscaled: string, scale: number): number {
  if (scale <= 0) return Number(unscaled + "0".repeat(-scale));
  const neg = unscaled.startsWith("-");
  const digits = (neg ? unscaled.slice(1) : unscaled).padStart(scale + 1, "0");
  const cut = digits.length - scale;
  return Number(`${neg ? "-" : ""}${digits.slice(0, cut)}.${digits.slice(cut)}`);
}

/** Wrap one raw cell as a tagged `ValueJson` for the given field type. */
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
    case "bytes":
      return { t: "bytes", v: Array.from(raw as ArrayLike<number>) };
    default:
      return { t: "text", v: String(raw) };
  }
}

// ── the typed column form ───────────────────────────────────────────────────

/** One column, decoded. `valid` is an Arrow-layout validity bitmap (bit `i`,
 *  LSB first, set = present) or null when every row is present. */
export type DecodedColumn =
  | { kind: "f64"; values: Float64Array; valid: Uint8Array | null }
  | { kind: "bool"; values: Uint8Array; valid: Uint8Array | null }
  | { kind: "date"; values: Int32Array; valid: Uint8Array | null }
  | { kind: "datetime"; values: Float64Array; valid: Uint8Array | null }
  | { kind: "utf8"; bytes: Uint8Array; offsets: Int32Array; valid: Uint8Array | null }
  | { kind: "binary"; bytes: Uint8Array; offsets: Int32Array; valid: Uint8Array | null };

/** A whole result as typed column buffers — what `ingestColumnBatch` sends. */
export interface ColumnBatch {
  schema: { fields: FieldJson[] };
  row_count: number;
  columns: DecodedColumn[];
}

const DAY_MS = 86_400_000;

function isValid(valid: Uint8Array | null, i: number): boolean {
  return valid === null || ((valid[i >> 3] >> (i & 7)) & 1) === 1;
}

/** Bytes per value buffer kind, for the boundary-bytes trend. */
export function batchBytes(batch: ColumnBatch): number {
  let n = 0;
  for (const c of batch.columns) {
    n += c.valid?.byteLength ?? 0;
    n += "bytes" in c ? c.bytes.byteLength + c.offsets.byteLength : c.values.byteLength;
  }
  return n;
}

/** Floor-divide a BigInt timestamp in `unit` (0 s, 1 ms, 2 µs, 3 ns) to ms. */
function toMillis(v: bigint, unit: number): number {
  switch (unit) {
    case 0:
      return Number(v) * 1000;
    case 1:
      return Number(v);
    default: {
      const d = unit === 2 ? 1000n : 1_000_000n;
      let q = v / d;
      if (v % d < 0n) q -= 1n;
      return Number(q);
    }
  }
}

/** A two's-complement little-endian integer of `words` 32-bit words. */
function wordsToBigInt(w: Uint32Array, at: number, words: number): bigint {
  let b = 0n;
  for (let k = words - 1; k >= 0; k--) b = (b << 32n) | BigInt(w[at + k]);
  return BigInt.asIntN(words * 32, b);
}

/** Does this column have a raw-buffer path for its type? */
function rawChunks(col: ArrowLikeColumn): ArrowLikeChunk[] | null {
  const data = col.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  // A sliced chunk (offset ≠ 0) is read per row; DuckDB never returns one.
  return data.every((d) => d.offset === 0 && d.values !== undefined) ? data : null;
}

class ValidityBuilder {
  bits: Uint8Array;
  any = false;
  constructor(n: number) {
    this.bits = new Uint8Array((n + 7) >> 3).fill(0xff);
  }
  clear(i: number) {
    this.bits[i >> 3] &= ~(1 << (i & 7));
    this.any = true;
  }
  done(): Uint8Array | null {
    return this.any ? this.bits : null;
  }
}

const encoder = new TextEncoder();

/** Read one Arrow column into its typed form. */
export function decodeColumn(col: ArrowLikeColumn | null, field: ArrowLikeField, rows: number): DecodedColumn {
  const ty = classifyType(field);
  const t = typeOf(field);
  const valid = new ValidityBuilder(rows);
  const chunks = col ? rawChunks(col) : null;
  // Walk every row of every chunk with its global index.
  const eachChunk = (f: (d: ArrowLikeChunk, base: number) => void) => {
    let base = 0;
    for (const d of chunks!) {
      if (d.nullCount > 0 && d.nullBitmap && d.nullBitmap.length > 0) {
        for (let i = 0; i < d.length; i++)
          if (((d.nullBitmap[i >> 3] >> (i & 7)) & 1) === 0) valid.clear(base + i);
      }
      f(d, base);
      base += d.length;
    }
  };
  // Per-row fallback: honours nulls through get() (toArray of a primitive
  // column reads a null as 0).
  const perRow = (): unknown[] => {
    if (!col) return new Array(rows).fill(null);
    const scale = decimalScale(field);
    if (typeof col.get === "function" && (scale !== null || (col.nullCount ?? 0) > 0 || t !== null)) {
      return Array.from({ length: rows }, (_, r) => {
        const cell = col.get!(r);
        if (cell == null) return null;
        if (scale !== null) return decimalToNumber(String(cell), scale);
        return cell;
      });
    }
    return Array.from(col.toArray());
  };

  if (ty === "text" || ty === "bytes") {
    if (chunks && t && (t.typeId === T.Utf8 || t.typeId === T.Binary)) {
      // The UTF-8 buffer and offsets ARE Arrow's layout: concatenate chunks.
      let total = 0;
      for (const d of chunks) total += d.valueOffsets![d.length] - d.valueOffsets![0];
      const bytes = new Uint8Array(total);
      const offsets = new Int32Array(rows + 1);
      let at = 0;
      eachChunk((d, base) => {
        const o = d.valueOffsets!;
        const v = d.values as Uint8Array;
        bytes.set(v.subarray(o[0], o[d.length]), at);
        for (let i = 0; i < d.length; i++) offsets[base + i + 1] = at + (o[i + 1] - o[0]);
        at += o[d.length] - o[0];
      });
      return { kind: ty === "text" ? "utf8" : "binary", bytes, offsets, valid: valid.done() };
    }
    // Per row: encode each cell.
    const cells = perRow();
    const parts: Uint8Array[] = [];
    const offsets = new Int32Array(rows + 1);
    let at = 0;
    for (let i = 0; i < rows; i++) {
      const c = cells[i];
      let b: Uint8Array;
      if (c == null) {
        valid.clear(i);
        b = new Uint8Array(0);
      } else if (ty === "bytes") {
        b = c instanceof Uint8Array ? c : Uint8Array.from(c as ArrayLike<number>);
      } else {
        b = encoder.encode(t?.typeId === T.Time ? timeText(c) : String(c));
      }
      parts.push(b);
      at += b.length;
      offsets[i + 1] = at;
    }
    const bytes = new Uint8Array(at);
    let p = 0;
    for (const b of parts) {
      bytes.set(b, p);
      p += b.length;
    }
    return { kind: ty === "text" ? "utf8" : "binary", bytes, offsets, valid: valid.done() };
  }

  if (ty === "bool") {
    const values = new Uint8Array(rows);
    if (chunks && t?.typeId === T.Bool) {
      eachChunk((d, base) => {
        const v = d.values as Uint8Array;
        for (let i = 0; i < d.length; i++) values[base + i] = (v[i >> 3] >> (i & 7)) & 1;
      });
    } else {
      perRow().forEach((c, i) => (c == null ? valid.clear(i) : (values[i] = c ? 1 : 0)));
    }
    return { kind: "bool", values, valid: valid.done() };
  }

  if (ty === "date") {
    const values = new Int32Array(rows);
    if (chunks && t?.typeId === T.Date && t.unit === 0 && chunks.every((d) => d.values instanceof Int32Array)) {
      // DateDay: the buffer IS days (get() would give epoch ms — DQ-1).
      eachChunk((d, base) => values.set((d.values as Int32Array).subarray(0, d.length), base));
    } else {
      perRow().forEach((c, i) => {
        if (c == null) return valid.clear(i);
        // A real Arrow Date reads as epoch ms (a Date or a number); a fake
        // supplies days.
        const ms = c instanceof Date ? c.getTime() : Number(c);
        values[i] = t ? Math.floor(ms / DAY_MS) : ms;
      });
    }
    return { kind: "date", values, valid: valid.done() };
  }

  if (ty === "datetime") {
    const values = new Float64Array(rows);
    const unit = t?.unit ?? 1;
    if (chunks && t?.typeId === T.Timestamp && chunks.every((d) => d.values instanceof BigInt64Array)) {
      // The buffer is in the column's storage unit (DQ-2): floor to ms.
      eachChunk((d, base) => {
        const v = d.values as BigInt64Array;
        for (let i = 0; i < d.length; i++) values[base + i] = toMillis(v[i], unit);
      });
    } else {
      perRow().forEach((c, i) => {
        if (c == null) return valid.clear(i);
        values[i] = c instanceof Date ? c.getTime() : typeof c === "bigint" ? toMillis(c, unit) : Math.floor(Number(c));
      });
    }
    return { kind: "datetime", values, valid: valid.done() };
  }

  // Numbers (int / float / decimal).
  const values = new Float64Array(rows);
  const scale = decimalScale(field);
  if (chunks && t?.typeId === T.Decimal && scale !== null) {
    const words = (t.bitWidth ?? 128) / 32;
    eachChunk((d, base) => {
      const w = d.values as Uint32Array;
      for (let i = 0; i < d.length; i++) {
        if (!isValid(valid.bits, base + i)) continue;
        values[base + i] = decimalToNumber(wordsToBigInt(w, i * words, words).toString(), scale);
      }
    });
  } else if (chunks && (t?.typeId === T.Int || (t?.typeId === T.Float && t.precision !== 0))) {
    eachChunk((d, base) => {
      const v = d.values!;
      if (v instanceof BigInt64Array || v instanceof BigUint64Array) {
        for (let i = 0; i < d.length; i++) values[base + i] = Number(v[i]);
      } else {
        values.set((v as unknown as Float64Array).subarray(0, d.length), base);
      }
    });
  } else {
    perRow().forEach((c, i) => (c == null ? valid.clear(i) : (values[i] = Number(c))));
  }
  return { kind: "f64", values, valid: valid.done() };
}

/** A TIME (µs since midnight, a BigInt) as DuckDB prints it — the fallback
 *  when the handle could not cast it in SQL. */
function timeText(c: unknown): string {
  if (typeof c !== "bigint") return String(c);
  const us = Number(c);
  const s = Math.floor(us / 1e6);
  const pad = (n: number) => String(n).padStart(2, "0");
  const frac = us % 1e6;
  const base = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  return frac ? `${base}.${String(frac).padStart(6, "0").replace(/0+$/, "")}` : base;
}

function schemaOf(table: ArrowLikeTable): FieldJson[] {
  return table.schema.fields.map((f) => ({ name: f.name, ty: classifyType(f), nullable: true }));
}

/** Read an Arrow table into typed column buffers — the boundary form
 *  `ingestColumnBatch` sends (one copy per column into the engine). */
export function arrowToColumns(table: ArrowLikeTable): ColumnBatch {
  const fields = schemaOf(table);
  const columns = table.schema.fields.map((f, i) => decodeColumn(table.getChildAt(i), f, table.numRows));
  return { schema: { fields }, row_count: table.numRows, columns };
}

const decoder = new TextDecoder();

/** One decoded column as `{t, v}` cells. */
export function columnToValues(c: DecodedColumn, rows: number): ValueJson[] {
  const out: ValueJson[] = new Array(rows);
  for (let i = 0; i < rows; i++) {
    if (!isValid(c.valid, i)) {
      out[i] = { t: "null" };
      continue;
    }
    switch (c.kind) {
      case "f64":
        out[i] = { t: "number", v: c.values[i] };
        break;
      case "bool":
        out[i] = { t: "bool", v: c.values[i] === 1 };
        break;
      case "date":
        out[i] = { t: "date", v: c.values[i] };
        break;
      case "datetime":
        out[i] = { t: "datetime", v: c.values[i] };
        break;
      case "utf8":
        out[i] = { t: "text", v: decoder.decode(c.bytes.subarray(c.offsets[i], c.offsets[i + 1])) };
        break;
      case "binary":
        out[i] = { t: "bytes", v: Array.from(c.bytes.subarray(c.offsets[i], c.offsets[i + 1])) };
        break;
    }
  }
  return out;
}

/** Materialise an Arrow table into the columnar `RecordSetJson` the engine
 *  ingests through `ingest_result` (`{t, v}` per cell). */
export function arrowToRecordSet(table: ArrowLikeTable): RecordSetJson {
  const batch = arrowToColumns(table);
  return {
    schema: batch.schema,
    columns: batch.columns.map((c) => columnToValues(c, batch.row_count)),
    row_count: batch.row_count,
  };
}
