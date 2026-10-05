// Update in place (campaign Wave 5): the pure re-lower planner. Given the
// scene tree with our labels and what the session remembers minting, a
// re-lower removes the old content (or reuses a table's frame) instead of
// minting a duplicate beside it.

import { describe, expect, it } from "vitest";

import { documentElements, planRelower } from "../relower";

const KEY = "x-paged:media.paged.data";
const label = (data: Record<string, unknown>) => [{ key: KEY, value: JSON.stringify({ v: 1, data }) }];

/** Two pages: page 1 has a table frame (labelled), an older duplicate of it,
 *  a user frame and two barcode modules (only the last labelled); page 2 was
 *  added by a merge and holds its two frames. */
const TREE: any[] = [
  {
    kind: "Spread",
    children: [
      {
        kind: "Page",
        children: [
          { kind: "TextFrame", id: { kind: "textFrame", id: "t1" }, pluginMetadata: label({ kind: "table", binding: "tb" }) },
          { kind: "TextFrame", id: { kind: "textFrame", id: "t0" }, pluginMetadata: label({ kind: "table", binding: "tb" }) },
          { kind: "TextFrame", id: { kind: "textFrame", id: "user" }, pluginMetadata: [] },
          { kind: "Polygon", id: { kind: "polygon", id: "m1" }, pluginMetadata: [] },
          { kind: "Polygon", id: { kind: "polygon", id: "m2" }, pluginMetadata: label({ kind: "barcode", binding: "bc" }) },
        ],
      },
    ],
  },
  {
    kind: "Spread",
    children: [
      {
        kind: "Page",
        children: [
          { kind: "TextFrame", id: { kind: "textFrame", id: "r0" }, pluginMetadata: label({ kind: "merge", merge: "mg", record: 0 }) },
          { kind: "Rectangle", id: { kind: "rectangle", id: "r1" }, pluginMetadata: label({ kind: "merge", merge: "mg", record: 0 }) },
        ],
      },
    ],
  },
];
const PAGES = ["p1", "p2"] as never[];

describe("re-lower updates in place [data.lower.relower-in-place]", () => {
  it("reads every item with its page and decoded label", () => {
    const els = documentElements(TREE);
    expect(els.map((e) => [e.element.id, e.page, e.data?.kind ?? null])).toEqual([
      ["t1", 0, "table"],
      ["t0", 0, "table"],
      ["user", 0, null],
      ["m1", 0, null],
      ["m2", 0, "barcode"],
      ["r0", 1, "merge"],
      ["r1", 1, "merge"],
    ]);
  });

  it("a table reuses its frame and removes the duplicates older lowerings left", () => {
    const plan = planRelower(documentElements(TREE), { kind: "table", binding: "tb" }, { pages: PAGES });
    expect(plan.reuse).toEqual({ kind: "textFrame", id: "t1" });
    expect(plan.remove).toEqual([{ op: "deleteFrame", args: { frameId: "t0" } }]);
  });

  it("a barcode removes every module it minted, labelled or not", () => {
    const plan = planRelower(
      documentElements(TREE),
      { kind: "barcode", binding: "bc" },
      { pages: PAGES, minted: [{ kind: "polygon", id: "m1" }, { kind: "polygon", id: "m2" }, { kind: "polygon", id: "gone" }] as never },
    );
    expect(plan.reuse).toBeNull();
    // "gone" was undone already: nothing to remove.
    expect(plan.removed.map((e) => e.id).sort()).toEqual(["m1", "m2"]);
  });

  it("a merge removes its frames and the pages it added once they are empty", () => {
    const plan = planRelower(documentElements(TREE), { kind: "merge", merge: "mg" }, { pages: PAGES, createdPages: ["p2"] as never });
    expect(plan.remove).toEqual([
      { op: "deleteFrame", args: { frameId: "r0" } },
      { op: "deleteFrame", args: { frameId: "r1" } },
      { op: "deletePage", args: { pageId: "p2" } },
    ]);
  });

  it("a page the merge added that the user put something on stays", () => {
    const tree = structuredClone(TREE);
    tree[1].children[0].children!.push({ kind: "TextFrame", id: { kind: "textFrame", id: "note" }, pluginMetadata: [] });
    const plan = planRelower(documentElements(tree), { kind: "merge", merge: "mg" }, { pages: PAGES, createdPages: ["p2"] as never });
    expect(plan.removedPages).toEqual([]);
  });

  it("nothing recorded: nothing removed, nothing reused", () => {
    const plan = planRelower(documentElements(TREE), { kind: "recordFlow", binding: "rf" }, { pages: PAGES });
    expect(plan).toEqual({ remove: [], reuse: null, removed: [], removedPages: [] });
  });
});
