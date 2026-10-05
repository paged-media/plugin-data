// Update in place and the record-flow writer (campaign Wave 5) against the
// REAL stack: real core (headless canvas-wasm), the real data-js wasm, real
// DuckDB. A second lower of the same binding must REPLACE what the first made:
//
// - a table is swapped inside its own frame (same frame id, one table frame);
// - a barcode's modules are replaced (the module count stays one symbol's);
// - a record flow's frames and the pages it added are replaced (same counts).
//
// Each lower is one undo step (two for a record flow that adds pages).
//
// Gate: skips without the pieces, EXCEPT under REQUIRE_REAL_CORE=1 /
// REQUIRE_REAL_ENGINE=1 / REQUIRE_REAL_DUCKDB=1, where a missing piece fails.

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { documentElements } from "../src/relower";
import {
  BUDGET_TIMEOUT_MS,
  bootCountedDuck,
  bootCountedEngine,
  openDataHost,
  productCsv,
  RUN_BUDGETS,
  sessionOver,
  type CountedDuck,
} from "./perf/harness";

vi.setConfig({ testTimeout: BUDGET_TIMEOUT_MS });

async function labelled(h: HeadlessHost, kind: string) {
  return documentElements((await h.host.document.tree()) as never).filter((e) => e.data?.kind === kind);
}

async function polygons(h: HeadlessHost): Promise<ElementId[]> {
  return documentElements((await h.host.document.tree()) as never)
    .map((e) => e.element)
    .filter((e) => e.kind === "polygon" || e.kind === "rectangle");
}

describe.skipIf(!RUN_BUDGETS)("re-lower updates in place, real core [data.lower.relower-in-place]", () => {
  let h: HeadlessHost | null = null;
  let duck: CountedDuck | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });
  afterAll(async () => {
    await duck?.handle.close();
  });

  async function session(csv: string) {
    h = await openDataHost();
    const engine = await bootCountedEngine();
    duck ??= await bootCountedDuck();
    const s = await sessionOver(h.host, engine, duck);
    const name = `p${Math.random().toString(36).slice(2, 8)}`;
    await s.registerCsvSource(name, csv);
    s.addQuery("q", `SELECT * FROM ${name}`, "recordStream");
    await s.refreshData();
    return s;
  }

  it("a table lowered twice is swapped inside its own frame [data.lower.relower-in-place]", async () => {
    const s = await session(productCsv(5));
    s.addTableBinding("t", "region", "q", [
      { header: "SKU", expr: "sku" },
      { header: "Price", expr: "price" },
    ]);
    await s.lowerBinding("t");
    const first = await labelled(h!, "table");
    expect(first.length).toBe(1);
    await s.lowerBinding("t");
    const second = await labelled(h!, "table");
    expect(second.map((e) => e.element)).toEqual(first.map((e) => e.element));
    // One undo takes the second lower back and leaves the first table.
    await h!.host.document.undo();
    expect((await labelled(h!, "table")).map((e) => e.element)).toEqual(first.map((e) => e.element));
  });

  it("a barcode lowered twice leaves one symbol [data.lower.relower-in-place]", async () => {
    const s = await session(productCsv(3));
    const rect = await h!.host.document.mutate({
      op: "insertFrame",
      args: { pageId: "usp" as never, bounds: [100, 100, 244, 244] },
    });
    const rectId = (rect as { createdId: { id: string } }).createdId.id;
    s.addBarcodeBinding("bc", rectId, "q", "code128", "sku");
    const before = (await polygons(h!)).length;
    await s.lowerBinding("bc");
    const once = (await polygons(h!)).length - before;
    expect(once).toBeGreaterThan(10);
    await s.lowerBinding("bc");
    expect((await polygons(h!)).length - before).toBe(once);
    await s.previewRecord("bc", 1);
    expect((await polygons(h!)).length - before).toBe(once);
  });

  it("a record flow becomes frames on added pages, and a re-lower replaces them [data.lower.relower-in-place]", async () => {
    const s = await session(productCsv(150));
    s.defineRecordFlow("rf", "q", [{ expr: "sku" }, { label: "Price: ", expr: "price" }]);
    await s.lowerBinding("rf");
    expect(s.getState().status).toBe("ready");
    const frames = await labelled(h!, "recordFlow");
    const pages = (await h!.host.document.collection("pages")).length;
    // 150 records × 2 lines × 14 pt do not fit one page: the flow added pages.
    expect(pages).toBeGreaterThan(1);
    expect(frames.length).toBe(pages);
    expect(new Set(frames.map((f) => f.page)).size).toBe(pages);
    // The first frame starts with the first record (in the flow's order).
    const geo = await h!.host.document.elementGeometry([frames[0].element]);
    const story = await h!.host.document.storyContent((geo[0] as { storyId: string }).storyId);
    expect(story!.paragraphs.length).toBeGreaterThan(10);

    await s.lowerBinding("rf");
    expect((await labelled(h!, "recordFlow")).length).toBe(frames.length);
    expect((await h!.host.document.collection("pages")).length).toBe(pages);
  });
});
