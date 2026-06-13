// Pure host-model translation for the v43 lanes (D-01 variables, D-14 image,
// D-13 rules): the engine's resolved values → host Mutations. No host calls —
// data in, mutations out.

import { describe, expect, it } from "vitest";

import {
  FIELD_PLUGIN,
  createRuleCellStyle,
  diffFields,
  idmlFit,
  insertFieldMutation,
  ownFields,
  placeImageMutation,
  placeableUri,
  ruleMutations,
  setFieldValueMutation,
  toRuleApplication,
  type PlaceholderField,
  type RuleResult,
  type RuleTarget,
} from "../index";
import type { ImageReference } from "../lowered";

describe("data_lower_variable_field (D-01 in-text variables)", () => {
  it("inserts a tagged placeholder field in this plugin's namespace", () => {
    const m = insertFieldMutation("story-1", 0, "v_price", null);
    expect(m.op).toBe("insertField");
    const args = (m as { args: { storyId: string; offset: number; field: unknown } }).args;
    expect(args.storyId).toBe("story-1");
    expect(args.offset).toBe(0);
    expect(args.field).toEqual({
      placeholder: { plugin: FIELD_PLUGIN, key: "v_price", value: undefined },
    });
  });

  it("carries a resolved value when present (null → token via undefined)", () => {
    const m = insertFieldMutation("s", 3, "k", "€ 9,99");
    const field = (m as { args: { field: { placeholder: { value?: string } } } }).args.field;
    expect(field.placeholder.value).toBe("€ 9,99");
  });

  it("re-resolves a field by its fresh-read offset (setFieldValue)", () => {
    const m = setFieldValueMutation("s", 12, "€ 19,99");
    expect(m.op).toBe("setFieldValue");
    expect((m as { args: { offset: number; value: string | null } }).args).toEqual({
      storyId: "s",
      offset: 12,
      value: "€ 19,99",
    });
    // A null clears the resolution (field falls back to its <key> token).
    expect(
      (setFieldValueMutation("s", 12, null) as { args: { value: string | null } }).args.value,
    ).toBeNull();
  });

  it("diffs enumerated fields against resolved values — only changed → write", () => {
    const fields: PlaceholderField[] = [
      { storyId: "s", offset: 0, plugin: FIELD_PLUGIN, key: "a", value: "old" },
      { storyId: "s", offset: 8, plugin: FIELD_PLUGIN, key: "b", value: "same" },
      { storyId: "s", offset: 16, plugin: FIELD_PLUGIN, key: "c", value: null },
    ];
    const resolved = new Map<string, string | null>([
      ["a", "new"], // changed
      ["b", "same"], // unchanged → no write
      // "c" has no resolved value → untouched
    ]);
    const refreshes = diffFields(fields, resolved);
    expect(refreshes.map((r) => r.changed)).toEqual([true, false, false]);
    expect(refreshes[0].next).toBe("new");
    expect(refreshes[2].next).toBeNull();
  });

  it("filters to this plugin's own fields (defence in depth)", () => {
    const fields: PlaceholderField[] = [
      { storyId: "s", offset: 0, plugin: FIELD_PLUGIN, key: "a", value: null },
      { storyId: "s", offset: 4, plugin: "media.paged.other", key: "x", value: null },
    ];
    expect(ownFields(fields)).toHaveLength(1);
    expect(ownFields(fields)[0].plugin).toBe(FIELD_PLUGIN);
  });
});

