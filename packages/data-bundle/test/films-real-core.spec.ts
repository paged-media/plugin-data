// The paged.media films' data scenes against the REAL stack: real core
// (canvas-wasm, headless host with `host.objects`), the real data-js engine
// and real DuckDB. Each test is a defect the films recorded:
//
//   · an unindexed EAN-13 barcode over the product list encodes the FIRST
//     row's EAN (it encoded the alphabetically first product's);
//   · Data Merge keeps the template frame's own formatting — fill, inset,
//     stroke (merged frames came out unfilled, with no inset);
//   · Data Merge runs from a script: `media.paged.data.merge` through
//     host.objects, the same path the menu command takes.
//
// Gate: skips without canvas-wasm, DuckDB or the built data-js wasm, EXCEPT
// under REQUIRE_REAL_CORE=1 / REQUIRE_REAL_DUCKDB=1.

import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { ENGINE_ANCHOR, openRealHost, REQUIRE_REAL_CORE } from "./real-core";
import { bootRealDuckDB, bootRealEngine, DATA_JS_WASM, REQUIRE_REAL_DUCKDB } from "./real-duckdb";

/** The first rows of the films' product list, in file order: the first row is
 *  not the first by content ("Bookmark set" sorts before it). */
const CSV = [
  "name,detail,price,sku,ean",
  'Linen notebook,"A5, 192 pages, lay-flat binding",€ 24,NB-A5-01,2000000210018',
  'Pocket notebook,"A6, 96 pages, dotted grid",€ 12,NB-A6-02,2000000210025',
  'Desk pad,"A4, 50 tear-off sheets",€ 16,DP-A4-03,2000000210032',
  'Bookmark set,"Brass, set of 3",€ 13,BM-3-20,2000000210209',
  'Card holder,"Walnut, desk stand",€ 29,CH-WN-24,2000000210247',
  "",
].join("\n");

const probe = await bootRealDuckDB();
const ready = ENGINE_ANCHOR !== null && probe.handle !== undefined && existsSync(DATA_JS_WASM);
const required = REQUIRE_REAL_CORE || REQUIRE_REAL_DUCKDB;

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
type Bounds = [number, number, number, number];

/** Read an EAN-13 back from its bars (the data film's decoder): 95 modules
 *  between the outer guards, each dark when a bar covers its centre. */
function decodeEan13(bars: Bounds[]): string {
  const left = Math.min(...bars.map((b) => b[1]));
  const right = Math.max(...bars.map((b) => b[3]));
  const unit = (right - left) / 95;
  let bits = "";
  for (let m = 0; m < 95; m++) {
    const x = left + (m + 0.5) * unit;
    bits += bars.some((b) => x > b[1] && x < b[3]) ? "1" : "0";
  }
  const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
  const G = L.map((c) => [...c].map((x) => (x === "1" ? "0" : "1")).reverse().join(""));
  const R = L.map((c) => [...c].map((x) => (x === "1" ? "0" : "1")).join(""));
  const FIRST = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];
  if (bits.slice(0, 3) !== "101" || bits.slice(45, 50) !== "01010" || bits.slice(92) !== "101") throw new Error(`not EAN-13: ${bits}`);
  let parity = "";
  let digits = "";
  for (let i = 0; i < 6; i++) {
    const c = bits.slice(3 + i * 7, 10 + i * 7);
    const l = L.indexOf(c);
    const g = G.indexOf(c);
    if (l >= 0) (digits += l), (parity += "L");
    else if (g >= 0) (digits += g), (parity += "G");
    else throw new Error(`left digit ${i}: ${c}`);
  }
  for (let i = 0; i < 6; i++) {
    const r = R.indexOf(bits.slice(50 + i * 7, 57 + i * 7));
    if (r < 0) throw new Error(`right digit ${i}`);
    digits += r;
  }
  return `${FIRST.indexOf(parity)}${digits}`;
}

