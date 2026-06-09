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
