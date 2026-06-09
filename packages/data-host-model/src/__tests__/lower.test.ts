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
});
