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

/** The tagged union the engine returns from `resolve_lowered`. */
export type LoweredOutput = LoweredVariable | LoweredTable;