/** Every element of one kind in the document, by a scene-tree walk. */
async function elementsOf(host: BundleHost, kind: string): Promise<ElementId[]> {
  const out: ElementId[] = [];
  type Node = { id?: ElementId | null; children?: Node[] };
  const walk = (ns: readonly Node[]) => {
    for (const n of ns) {
      if (n.id?.kind === kind) out.push(n.id);
      if (n.children) walk(n.children);
    }
  };
  walk((await host.document.tree()) as unknown as Node[]);
  return out;
}

/** One property of an element, as core reads it back. */
async function prop(host: BundleHost, id: ElementId, path: string): Promise<unknown> {
  const props = await host.document.elementProperties(id);
  return (props?.entries as { path: string; value?: { value?: unknown } | null }[] | undefined)?.find((e) => e.path === path)?.value
    ?.value;
}

describe.skipIf(!ready && !required)("the films' data scenes, real core + engine + DuckDB [data.plugin.bundle]", () => {
  const hosts: HeadlessHost[] = [];
  afterEach(() => {
    while (hosts.length) hosts.pop()!.dispose();
  });

  async function open(mod: Mod) {
    const h = await openRealHost();
    hosts.push(h);
    let bundleHost!: BundleHost;
    h.loadBundle({
      ...mod.dataBundle,
      activate: (bh: BundleHost) => {
        bundleHost = bh;
        return mod.dataBundle.activate(bh);
      },
    } as typeof mod.dataBundle);
    const s = mod.sessionFor(bundleHost)!;
    await s.whenRestored();
    await s.registerCsvSource("catalogue", CSV);
    // The Bindings panel's "All rows of catalogue".
    s.addQuery("q_all", "SELECT * FROM catalogue", "recordStream");
    await s.refreshData();
    return { h, host: bundleHost, s };
  }

  /** The data film's card template on the page: <<field>> frames, each
   *  filled with a swatch and inset, the way a designer formats a card. */
  async function cardTemplate(host: BundleHost): Promise<{ swatch: string; frames: ElementId[] }> {
    const sw = await host.document.mutate({ op: "createSwatch", args: { spec: { name: "Sand", space: "RGB", value: [238, 226, 205] } } } as never);
    expect(sw.applied).toBe(true);
    const swatch = ((await host.document.collection<{ name: string; selfId: string }>("swatches")).find((s) => s.name === "Sand"))!.selfId;
    const frames: ElementId[] = [];
    for (const [bounds, text] of [
      [[72, 72, 110, 300], "<<name>>"],
      [[114, 72, 150, 300], "SKU <<sku>>"],
    ] as const) {
      const r = await host.document.mutate({ op: "insertTextFrame", args: { pageId: "usp", bounds: [...bounds] } } as never);
      expect(r.applied).toBe(true);
      const id = (r as { createdId: ElementId }).createdId;
      const g = await host.document.elementGeometry([id]);
      const storyId = (g[0] as { storyId?: string }).storyId!;
      for (const op of [
        { op: "insertText", args: { storyId, offset: 0, text } },
        { op: "setElementProperty", args: { elementId: id, path: "frameFillColor", value: { type: "colorRef", value: swatch } } },
        { op: "setElementProperty", args: { elementId: id, path: "frameInsetSpacing", value: { type: "bounds", value: [14, 16, 14, 16] } } },
        { op: "setElementProperty", args: { elementId: id, path: "frameStrokeWeight", value: { type: "length", value: 2 } } },
        { op: "setElementProperty", args: { elementId: id, path: "textFrameVerticalJustification", value: { type: "text", value: "CenterAlign" } } },
      ]) {
        expect((await host.document.mutate(op as never)).applied, op.op).toBe(true);
      }
      frames.push(id);
    }
    return { swatch, frames };
  }

  it("DATA-1: an unindexed EAN-13 barcode encodes the first row's EAN [data.barcode.symbology]", async () => {
    expect(ready, "real core, DuckDB and the data-js wasm must all be available").toBe(true);
    const mod = await loadBundleModule();
    const { host, s } = await open(mod);
    s.addBarcodeBinding("bc", "urect", "q_all", "ean13", "ean");
    await s.lowerBinding("bc");
    expect(s.getState().message).toMatch(/Resolved \+ lowered barcode/);
    const bars = await host.document.elementGeometry(await elementsOf(host, "polygon"));
    expect(bars.length).toBeGreaterThan(20);
    expect(decodeEan13(bars.map((b) => b.bounds as Bounds))).toBe("2000000210018");
    // The preview stepper's record 4 is the fourth row, Bookmark set.
    await s.previewRecord("bc", 3);
    const stepped = await host.document.elementGeometry(await elementsOf(host, "polygon"));
    expect(decodeEan13(stepped.map((b) => b.bounds as Bounds))).toBe("2000000210209");
  });

  it("DATA-2: merged frames keep the template frame's fill, inset and stroke [data.lower.merge-writer]", async () => {
    expect(ready, "real core, DuckDB and the data-js wasm must all be available").toBe(true);
    const mod = await loadBundleModule();
    const { host, s } = await open(mod);
    const { swatch } = await cardTemplate(host);
    const r = await s.mergeRecords({ query: "q_all", template: "consume", recordsPerPage: { mode: "single" } });
    expect(r.ok, r.diagnostics.join("; ")).toBe(true);
    expect(r.records.length).toBe(5);
    const merged = r.records.flatMap((rec) => rec.frames.map((f) => f.element));
    expect(merged.length).toBe(10);
    for (const id of merged) {
      expect(await prop(host, id, "frameFillColor"), `fill of ${id.id}`).toBe(swatch);
      expect(await prop(host, id, "frameInsetSpacing"), `inset of ${id.id}`).toEqual([14, 16, 14, 16]);
      expect(await prop(host, id, "frameStrokeWeight"), `stroke of ${id.id}`).toBe(2);
      expect(await prop(host, id, "textFrameVerticalJustification")).toBe("CenterAlign");
    }
    // Still one undo step, and the undo brings the template back.
    expect(r.mutateCalls).toBe(1);
  });

  it("DATA-4: a script starts Data Merge through media.paged.data.merge, as the menu does [data.object-model]", async () => {
    expect(ready, "real core, DuckDB and the data-js wasm must all be available").toBe(true);
    const mod = await loadBundleModule();
    const { h, host } = await open(mod);
    await cardTemplate(host);
    const commands = (await h.objects.commands()).filter((c) => c.owner === "media.paged.data").map((c) => c.id);
    expect(commands).toContain("media.paged.data.merge");
    const out = (await h.objects.invoke("media.paged.data.merge", {
      query: "q_all",
      mode: "multiple",
      arrange: "rows",
      template: "consume",
    })) as { ok: boolean; records: number; pages: number; overset: number; message: string };
    expect(out.ok, out.message).toBe(true);
    expect(out.records).toBe(5);
    expect(out.message).toMatch(/^Merged 5 record\(s\) onto \d+ page\(s\)/);
    // Every record's name is on a page, nothing of the template is left.
    const texts: string[] = [];
    for (const id of await elementsOf(host, "textFrame")) {
      const g = await host.document.elementGeometry([id]);
      const story = (g[0] as { storyId?: string }).storyId;
      const c = story ? await host.document.storyContent(story) : null;
      texts.push(c ? c.paragraphs.map((p) => p.runs.map((x) => x.text).join("")).join("\n") : "");
    }
    expect(texts.filter((t) => t.includes("<<"))).toEqual([]);
    for (const n of ["Linen notebook", "Bookmark set", "Card holder"]) expect(texts).toContain(n);

    // No arguments: the menu's defaults — the first query, one record per
    // page, on new pages after the template, which stays.
    const other = await open(mod);
    await cardTemplate(other.host);
    const plain = (await other.h.objects.invoke("media.paged.data.merge", {})) as { ok: boolean; records: number; pages: number };
    expect(plain).toMatchObject({ ok: true, records: 5, pages: 5 });
    expect((await other.host.document.collection("pages")).length).toBe(6);
  });
});
