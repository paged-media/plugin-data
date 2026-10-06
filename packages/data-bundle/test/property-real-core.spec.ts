// ADR 558 / 559 against the REAL stack: real core (canvas-wasm, headless
// host with `host.objects`), the real data-js engine and real DuckDB.
//
//   · a property binding on a core frame property, written through
//     host.objects: set, step a record, undo ONE step;
//   · the binding lives in the frame's label (one key, ASCII JSON) and in the
//     document; a saved .paged reopens with it;
//   · the parts stripped the way InDesign strips them: the session comes back
//     from the labels, only the data asks to be re-linked;
//   · visibility re-expressed as `elementVisible` through the same lane;
//   · a canary.10-era session part loads, and its first save writes labels;
//   · data's own object model through `host.objects`;
//   · the count budget: 50 property bindings apply as ONE batch.
//
// Gate: skips without canvas-wasm, DuckDB or the built data-js wasm, EXCEPT
// under REQUIRE_REAL_CORE=1 / REQUIRE_REAL_DUCKDB=1.

import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { BundleHost } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { ENGINE_ANCHOR, fixedFrom, openRealHost, REQUIRE_REAL_CORE } from "./real-core";
import { bootRealDuckDB, bootRealEngine, DATA_JS_WASM, REQUIRE_REAL_DUCKDB } from "./real-duckdb";
import { readZip, stripContainerParts, text } from "./zip";

const KEY = "x-paged:media.paged.data";
const CSV = "sku,weight_mm,tint,shown\nA-1,2,#ff0000,yes\nB-2,4,Black,no\nC-3,,\"cmyk(0,100,0,0)\",yes\n";

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

async function exportPaged(host: BundleHost): Promise<Uint8Array> {
  const reply = (await host.editor.client.send({ kind: "exportPaged", payload: {} } as never)) as {
    kind: string;
    payload: { bytes?: number[]; error?: string };
  };
  if (reply.kind !== "pagedExported") throw new Error(`exportPaged: ${reply.kind} ${reply.payload.error ?? ""}`);
  return Uint8Array.from(reply.payload.bytes!);
}

type Mod = Awaited<ReturnType<typeof loadBundleModule>>;

