// The table lower is ONE batch: the frame, the native table in the frame's
// story, every cell and the binding label, addressed through C-15 handles
// (`$h:frame`, `$h:table`). When core refuses the `insertTable` child, the
// §2.2 degradation (tab text + drawn rules) is one batch too.

import { describe, expect, it } from "vitest";

import type { BundleHost, Mutation } from "@paged-media/plugin-api";

import { commitLoweredTable } from "../lower";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const table = {
  kind: "table" as const,
  region: "region",
  columns: [
    { index: 0, header: "SKU", xPt: 0, widthPt: 50 },
    { index: 1, header: "Name", xPt: 50, widthPt: 80 },
  ],
  rows: [
    { cells: ["SKU", "Name"], yPt: 0, heightPt: 12, header: true },
    { cells: ["A1", ""], yPt: 12, heightPt: 12, header: false },
  ],
  rules: [{ x1Pt: 0, y1Pt: 12, x2Pt: 130, y2Pt: 12 }],
  text: "SKU\tName\nA1\t",
  bounds: { widthPt: 130, heightPt: 24 },
};

function fakeHost(reply: (ops: Mutation[]) => { applied: boolean; error?: unknown }) {
  const sent: Mutation[][] = [];
  const selected: unknown[] = [];
  const frame = { kind: "textFrame", id: "u1" };
  const host = {
    manifest: { id: "media.paged.data", version: "0.0.1" },
    log: silent,
    supports: () => true,
    selection: { get: () => [], set: async (ids: unknown[]) => void selected.push(...ids) },
    document: {
      mutate: async (m: Mutation) => {
        const ops = (m.args as { ops: Mutation[] }).ops;
        sent.push(ops);
        const r = reply(ops);
        return r.applied
          ? { applied: true, createdId: frame, pageIds: [], minted: [{ handle: "frame", element: frame, storyId: "Story/u2" }] }
          : r;
      },
      meta: async () => ({ activePage: "p1" }),
      collection: async () => [{ selfId: "p1" }],
      hitTest: async () => {
        throw new Error("the table lower must not hitTest (D-16)");
      },
    },
  } as unknown as BundleHost;
  return { host, sent, selected };
}

describe("commitLoweredTable is one batch [data.lower.content]", () => {
  it("frame, table, cells and label in ONE mutate, addressed by handle [data.lower.content]", async () => {
    const fake = fakeHost(() => ({ applied: true }));
    const frameId = await commitLoweredTable(fake.host, table, { binding: "t1", def: "d", session: "s" });
    expect(frameId).toBe("u1");
    expect(fake.sent.length).toBe(1);
    const ops = fake.sent[0]!;
    expect(ops.map((o) => o.op)).toEqual([
      "insertTextFrame",
      "bindCreated",
      "insertTable",
      "bindCreated",
      "insertText",
      "insertText",
      "insertText", // the empty cell is skipped
      "setPluginMetadata",
    ]);
    expect((ops[2]!.args as { storyId: string }).storyId).toBe("$h:frame");
    expect((ops[4]!.args as { storyId: string; cell: { tableId: string } }).cell.tableId).toBe("$h:table");
    expect((ops[7]!.args as { elementId: { id: string } }).elementId.id).toBe("$h:frame");
    expect(fake.selected).toEqual([{ kind: "textFrame", id: "u1" }]);
  });

  it("degrades to tab text + rules in one batch when core refuses insertTable [data.lower.content]", async () => {
    const fake = fakeHost((ops) =>
      ops.some((o) => o.op === "insertTable")
        ? { applied: false, error: { what: "Mutation::Batch child 2 (InsertTable): unsupported — batch rolled back" } }
        : { applied: true },
    );
    expect(await commitLoweredTable(fake.host, table)).toBe("u1");
    expect(fake.sent.length).toBe(2);
    expect(fake.sent[1]!.map((o) => o.op)).toEqual([
      "insertTextFrame",
      "bindCreated",
      "insertLine",
      "insertText",
      "setPluginMetadata",
    ]);
  });

  it("any other rejection places nothing and does not degrade [data.lower.content]", async () => {
    const fake = fakeHost(() => ({
      applied: false,
      error: { what: "Mutation::Batch child 7 (SetPluginMetadata): foreign key — batch rolled back" },
    }));
    expect(await commitLoweredTable(fake.host, table)).toBeNull();
    expect(fake.sent.length).toBe(1);
  });
});
