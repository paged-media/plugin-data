// ADR 559's InDesign lane: do the bindings survive InDesign, and does
// InDesign merge our Data Merge template?
//
//   PAGED_RECORD_INDESIGN_FIXTURES=1 vitest run test/indesign-binding.spec.ts
//     writes conformance/indesign-binding/fixtures/ (paged authors them on the
//     real stack): bound.idml — a document with property, visibility and
//     table bindings, saved by paged then stripped of its container parts —
//     and dm-template.idml + dm.csv (our "Export as InDesign Data Merge
//     template").
//   bash conformance/indesign-binding/record.sh
//     InDesign 2025 opens each fixture, records what it sees
//     (recorded/<id>.json: labels, Data Merge fields and placeholders, the
//     merged records) and saves it again (recorded/<id>.rt.idml).
//
// The REPLAY (this spec, always): paged opens InDesign's re-save and rebuilds
// every binding from the labels; the recorded merge is what the data says.

import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BundleHost } from "@paged-media/plugin-api";

import { ENGINE_ANCHOR, openRealHost, REQUIRE_REAL_CORE } from "./real-core";
import { bootRealDuckDB, bootRealEngine, DATA_JS_WASM, REQUIRE_REAL_DUCKDB } from "./real-duckdb";
import { stripContainerParts } from "./zip";

const LANE = fileURLToPath(new URL("../../../conformance/indesign-binding/", import.meta.url));
const STAGE = "/tmp/paged-data-binding-stage";
const CSV = "sku,name,weight_mm,tint,shown\nA-1,Grüne Äpfel,2,\"cmyk(0,100,100,0)\",yes\nB-2,Blue,4,Black,no\nC-3,Cyan,1,#00ffff,yes\n";
const RECORD = process.env.PAGED_RECORD_INDESIGN_FIXTURES === "1";

const probe = await bootRealDuckDB();
const ready = ENGINE_ANCHOR !== null && probe.handle !== undefined && existsSync(DATA_JS_WASM);
const recorded = (id: string) => join(LANE, "recorded", `${id}.json`);

async function bundle() {
  vi.resetModules();
  vi.doMock("../src/engine", async (orig) => ({ ...(await orig<typeof import("../src/engine")>()), bootEngine: (t: number) => bootRealEngine(t) }));
  vi.doMock("../src/query/duckdb", async (orig) => ({
    ...(await orig<typeof import("../src/query/duckdb")>()),
    bootDuckDB: async () => (await bootRealDuckDB()).handle!,
  }));
  return import("../src/index");
}

async function open(mod: Awaited<ReturnType<typeof bundle>>, bytes?: Uint8Array) {
  const h = await openRealHost();
  if (bytes) await h.load(bytes);
  let host!: BundleHost;
  h.loadBundle({ ...mod.dataBundle, activate: (bh) => ((host = bh), mod.dataBundle.activate(bh)) } as typeof mod.dataBundle);
  const s = mod.sessionFor(host)!;
  await s.whenRestored();
  return { h, host, s };
}

/** The bindings a document's session holds, as definitions (sorted). */
async function definitions(s: { listBindings(): { id: string }[]; bindingDefinition(id: string): Promise<Record<string, unknown> | null> }) {
  const out: Record<string, unknown> = {};
  for (const b of s.listBindings().sort((a, b) => a.id.localeCompare(b.id))) {
    const def = { ...(await s.bindingDefinition(b.id)) };
    // Raw targets are today's Self ids, which InDesign renumbers.
    if (def.kind === "visibility" || def.kind === "table") delete def[def.kind === "table" ? "region" : "target"];
    out[b.id] = def;
  }
  return out;
}

