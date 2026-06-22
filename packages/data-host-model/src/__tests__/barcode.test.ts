/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// The pure barcode VECTOR translation (spec §9.7): a lowered barcode (already
// encoded + scaled into content-space filled rects by the Rust engine) becomes
// one `insertPath` closed 4-anchor filled rect per dark module, plus the binding
// envelope on the first created path. No host calls, ZERO symbology semantics —
// data in, mutations out. RASTER is BLOCKED (placeImage needs a uri), so a
// barcode never lowers to an image — the VECTOR lane is the honest path.

import { describe, expect, it } from "vitest";

import {
  barcodeModuleCount,
  barcodeToMutations,
  BINDING_KEY,
  makeEnvelope,
  type BarcodePlacement,
} from "../index";
import type { LoweredBarcode } from "../lowered";

function code128(): LoweredBarcode {
  return {
    kind: "barcode",
    target: "bc-frame",
    symbology: "code128",
    modules: [
      { xPt: 0, yPt: 0, wPt: 2, hPt: 36 },
      { xPt: 4, yPt: 0, wPt: 1, hPt: 36 },
    ],
    modulesX: 60,
    modulesY: 1,
    bounds: { widthPt: 144, heightPt: 36 },
    text: "SKU-42",
  };
}

function qr(): LoweredBarcode {
  return {
    kind: "barcode",
    target: "bc-frame",
    symbology: "qr",
    modules: [
      { xPt: 0, yPt: 0, wPt: 4, hPt: 4 },
      { xPt: 4, yPt: 0, wPt: 4, hPt: 4 },
      { xPt: 0, yPt: 4, wPt: 4, hPt: 4 },
    ],
    modulesX: 29,
    modulesY: 29,
    bounds: { widthPt: 100, heightPt: 100 },
    text: "",
  };
}

const placement: BarcodePlacement = { pageId: "page-1" as never, topPt: 36, leftPt: 36 };

describe("data-host-model · barcode (VECTOR lane, §9.7)", () => {
  it("emits one closed insertPath filled rect per dark module + the page origin", () => {
    const ops = barcodeToMutations(code128(), placement);
    // 2 modules → 2 insertPath ops (no envelope passed → no metadata op).
    const paths = ops.filter((o) => o.op === "insertPath");
    expect(paths).toHaveLength(2);
    const first = paths[0] as {
      args: { pageId: string; open: boolean; anchors: { anchor: [number, number] }[] };
    };
    // A filled rect is a CLOSED path of 4 anchors.
    expect(first.args.open).toBe(false);
    expect(first.args.anchors).toHaveLength(4);
    // The first module sits at the page origin (left 36, top 36) + its content
    // offset (0, 0); the rect is [0,0]→[2,36] in content-space.
    const a = first.args.anchors.map((p) => p.anchor);
    expect(a[0]).toEqual([36, 36]); // top-left
    expect(a[1]).toEqual([38, 36]); // top-right (x + w)
    expect(a[2]).toEqual([38, 72]); // bottom-right (y + h)
    expect(a[3]).toEqual([36, 72]); // bottom-left
  });

  it("stamps the binding envelope onto the first created path when supplied", () => {
    const env = makeEnvelope({ kind: "barcode", target: "bc-frame", symbology: "code128" });
    const ops = barcodeToMutations(code128(), placement, env);
    // 2 paths + 1 metadata op.
    expect(ops).toHaveLength(3);
    const meta = ops.find((o) => o.op === "setPluginMetadata") as
      | { args: { key: string; elementId: { id: string } } }
      | undefined;
    expect(meta?.args.key).toBe(BINDING_KEY);
    expect(meta?.args.elementId.id).toBe("$created");
  });

  it("lowers QR modules as square cells offset by the page origin", () => {
    const ops = barcodeToMutations(qr(), placement);
    expect(ops).toHaveLength(3); // 3 dark modules, no envelope
    const third = ops[2] as { args: { anchors: { anchor: [number, number] }[] } };
    // The 3rd module is at content (0, 4); page origin (36, 36) → top-left (36, 40).
    const a = third.args.anchors.map((p) => p.anchor);
    expect(a[0]).toEqual([36, 40]);
    expect(a[2]).toEqual([40, 44]); // +4 × +4 (a square cell)
  });

  it("an empty barcode (missing-policy skip) yields no ops, never a placeholder", () => {
    const empty: LoweredBarcode = { ...code128(), modules: [], text: "" };
    expect(barcodeToMutations(empty, placement)).toHaveLength(0);
    expect(barcodeModuleCount(empty)).toBe(0);
    // Even with an envelope, no modules → nothing drawn (no stray metadata).
    expect(barcodeToMutations(empty, placement, makeEnvelope({}))).toHaveLength(0);
  });
});
