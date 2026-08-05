// The pure §9.8 visibility + §9.9 data-set-apply translators. Every assertion
// here is about SHAPE (which op, which args) and about UNDO COST (how many
// mutations the host is asked to apply) — the two things a pure layer can pin
// without a host.

import { describe, expect, it } from "vitest";

import {
  dataSetBatch,
  dataSetPlan,
  visibilityMutation,
  visibilityTarget,
  visibilityToMutations,
  type DataSetApply,
} from "../index";

describe("§9.8 — the visibility variable", () => {
  it("writes core's own elementVisible property, not a parallel system", () => {
    const m = visibilityMutation(visibilityTarget("rectangle", "u123"), false);
    expect(m).toEqual({
      op: "setElementProperty",
      args: {
        elementId: { kind: "rectangle", id: "u123" },
        path: "elementVisible",
        value: { type: "bool", value: false },
      },
    });
  });

  it("emits NOTHING for the Leave missing policy", () => {
    const target = visibilityTarget("textFrame", "u9");
    expect(
      visibilityToMutations({ kind: "visibility", target: "u9", visible: null }, target),
    ).toEqual([]);
    // ...and exactly one op when the engine did decide.
    expect(
      visibilityToMutations({ kind: "visibility", target: "u9", visible: true }, target),
    ).toHaveLength(1);
  });
});

describe("§9.9 — applying a data set", () => {
  const applies: DataSetApply[] = [
    { variable: "Name", kind: "text", text: "Beta", applicable: true },
    { variable: "Photo", kind: "image", href: "images/beta.png", applicable: true },
    { variable: "Badge", kind: "visibility", visible: false, applicable: true },
  ];
  const targets = {
    fields: { Name: { storyId: "s1", offset: 12 } },
    frames: { Photo: "u55" },
    elements: { Badge: visibilityTarget("rectangle", "u77") },
  };

  it("routes each trait to the door that already ships for it", () => {
    const plan = dataSetPlan(applies, targets);
    expect(plan.skipped).toEqual({});
    expect(plan.ops).toEqual([
      { op: "setFieldValue", args: { storyId: "s1", offset: 12, value: "Beta" } },
      {
        op: "placeImage",
        args: { elementId: "u55", uri: "images/beta.png", fit: "Proportionally" },
      },
      {
        op: "setElementProperty",
        args: {
          elementId: { kind: "rectangle", id: "u77" },
          path: "elementVisible",
          value: { type: "bool", value: false },
        },
      },
    ]);
  });

  it("MEASURES the undo cost: switching a data set is ONE undo step", () => {
    const plan = dataSetPlan(applies, targets);
    const batch = dataSetBatch(plan);
    // 3 variables move. The host is asked to apply exactly ONE mutation, so the
    // user presses undo once — not once per variable.
    expect(batch).not.toBeNull();
    expect(batch!.op).toBe("batch");
    expect((batch!.args as { ops: unknown[] }).ops).toHaveLength(3);

    // The claim scales: a 12-variable data set is still one undo step.
    const many: DataSetApply[] = Array.from({ length: 12 }, (_, i) => ({
      variable: `v${i}`,
      kind: "text" as const,
      text: `x${i}`,
      applicable: true,
    }));
    const fields = Object.fromEntries(
      many.map((a, i) => [a.variable, { storyId: "s1", offset: i * 4 }]),
    );
    const big = dataSetBatch(dataSetPlan(many, { fields }));
    expect(big!.op).toBe("batch");
    expect((big!.args as { ops: unknown[] }).ops).toHaveLength(12);
  });

  it("never burns an undo step on a no-op", () => {
    expect(dataSetBatch({ ops: [], skipped: {} })).toBeNull();
    // A plan of nothing-but-skips also commits nothing.
    const onlySkips = dataSetPlan(
      [{ variable: "Sales", kind: "graphData", applicable: false, note: "RFI D-15" }],
      {},
    );
    expect(onlySkips.ops).toEqual([]);
    expect(dataSetBatch(onlySkips)).toBeNull();
  });

  it("records WHY each row was skipped instead of half-applying in silence", () => {
    const plan = dataSetPlan(
      [
        ...applies,
        { variable: "Sales", kind: "graphData", applicable: false, note: "no chart surface" },
        { variable: "Orphan", kind: "text", text: "x", applicable: false, note: "no binding" },
        { variable: "Unplaced", kind: "text", text: "y", applicable: true },
        { variable: "NoFrame", kind: "image", href: "a.png", applicable: true },
        { variable: "NoElement", kind: "visibility", visible: true, applicable: true },
      ],
      targets,
    );
    expect(plan.ops).toHaveLength(3);
    expect(Object.keys(plan.skipped).sort()).toEqual([
      "NoElement",
      "NoFrame",
      "Orphan",
      "Sales",
      "Unplaced",
    ]);
    expect(plan.skipped.Sales).toBe("no chart surface");
    expect(plan.skipped.Unplaced).toContain("no placeholder field");
  });

  it("clears a text variable rather than writing the string 'null'", () => {
    const plan = dataSetPlan([{ variable: "Name", kind: "text", applicable: true }], {
      fields: { Name: { storyId: "s1", offset: 0 } },
    });
    expect(plan.ops[0]).toEqual({
      op: "setFieldValue",
      args: { storyId: "s1", offset: 0, value: null },
    });
  });

  it("honors an explicit IDML fit on an image swap", () => {
    const plan = dataSetPlan(
      [{ variable: "Photo", kind: "image", href: "b.png", applicable: true }],
      { frames: { Photo: "u1" }, fit: "FillProportionally" },
    );
    expect(plan.ops[0]).toMatchObject({
      args: { fit: "FillProportionally" },
    });
  });
});
