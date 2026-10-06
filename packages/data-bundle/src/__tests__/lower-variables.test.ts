// `lowerAll` places every variable of the command as ONE batch (budget W5):
// a fresh frame per variable named by `bindCreated`, its field addressing the
// frame's story as `$h:v<i>`. A refused batch falls back to one mutate per
// variable, so one bad field cannot lose the rest.

import { describe, expect, it } from "vitest";

import type { BundleHost, Mutation } from "@paged-media/plugin-api";

import { commitLoweredVariables } from "../lower";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const variable = (text: string) => ({ kind: "variable" as const, target: "anchor", text, hidden: false });

function fakeHost(opts: { refuseBatchOf?: number; caret?: { storyId: string; offset: number } } = {}) {
  const sent: Mutation[] = [];
  let frames = 0;
  const host = {
    manifest: { id: "media.paged.data", version: "0.0.1" },
    log: silent,
    supports: () => true,
    text: { caret: () => opts.caret ?? null },
    selection: { get: () => [], set: async () => {} },
    document: {
      mutate: async (m: Mutation) => {
        sent.push(m);
        const ops = m.op === "batch" ? (m.args as { ops: Mutation[] }).ops : [m];
        if (opts.refuseBatchOf !== undefined && ops.filter((o) => o.op === "insertField").length === opts.refuseBatchOf) {
          return { applied: false, error: "Mutation::Batch child 5 (insertField): refused — batch rolled back" };
        }
        const minted = ops
          .filter((o) => o.op === "insertTextFrame")
          .map(() => {
            frames += 1;
            // Core may report handle: null for a named element.
            return { handle: null, element: { kind: "textFrame", id: `u${frames}` }, storyId: `Story/s${frames}` };
          });
        return { applied: true, pageIds: [], minted };
      },
      meta: async () => ({ activePage: "p1" }),
      collection: async () => [{ selfId: "p1" }],
    },
  } as unknown as BundleHost;
  return { host, sent };
}

describe("lowerAll places variables in one batch [data.lower.content]", () => {
  it("mints one frame per variable and every field in ONE mutate [data.lower.content]", async () => {
    const fake = fakeHost();
    const placed = await commitLoweredVariables(fake.host, [
      { variable: variable("A"), key: "a" },
      { variable: variable("B"), key: "b" },
      { variable: variable("C"), key: "c" },
    ]);
    expect(fake.sent.length).toBe(1);
    const ops = (fake.sent[0]!.args as { ops: Mutation[] }).ops;
    expect(ops.map((o) => o.op)).toEqual([
      "insertTextFrame", "bindCreated", "insertField",
      "insertTextFrame", "bindCreated", "insertField",
      "insertTextFrame", "bindCreated", "insertField",
    ]);
    expect((ops[1]!.args as { handle: string }).handle).toBe("v0");
    expect((ops[8]!.args as { storyId: string }).storyId).toBe("$h:v2");
    // The i-th minted frame is the i-th variable's, even without handles.
    expect([...placed.entries()]).toEqual([
      ["a", { storyId: "Story/s1", offset: 0 }],
      ["b", { storyId: "Story/s2", offset: 0 }],
      ["c", { storyId: "Story/s3", offset: 0 }],
    ]);
  });

  it("puts every field at the caret in one batch [data.lower.content]", async () => {
    const fake = fakeHost({ caret: { storyId: "Story/x", offset: 4 } });
    const placed = await commitLoweredVariables(fake.host, [
      { variable: variable("A"), key: "a" },
      { variable: variable("B"), key: "b" },
    ]);
    expect(fake.sent.length).toBe(1);
    const ops = (fake.sent[0]!.args as { ops: Mutation[] }).ops;
    expect(ops.map((o) => [o.op, (o.args as { storyId: string }).storyId])).toEqual([
      ["insertField", "Story/x"],
      ["insertField", "Story/x"],
    ]);
    expect(placed.get("b")).toEqual({ storyId: "Story/x", offset: 4 });
  });

  it("falls back to one mutate per variable when the batch is refused [data.lower.content]", async () => {
    const fake = fakeHost({ refuseBatchOf: 2 });
    const placed = await commitLoweredVariables(fake.host, [
      { variable: variable("A"), key: "a" },
      { variable: variable("B"), key: "b" },
    ]);
    // The refused batch, then one per variable.
    expect(fake.sent.length).toBe(3);
    expect([...placed.keys()]).toEqual(["a", "b"]);
  });
});
