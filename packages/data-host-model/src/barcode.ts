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

// The barcode VECTOR lowering (spec §9.7): the engine has ALREADY encoded the
// symbology and scaled its module grid into content-space filled rects; this
// turns each module into a native `insertPath` closed 4-anchor filled rectangle
// on the page (the VECTOR lane — resolution-independent, no asset-store door).
// ZERO symbology/encoding semantics live here (CLAUDE.md hard rule): the Rust
// data-barcode crate owns every bar/module pattern; this is arithmetic over the
// already-decided rects plus the host path vocabulary.
//
// RASTER is BLOCKED today: placeImage needs a resolvable uri, and inline PNG
// bytes have no asset-store door — so a barcode is NEVER lowered to an image.
// The VECTOR lane is the honest path and is also crisper (resolution-free).

import type { Mutation, PageId } from "@paged-media/plugin-api";

import { BINDING_KEY } from "./binding";
import type { LoweredBarcode } from "./lowered";

export type { LoweredBarcode } from "./lowered";

/** One content-space filled-rect module of a lowered barcode (pt) — the exact
 *  shape the engine serialises (camelCase mirrors the Rust `BarcodeModule`). */
export type BarcodeModule = LoweredBarcode["modules"][number];

/** The four closed anchors of a rect at `(x, y)` size `(w, h)` (page-pt),
 *  clockwise from the top-left. A filled-rect path module: no Bézier handles
 *  (the anchor == its left/right control points → straight segments). */
function rectAnchors(
  x: number,
  y: number,
  w: number,
  h: number,
): { anchor: [number, number]; left: [number, number]; right: [number, number] }[] {
  const corners: [number, number][] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  return corners.map((p) => ({ anchor: p, left: p, right: p }));
}

/** Where the barcode lands on the page: the bound frame's page-coordinate
 *  top-left (the modules are content-space offsets from it, §9.6). */
export interface BarcodePlacement {
  pageId: PageId;
  /** The frame content box's top-left in page coordinates (pt). */
  topPt: number;
  leftPt: number;
}

/** Translate a lowered barcode into one `insertPath` closed filled-rect per dark
 *  module, wrapped in a single undoable `batch` that also stamps the binding
 *  envelope onto the batch-created group/first path (so one undo removes the
 *  whole symbol). Pure: no host import beyond wire TYPES. An empty barcode
 *  (missing-policy skip) yields an EMPTY ops list — the caller draws nothing,
 *  never a placeholder. The page origin is added to each content-space module.
 *
 *  `bindingJson` is the binding envelope (`makeEnvelope`); when supplied it is
 *  written via `setPluginMetadata` onto the `$created` sentinel of the FIRST
 *  inserted path so the symbol round-trips with the document. */
export function barcodeToMutations(
  barcode: LoweredBarcode,
  placement: BarcodePlacement,
  bindingJson?: string,
): Mutation[] {
  const { pageId, topPt, leftPt } = placement;
  const ops: Mutation[] = [];
  for (const m of barcode.modules) {
    ops.push({
      op: "insertPath",
      args: {
        pageId,
        anchors: rectAnchors(leftPt + m.xPt, topPt + m.yPt, m.wPt, m.hPt),
        open: false,
      },
    });
  }
  // Stamp the binding envelope onto the first created path ($created sentinel)
  // so an undo of the whole batch also removes the binding metadata.
  if (bindingJson && ops.length > 0) {
    ops.push({
      op: "setPluginMetadata",
      args: {
        elementId: { kind: "rectangle", id: "$created" },
        key: BINDING_KEY,
        value: bindingJson,
      },
    });
  }
  return ops;
}

/** The number of dark modules a lowered barcode will draw (one `insertPath`
 *  each) — a quick capacity/emptiness check for the caller. */
export function barcodeModuleCount(barcode: LoweredBarcode): number {
  return barcode.modules.length;
}
