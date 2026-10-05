// Wave 6 against the REAL stack (real core headless host, real data-js wasm,
// real DuckDB): imported JSON / Parquet / XLSX sources are saved with the
// document — small files inline, a large one as its own `data/<hash>.json`
// part — and come back on reopen, worksheet choice, saved query and refresh
// policy included. The File ▸ Import door (`contribute.importer`) routes a
// JSON file into the session.
//
// Gate: skips without canvas-wasm, DuckDB or the built data-js wasm, EXCEPT
// under REQUIRE_REAL_CORE=1 / REQUIRE_REAL_DUCKDB=1.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BundleHost } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { ENGINE_ANCHOR, openRealHost, REQUIRE_REAL_CORE } from "./real-core";
import { bootRealDuckDB, bootRealEngine, DATA_JS_WASM, REQUIRE_REAL_DUCKDB } from "./real-duckdb";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "..", "..", "conformance", "sources");
const XLSX = new Uint8Array(readFileSync(join(FIXTURES, "products.xlsx")));
const PARQUET = new Uint8Array(readFileSync(join(FIXTURES, "products.parquet")));

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
  if (reply.kind !== "pagedExported")
    throw new Error(`exportPaged: ${reply.kind} ${reply.payload.error ?? ""}`);
  return Uint8Array.from(reply.payload.bytes!);
}

/** A JSON array over 64 KiB, so it is saved as its own part. */
function bigJson(): Uint8Array {
  const rows = Array.from({ length: 2000 }, (_, i) => ({
    id: i,
    name: `item-${String(i).padStart(5, "0")}`,
    note: "x".repeat(24),
  }));
  return new TextEncoder().encode(JSON.stringify(rows));
}

describe.skipIf(!ready && !required)(
  "imported files saved with the document, real core + engine + DuckDB [data.source.adapters]",
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

    it("JSON (large, a part), Parquet and XLSX (inline) come back on reopen [data.plugin.persistence]", async () => {
      expect(ready, "real core, DuckDB and the data-js wasm must all be available").toBe(true);
      const mod = await loadBundleModule();
      const h1 = await open();
      h1.loadBundle(mod.dataBundle);
      const s1 = mod.sessionFor(h1.host)!;
      await s1.whenRestored();

      const big = bigJson();
      expect(big.length).toBeGreaterThan(64 * 1024);
      expect((await s1.importFile("items.json", big)).error).toBeUndefined();
      expect((await s1.importFile("products.parquet", PARQUET)).error).toBeUndefined();
      expect((await s1.importFile("book.xlsx", XLSX)).error).toBeUndefined();
      await s1.selectSheet("book", "Prices");
      expect(await s1.saveQuery("q", "SELECT region, factor FROM book ORDER BY region")).toBeNull();
      expect(s1.setRefreshPolicy("products", { policy: "never" })).toBeNull();

      await h1.willSave.fire();
      const parts = await h1.host.parts.list("data/");
      expect(parts.filter((p) => p.endsWith(".json"))).toHaveLength(1);
      expect(parts.filter((p) => /\.(parquet|xlsx)$/.test(p))).toEqual([]);
      const saved = await exportPaged(h1.host);

      // ── reopen ───────────────────────────────────────────────────────────
      const h2 = await open(saved);
      h2.loadBundle(mod.dataBundle);
      const s2 = mod.sessionFor(h2.host)!;
      await s2.whenRestored();
      const st = s2.getState();
      expect(st.diagnostics.filter((d) => d.level === "error")).toEqual([]);
      expect(st.sources).toEqual(["items", "products", "book"]);
      expect(st.files.map((f) => [f.source, f.format, f.fileName, f.sheet ?? null])).toEqual([
        ["items", "json", "items.json", null],
        ["products", "parquet", "products.parquet", null],
        ["book", "xlsx", "book.xlsx", "Prices"],
      ]);
      expect(st.refresh).toEqual({ products: { policy: "never" } });
      expect(s2.listQueries()).toEqual([
        { id: "q", sql: "SELECT region, factor FROM book ORDER BY region" },
      ]);

      // The data is back in DuckDB on first use.
      expect((await s2.previewQuery("SELECT count(*) FROM items")).rows).toEqual([["2000"]]);
      expect((await s2.previewQuery("SELECT price FROM products ORDER BY sku LIMIT 1")).rows).toEqual([
        ["9.99"],
      ]);
      await s2.refreshData();
      expect(await s2.recordCount("q")).toBe(2);
    });

    it("File ▸ Import routes a JSON file to the session; CSV/TSV/XLSX stay with the spreadsheet plugin [data.plugin.bundle]", async () => {
      expect(ready).toBe(true);
      const mod = await loadBundleModule();
      const h = await open();
      h.loadBundle(mod.dataBundle);
      const s = mod.sessionFor(h.host)!;
      await s.whenRestored();
      const ours = h.importersContributed().filter((c) => c.id === "media.paged.data.importer.table");
      expect(ours).toHaveLength(1);
      expect([...ours[0].extensions]).toEqual([".json", ".ndjson", ".jsonl", ".parquet"]);
      await ours[0].import({
        name: "feed.json",
        bytes: new TextEncoder().encode('[{"a":1},{"a":2}]'),
        mimeType: "application/json",
      });
      expect(s.getState().sources).toEqual(["feed"]);
      expect((await s.previewQuery("SELECT sum(a) FROM feed")).rows).toEqual([["3"]]);
    });
  },
);
