// Persistence against the REAL stack: real core (canvas-wasm headless host),
// real data-js engine, real DuckDB. A session is built through the loaded
// bundle, the document is saved as a `.paged` container (exportPaged), a NEW
// host loads those bytes, the bundle activates again, and the restored session
// must work: sources re-register in DuckDB, queries run, the placed field is
// found again (not placed twice), refresh writes it, and undo behaves.
//
// Gate: skips without canvas-wasm, DuckDB or the built data-js wasm, EXCEPT
// under REQUIRE_REAL_CORE=1 / REQUIRE_REAL_DUCKDB=1, where a missing piece is a
// failure.

import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";

import type { BundleHost } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { ENGINE_ANCHOR, openRealHost, REQUIRE_REAL_CORE } from "./real-core";
import { bootRealDuckDB, bootRealEngine, DATA_JS_WASM, REQUIRE_REAL_DUCKDB } from "./real-duckdb";
import { minimalIdml } from "./fixtures/minimal-idml";

const PLUGIN = "media.paged.data";
const CSV = "sku,price\nA-1,9.99\nB-2,19.99\nC-3,29.99\n";

const probe = await bootRealDuckDB();
const ready = ENGINE_ANCHOR !== null && probe.handle !== undefined && existsSync(DATA_JS_WASM);
const required = REQUIRE_REAL_CORE || REQUIRE_REAL_DUCKDB;

/** The bundle module, with the two engine boots pointed at real Node builds. */
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
  if (reply.kind !== "pagedExported")
    throw new Error(`exportPaged: ${reply.kind} ${reply.payload.error ?? ""}`);
  return Uint8Array.from(reply.payload.bytes!);
}

async function ours(host: BundleHost) {
  const all = await host.document.placeholders();
  return all.filter((p) => p.plugin === PLUGIN);
}

