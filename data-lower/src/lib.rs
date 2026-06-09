/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

//! # data-lower — placeholder lowering to the `LoweredContent` IR (spec §9)
//!
//! Pure `resolved-content → IR`. The TS `data-host-model` turns the IR into
//! host `Mutation`s (zero semantics there). M0 covers:
//!
//! - **variable replacement** (§9.1): the resolved display string placed at a
//!   tagged placeholder (the anchor survives; only content updates);
//! - **single-region dynamic table** (§9.3): the resolved grid laid out as a
//!   native table — but, since the SDK has no `insertTable` op (BREAKAGE D-02),
//!   the M0 IR also carries the **degraded** tab-aligned text + drawn rules
//!   path (the spec §2.2 fallback, exactly as plugin-sheet S-03).
//!
//! All geometry is **content-space** (offsets from the region's own top-left,
//! §9.6), so core applies frame transforms for free — `data.frame.transform.*`
//! asserts the IR never encodes display geometry. Column widths are estimated
//! from character counts (no font-metrics door yet — BREAKAGE D-13/S-13).
//!
//! Inputs are plain resolved content (display strings) so this crate depends
//! ONLY on `data-core` — `data-js` bridges `data-bind`'s resolved output here.

use serde::{Deserialize, Serialize};

use data_core::{FrameRef, PlaceholderRef};

/// Layout knobs for table lowering (point units). Defaults are conservative
/// monospace-ish estimates until the font-metrics door lands (D-13/S-13).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LowerOpts {
    pub header_row: bool,
    pub row_height_pt: f64,
    pub char_width_pt: f64,
    pub padding_pt: f64,
}

impl Default for LowerOpts {
    fn default() -> Self {
        LowerOpts {
            header_row: true,
            row_height_pt: 14.0,
            char_width_pt: 6.0,
            padding_pt: 4.0,
        }
    }
}

/// A lowered variable (spec §9.1) — the resolved display placed at a
/// placeholder. `hidden` is the `HideParagraph` missing policy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoweredVariable {
    pub target: PlaceholderRef,
    pub text: String,
    pub hidden: bool,
}

/// Lower a resolved variable. Trivial, but the IR boundary is uniform with the
/// table path (the host-model consumes both).
pub fn lower_variable(target: PlaceholderRef, display: &str, hidden: bool) -> LoweredVariable {
    LoweredVariable {
        target,
        text: display.to_string(),
        hidden,
    }
}

/// A laid-out column (content-space).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoweredColumn {
    pub index: usize,
    pub header: String,
    /// Content-space x of the column's left edge (pt).
    pub x_pt: f64,
    pub width_pt: f64,
}

/// A laid-out row of cells (content-space).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoweredRow {
    pub cells: Vec<String>,
    /// Content-space y of the row's top edge (pt).
    pub y_pt: f64,
    pub height_pt: f64,
    /// True for the header row.
    pub header: bool,
}

/// A drawn grid rule (the §2.2 degradation — content-space line, pt).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridRule {
    pub x1_pt: f64,
    pub y1_pt: f64,
    pub x2_pt: f64,
    pub y2_pt: f64,
}

/// The content-space size of a lowered region.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentBox {
    pub width_pt: f64,
    pub height_pt: f64,
}

/// A lowered dynamic table (spec §9.3). Carries BOTH the structured grid (for
/// when a native table op lands) and the degraded `text` + `rules` the M0 host
/// path actually commits (D-02).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoweredTable {
    pub region: FrameRef,
    pub columns: Vec<LoweredColumn>,
    pub rows: Vec<LoweredRow>,
    /// Grid rules in content-space (the degraded drawn-rules path).
    pub rules: Vec<GridRule>,
    /// Tab-within-row, newline-between-rows join (the degraded text path, D-02).
    pub text: String,
    pub bounds: ContentBox,
}

