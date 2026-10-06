// Engine protocol 71 + SDK 0.2.44 against the REAL stack (real core, the real
// data-js engine, real DuckDB):
//
//   · a variable binding is placed as a CUSTOM TEXT VARIABLE `paged:<id>`
//     (ADR 559: InDesign keeps it and shows its value), refreshed by ONE `Set`
//     on its contents (one undo step), and exported to IDML as InDesign's own
//     <TextVariable> + <TextVariableInstance>;
//   · a document made with a placeholder field keeps being refreshed through
//     it (no second carrier is placed);
//   · a literal colour's new swatch is created in the apply's own
//     host.objects batch: swatch + apply = ONE undo step;
//   · a table rule writes `appliedCellStyle` on `cell:` addresses through
//     host.objects, its cell style created in the same batch: ONE undo step;
//   · the parts stripped the way InDesign strips them: the variable binding
//     comes back from the document label in designmap.xml, and its text
//     variable is still in the text.
//
// Every test here needs engine protocol 71; on an older engine the suite is
// skipped (the 0.70 lane keeps the placeholder field, the two-step swatch and
// the setElementProperty rule path — covered by the other real-core specs).

import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";

import type { BundleHost } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { ENGINE_ANCHOR, ENGINE_PROTOCOL, openRealHost, REQUIRE_REAL_CORE } from "./real-core";
import { bootRealDuckDB, bootRealEngine, DATA_JS_WASM, REQUIRE_REAL_DUCKDB } from "./real-duckdb";
import { readZip, stripContainerParts, text } from "./zip";

const CSV = "sku,name,weight_mm,tint\nA-1,Alpha,2,#ff0000\nB-2,Beta,4,Black\nC-3,Gamma,1,Black\n";
const CSV2 = "sku,name,weight_mm,tint\nA-1,Alpha Two,2,#ff0000\nB-2,Beta,4,Black\nC-3,Gamma,1,Black\n";
const TV = "textVariable:dTextVariablenpaged:v_name";

const probe = await bootRealDuckDB();
const ready = ENGINE_ANCHOR !== null && probe.handle !== undefined && existsSync(DATA_JS_WASM);
const required = REQUIRE_REAL_CORE || REQUIRE_REAL_DUCKDB;
const v71 = ENGINE_PROTOCOL >= 71;

async function loadBundleModule() {
  vi.resetModules();
  vi.doMock("../src/engine", async (orig) => ({
    ...(await orig<typeof import("../src/engine")>()),
    bootEngine: (today: number) => bootRealEngine(today),
  }));
  vi.doMock("../src/query/duckdb", async (orig) => ({
    ...(await orig<typeof import("../src/query/duckdb")>()),
    bootDuckDB: async () => {
      const b = await bootRealDuckDB();
      if (!b.handle) throw new Error(b.error);
      return b.handle;
    },
  }));
  return import("../src/index");
}

type Mod = Awaited<ReturnType<typeof loadBundleModule>>;

async function exportPaged(host: BundleHost): Promise<Uint8Array> {
  const reply = (await host.editor.client.send({ kind: "exportPaged", payload: {} } as never)) as {
    kind: string;
    payload: { bytes?: number[]; error?: string };
  };
  if (reply.kind !== "pagedExported") throw new Error(`exportPaged: ${reply.kind} ${reply.payload.error ?? ""}`);
  return Uint8Array.from(reply.payload.bytes!);
}