describe.skipIf(!ready && !required)(
  "session persistence through a saved .paged, real core + engine + DuckDB [data.plugin.persistence]",
  () => {
    const hosts: HeadlessHost[] = [];
    afterEach(() => {
      while (hosts.length) hosts.pop()!.dispose();
    });

    async function open(bytes?: Uint8Array) {
      const h = await openRealHost();
      if (bytes) await h.load(bytes);
      hosts.push(h);
      return h;
    }

    it("import, bind, save, reopen: the restored session refreshes the same field [data.plugin.persistence]", async () => {
      expect(ready, "real core, DuckDB and the data-js wasm must all be available").toBe(true);
      const mod = await loadBundleModule();

      // ── session 1: import, query, bind, lower ────────────────────────────
      const h1 = await open();
      h1.loadBundle(mod.dataBundle);
      const s1 = mod.sessionFor(h1.host)!;
      await s1.whenRestored();
      await s1.registerCsvSource("products", CSV);
      s1.addQuery("q", "SELECT sku, price FROM products ORDER BY sku", "recordStream");
      s1.addVariableBinding("v_sku", "anchor", "q", "sku");
      s1.setLocale("de");
      await s1.lowerAll();
      expect((await ours(h1.host)).map((p) => [p.key, p.value])).toEqual([["v_sku", "A-1"]]);

      // A save runs the will-save listeners first; that is where pending
      // session state is written.
      await h1.willSave.fire();
      const saved = await exportPaged(h1.host);

      // ── session 2: a new host opens the saved bytes ───────────────────────
      const h2 = await open(saved);
      h2.loadBundle(mod.dataBundle);
      const s2 = mod.sessionFor(h2.host)!;
      await s2.whenRestored();

      const st = s2.getState();
      expect(st.sources).toEqual(["products"]);
      expect(st.queries).toEqual(["q"]);
      expect(st.bindings).toEqual(["v_sku"]);
      expect(s2.getLocale()).toBe("de");
      expect(st.diagnostics.filter((d) => d.level === "error")).toEqual([]);

      // The field came back with the document; the session knows it is placed.
      expect((await ours(h2.host)).map((p) => [p.key, p.value])).toEqual([["v_sku", "A-1"]]);

      // Refresh works: the CSV re-registers in DuckDB on first use, the query
      // runs, and the preview writes the field in place.
      await s2.refreshData();
      await s2.previewRecord("v_sku", 1);
      expect((await ours(h2.host)).map((p) => [p.key, p.value])).toEqual([["v_sku", "B-2"]]);

      // A re-lower re-resolves the existing field — it does not place a second.
      await s2.lowerAll();
      expect((await ours(h2.host)).map((p) => [p.key, p.value])).toEqual([["v_sku", "A-1"]]);

      // Undo: the field write is a document mutation and undoes; the saved
      // session is container state, which undo does not touch.
      const partBefore = await h2.host.parts.read("session.json");
      await h2.host.document.undo();
      expect((await ours(h2.host)).map((p) => p.value)).toEqual(["B-2"]);
      const partAfter = await h2.host.parts.read("session.json");
      expect(partAfter).not.toBeNull();
      expect(new TextDecoder().decode(partAfter!)).toBe(new TextDecoder().decode(partBefore!));
    });

    it("a lowered table carries its binding in an undoable label; reopen checks it [data.plugin.persistence]", async () => {
      expect(ready).toBe(true);
      const mod = await loadBundleModule();
      const h1 = await open();
      h1.loadBundle(mod.dataBundle);
      const s1 = mod.sessionFor(h1.host)!;
      await s1.whenRestored();
      await s1.registerCsvSource("products", CSV);
      s1.addQuery("q", "SELECT sku, price FROM products ORDER BY sku", "recordStream");
      s1.addTableBinding("t", "region", "q", [{ header: "SKU", expr: "sku" }]);
      await s1.lowerAll();

      // The frame the table went into is labelled with the binding, the hash
      // of its definition and the hash of the session part it was lowered under.
      await s1.flushPersist();
      const head = JSON.parse(
        new TextDecoder().decode((await h1.host.parts.read("session.json"))!),
      );
      const frame = head.targets.lowered.t;
      expect(frame?.kind).toBe("textFrame");
      const label = (await h1.host.document.getMetadata(frame)) as unknown as {
        data: { binding: string; def: string; session: string };
      };
      expect(label.data.binding).toBe("t");
      expect(label.data.def).toMatch(/^[0-9a-f]{32}$/);
      expect(label.data.session).toMatch(/^[0-9a-f]{32}$/);

      // Reopen with the table in place: nothing to report.
      await h1.willSave.fire();
      const kept = await open(await exportPaged(h1.host));
      kept.loadBundle(mod.dataBundle);
      const sk = mod.sessionFor(kept.host)!;
      await sk.whenRestored();
      expect(sk.getState().diagnostics).toEqual([]);

      // Undo the lower. It is several undo steps today (frame, table, cell
      // fill, label); the label is the last of them, so the first undo takes
      // it. The session part is not undone. Reopen says the binding no longer
      // has labelled content.
      let undos = 0;
      while ((await h1.host.document.getMetadata(frame)) !== null && undos < 8) {
        await h1.host.document.undo();
        undos++;
      }
      expect(undos).toBe(1);
      expect(await h1.host.parts.read("session.json")).not.toBeNull();
      await h1.willSave.fire();
      const h2 = await open(await exportPaged(h1.host));
      h2.loadBundle(mod.dataBundle);
      const s2 = mod.sessionFor(h2.host)!;
      await s2.whenRestored();
      expect(s2.getState().bindings).toEqual(["t"]);
      expect(s2.getState().diagnostics.map((d) => [d.source, d.binding, d.level])).toEqual([
        ["restore", "t", "info"],
      ]);
    });

    it("a record flow defines, previews, and comes back with its template [data.bind.authoring]", async () => {
      expect(ready).toBe(true);
      const mod = await loadBundleModule();
      const h1 = await open();
      h1.loadBundle(mod.dataBundle);
      const s1 = mod.sessionFor(h1.host)!;
      await s1.whenRestored();
      await s1.registerCsvSource("stock", "sku,region\nA-1,North\nB-2,South\nC-3,North\n");
      s1.addQuery("q", "SELECT sku, region FROM stock ORDER BY sku", "recordStream");
      s1.defineRecordFlow("rf", "q", [{ expr: "sku" }], { groupBy: ["region"] });
      await s1.refreshData();
      const before = await s1.previewRecordFlow("rf");
      expect(before?.total).toBe(3);
      expect(before?.blocks.filter((b) => b.kind === "header").map((b) => b.text)).toEqual([
        "North",
        "South",
      ]);
      expect(before?.blocks.filter((b) => b.kind === "record").map((b) => b.text)).toEqual([
        "A-1",
        "C-3",
        "B-2",
      ]);
      expect(s1.listBindings()).toEqual([{ id: "rf", kind: "recordFlow" }]);

      await h1.willSave.fire();
      const h2 = await open(await exportPaged(h1.host));
      h2.loadBundle(mod.dataBundle);
      const s2 = mod.sessionFor(h2.host)!;
      await s2.whenRestored();
      await s2.refreshData();
      expect(await s2.previewRecordFlow("rf")).toEqual(before);
    });

    it("a large CSV is stored once as its own content-addressed part [data.plugin.persistence]", async () => {
      expect(ready).toBe(true);
      const mod = await loadBundleModule();
      const rows = Array.from(
        { length: 6000 },
        (_, i) => `SKU-${String(i).padStart(5, "0")},${i}.5`,
      );
      const big = `sku,price\n${rows.join("\n")}\n`;
      expect(big.length).toBeGreaterThan(64 * 1024);

      const h1 = await open();
      h1.loadBundle(mod.dataBundle);
      const s1 = mod.sessionFor(h1.host)!;
      await s1.whenRestored();
      await s1.registerCsvSource("catalog", big);
      s1.addQuery("q", "SELECT count(*) AS n FROM catalog", "scalar");
      await s1.flushPersist();

      const dataParts = (await h1.host.parts.list("data/")).filter((p) => p.endsWith(".csv"));
      expect(dataParts).toHaveLength(1);
      const head = JSON.parse(
        new TextDecoder().decode((await h1.host.parts.read("session.json"))!),
      );
      expect(JSON.stringify(head).length).toBeLessThan(8 * 1024);
      expect(head.data[0].ref.bytes).toBe(new TextEncoder().encode(big).length);

      await h1.willSave.fire();
      const h2 = await open(await exportPaged(h1.host));
      h2.loadBundle(mod.dataBundle);
      const s2 = mod.sessionFor(h2.host)!;
      await s2.whenRestored();
      expect(s2.getState().sources).toEqual(["catalog"]);
      await s2.refreshData();
      expect(await s2.recordCount("q")).toBe(1);
      expect(s2.getState().diagnostics.filter((d) => d.level === "error")).toEqual([]);
    });

    it("a remote source comes back inert: nothing is fetched on open [data.security.gates]", async () => {
      expect(ready).toBe(true);
      const mod = await loadBundleModule();
      const h1 = await open();
      h1.loadBundle(mod.dataBundle);
      const s1 = mod.sessionFor(h1.host)!;
      await s1.whenRestored();
      await s1.registerCsvSource("products", CSV);
      expect(s1.addRemoteSource("feed", "https://data.example.com/feed.csv", "csv")).toBeNull();
      await h1.willSave.fire();

      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const h2 = await open(await exportPaged(h1.host));
      h2.loadBundle(mod.dataBundle);
      const s2 = mod.sessionFor(h2.host)!;
      await s2.whenRestored();
      expect(s2.getState().remote.map((r) => [r.name, r.status, r.consent])).toEqual([
        ["feed", "inert", "required"],
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("a document without a saved session restores to an empty session [data.plugin.persistence]", async () => {
      expect(ready).toBe(true);
      const mod = await loadBundleModule();
      const h = await open(minimalIdml());
      h.loadBundle(mod.dataBundle);
      const s = mod.sessionFor(h.host)!;
      await s.whenRestored();
      expect(s.getState().bindings).toEqual([]);
      expect(s.getState().diagnostics).toEqual([]);
    });
  },
);
