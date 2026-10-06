// ADR 559 (engine protocol 71): a variable binding as a custom text variable,
// and the core-71 address spellings the binding writes. Pure: ops out.

import { describe, expect, it } from "vitest";

import {
  cellAddress,
  createTextVariableMutation,
  dataSetPlan,
  encodeAddressPart,
  fieldWriteMutation,
  insertTextVariableMutation,
  keyOfTextVariable,
  ruleCellOps,
  setTextVariableMutation,
  textVariableAddress,
  textVariableField,
  textVariableId,
} from "../index";

describe("custom text variables (ADR 559) [data.bind.text-variables]", () => {
  it("binding k is the text variable paged:k, its Self InDesign's spelling [data.bind.text-variables]", () => {
    expect(textVariableId("v_name")).toBe("dTextVariablenpaged:v_name");
    expect(textVariableAddress(textVariableId("v_name"))).toBe("textVariable:dTextVariablenpaged:v_name");
    expect(keyOfTextVariable("dTextVariablenpaged:v_name")).toBe("v_name");
    expect(keyOfTextVariable("textVariable:dTextVariablenpaged:v_name")).toBe("v_name");
    expect(keyOfTextVariable("paged:v_name")).toBe("v_name");
    // Not ours: an InDesign built-in and a user's custom variable.
    expect(keyOfTextVariable("dTextVariablenChapter Number")).toBeNull();
    expect(keyOfTextVariable("dTextVariablenpaged:")).toBeNull();
  });

  it("create, instance and Set ops [data.bind.text-variables]", () => {
    expect(createTextVariableMutation("v", "Alpha")).toEqual({
      op: "createTextVariable",
      args: { name: "paged:v", contents: "Alpha" },
    });
    // An unresolved value shows <key>, as the placeholder field does.
    expect(createTextVariableMutation("v", null)).toEqual({ op: "createTextVariable", args: { name: "paged:v", contents: "<v>" } });
    expect(insertTextVariableMutation("$h:f", 0, textVariableId("v"))).toEqual({
      op: "insertField",
      args: { storyId: "$h:f", offset: 0, field: { textVariable: { variableId: "dTextVariablenpaged:v" } } },
    });
    // An InDesign save re-spells the Self: the instance names the id read.
    expect(insertTextVariableMutation("u1", 7, "dTextVariablenpaged-v", 9).args).toMatchObject({
      offset: 7,
      contentOffset: 9,
      field: { textVariable: { variableId: "dTextVariablenpaged-v" } },
    });
    expect(setTextVariableMutation("dTextVariablenpaged:v", "v", "Beta")).toEqual({
      op: "set",
      args: { address: "textVariable:dTextVariablenpaged:v", path: "textVariableContents", value: { type: "text", value: "Beta" } },
    });
  });

  it("a text variable is a field to the refresh loops; a write is a Set, a placeholder's a setFieldValue [data.bind.text-variables]", () => {
    const f = textVariableField("dTextVariablenpaged:v", "v", "<v>");
    expect(f).toEqual({
      storyId: "textVariable:dTextVariablenpaged:v",
      offset: 0,
      plugin: "media.paged.data",
      key: "v",
      value: null,
      variable: "dTextVariablenpaged:v",
    });
    // InDesign's re-spelled id is carried as read; the key comes from the name.
    expect(textVariableField("dTextVariablenpaged-v", "v", "B").variable).toBe("dTextVariablenpaged-v");
    expect(keyOfTextVariable("dTextVariablenpaged-v")).toBeNull();
    expect(fieldWriteMutation(f, "B").op).toBe("set");
    expect(fieldWriteMutation({ storyId: "u1", offset: 3, key: "v" }, "B")).toEqual({
      op: "setFieldValue",
      args: { storyId: "u1", offset: 3, value: "B" },
    });
  });

  it("a data set's text row writes the text variable when it has one [data.bind.text-variables]", () => {
    const plan = dataSetPlan(
      [
        { variable: "a", kind: "text", text: "A", applicable: true },
        { variable: "b", kind: "text", text: "B", applicable: true },
      ],
      {
        fields: {
          a: { storyId: "textVariable:dTextVariablenpaged:a", offset: 0, variable: "dTextVariablenpaged:a" },
          b: { storyId: "u1", offset: 4 },
        },
      },
    );
    expect(plan.ops.map((o) => o.op)).toEqual(["set", "setFieldValue"]);
  });
});

describe("core 71 addresses (ADR 131) [data.bind.property]", () => {
  it("a cell address escapes only % and / in the table id [data.bind.property]", () => {
    expect(cellAddress("u1f3", 2, 1)).toBe("cell:u1f3/2,1");
    expect(cellAddress("Table/x%1", 0, 0)).toBe("cell:Table%2Fx%251/0,0");
    expect(encodeAddressPart("a@b", "@")).toBe("a%40b");
  });

  it("a fired table rule: the style created in the same batch, one set per fired cell [data.rule.authoring]", () => {
    expect(ruleCellOps("t1", 1, 1, [0, 2], "heavy", null)).toEqual([
      { op: "create", kind: "style", props: { family: "cell", name: "heavy" } },
      { op: "set", address: "cell:t1/1,1", path: "appliedCellStyle", value: "CellStyle/heavy" },
      { op: "set", address: "cell:t1/3,1", path: "appliedCellStyle", value: "CellStyle/heavy" },
    ]);
    // The document has the style: no create.
    expect(ruleCellOps("t1", 0, 0, [1], "heavy", "CellStyle/heavy")).toEqual([
      { op: "set", address: "cell:t1/1,0", path: "appliedCellStyle", value: "CellStyle/heavy" },
    ]);
    expect(ruleCellOps("t1", 0, 0, [], "heavy", null)).toEqual([]);
  });
});
