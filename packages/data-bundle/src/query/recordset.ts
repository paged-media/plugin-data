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
  /** Per-row read that honours the validity bitmap (Arrow `Vector.get`).
   *  Optional so a plain fake satisfies the interface. */
  get?(index: number): unknown;
  /** Null slots in the column (Arrow `Vector.nullCount`). */
  nullCount?: number;
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
}

/** The scale of an Arrow Decimal field, or null for any other type. Arrow JS
 *  stores a decimal as its UNSCALED integer (`get` returns a big-number view
 *  whose `String()` is that integer), so the scale is needed to read it. */
export function decimalScale(field: ArrowLikeField): number | null {
  const t = field.type as { typeId?: unknown; scale?: unknown; toString?(): string } | null;
  if (!t || typeof t !== "object") return null;
  const isDecimal =
    t.typeId === 7 /* Arrow Type.Decimal */ || /^decimal/i.test(String(t.toString?.() ?? ""));
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
    const col = table.getChildAt(i);
    if (!col) return [];
    const scale = decimalScale(table.schema.fields[i]);
    if (scale !== null && typeof col.get === "function") {
      // A decimal's toArray() is its raw 32-bit words (four per row), so read
      // per row and apply the scale.
      return Array.from({ length: table.numRows }, (_, r) => {
        const cell = col.get!(r);
        return cell == null
          ? ({ t: "null" } as const)
          : ({ t: "number", v: decimalToNumber(String(cell), scale) } as const);
      });
    }
    if ((col.nullCount ?? 0) > 0 && typeof col.get === "function") {
      // toArray() of a primitive column ignores the validity bitmap (a null
      // reads as 0), so a column with nulls is read per row.
      return Array.from({ length: table.numRows }, (_, r) => cellToValue(col.get!(r), f.ty));
    }
    return Array.from(col.toArray(), (cell) => cellToValue(cell, f.ty));
  });
  return { schema: { fields }, columns, row_count: table.numRows };
}