describe("data_lower_image_place (D-14 image placement)", () => {
  it("maps ImgFit → the IDML FittingOnEmptyFrame vocabulary", () => {
    expect(idmlFit("fit")).toBe("Proportionally");
    expect(idmlFit("fill")).toBe("FillProportionally");
    expect(idmlFit("crop")).toBe("FitContentToFrame");
  });

  it("resolves a placeable URI from uri/path; null for bytes/assetId/none", () => {
    expect(placeableUri({ ref: "uri", uri: "https://x/y.png" } as ImageReference)).toBe(
      "https://x/y.png",
    );
    expect(placeableUri({ ref: "path", path: "img/a.jpg" } as ImageReference)).toBe("img/a.jpg");
    expect(placeableUri({ ref: "assetId", id: "u1" } as ImageReference)).toBeNull();
    expect(placeableUri({ ref: "bytes", bytes: [1, 2] } as ImageReference)).toBeNull();
    expect(placeableUri({ ref: "none" } as ImageReference)).toBeNull();
  });

  it("emits a placeImage mutation on the bound rectangle", () => {
    const m = placeImageMutation("urect", "https://x/y.png", "FillProportionally");
    expect(m.op).toBe("placeImage");
    expect((m as { args: { elementId: string; uri: string; fit: string } }).args).toEqual({
      elementId: "urect",
      uri: "https://x/y.png",
      fit: "FillProportionally",
    });
  });
});

describe("data_lower_rule (D-13 rule application)", () => {
  it("maps the engine RuleResult to a normalised RuleApplication", () => {
    const result: RuleResult = {
      scope: "table-region",
      fires: [0, 2],
      apply: { action: "tableStyle", name: "low-stock" },
      total: 3,
    };
    const app = toRuleApplication(result);
    expect(app.apply).toEqual({ kind: "table", name: "low-stock" });
    expect(app.fires).toEqual([0, 2]);
  });

  it("table rule → one appliedCellStyle per fired row, offset past headers", () => {
    const result: RuleResult = {
      scope: "table-region",
      fires: [0, 2],
      apply: { action: "tableStyle", name: "low-stock" },
      total: 3,
    };
    const target: RuleTarget = {
      kind: "tableColumn",
      storyId: "s",
      tableId: "t1",
      col: 1,
      headerRows: 1,
    };
    const muts = ruleMutations(toRuleApplication(result), target);
    expect(muts).toHaveLength(2);
    const first = muts[0] as {
      op: string;
      args: { elementId: { kind: string; id: { row: number; col: number } }; path: string };
    };
    expect(first.op).toBe("setElementProperty");
    expect(first.args.path).toBe("appliedCellStyle");
    // Fired record 0 → table row 0 + 1 header row = row 1; col 1.
    expect(first.args.elementId).toEqual({
      kind: "tableCell",
      id: { story_id: "s", table_id: "t1", row: 1, col: 1 },
    });
    const second = muts[1] as { args: { elementId: { id: { row: number } } } };
    expect(second.args.elementId.id.row).toBe(3); // record 2 + 1 header
  });

  it("paragraph/character rule → one applyStyle over the story range", () => {
    const result: RuleResult = {
      scope: "story",
      fires: [0],
      apply: { action: "paragraphStyle", name: "Emphasis" },
      total: 1,
    };
    const muts = ruleMutations(toRuleApplication(result), {
      kind: "storyRange",
      storyId: "s",
      start: 0,
      end: 10,
    });
    expect(muts).toHaveLength(1);
    const m = muts[0] as { op: string; args: { style: string; scope: string } };
    expect(m.op).toBe("applyStyle");
    expect(m.args.style).toBe("Emphasis");
    expect(m.args.scope).toBe("paragraph");
  });

  it("mints a cell style by name (idempotent at the host)", () => {
    const m = createRuleCellStyle("low-stock");
    expect(m.op).toBe("createCellStyle");
    expect((m as { args: { selfId: string; name: string } }).args).toEqual({
      selfId: "low-stock",
      name: "low-stock",
    });
  });

  it("mismatched target kind yields no mutations (honest no-op)", () => {
    const result: RuleResult = {
      scope: "x",
      fires: [0],
      apply: { action: "tableStyle", name: "s" },
      total: 1,
    };
    // A table action with a storyRange target cannot apply per-cell → [].
    expect(
      ruleMutations(toRuleApplication(result), {
        kind: "storyRange",
        storyId: "s",
        start: 0,
        end: 1,
      }),
    ).toEqual([]);
  });
});
