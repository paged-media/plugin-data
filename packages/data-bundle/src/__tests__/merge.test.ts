// The Data Merge writer's pure half (campaign Wave 5): how a merge plan
// becomes mutations. The real-core proof against the InDesign recordings is
// test/merge-real-core.spec.ts.

import { describe, expect, it } from "vitest";

import {
  contentMutation,
  imageUri,
  pageElements,
  pageMutations,
  storyText,
  textOffsetLength,
  type MergePlan,
  type MergeTemplate,
} from "../merge";

const TEMPLATE: MergeTemplate = {
  pageId: "p1" as never,
  frames: [
    {
      element: { kind: "textFrame", id: "tf" } as never,
      storyId: "s1",
      format: [{ path: "characterFontSize", value: { type: "length", value: 10 } }],
      font: { family: "", style: null, sizePt: 10, leadingPt: 12 },
    },
    {
      element: { kind: "rectangle", id: "img" } as never,
      storyId: null,
      format: [],
      font: { family: "", style: null, sizePt: 12, leadingPt: 14.4 },
    },
  ],
  spec: {
    marginBox: [36, 36, 756, 576],
    frames: [
      { id: "tf", bounds: [36, 36, 60, 236], content: { kind: "text", text: "<<name>>" } },
      { id: "img", bounds: [72, 36, 172, 186], content: { kind: "image", field: "photo" } },
    ],
  },
};

const PLAN: Pick<MergePlan, "pageCount" | "records"> = {
  pageCount: 2,
  records: [
    { record: 0, page: 0, row: 0, column: 0, frames: [{ template: 0, bounds: [36, 36, 60, 236], text: "Grün" }, { template: 1, bounds: [72, 36, 172, 186], image: "red.png" }] },
    { record: 1, page: 1, row: 0, column: 0, frames: [{ template: 0, bounds: [36, 36, 60, 236], text: "" }, { template: 1, bounds: [72, 36, 172, 186] }] },
  ],
};

describe("Data Merge writer, pure [data.lower.merge-writer]", () => {
  it("text offsets are UTF-8 bytes with one per paragraph boundary", () => {
    expect(textOffsetLength("Grün\nA")).toBe(7);
    expect(storyText({ paragraphs: [{ runs: [{ text: "a" }, { text: "\nb" }] }, { runs: [] }] })).toBe("a\nb\n");
  });

  it("pages: consume duplicates the emptied template page; keep inserts after it; one page needs none", () => {
    expect(pageMutations({ pageCount: 1 }, TEMPLATE, { template: "consume" })).toBeNull();
    expect(pageMutations({ pageCount: 3 }, TEMPLATE, { template: "consume" })).toEqual({
      op: "batch",
      args: {
        ops: [
          { op: "deleteFrame", args: { frameId: "tf" } },
          { op: "deleteFrame", args: { frameId: "img" } },
          { op: "duplicatePage", args: { page: "p1" } },
          { op: "duplicatePage", args: { page: "p1" } },
        ],
      },
    });
    const keep = pageMutations({ pageCount: 2 }, TEMPLATE, { template: "keep" }) as { args: { ops: unknown[] } };
    expect(keep.args.ops).toEqual([
      { op: "insertPage", args: { afterPageId: "p1", masterId: null } },
      { op: "insertPage", args: { afterPageId: "p1", masterId: null } },
    ]);
  });

  it("content: one batch; each frame named, filled, formatted and labelled through its handle", () => {
    const m = contentMutation(PLAN, TEMPLATE, ["p1", "p2"] as never, {
      template: "consume",
      mergeId: "mg",
      imageBase: "/data/images",
    }) as { op: string; args: { ops: any[] } };
    expect(m.op).toBe("batch");
    const ops = m.args.ops;
    expect(ops.map((o) => o.op)).toEqual([
      "insertTextFrame", "bindCreated", "insertText", "setElementProperty", "setPluginMetadata",
      "insertFrame", "bindCreated", "placeImage", "setPluginMetadata",
      // record 1: an empty text and an empty image field write no content
      "insertTextFrame", "bindCreated", "setPluginMetadata",
      "insertFrame", "bindCreated", "setPluginMetadata",
    ]);
    expect(ops[0].args).toEqual({ pageId: "p1", bounds: [36, 36, 60, 236] });
    expect(ops[2].args).toEqual({ storyId: "$h:m0f0", offset: 0, text: "Grün" });
    expect(ops[3].args.elementId).toEqual({ kind: "storyRange", id: { story_id: "$h:m0f0", start: 0, end: 5 } });
    expect(ops[7].args).toEqual({ elementId: "$h:m0f1", uri: "/data/images/red.png", fit: "Proportionally" });
    expect(JSON.parse(ops[4].args.value)).toEqual({ v: 1, data: { kind: "merge", merge: "mg", record: 0, frame: 0 } });
    expect(ops[9].args.pageId).toBe("p2");
  });

  it("content: consuming a one-page merge removes the template frames in the same batch", () => {
    const one = { pageCount: 1, records: [PLAN.records[0]] };
    const m = contentMutation(one, TEMPLATE, ["p1"] as never, { template: "consume", mergeId: "mg" }) as { args: { ops: any[] } };
    expect(m.args.ops.slice(0, 2).map((o) => o.op)).toEqual(["deleteFrame", "deleteFrame"]);
  });

  it("image references resolve against the base unless absolute", () => {
    expect(imageUri("a.png", "/x")).toBe("/x/a.png");
    expect(imageUri("a.png", "/x/")).toBe("/x/a.png");
    expect(imageUri("/abs/a.png", "/x")).toBe("/abs/a.png");
    expect(imageUri("https://h/a.png", "/x")).toBe("https://h/a.png");
    expect(imageUri("a.png")).toBe("a.png");
  });

  it("page items are read per page in document order", () => {
    const tree = [
      { kind: "Spread", children: [{ kind: "Page", children: [{ kind: "TextFrame", id: { kind: "textFrame", id: "a" } }] }] },
      { kind: "Spread", children: [{ kind: "Page", children: [{ kind: "Group", id: { kind: "group", id: "g" }, children: [] }] }] },
    ];
    expect(pageElements(tree, 0)).toEqual([{ kind: "textFrame", id: "a" }]);
    expect(pageElements(tree, 1)).toEqual([{ kind: "group", id: "g" }]);
    expect(pageElements(tree, 2)).toEqual([]);
  });
});