describe.skipIf(!RECORD || !ready)("record the InDesign binding fixtures (local) [data.persist.labels]", () => {
  it("writes bound.idml and the Data Merge template [data.persist.labels]", async () => {
    const mod = await bundle();
    const { h, host, s } = await open(mod);
    await s.registerCsvSource("products", CSV);
    s.addQuery("q", "SELECT * FROM products ORDER BY sku", "recordStream");
    await s.refreshData();
    await s.addPropertyBinding("weight", { target: "rectangle:urect", path: "frameStrokeWeight", query: "q", expr: "MM(weight_mm)" });
    await s.addPropertyBinding("fill", { target: "rectangle:urect", path: "frameFillColor", query: "q", expr: "tint" });
    const tf = await host.document.mutate({ op: "insertTextFrame", args: { pageId: "usp", bounds: [40, 40, 90, 400] } } as never);
    const frame = (tf.createdId as { id: string }).id;
    await s.addPropertyBinding("opacity", { target: `textFrame:${frame}`, path: "frameOpacity", query: "q", expr: 'IF(shown = "yes", 100, 40)' });
    s.addVisibilityBinding("badge", frame, "q", "shown", { kind: "textFrame" });
    const story = (await host.document.collection<{ selfId: string }>("stories"))[0]!.selfId;
    await host.document.mutate({ op: "insertText", args: { storyId: story, offset: 0, text: "SKU: <<sku>> / " } } as never);
    s.addVariableBinding("v_name", "v_name", "q", "name");
    await s.lowerAll();
    await h.willSave.fire();
    const reply = (await host.editor.client.send({ kind: "exportPaged", payload: {} } as never)) as { payload: { bytes: number[] } };
    mkdirSync(join(LANE, "fixtures"), { recursive: true });
    writeFileSync(join(LANE, "fixtures", "bound.idml"), stripContainerParts(Uint8Array.from(reply.payload.bytes)));
    writeFileSync(join(LANE, "fixtures", "bound.definitions.json"), JSON.stringify(await definitions(s), null, 2) + "\n");
    const dm = await s.exportDataMergeTemplate({ dataSourceFile: `${STAGE}/dm.csv` });
    expect(dm.ok, dm.reason).toBe(true);
    writeFileSync(join(LANE, "fixtures", "dm-template.idml"), dm.idml!);
    writeFileSync(join(LANE, "fixtures", "dm.csv"), dm.csv!);
    h.dispose();
  });
});

describe.skipIf(!ready && !(REQUIRE_REAL_CORE || REQUIRE_REAL_DUCKDB))("replay the InDesign recordings [data.persist.labels]", () => {
  it.skipIf(!existsSync(recorded("bound")))("InDesign kept every label: paged rebuilds every binding from InDesign's re-save [data.persist.labels]", async () => {
    const rec = JSON.parse(readFileSync(recorded("bound"), "utf8")) as {
      open: string;
      labels: { item: string; name: string; value: string }[];
    };
    expect(rec.open).toBe("ok");
    // InDesign returned our labels on the rectangle and the text frame.
    expect(rec.labels.map((l) => l.item).sort()).toEqual(["Rectangle", "TextFrame", "TextFrame"]);
    const mod = await bundle();
    const rt = new Uint8Array(readFileSync(join(LANE, "recorded", "bound.rt.idml")));
    const { s, h } = await open(mod, rt);
    const want = JSON.parse(readFileSync(join(LANE, "fixtures", "bound.definitions.json"), "utf8"));
    expect(await definitions(s)).toEqual(want);
    expect(s.getState().relink).toEqual(["products"]);
    // Re-link the data; the bindings drive InDesign's document.
    await s.registerCsvSource("products", CSV);
    await s.refreshData();
    const r = await s.applyProperties({ record: 1, withVisibility: true });
    expect(r.applied).toBe(4);
    expect(r.undoSteps).toBe(1);
    h.dispose();
  });

  it.skipIf(!existsSync(recorded("dm-template")))("InDesign merges our Data Merge template [data.export.datamerge]", () => {
    const rec = JSON.parse(readFileSync(recorded("dm-template"), "utf8")) as {
      open: string;
      data_merge: { fields: string[]; text_placeholders: string[] };
      merge: { page_count: number; pages: { texts: string[] }[] } | string;
    };
    expect(rec.open).toBe("ok");
    expect(rec.data_merge.fields).toEqual(["sku", "name"]);
    expect([...rec.data_merge.text_placeholders].sort()).toEqual(["name", "sku"]);
    expect(typeof rec.merge).toBe("object");
    const merge = rec.merge as { page_count: number; pages: { texts: string[] }[] };
    expect(merge.page_count).toBe(3);
    const texts = merge.pages.map((p) => p.texts.join(" | "));
    expect(texts[0]).toContain("SKU: A-1 / ");
    expect(texts[0]).toContain("Grüne Äpfel");
    expect(texts[2]).toContain("SKU: C-3 / ");
  });
});
