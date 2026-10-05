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

// The Arrow → RecordSet conversion (the TS half of the §6.1 seam) — unit-tested
// against a fake Arrow-like table, so it needs no DuckDB. Asserts the exact
// `data-core::RecordSet` serde shape the engine ingests (tagged values, field
// types, row_count).

import { describe, expect, it } from "vitest";

import { arrowToRecordSet, cellToValue, classifyType, type ArrowLikeTable } from "../query/recordset";

function fakeTable(): ArrowLikeTable {
  return {
    numRows: 2,
    schema: {
      fields: [
        { name: "sku", type: "Utf8" },
        { name: "price", type: "Float64" },
        { name: "qty", type: "Int64" },
      ],
    },
    getChildAt(i: number) {
      const cols = [["A-1", "B-2"], [9.99, 19.99], [3, 7]];
      return { toArray: () => cols[i] };
    },
  };
}

describe("arrowToRecordSet", () => {
  it("maps Arrow types to the engine's logical field types", () => {
    expect(classifyType({ name: "x", type: "Utf8" })).toBe("text");
    expect(classifyType({ name: "x", type: "Float64" })).toBe("float");
    expect(classifyType({ name: "x", type: "Int64" })).toBe("int");
    expect(classifyType({ name: "x", type: "Bool" })).toBe("bool");
    expect(classifyType({ name: "x", type: "Timestamp<ms>" })).toBe("datetime");
  });

  it("wraps cells as tagged values matching data-core::Value", () => {
    expect(cellToValue("hi", "text")).toEqual({ t: "text", v: "hi" });
    expect(cellToValue(9.99, "float")).toEqual({ t: "number", v: 9.99 });
    expect(cellToValue(null, "float")).toEqual({ t: "null" });
  });

  it("materialises a columnar RecordSet with row_count", () => {
    const rs = arrowToRecordSet(fakeTable());
    expect(rs.row_count).toBe(2);
    expect(rs.schema.fields.map((f) => f.name)).toEqual(["sku", "price", "qty"]);
    expect(rs.schema.fields.map((f) => f.ty)).toEqual(["text", "float", "int"]);
    expect(rs.columns[0]).toEqual([
      { t: "text", v: "A-1" },
      { t: "text", v: "B-2" },
    ]);
    expect(rs.columns[1][0]).toEqual({ t: "number", v: 9.99 });
  });
});

// ── Real apache-arrow vectors: decimal scale and nulls (wave 0, data bug f) ──

import * as arrow from "apache-arrow";

/** A 128-bit Decimal vector of UNSCALED integers (`null` → a null slot). */
function decimalVector(unscaled: (bigint | null)[], scale: number, precision = 18) {
  const words = new Uint32Array(unscaled.length * 4);
  const bitmap = new Uint8Array(Math.ceil(unscaled.length / 8));
  unscaled.forEach((v, i) => {
    if (v === null) return;
    bitmap[i >> 3] |= 1 << (i & 7);
    const b = BigInt.asUintN(128, v);
    for (let k = 0; k < 4; k++) words[i * 4 + k] = Number((b >> BigInt(32 * k)) & 0xffffffffn);
  });
  const nulls = unscaled.filter((v) => v === null).length;
  return arrow.makeVector(
    arrow.makeData({
      type: new arrow.Decimal(scale, precision, 128),
      length: unscaled.length,
      nullCount: nulls,
      nullBitmap: bitmap,
      data: words,
    }),
  );
}

