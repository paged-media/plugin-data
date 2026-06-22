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

// The pure host-model translation: the binding envelope round-trips, the
// default placement sizes to the content box, and a lowered table becomes the
// two-phase batch (insertTextFrame + insertLine per rule + setPluginMetadata)
// plus the phase-2 text. No host calls — data in, mutations out.

import { describe, expect, it } from "vitest";

import {
  BINDING_KEY,
  defaultPlacement,
  makeEnvelope,
  parseEnvelope,
  tableCellInserts,
  tableInsertMutation,
  tableInsertSpec,
  tableToMutations,
} from "../index";
import type { LoweredTable } from "../lowered";

function table(): LoweredTable {
  return {
    kind: "table",
    region: "r1",
    columns: [
      { index: 0, header: "SKU", xPt: 0, widthPt: 40 },
      { index: 1, header: "Price", xPt: 40, widthPt: 50 },
    ],
    rows: [
      { cells: ["SKU", "Price"], yPt: 0, heightPt: 14, header: true },
      { cells: ["A-1", "$9.99"], yPt: 14, heightPt: 14, header: false },
    ],
    rules: [
      { x1Pt: 0, y1Pt: 0, x2Pt: 90, y2Pt: 0 },
      { x1Pt: 0, y1Pt: 28, x2Pt: 90, y2Pt: 28 },
    ],
    text: "SKU\tPrice\nA-1\t$9.99",
    bounds: { widthPt: 90, heightPt: 28 },
  };
}

describe("data-host-model", () => {
  it("round-trips the binding envelope", () => {
    const json = makeEnvelope({ kind: "table", region: "r1" });
    const parsed = parseEnvelope(json);
    expect(parsed?.v).toBe(1);
    expect(parseEnvelope("not json")).toBeNull();
  });

  it("emits the host metadata-envelope shape { v, data } (NOT payload)", () => {
    // The host's setPluginMetadata door validates the envelope as
    // { v: <int >= 1>, data: {…}, engine?: {…} }. A `{v, payload}` envelope is
    // rejected and sinks the whole atomic batch (the barcode-lower regression).
    const raw = JSON.parse(makeEnvelope({ kind: "barcode", target: "f1" })) as Record<
      string,
      unknown
    >;
    expect(raw.v as number).toBeGreaterThanOrEqual(1);
    expect(raw.data).toEqual({ kind: "barcode", target: "f1" });
    expect(raw).not.toHaveProperty("payload");
  });

  it("default placement sizes to the content box", () => {
    const p = defaultPlacement("page-1" as never, { widthPt: 90, heightPt: 28 });
    const [top, left, bottom, right] = p.bounds;
    expect(right - left).toBe(90);
    expect(bottom - top).toBe(28);
  });

  it("lowers a table to the two-phase batch + text", () => {
    const placement = defaultPlacement("page-1" as never, table().bounds);
    const { batch, text } = tableToMutations(table(), placement, makeEnvelope({ region: "r1" }));
    expect(batch.op).toBe("batch");
    const ops = (batch as { op: "batch"; args: { ops: { op: string }[] } }).args.ops;
    // insertTextFrame + 2 rules + setPluginMetadata.
    expect(ops[0].op).toBe("insertTextFrame");
    expect(ops.filter((o) => o.op === "insertLine")).toHaveLength(2);
    const meta = ops.find((o) => o.op === "setPluginMetadata") as
      | { args: { key: string } }
      | undefined;
    expect(meta?.args.key).toBe(BINDING_KEY);
    expect(text).toBe("SKU\tPrice\nA-1\t$9.99");
  });

  it("derives the native insertTable spec from the IR (D-02)", () => {
    const spec = tableInsertSpec(table());
    expect(spec.rows).toBe(2); // header + 1 data row
    expect(spec.cols).toBe(2);
    expect(spec.headerRows).toBe(1); // first IR row is the header
    expect(spec.columnWidths).toEqual([40, 50]);
    const m = tableInsertMutation("story-1", spec);
    expect(m.op).toBe("insertTable");
    expect((m as { args: { rows: number; cols: number } }).args.rows).toBe(2);
  });

  it("fills native cells by (tableId, row, col), skipping empties", () => {
    const ops = tableCellInserts(table(), "story-1", "tbl-1");
    // 2 rows × 2 cols, all non-empty → 4 inserts.
    expect(ops).toHaveLength(4);
    const first = ops[0] as {
      op: string;
      args: { storyId: string; text: string; cell: { tableId: string; row: number; col: number } };
    };
    expect(first.op).toBe("insertText");
    expect(first.args.cell).toEqual({ tableId: "tbl-1", row: 0, col: 0 });
    expect(first.args.text).toBe("SKU");
    // An empty cell is skipped.
    const withEmpty: LoweredTable = {
      ...table(),
      rows: [{ cells: ["only", ""], yPt: 0, heightPt: 14, header: false }],
    };
    expect(tableCellInserts(withEmpty, "s", "t")).toHaveLength(1);
  });
});
