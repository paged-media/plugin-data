import { describe, expect, it } from "vitest";

import {
  asciiJson,
  decodeAid,
  labelData,
  mergeLabel,
  oidOfSelector,
  oidSelector,
  planProperties,
  type PropertyApply,
} from "../property";

const sel = oidSelector("pd-1");
const write = (binding: string, path: string, value: unknown, color?: unknown): PropertyApply =>
  ({
    binding,
    property: {
      target: { selector: sel },
      path,
      outcome: { outcome: "write", value, ...(color ? { color } : {}) },
    },
  }) as PropertyApply;

describe("planProperties — ADR 558 triples to host.objects ops [data.bind.property]", () => {
  it("one set per targeted object, keep and fail skipped with their reason [data.bind.property]", () => {
    const plan = planProperties(
      [
        write("w", "frameStrokeWeight", 3),
        { binding: "k", property: { target: { selector: sel }, path: "x", outcome: { outcome: "keep", reason: "the value is missing" } } },
        { binding: "f", property: { target: { selector: sel }, path: "x", outcome: { outcome: "fail", message: "\"Middle\" is not one of …" } } },
      ],
      new Map([[sel, ["rectangle:a", "rectangle:b"]]]),
      [],
    );
    expect(plan.ops).toEqual([
      { op: "set", address: "rectangle:a", path: "frameStrokeWeight", value: 3 },
      { op: "set", address: "rectangle:b", path: "frameStrokeWeight", value: 3 },
    ]);
    expect(plan.bindings).toEqual(["w", "w"]);
    expect(plan.written).toEqual({ w: 2 });
    expect(plan.skipped).toEqual({ k: "the value is missing", f: "\"Middle\" is not one of …" });
    expect(plan.mint).toEqual([]);
  });

  it("a colour reuses a swatch by name or mints one under InDesign's name, once [data.bind.property]", () => {
    const red = { name: "R=255 G=0 B=0", spec: { space: "RGB", value: [255, 0, 0] } };
    const plan = planProperties(
      [
        write("a", "frameFillColor", "Paper", { name: "Paper" }),
        write("b", "frameFillColor", red.name, red),
        write("c", "frameStrokeColor", red.name, red),
      ],
      new Map([[sel, ["rectangle:a"]]]),
      [{ selfId: "Color/Paper", name: "Paper" }],
    );
    expect(plan.ops.map((o) => (o as { value: unknown }).value)).toEqual(["Color/Paper", "Color/R=255 G=0 B=0", "Color/R=255 G=0 B=0"]);
    expect(plan.mint).toEqual([
      {
        op: "createSwatch",
        args: { spec: { selfId: "Color/R=255 G=0 B=0", name: "R=255 G=0 B=0", space: "RGB", value: [255, 0, 0], model: "Process" } },
      },
    ]);
  });

  it("an unknown swatch name and an empty target are reasons, not guesses [data.bind.property]", () => {
    const plan = planProperties(
      [write("a", "frameFillColor", "Nope", { name: "Nope" }), write("b", "frameStrokeWeight", 1)],
      new Map([[sel, []]]),
      [],
    );
    expect(plan.ops).toEqual([]);
    expect(plan.skipped.a).toContain("names no object");
    expect(plan.skipped.b).toContain("names no object");
    const named = planProperties([write("a", "frameFillColor", "Nope", { name: "Nope" })], new Map([[sel, ["rectangle:a"]]]), []);
    expect(named.skipped.a).toBe('no swatch named "Nope" in this document');
  });

  it("a host target resolves through the binding's oid [data.bind.property]", () => {
    const plan = planProperties(
      [{ binding: "h", property: { target: "host", path: "elementVisible", outcome: { outcome: "write", value: false } } }],
      new Map([[oidSelector("pd-9"), ["textFrame:t"]]]),
      [],
      { h: "pd-9" },
    );
    expect(plan.ops).toEqual([{ op: "set", address: "textFrame:t", path: "elementVisible", value: false }]);
  });
});

describe("labels — ADR 559 [data.persist.labels]", () => {
  it("the oid selector round-trips its id [data.persist.labels]", () => {
    expect(oidOfSelector(oidSelector("pd-ab12"))).toBe("pd-ab12");
    expect(oidOfSelector("textFrame[name=x]")).toBeNull();
  });

  it("label values are ASCII; InDesign's <?AID?> re-encoding decodes back [data.persist.labels]", () => {
    const json = asciiJson({ v: 1, data: { note: "Grüße 😀" } });
    expect(json).toMatch(/^[\x00-\x7f]*$/);
    expect(JSON.parse(json).data.note).toBe("Grüße 😀");
    // What InDesign writes for a raw-UTF-8 emoji after one save.
    const aid = '{"v":1,"data":{"note":"<?AID d83d?><?AID de00?>"}}';
    expect(decodeAid(aid)).toBe('{"v":1,"data":{"note":"😀"}}');
    expect(labelData(aid)).toEqual({ note: "😀" });
  });

  it("merging keeps a lowered content's keys and replaces only ours [data.persist.labels]", () => {
    const lowered = { kind: "table", binding: "tbl", def: "abc", session: "def" };
    const merged = JSON.parse(mergeLabel(lowered, { oid: "pd-1", bind: [{ id: "tbl" }] })!);
    expect(merged).toEqual({ v: 1, data: { ...lowered, oid: "pd-1", bind: [{ id: "tbl" }] } });
    // Removing ours leaves theirs; nothing left → null (the key is cleared).
    expect(JSON.parse(mergeLabel(merged.data, null)!).data).toEqual(lowered);
    expect(mergeLabel({ oid: "pd-1", bind: [] }, null)).toBeNull();
  });
});
