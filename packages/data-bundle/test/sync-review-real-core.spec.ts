// Wave 7 against the REAL stack (real core headless host, real data-js
// engine, real DuckDB), through the loaded bundle:
//
//   · a field's display pattern and its own locale are written into the
//     document, and survive a save and reopen;
//   · a pinned field is left alone by a refresh, the row diff names the row
//     that changed and the binding it reaches, and accept-source writes the
//     source value and re-links;
//   · a rule's condition preview agrees with what it applies, and a
//     per-record paragraph rule styles exactly the paragraphs of the records
//     that fire, with a style read from the document's own collection.
//
// Gate: skips without canvas-wasm, DuckDB or the built data-js wasm, EXCEPT
// under REQUIRE_REAL_CORE=1 / REQUIRE_REAL_DUCKDB=1, where a missing piece is a
// failure.

import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";

import type { BundleHost } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { dataFields, ENGINE_ANCHOR, openRealHost, REQUIRE_REAL_CORE } from "./real-core";
import { bootRealDuckDB, bootRealEngine, DATA_JS_WASM, REQUIRE_REAL_DUCKDB } from "./real-duckdb";

const CSV = "sku,price\nA-1,9.99\nB-2,19.99\nC-3,29.99\n";
// The same products after a price change of A-1.
const CSV2 = "sku,price\nA-1,12.5\nB-2,19.99\nC-3,29.99\n";

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

async function fieldValue(host: BundleHost, key: string): Promise<string | null | undefined> {
  // A placeholder field, or (protocol 71) the text variable `paged:<key>`.
  return (await dataFields(host as never)).find((p) => p.key === key)?.value;
}

describe.skipIf(!ready && !required)(
  "sync review through the real stack [data.bind.sync-review]",
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

    it("pattern + locale, pin, row diff, accept source, save and reopen [data.bind.sync-review]", async () => {
      expect(ready, "real core, DuckDB and the data-js wasm must all be available").toBe(true);
      const mod = await loadBundleModule();
      const h1 = await open();
      h1.loadBundle(mod.dataBundle);
      const s = mod.sessionFor(h1.host)!;
      await s.whenRestored();
      await s.registerCsvSource("products", CSV);
      s.addQuery("q", "SELECT sku, price FROM products ORDER BY sku", "recordStream");
      s.addVariableBinding("v_price", "anchor", "q", "price");
      await s.lowerAll();
      expect(await fieldValue(h1.host, "v_price")).toBe("9.99");

      // A display pattern and the field's own locale are written now.
      expect(await s.setBindingFormat("v_price", { kind: "currency", decimals: 2 })).toBe(true);
      expect(await fieldValue(h1.host, "v_price")).toBe("$9.99");
      await s.setBindingLocale("v_price", "fr");
      expect(await fieldValue(h1.host, "v_price")).toBe("9,99 €");
      expect(await s.previewBinding("v_price", 1)).toBe("19,99 €");

      // Pin it; the data changes; a refresh leaves the pinned field alone.
      await s.pin("v_price");
      await s.registerCsvSource("products_v2", CSV2);
      s.addQuery("q", "SELECT sku, price FROM products_v2 ORDER BY sku", "recordStream");
      await s.refreshData();
      const [diff] = await s.rowDiff();
      expect(diff.query).toBe("q");
      expect(diff.key).toEqual(["sku"]);
      expect([diff.insertedCount, diff.removedCount, diff.updatedCount]).toEqual([0, 0, 1]);
      expect(diff.updated[0]).toEqual({
        index: 0,
        key: "A-1",
        changes: [{ column: "price", before: "9.99", after: "12.5" }],
      });
      expect(diff.affected.map((a) => a.binding)).toEqual(["v_price"]);
      await s.refreshFields();
      expect(await fieldValue(h1.host, "v_price")).toBe("9,99 €");
      const sync = await s.bindingSync();
      expect(sync.find((b) => b.id === "v_price")).toMatchObject({
        status: "pinned",
        locale: "fr",
        format: { inner: "price", pattern: { kind: "currency", decimals: 2 } },
      });

      // Accept the source: the new price, and the binding follows it again.
      expect(await s.acceptSource("v_price")).toBe(true);
      expect(await fieldValue(h1.host, "v_price")).toBe("12,50 €");
      expect((await s.bindingSync()).find((b) => b.id === "v_price")?.status).toBe("linked");

      // Pin again and save: the decision, the locale and the pattern reopen.
      await s.pin("v_price");
      await h1.willSave.fire();
      const saved = await exportPaged(h1.host);
      const h2 = await open(saved);
      h2.loadBundle(mod.dataBundle);
      const s2 = mod.sessionFor(h2.host)!;
      await s2.whenRestored();
      expect((await s2.bindingSync()).find((b) => b.id === "v_price")).toMatchObject({
        status: "pinned",
        locale: "fr",
        format: { inner: "price", pattern: { kind: "currency", decimals: 2 } },
      });
      expect(await fieldValue(h2.host, "v_price")).toBe("12,50 €");
    });

    it("a per-record paragraph rule styles the paragraphs of the records that fire [data.rule.authoring]", async () => {
      expect(ready).toBe(true);
      const mod = await loadBundleModule();
      const h = await open();
      h.loadBundle(mod.dataBundle);
      const s = mod.sessionFor(h.host)!;
      await s.whenRestored();
      await s.registerCsvSource("products", CSV);
      s.addQuery("q", "SELECT sku, price FROM products ORDER BY sku", "recordStream");
      // A story to style: the variable field lands in a fresh frame; three
      // paragraphs go in front of it, one per record.
      s.addVariableBinding("v_sku", "anchor", "q", "sku");
      await s.lowerAll();
      // The variable's frame is the only story (its field may be a text
      // variable, protocol 71, which names no story).
      const stories = await h.host.document.collection<{ selfId: string }>("stories");
      expect(stories).toHaveLength(1);
      const storyId = stories[0]!.selfId;
      const ins = await h.host.document.mutate({
        op: "insertText",
        args: { storyId, offset: 0, text: "A-1\nB-2\nC-3\n" },
      });
      expect(ins.applied).toBe(true);
      const made = await h.host.document.mutate({
        op: "createParagraphStyle",
        args: { selfId: "ParagraphStyle/Low", name: "Low" },
      });
      expect(made.applied).toBe(true);

      // The style is offered from the document's own collection.
      const styles = await s.documentStyles("paragraph");
      expect(styles).toContainEqual({ selfId: "ParagraphStyle/Low", name: "Low" });

      // The preview and the applied rule agree: records 0 and 1 fire.
      expect(await s.previewCondition("q", "price < 20")).toEqual({ fires: [0, 1], total: 3 });
      expect((await s.checkExpression("stock < 5", "q")).unknownFields).toEqual(["stock"]);
      s.addRuleBinding(
        "r_low",
        "r_low",
        "q",
        "price < 20",
        { action: "paragraphStyle", name: "ParagraphStyle/Low" },
        { kind: "storyParagraphs", storyId, firstParagraph: 0 },
      );
      expect(await s.applyRule("r_low")).toBe(2);
      const story = await h.host.document.storyContent(storyId);
      const styled = story!.paragraphs.map((p) => p.paragraphStyle ?? null);
      expect(styled.slice(0, 3)).toEqual(["ParagraphStyle/Low", "ParagraphStyle/Low", styled[2]]);
      expect(styled[2]).not.toBe("ParagraphStyle/Low");
    });
  },
);