describe.skipIf(!ready && !required)("universal property binding, real core + engine + DuckDB [data.bind.property]", () => {
  const hosts: HeadlessHost[] = [];
  afterEach(() => {
    while (hosts.length) hosts.pop()!.dispose();
  });

  /** A host with the data bundle loaded; `bundleHost` is the bundle's own. */
  async function open(mod: Mod, bytes?: Uint8Array) {
    const h = await openRealHost();
    if (bytes) await h.load(bytes);
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
    return { h, host: bundleHost, s };
  }

  async function seed(s: NonNullable<ReturnType<Mod["sessionFor"]>>) {
    await s.registerCsvSource("products", CSV);
    s.addQuery("q", "SELECT * FROM products ORDER BY sku", "recordStream");
    await s.refreshData();
  }

  const get = async (h: HeadlessHost, path: string) => (await h.objects.get("rectangle:urect", path)) as { kind: string; value?: unknown };

  it("binds a core frame property through host.objects; one apply is one undo step [data.bind.property]", async () => {
    expect(ready, "real core, DuckDB and the data-js wasm must all be available").toBe(true);
    const mod = await loadBundleModule();
    const { h, host, s } = await open(mod);
    await seed(s);

    const r = await s.addPropertyBinding("weight", {
      target: "rectangle:urect",
      path: "frameStrokeWeight",
      query: "q",
      expr: "MM(weight_mm)",
    });
    expect(r.ok, r.reason).toBe(true);
    // The raw id became a durable selector over the frame's own label.
    expect(r.selector).toMatch(/^frame\[label\.x-paged:media\.paged\.data\*="\\"oid\\":\\"pd-[0-9a-f]{8}\\""\]$/);
    expect(await h.objects.query(r.selector!)).toEqual(["rectangle:urect"]);

    // The label: ONE key, ASCII JSON, the binding relative to its element.
    const label = (await host.document.getMetadata({ kind: "rectangle", id: "urect" } as never)) as unknown as {
      data: { oid: string; bind: { id: string; kind: string; target: unknown; path: string; schema: unknown }[]; queries: { id: string }[]; sources: { id: string }[] };
    };
    expect(label.data.bind).toEqual([
      // The schema row as the SDK serves it (0.2.44 adds the catalog's
      // default and range).
      expect.objectContaining({
        id: "weight",
        kind: "property",
        target: "host",
        path: "frameStrokeWeight",
        schema: expect.objectContaining({ type: { kind: "length" }, nullable: true }),
      }),
    ]);
    expect(label.data.queries.map((q) => q.id)).toEqual(["q"]);
    expect(label.data.sources.map((x) => x.id)).toEqual(["products"]);

    const before = await get(h, "frameStrokeWeight");
    const batch = vi.spyOn(host.objects, "batch");
    await s.lowerAll();
    expect(batch).toHaveBeenCalledTimes(1);
    expect((await get(h, "frameStrokeWeight")).value).toBeCloseTo((2 * 72) / 25.4, 6);
    // Step to record 2 (4 mm), then record 3 (null → KeepLast: unchanged).
    await s.previewRecord("weight", 1);
    expect((await get(h, "frameStrokeWeight")).value).toBeCloseTo((4 * 72) / 25.4, 6);
    await s.previewRecord("weight", 2);
    expect((await get(h, "frameStrokeWeight")).value).toBeCloseTo((4 * 72) / 25.4, 6);
    // One undo = one apply.
    await host.document.undo();
    expect((await get(h, "frameStrokeWeight")).value).toBeCloseTo((2 * 72) / 25.4, 6);
    await host.document.undo();
    expect(await get(h, "frameStrokeWeight")).toEqual(before);
  });

  it("colours resolve to swatches (minted under InDesign's name), enum/strict failures are reported [data.bind.property]", async () => {
    const mod = await loadBundleModule();
    const { h, s } = await open(mod);
    await seed(s);
    expect((await s.addPropertyBinding("fill", { target: "rectangle:urect", path: "frameFillColor", query: "q", expr: "tint" })).ok).toBe(true);
    await s.lowerAll();
    expect((await get(h, "frameFillColor")).value).toBe("Color/R=255 G=0 B=0");
    expect(await h.objects.query("swatch")).toContain("swatch:Color/R=255 G=0 B=0");
    await s.previewRecord("fill", 1);
    expect((await get(h, "frameFillColor")).value).toBe("Color/Black");
    // A colour where a length belongs: strict coercion fails, nothing written.
    await s.addPropertyBinding("bad", { target: "rectangle:urect", path: "frameStrokeWeight", query: "q", expr: "tint" });
    const weight = await get(h, "frameStrokeWeight");
    await s.lowerAll();
    expect(await get(h, "frameStrokeWeight")).toEqual(weight);
    expect(s.getState().diagnostics.some((d) => d.binding === "bad" && d.level === "error" && /expected a length/.test(d.message))).toBe(true);
    expect(s.syncStatusOf("bad")).toBe("error");
  });

  it("visibility re-expressed: elementVisible through the same lane, one step [data.bind.property]", async () => {
    const mod = await loadBundleModule();
    const { h, host, s } = await open(mod);
    await seed(s);
    s.addVisibilityBinding("badge", "urect", "q", "shown", { kind: "rectangle" });
    const batch = vi.spyOn(host.objects, "batch");
    const mutate = vi.spyOn(host.document, "mutate");
    await s.previewRecord("badge", 1);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
    expect((await get(h, "elementVisible")).value).toBe(false);
    await host.document.undo();
    expect((await get(h, "elementVisible")).value).not.toBe(false);
  });

  // A core gap, pinned: the published engine (0.69, 0.70) keeps elementVisible in
  // its model but does not write `Visible="false"` into the exported IDML,
  // so a hidden item is baked for paged and NOT for InDesign; 0.70 still
  // does not. Fixed in core → this flips to a plain pass.
  fixedFrom(71, it)("a hidden item is baked into the exported IDML as Visible=\"false\" [data.persist.labels]", async () => {
    const mod = await loadBundleModule();
    const { host, s } = await open(mod);
    await seed(s);
    s.addVisibilityBinding("badge", "urect", "q", "shown", { kind: "rectangle" });
    await s.previewRecord("badge", 1);
    const xml = text(readZip(await exportPaged(host)).find((e) => e.name.startsWith("Spreads/")));
    expect(xml).toMatch(/<Rectangle Self="urect"[^>]*Visible="false"/);
  });

  it("save, reopen; strip the parts like InDesign: the bindings come back from the labels [data.persist.labels]", async () => {
    const mod = await loadBundleModule();
    const a = await open(mod);
    await seed(a.s);
    await a.s.addPropertyBinding("weight", { target: "rectangle:urect", path: "frameStrokeWeight", query: "q", expr: "MM(weight_mm)" });
    await a.s.addPropertyBinding("fill", { target: "rectangle:urect", path: "frameFillColor", query: "q", expr: "tint", missing: "default" });
    await a.s.lowerAll();
    await a.h.willSave.fire();
    const saved = await exportPaged(a.host);

    // The label in the IDML itself: one KeyValuePair under the rectangle.
    const spread = text(readZip(saved).find((e) => e.name.startsWith("Spreads/")));
    const kvp = [...spread.matchAll(/<KeyValuePair Key="([^"]+)"/g)].map((m) => m[1]);
    expect(kvp).toEqual([KEY]);
    expect(spread).not.toMatch(/[^\x00-\x7f]/);

    // 1. a paged reopen (parts present).
    const b = await open(mod, saved);
    expect(b.s.listBindings().map((x) => x.id).sort()).toEqual(["fill", "weight"]);
    expect(b.s.getState().relink ?? []).toEqual([]);

    // 2. what InDesign keeps: no container parts at all.
    const stripped = stripContainerParts(saved);
    expect(readZip(stripped).some((e) => e.name.startsWith("paged/"))).toBe(false);
    const c = await open(mod, stripped);
    expect(c.s.listBindings().map((x) => x.id).sort()).toEqual(["fill", "weight"]);
    expect(c.s.getState().queries).toEqual(["q"]);
    expect(c.s.getState().relink).toEqual(["products"]);
    const relinkDiag = c.s.getState().diagnostics.find((d) => d.source === "restore" && /re-link data source "products"/.test(d.message));
    expect(relinkDiag?.level).toBe("warn");
    // The baked values are the document's, untouched by the restore.
    expect((await get(c.h, "frameFillColor")).value).toBe("Color/R=255 G=0 B=0");
    // Re-link the data: the restored bindings drive the frame again.
    await c.s.registerCsvSource("products", CSV);
    expect(c.s.getState().relink).toEqual([]);
    await c.s.refreshData();
    await c.s.previewRecord("weight", 1);
    expect((await get(c.h, "frameStrokeWeight")).value).toBeCloseTo((4 * 72) / 25.4, 6);
    // The definition came back whole (target, coerce, missing, schema).
    const def = await c.s.bindingDefinition("fill");
    expect(def).toMatchObject({ kind: "property", path: "frameFillColor", missing: "default", schema: { type: { kind: "color" } } });
  });

  it("InDesign's <?AID?> re-encoding of a label still restores [data.persist.labels]", async () => {
    const mod = await loadBundleModule();
    const a = await open(mod);
    await seed(a.s);
    await a.s.addPropertyBinding("weight", { target: "rectangle:urect", path: "frameStrokeWeight", query: "q", expr: 'IF(sku = "A-1", MM(1), PT(2))' });
    await a.h.willSave.fire();
    const entries = readZip(stripContainerParts(await exportPaged(a.host)));
    // Re-encode one ASCII character the way InDesign writes a surrogate half.
    const spread = entries.find((e) => e.name.startsWith("Spreads/"))!;
    spread.bytes = new TextEncoder().encode(text(spread).replace("A-1", "&lt;?AID 0041?&gt;-1"));
    const { writeZip } = await import("./zip");
    const c = await open(mod, writeZip(entries));
    expect((await c.s.bindingDefinition("weight"))?.expr).toBe('IF(sku = "A-1", MM(1), PT(2))');
  });

  it("a canary.10 session part loads; its first save writes the labels [data.persist.labels]", async () => {
    const mod = await loadBundleModule();
    const a = await open(mod);
    const payload = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../data-conformance/tests/fixtures/canary10-payload.json", import.meta.url)), "utf8"),
    ) as { bindings: { id: string; kind: string; target?: string }[] };
    // The visibility binding targets this fixture's rectangle.
    for (const b of payload.bindings) if (b.kind === "visibility") b.target = "urect";
    const part = {
      v: 1,
      engine: payload,
      locale: "en",
      sync: [],
      targets: { image: {}, barcode: {}, visibility: { badge: { elementId: "urect", kind: "rectangle" } }, rule: {}, lowered: {} },
      data: [{ source: "products", format: "csv", text: CSV }],
      remote: [],
    };
    await a.host.parts.write("session.json", new TextEncoder().encode(JSON.stringify(part)));
    await a.s.documentOpened();
    expect(a.s.listBindings().map((b) => b.kind)).toEqual(["variable", "image", "visibility", "rule", "barcode", "table"]);
    expect(a.s.getState().diagnostics.filter((d) => d.level === "error")).toEqual([]);
    expect(await a.host.document.getMetadata({ kind: "rectangle", id: "urect" } as never)).toBeNull();
    await a.h.willSave.fire();
    const label = (await a.host.document.getMetadata({ kind: "rectangle", id: "urect" } as never)) as unknown as { data: { bind: unknown[] } };
    expect(label.data.bind).toEqual([expect.objectContaining({ id: "badge", kind: "visibility", target: "$host" })]);
  });

  it("data's own objects through host.objects: list, get, set (redefine), typed commands [data.object-model]", async () => {
    const mod = await loadBundleModule();
    const { h, s } = await open(mod);
    await seed(s);
    const kinds = (await h.objects.kinds()).map((k) => k.kind);
    expect(kinds).toEqual(expect.arrayContaining(["source", "query", "binding", "dataSet", "variable"].map((k) => `plugin:media.paged.data/${k}`)));
    expect(await h.objects.query("plugin:media.paged.data/source")).toEqual(["plugin:media.paged.data/source/products"]);
    expect(await h.objects.get("plugin:media.paged.data/source/products", "type")).toEqual({ kind: "value", value: "csv" });
    expect(await h.objects.get("plugin:media.paged.data/query/q", "recordCount")).toEqual({ kind: "value", value: 3 });

    // Define through a typed command (headless "Bind to data…" completion).
    const def = (await h.objects.invoke("media.paged.data.defineProperty", {
      id: "w",
      selector: "rectangle:urect",
      path: "frameStrokeWeight",
      query: "q",
      expr: "PT(1)",
    })) as { ok: boolean };
    expect(def.ok).toBe(true);
    const b = "plugin:media.paged.data/binding/w";
    expect(await h.objects.get(b, "kind")).toEqual({ kind: "value", value: "property" });
    // set = redefine; one more set through a script-like batch.
    expect((await h.objects.set(b, "expr", "PT(5)")).applied).toBe(true);
    expect((await h.objects.get(b, "expr")).kind === "value" && (await h.objects.get(b, "expr"))).toEqual({ kind: "value", value: "PT(5)" });
    expect((await h.objects.set(b, "coerce", "sideways")).code).toBe("invalidValue");
    await h.objects.invoke("media.paged.data.apply", { record: 0 });
    expect((await get(h, "frameStrokeWeight")).value).toBe(5);
    // The badge read: which property bindings sit on this frame and path.
    const found = (await h.objects.invoke("media.paged.data.propertyBindings", { address: "rectangle:urect", path: "frameStrokeWeight" })) as { binding: string }[];
    expect(found.map((x) => x.binding)).toEqual(["w"]);
    // Pin it; a delete removes it (and its label entry).
    expect((await h.objects.set(b, "status", "pinned")).applied).toBe(true);
    expect(await h.objects.get(b, "status")).toEqual({ kind: "value", value: "pinned" });
    expect((await h.objects.batch([{ op: "delete", address: b }])).applied).toBe(true);
    expect(await h.objects.query("plugin:media.paged.data/binding")).toEqual([]);
    // "Bind to data…" (the editor's call): a draft, the panel opens.
    const draft = (await h.objects.invoke("media.paged.data.bindProperty", { selector: "rectangle:urect", path: "frameFillColor", schema: '{"path":"frameFillColor","type":{"kind":"color"}}' })) as { status: string };
    expect(draft.status).toBe("draft");
    expect(s.getPropertyDraft()).toEqual({ selector: "rectangle:urect", path: "frameFillColor", schema: '{"path":"frameFillColor","type":{"kind":"color"}}' });
  });

  it("count budget: 50 property bindings apply as ONE host.objects batch, one undo step [data.perf.gates]", async () => {
    const mod = await loadBundleModule();
    const { h, host, s } = await open(mod);
    await seed(s);
    const ops = Array.from({ length: 49 }, (_, i) => ({ op: "insertFrame", args: { pageId: "usp", bounds: [10 + i, 10, 15 + i, 15] } }));
    expect((await host.document.mutate({ op: "batch", args: { ops } } as never)).applied).toBe(true);
    const frames = await h.objects.query("frame");
    expect(frames.length).toBe(50);
    for (const [i, f] of frames.entries()) {
      const r = await s.addPropertyBinding(`w${i}`, { target: f, path: "frameStrokeWeight", query: "q", expr: `PT(${i + 1})` });
      expect(r.ok, r.reason).toBe(true);
    }
    const batch = vi.spyOn(host.objects, "batch");
    const query = vi.spyOn(host.objects, "query");
    const mutate = vi.spyOn(host.document, "mutate");
    const result = await s.applyProperties();
    expect(result.applied).toBe(50);
    expect(result.undoSteps).toBe(1);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
    // One query per distinct target selector (each frame has its own oid).
    expect(query).toHaveBeenCalledTimes(50);
    expect(result.calls).toBe(51);
    expect((await h.objects.get(frames[49]!, "frameStrokeWeight")).kind).toBe("value");
    await host.document.undo();
    for (const f of [frames[0]!, frames[49]!]) {
      expect((await h.objects.get(f, "frameStrokeWeight")) as { value?: unknown }).not.toEqual({ kind: "value", value: 50 });
    }
  }, 120_000);
});
