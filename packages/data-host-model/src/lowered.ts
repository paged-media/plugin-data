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

// The lowered-IR types — the exact shape the `data-js` engine serialises
// across the wasm boundary (`DataEngine.resolve_lowered` → `LoweredOutput`).
// camelCase mirrors the Rust serde renames in `data-lower`. Type-only; the
// host-model translates these into host mutations (zero semantics here).

/** A lowered variable (§9.1): the resolved display placed at a placeholder. */
export interface LoweredVariable {
  kind: "variable";
  /** The placeholder anchor id (a tagged text run; coarse element id at M0). */
  target: string;
  text: string;
  /** The `HideParagraph` missing policy. */
  hidden: boolean;
}

/** A laid-out column (content-space, pt). */
export interface LoweredColumn {
  index: number;
  header: string;
  xPt: number;
  widthPt: number;
}

/** A laid-out row of cells (content-space, pt). */
export interface LoweredRow {
  cells: string[];
  yPt: number;
  heightPt: number;
  header: boolean;
}

/** A drawn grid rule (the §2.2 degradation — content-space line, pt). */
export interface GridRule {
  x1Pt: number;
  y1Pt: number;
  x2Pt: number;
  y2Pt: number;
}

/** The content-space size of a lowered region (pt). */
export interface ContentBox {
  widthPt: number;
  heightPt: number;
}

/** A lowered dynamic table (§9.3) — structured grid + the degraded tab-text
 *  and drawn-rules path the M0 host actually commits (D-02). */
export interface LoweredTable {
  kind: "table";
  region: string;
  columns: LoweredColumn[];
  rows: LoweredRow[];
  rules: GridRule[];
  /** Tab-within-row, newline-between-rows join (the D-02 degraded text). */
  text: string;
  bounds: ContentBox;
}

/** A classified image reference (§9.2) — matches the `data-core` serde shape. */
export type ImageReference =
  | { ref: "uri"; uri: string }
  | { ref: "path"; path: string }
  | { ref: "assetId"; id: string }
  | { ref: "bytes"; bytes: number[] }
  | { ref: "none" };

/** The image resolution status after the missing policy. */
export type ImageStatus = "present" | "skipped" | "flagged" | "fallback";

/** A lowered image placeholder (§9.2): the reference + fit + status to place
 *  into the target frame through the core asset mechanism. The host placement op
 *  is an SDK gap (BREAKAGE D-14) — M0 records the binding, never `plugin-image`. */
export interface LoweredImage {
  kind: "image";
  target: string;
  reference: ImageReference;
  fit: "fit" | "fill" | "crop";
  status: ImageStatus;
}

/** A lowered barcode (§9.7) — the symbology's dark modules as content-space
 *  filled rects scaled to the bound frame's content box (the VECTOR lane). The
 *  full shape lives in `barcode.ts`; re-exported through the union here. */
export interface LoweredBarcode {
  kind: "barcode";
  target: string;
  symbology: string;
  modules: { xPt: number; yPt: number; wPt: number; hPt: number }[];
  modulesX: number;
  modulesY: number;
  bounds: ContentBox;
  text: string;
}

/** The tagged union the engine returns from `resolve_lowered`. */
export type LoweredOutput = LoweredVariable | LoweredTable | LoweredImage | LoweredBarcode;