describe("arrowToRecordSet over real Arrow vectors [data.query.seam]", () => {
  it("a Decimal column keeps its scale, one value per row [data.query.seam]", () => {
    const table = new arrow.Table({
      price: decimalVector([1234n, -560n, null, 100000000000000001n], 2),
    });
    const rs = arrowToRecordSet(table as unknown as ArrowLikeTable);
    expect(rs.row_count).toBe(4);
    expect(rs.schema.fields).toEqual([{ name: "price", ty: "float", nullable: true }]);
    expect(rs.columns[0]).toEqual([
      { t: "number", v: 12.34 },
      { t: "number", v: -5.6 },
      { t: "null" },
      // 1000000000000000.01: beyond f64 precision, rounded the way the decimal
      // string would be, not the unscaled integer divided in floating point.
      { t: "number", v: Number("1000000000000000.01") },
    ]);
  });

  it("a scale-0 Decimal is an integer value [data.query.seam]", () => {
    const table = new arrow.Table({ qty: decimalVector([42n, -7n], 0) });
    expect(arrowToRecordSet(table as unknown as ArrowLikeTable).columns[0]).toEqual([
      { t: "number", v: 42 },
      { t: "number", v: -7 },
    ]);
  });

  it("a null in a numeric column stays null, not 0 [data.query.seam]", () => {
    const table = arrow.tableFromArrays({ price: [1.5, null, 3] as (number | null)[] } as never);
    const rs = arrowToRecordSet(table as unknown as ArrowLikeTable);
    expect(rs.columns[0]).toEqual([{ t: "number", v: 1.5 }, { t: "null" }, { t: "number", v: 3 }]);
  });
});

// ── Raw-buffer reads (Wave 2): the typed column form and the oracle types ──

import { arrowToColumns, columnToValues, needsText } from "../query/recordset";

describe("arrowToColumns reads Arrow's buffers by type [data.query.seam]", () => {
  it("DateDay is days, Timestamp<µs> is floored ms, with and without nulls [data.query.seam]", () => {
    const table = arrow.tableFromArrays({
      d: arrow.vectorFromArray([new Date(Date.UTC(1969, 11, 31)), new Date(Date.UTC(2024, 1, 29))], new arrow.DateDay()),
      ts: arrow.makeVector(
        arrow.makeData({
          type: new arrow.TimestampMicrosecond(),
          length: 2,
          nullCount: 0,
          data: BigInt64Array.from([-1n, 1_709_214_306_789_000n]),
        }),
      ),
    } as never);
    const rs = arrowToRecordSet(table as unknown as ArrowLikeTable);
    expect(rs.schema.fields.map((f) => f.ty)).toEqual(["date", "datetime"]);
    expect(rs.columns[0]).toEqual([{ t: "date", v: -1 }, { t: "date", v: 19782 }]);
    // −1 µs floors to −1 ms (1969-12-31 23:59:59.999), not 0.
    expect(rs.columns[1]).toEqual([{ t: "datetime", v: -1 }, { t: "datetime", v: 1_709_214_306_789 }]);
  });

  it("text crosses as ONE UTF-8 buffer + offsets across chunks; both forms agree [data.query.seam]", () => {
    const a = arrow.tableFromArrays({ s: ["ä", null, "b"], n: [1, 2, 3], b: [true, false, null] } as never);
    const b = arrow.tableFromArrays({ s: ["€uro"], n: [4], b: [true] } as never);
    const table = a.concat(b);
    const batch = arrowToColumns(table as unknown as ArrowLikeTable);
    const s = batch.columns[0];
    expect(s.kind).toBe("utf8");
    if (s.kind !== "utf8") return;
    expect(new TextDecoder().decode(s.bytes)).toBe("äb€uro");
    expect(Array.from(s.offsets)).toEqual([0, 2, 2, 3, 9]);
    expect(Array.from(s.valid!)[0] & 0b1111).toBe(0b1101);
    const rs = arrowToRecordSet(table as unknown as ArrowLikeTable);
    batch.columns.forEach((c, i) => expect(columnToValues(c, batch.row_count)).toEqual(rs.columns[i]));
    expect(rs.columns[2]).toEqual([{ t: "bool", v: true }, { t: "bool", v: false }, { t: "null" }, { t: "bool", v: true }]);
  });

  it("types without a data-core kind are named for the VARCHAR cast; timestamps are not [data.query.seam]", () => {
    expect(needsText({ name: "x", type: "Time64<MICROSECOND>" })).toBe(true);
    expect(needsText({ name: "x", type: "List<Int32>" })).toBe(true);
    expect(needsText({ name: "x", type: "Timestamp<ms>" })).toBe(false);
    expect(classifyType({ name: "x", type: "Interval<MONTH_DAY_NANO>" })).toBe("text");
    expect(classifyType({ name: "x", type: "Binary" })).toBe("bytes");
  });
});