/// Lower a resolved grid (headers + display rows) to the table IR. Geometry is
/// content-space; widths are character-count estimates (D-13/S-13).
pub fn lower_table(
    region: FrameRef,
    headers: &[String],
    rows: &[Vec<String>],
    opts: &LowerOpts,
) -> LoweredTable {
    let ncols = headers.len();

    // Column widths: max char count over header + cells, ×char_width + padding.
    let mut widths = vec![0.0_f64; ncols];
    for (c, h) in headers.iter().enumerate() {
        widths[c] = h.chars().count() as f64;
    }
    for row in rows {
        for (c, cell) in row.iter().enumerate().take(ncols) {
            widths[c] = widths[c].max(cell.chars().count() as f64);
        }
    }
    let pad2 = opts.padding_pt * 2.0;
    let widths: Vec<f64> = widths
        .into_iter()
        .map(|chars| chars * opts.char_width_pt + pad2)
        .collect();

    // Column x offsets (content-space).
    let mut columns = Vec::with_capacity(ncols);
    let mut x = 0.0;
    for (c, w) in widths.iter().enumerate() {
        columns.push(LoweredColumn {
            index: c,
            header: headers.get(c).cloned().unwrap_or_default(),
            x_pt: x,
            width_pt: *w,
        });
        x += *w;
    }
    let total_width = x;

    // Rows (header first when requested), content-space y top-down.
    let mut lowered_rows = Vec::new();
    let mut y = 0.0;
    if opts.header_row {
        lowered_rows.push(LoweredRow {
            cells: headers.to_vec(),
            y_pt: y,
            height_pt: opts.row_height_pt,
            header: true,
        });
        y += opts.row_height_pt;
    }
    for row in rows {
        lowered_rows.push(LoweredRow {
            cells: row.clone(),
            y_pt: y,
            height_pt: opts.row_height_pt,
            header: false,
        });
        y += opts.row_height_pt;
    }
    let total_height = y;

    // Grid rules: horizontals at every row boundary, verticals at every column
    // boundary (content-space, from the region origin).
    let mut rules = Vec::new();
    let row_count = lowered_rows.len();
    for i in 0..=row_count {
        let yy = i as f64 * opts.row_height_pt;
        rules.push(GridRule {
            x1_pt: 0.0,
            y1_pt: yy,
            x2_pt: total_width,
            y2_pt: yy,
        });
    }
    let mut vx = 0.0;
    rules.push(GridRule {
        x1_pt: vx,
        y1_pt: 0.0,
        x2_pt: vx,
        y2_pt: total_height,
    });
    for w in &widths {
        vx += *w;
        rules.push(GridRule {
            x1_pt: vx,
            y1_pt: 0.0,
            x2_pt: vx,
            y2_pt: total_height,
        });
    }

    // The degraded tab/newline text (D-02).
    let text = lowered_rows
        .iter()
        .map(|r| r.cells.join("\t"))
        .collect::<Vec<_>>()
        .join("\n");

    LoweredTable {
        region,
        columns,
        rows: lowered_rows,
        rules,
        text,
        bounds: ContentBox {
            width_pt: total_width,
            height_pt: total_height,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_lower_variable_places_text() {
        let v = lower_variable(PlaceholderRef::from("ph1"), "Widget", false);
        assert_eq!(v.text, "Widget");
        assert!(!v.hidden);
    }

    #[test]
    fn data_lower_table_geometry_is_content_space() {
        let headers = vec!["SKU".to_string(), "Price".to_string()];
        let rows = vec![
            vec!["A-1".to_string(), "$9.99".to_string()],
            vec!["B-22".to_string(), "$19.99".to_string()],
        ];
        let t = lower_table(
            FrameRef::from("region1"),
            &headers,
            &rows,
            &LowerOpts::default(),
        );
        // Header + 2 rows = 3 rows.
        assert_eq!(t.rows.len(), 3);
        assert!(t.rows[0].header);
        // Content-space: first column starts at x=0, first row at y=0.
        assert_eq!(t.columns[0].x_pt, 0.0);
        assert_eq!(t.rows[0].y_pt, 0.0);
        // Every rule coordinate is a non-negative content-space offset (§9.6 —
        // never display geometry).
        for r in &t.rules {
            assert!(r.x1_pt >= 0.0 && r.y1_pt >= 0.0 && r.x2_pt >= 0.0 && r.y2_pt >= 0.0);
        }
        // The degraded text path is tab/newline joined (D-02).
        assert_eq!(t.text, "SKU\tPrice\nA-1\t$9.99\nB-22\t$19.99");
        assert!(t.bounds.width_pt > 0.0 && t.bounds.height_pt > 0.0);
    }
}