describe.skipIf(!v71 || (!ready && !required))("engine protocol 71: text variables, creates in the batch, cell addresses [data.bind.property]", () => {
  const hosts: HeadlessHost[] = [];
  afterEach(() => {
    while (hosts.length) hosts.pop()!.dispose();
  });

  async function open(mod: Mod, bytes?: Uint8Array) {
    const h = await openRealHost();
    if (bytes) await h.load(bytes);
    hosts.push(h);
    let host!: BundleHost;
    h.loadBundle({ ...mod.dataBundle, activate: (bh: BundleHost) => ((host = bh), mod.dataBundle.activate(bh)) } as typeof mod.dataBundle);
    const s = mod.sessionFor(host)!;
    await s.whenRestored();
    return { h, host, s };
  }

  async function seed(s: NonNullable<ReturnType<Mod["sessionFor"]>>, csv = CSV) {
    await s.registerCsvSource("products", csv);
    s.addQuery("q", "SELECT * FROM products ORDER BY sku", "recordStream");
    await s.refreshData();
  }

  const contents = async (h: HeadlessHost) => ((await h.objects.get(TV, "textVariableContents")) as { value?: unknown }).value;

  /** Every story's text, joined. */
  async function allText(host: BundleHost): Promise<string> {
    const out: string[] = [];
    for (const st of await host.document.collection<{ selfId: string }>("stories")) {
      const c = await host.document.storyContent(st.selfId);
      out.push((c?.paragraphs ?? []).map((p) => p.runs.map((r) => r.text).join("")).join("\n"));
    }
    return out.join("\n");
  }

  it("a variable binding is a custom text variable; one Set refreshes it, one undo takes it back [data.bind.text-variables]", async () => {
    expect(ready, "real core, DuckDB and the data-js wasm must all be available").toBe(true);
    const mod = await loadBundleModule();
    const { h, host, s } = await open(mod);
    await seed(s);
    s.addVariableBinding("v_name", "v_name", "q", "name");
    await s.lowerAll();
    expect(await h.objects.query("textVariable")).toContain(TV);
    expect(await contents(h)).toBe("Alpha");
    expect(await host.document.placeholders()).toEqual([]);
    expect(await allText(host)).toContain("Alpha");

    await s.registerCsvSource("products", CSV2);
    await s.refreshData();
    const mutate = vi.spyOn(host.document, "mutate");
    expect(await s.refreshFields()).toBe(1);
    // ONE write: the Set (the session label rides it in the same batch).
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(await contents(h)).toBe("Alpha Two");
    expect(await allText(host)).toContain("Alpha Two");
    // Nothing changed: no write at all.
    expect(await s.refreshFields()).toBe(0);
    expect(mutate).toHaveBeenCalledTimes(1);
    mutate.mockRestore();

    await host.document.undo();
    expect(await contents(h)).toBe("Alpha");
    expect(await allText(host)).toContain("Alpha");
    expect(await allText(host)).not.toContain("Alpha Two");
  });

  it("the text variable is exported as InDesign's own <TextVariable> and instance; the stripped file restores the binding from designmap.xml [data.persist.labels]", async () => {
    const mod = await loadBundleModule();
    const a = await open(mod);
    await seed(a.s);
    a.s.addVariableBinding("v_name", "v_name", "q", "name");
    await a.s.lowerAll();
    await a.h.willSave.fire();
    const saved = await exportPaged(a.host);
    const entries = readZip(saved);
    const designmap = text(entries.find((e) => e.name === "designmap.xml"));
    expect(designmap).toMatch(/<TextVariable Self="dTextVariablenpaged:v_name" Name="paged:v_name"[^>]*VariableType="CustomTextType"/);
    expect(designmap).toContain('<Contents type="string">Alpha</Contents>');
    // The document label (the recipe) is in designmap.xml too.
    expect(designmap).toContain('Key="x-paged:media.paged.data"');
    const stories = entries.filter((e) => e.name.startsWith("Stories/")).map(text).join("\n");
    expect(stories).toMatch(/<TextVariableInstance [^>]*ResultText="Alpha"[^>]*AssociatedTextVariable="dTextVariablenpaged:v_name"/);

    // What InDesign keeps: no container parts.
    const b = await open(mod, stripContainerParts(saved));
    expect(b.s.listBindings().map((x) => x.id)).toEqual(["v_name"]);
    expect(b.s.getState().relink).toEqual(["products"]);
    await seed(b.s, CSV2);
    expect(await b.s.refreshFields()).toBe(1);
    expect(await contents(b.h)).toBe("Alpha Two");
    // Placed already (the text variable is the field): Lower adds no second one.
    await b.s.lowerAll();
    expect((await b.h.objects.query("textVariable")).filter((x) => x === TV)).toHaveLength(1);
    expect((await allText(b.host)).match(/Alpha Two/g)).toHaveLength(1);
  });

  it("migration: a document whose variable is a placeholder field keeps being refreshed through it [data.bind.text-variables]", async () => {
    const mod = await loadBundleModule();
    const a = await open(mod);
    await seed(a.s);
    a.s.addVariableBinding("v_name", "v_name", "q", "name");
    // The field as an engine before protocol 71 placed it.
    const placed = await a.host.document.mutate({
      op: "batch",
      args: {
        ops: [
          { op: "insertTextFrame", args: { pageId: "usp", bounds: [40, 40, 90, 400] } },
          { op: "bindCreated", args: { handle: "f" } },
          { op: "insertField", args: { storyId: "$h:f", offset: 0, field: { placeholder: { plugin: "media.paged.data", key: "v_name", value: "Alpha" } } } },
        ],
      },
    } as never);
    expect(placed.applied).toBe(true);
    await a.h.willSave.fire();
    const saved = await exportPaged(a.host);

    const b = await open(mod, saved);
    await seed(b.s, CSV2);
    expect(await b.s.refreshFields()).toBe(1);
    const fields = await b.host.document.placeholders();
    expect(fields.map((f) => [f.key, f.value])).toEqual([["v_name", "Alpha Two"]]);
    // Lower does not place the variable again as a text variable.
    await b.s.lowerAll();
    expect(await b.h.objects.query("textVariable")).not.toContain(TV);
  });

  it("a new swatch is created in the apply's own batch: swatch + apply = ONE undo step [data.bind.property]", async () => {
    const mod = await loadBundleModule();
    const { h, host, s } = await open(mod);
    await seed(s);
    expect((await s.addPropertyBinding("fill", { target: "rectangle:urect", path: "frameFillColor", query: "q", expr: "tint" })).ok).toBe(true);
    const before = await h.objects.get("rectangle:urect", "frameFillColor");
    const mutate = vi.spyOn(host.document, "mutate");
    const r = await s.applyProperties({ record: 0 });
    expect(r.applied).toBe(1);
    expect(r.undoSteps).toBe(1);
    // One query (the target), one swatches read, one batch — the create rides it.
    expect(r.calls).toBe(3);
    expect(mutate).not.toHaveBeenCalled();
    expect(((await h.objects.get("rectangle:urect", "frameFillColor")) as { value: unknown }).value).toBe("Color/R=255 G=0 B=0");
    expect(await h.objects.query("swatch")).toContain("swatch:Color/R=255 G=0 B=0");
    await host.document.undo();
    expect(await h.objects.get("rectangle:urect", "frameFillColor")).toEqual(before);
    expect(await h.objects.query("swatch")).not.toContain("swatch:Color/R=255 G=0 B=0");
  });

  it("a table rule writes appliedCellStyle on cell: addresses, its style created in the same batch: ONE undo step [data.rule.authoring]", async () => {
    const mod = await loadBundleModule();
    const { h, host, s } = await open(mod);
    await seed(s);
    s.addTableBinding("t", "region", "q", [
      { header: "SKU", expr: "sku" },
      { header: "Weight", expr: "weight_mm" },
    ]);
    await s.lowerBinding("t");
    const tables = await h.objects.query("table");
    expect(tables).toHaveLength(1);
    const tableId = tables[0]!.slice("table:".length);
    const storyId = (await host.document.collection<{ selfId: string }>("stories"))[0]!.selfId;
    s.addRuleBinding("r", "table-region", "q", "weight_mm > 3", { action: "tableStyle", name: "heavy" }, {
      kind: "tableColumn",
      storyId,
      tableId,
      col: 1,
      headerRows: 1,
    });
    const cell = `cell:${tableId}/2,1`;
    const before = await h.objects.get(cell, "appliedCellStyle");
    const batch = vi.spyOn(host.objects, "batch");
    const mutate = vi.spyOn(host.document, "mutate");
    expect(await s.applyRule("r")).toBe(1);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
    expect(((await h.objects.get(cell, "appliedCellStyle")) as { value: unknown }).value).toBe("CellStyle/heavy");
    expect((await host.document.collection<{ selfId: string }>("cellStyles")).map((c) => c.selfId)).toContain("CellStyle/heavy");
    await host.document.undo();
    expect(await h.objects.get(cell, "appliedCellStyle")).toEqual(before);
    expect((await host.document.collection<{ selfId: string }>("cellStyles")).map((c) => c.selfId)).not.toContain("CellStyle/heavy");
  });
});
