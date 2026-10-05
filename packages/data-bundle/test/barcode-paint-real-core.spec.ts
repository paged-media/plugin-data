// Barcode modules are painted, proven against the REAL core engine (wave 0,
// data bug f). A fresh `insertPath` takes core's defaults: the document's
// default fill (none in a fresh document) and a 1 pt Color/Black stroke
// (paged-canvas model.rs, Mutation::InsertPath). So an unpainted module is an
// outline whose stroke widens every bar by 1 pt. The lowering now paints each
// module through `$created`: fill Color/Black, stroke Swatch/None.
//
// Skips without a reachable canvas-wasm; REQUIRE_REAL_CORE=1 fails instead.

import { afterEach, describe, expect, it } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { barcodeToMutations, type LoweredBarcode } from "../../data-host-model/src";
import { ENGINE_ANCHOR, openRealHost, REQUIRE_REAL_CORE } from "./real-core";

const run = ENGINE_ANCHOR !== null || REQUIRE_REAL_CORE;

const code128: LoweredBarcode = {
  kind: "barcode",
  target: "bc-frame",
  symbology: "code128",
  modules: [
    { xPt: 0, yPt: 0, wPt: 2, hPt: 30 },
    { xPt: 4, yPt: 0, wPt: 1, hPt: 30 },
  ],
  modulesX: 10,
  modulesY: 1,
  bounds: { widthPt: 20, heightPt: 30 },
  text: "",
} as LoweredBarcode;

describe.skipIf(!run)("barcode modules against real core [data.barcode.symbology]", () => {
  let h: HeadlessHost | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  it("every module is a black-filled, unstroked polygon [data.barcode.symbology]", async () => {
    h = await openRealHost();
    const host = h.host;
    const ops = barcodeToMutations(code128, { pageId: "usp" as never, topPt: 50, leftPt: 50 });
    const out = await host.document.mutate({ op: "batch", args: { ops } });
    expect(out.applied).toBe(true);

    const tree = JSON.stringify(await host.document.tree());
    const ids = [...tree.matchAll(/"kind":"polygon","id":"([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      const props = await host.document.elementProperties({ kind: "polygon", id } as never);
      const entry = (path: string) =>
        (props?.entries as { path: string; value: { value: unknown } }[]).find((e) => e.path === path)?.value
          .value;
      expect([id, entry("frameFillColor"), entry("frameStrokeColor")]).toEqual([
        id,
        "Color/Black",
        "Swatch/None",
      ]);
    }
  });
});
