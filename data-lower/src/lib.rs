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

use data_core::{FrameRef, ImageReference, ImageStatus, ImgFit, PlaceholderRef};

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

/// A lowered image placeholder (spec §9.2): the classified reference + fit +
/// status to place into the target frame through the core asset mechanism. The
/// host placement op is an SDK gap (BREAKAGE D-14); M0 carries the IR + records
/// the binding, never `plugin-image` (§2.1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoweredImage {
    pub target: PlaceholderRef,
    pub reference: ImageReference,
    pub fit: ImgFit,
    pub status: ImageStatus,
}

/// Lower a resolved image to the placement IR (§9.2).
pub fn lower_image(
    target: PlaceholderRef,
    reference: ImageReference,
    fit: ImgFit,
    status: ImageStatus,
) -> LoweredImage {
    LoweredImage {
        target,
        reference,
        fit,
        status,
    }
}

// ── Barcode / QR symbol lowering (spec §9.7 — the VECTOR lane) ──────────────
//
// The catalog staple: a bound field value is encoded (data-barcode) into a
// unit-box module/bar grid, then lowered to filled-rect VECTOR modules scaled
// to the bound frame's content box. The bundle emits one native `insertPath`
// filled rect per module — resolution-independent, no asset-store door (raster
// is BLOCKED today: placeImage needs a resolvable uri; inline PNG bytes can't be
// placed). Geometry is content-space (§9.6): rects are offsets from the
// region's top-left, so frame transforms are honored for free.

/// One filled-rect module of a lowered barcode (content-space, pt) — a corner
/// `(x_pt, y_pt)` + a size. The bundle turns each into a closed 4-anchor
/// `insertPath` filled rect.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BarcodeModule {
    pub x_pt: f64,
    pub y_pt: f64,
    pub w_pt: f64,
    pub h_pt: f64,
}

/// A lowered barcode (spec §9.7): the symbology's dark modules as filled rects
/// in content-space, scaled to the bound frame's content box, plus the module
/// grid (so the host can pixel-snap) and the human-readable text line (1D only;
/// empty for QR). The host draws one filled rect per `module` and never a
/// background rect (the light quiet zone is the empty frame).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoweredBarcode {
    /// The bound frame the symbol renders onto.
    pub target: FrameRef,
    /// The registry/wire symbology id (`"ean13"`, `"upca"`, `"code128"`, `"qr"`).
    pub symbology: String,
    /// The dark modules as filled rects, content-space (pt), scaled to `bounds`.
    pub modules: Vec<BarcodeModule>,
    /// The module grid width/height (incl. quiet zone) — lets the host snap.
    pub modules_x: u32,
    pub modules_y: u32,
    /// The content-space size the modules were scaled into (the frame content box).
    pub bounds: ContentBox,
    /// The human-readable line (1D digits/text; empty for QR).
    pub text: String,
}

/// Lower a barcode geometry to content-space filled-rect modules scaled to the
/// frame's content box (spec §9.7). The unit-box rects (x/y/w/h in [0,1]) are
/// multiplied by `box_w_pt` / `box_h_pt`. Pure: the encoding already happened
/// (data-barcode); this is the geometry scale into content-space.
pub fn lower_barcode(
    target: FrameRef,
    geometry: &data_barcode::BarcodeGeometry,
    box_w_pt: f64,
    box_h_pt: f64,
) -> LoweredBarcode {
    let modules = geometry
        .rects
        .iter()
        .map(|r| BarcodeModule {
            x_pt: r.x * box_w_pt,
            y_pt: r.y * box_h_pt,
            w_pt: r.w * box_w_pt,
            h_pt: r.h * box_h_pt,
        })
        .collect();
    LoweredBarcode {
        target,
        symbology: geometry.symbology.id().to_string(),
        modules,
        modules_x: geometry.modules_x,
        modules_y: geometry.modules_y,
        bounds: ContentBox {
            width_pt: box_w_pt,
            height_pt: box_h_pt,
        },
        text: geometry.text.clone(),
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

// ── Record flow / pagination (spec §9.4 — the catalog engine) ──────────────
//
// The defining print-automation feature: records flow through a frame chain,
// one atomic template instance per record, paginating across pages. The host
// frame-chain topology read + content-box reflow notification are an SDK gap
// (BREAKAGE D-12), so — exactly as plugin-sheet built its paginator ahead of
// S-05 — this packs over a **caller-supplied** chain. Pure + deterministic;
// records are atomic (never split), so the settle loop is a single bounded
// pass that converges even for a record taller than a frame.

/// A frame in the caller-supplied chain (until the SDK frame-chain read lands,
/// D-12). `height_pt` is the frame's content-box capacity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameCapacity {
    pub frame: String,
    pub page: String,
    pub height_pt: f64,
}

/// One section to paginate: an optional header, its atomic record instances, and
/// an optional footer (a subtotal/count row at the group's end, §9.4). With
/// multi-level grouping, parent levels are header-only sections (`records` empty)
/// and `level` (0 = outermost) carries the nesting depth.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FlowGroup {
    #[serde(default)]
    pub header: Option<String>,
    /// The nesting level (0 = outermost). Single-level/ungrouped → 0.
    #[serde(default)]
    pub level: usize,
    pub records: Vec<FlowRecord>,
    #[serde(default)]
    pub footer: Option<FlowRecord>,
}

/// One rendered record instance (the "catalog cell").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowRecord {
    pub cells: Vec<String>,
    pub height_pt: f64,
}

/// Pagination knobs (pt).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowLayoutOpts {
    /// Re-emit a group's header when it continues on a new frame.
    pub repeat_header: bool,
    /// Mark a re-emitted header as "continued".
    pub continued_marker: bool,
    /// Height a header block consumes.
    pub header_height_pt: f64,
}

impl Default for FlowLayoutOpts {
    fn default() -> Self {
        FlowLayoutOpts {
            repeat_header: true,
            continued_marker: true,
            header_height_pt: 16.0,
        }
    }
}

/// A placed block within a paginated frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "block", rename_all = "camelCase")]
pub enum FlowBlock {
    /// A section header (`continued` when re-emitted on a later frame). `level`
    /// (0 = outermost) lets the host indent/style nested group headers.
    GroupHeader {
        text: String,
        level: usize,
        continued: bool,
    },
    /// A record instance.
    Record { cells: Vec<String>, height_pt: f64 },
    /// A section footer (a group subtotal/count row, §9.4).
    GroupFooter { cells: Vec<String>, height_pt: f64 },
}

/// One frame after pagination.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedFrame {
    pub frame: String,
    pub page: String,
    pub blocks: Vec<FlowBlock>,
    pub used_pt: f64,
}

/// The paginated record flow.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedFlow {
    pub frames: Vec<PaginatedFrame>,
    /// True when records ran out of chain (more frames are needed).
    pub overflow: bool,
    /// Records placed and total (placed < total ⇒ overflow).
    pub placed: usize,
    pub total: usize,
}

/// Paginate grouped record instances over a frame chain (spec §9.4). Greedy,
/// atomic-record packing with repeated/continued group headers; a record taller
/// than a frame gets its own (over-full) frame so the pass always converges.
pub fn paginate_flow(
    groups: &[FlowGroup],
    chain: &[FrameCapacity],
    opts: &FlowLayoutOpts,
) -> PaginatedFlow {
    let total: usize = groups.iter().map(|g| g.records.len()).sum();
    let mut frames: Vec<PaginatedFrame> = chain
        .iter()
        .map(|c| PaginatedFrame {
            frame: c.frame.clone(),
            page: c.page.clone(),
            blocks: Vec::new(),
            used_pt: 0.0,
        })
        .collect();
    let cap = |i: usize| chain[i].height_pt;

    let mut fi = 0usize;
    let mut overflow = false;
    let mut placed = 0usize;
    // The active ancestor headers (level, text), built from header-only parent
    // sections, so a leaf's continuation frame can repeat its full path.
    let mut parent_stack: Vec<(usize, String)> = Vec::new();

    'groups: for group in groups {
        let mut group_started = false;

        // A header-only parent section becomes the active ancestor at its level
        // (replacing any deeper context).
        if group.records.is_empty() {
            if let Some(text) = &group.header {
                parent_stack.retain(|(l, _)| *l < group.level);
                parent_stack.push((group.level, text.clone()));
            }
        }

        // The group's opening header (advance first if it won't fit here).
        if let Some(text) = &group.header {
            if fi < frames.len() && frames[fi].used_pt + opts.header_height_pt > cap(fi) {
                fi += 1;
            }
            if fi >= frames.len() {
                overflow = true;
                break 'groups;
            }
            frames[fi].blocks.push(FlowBlock::GroupHeader {
                text: text.clone(),
                level: group.level,
                continued: false,
            });
            frames[fi].used_pt += opts.header_height_pt;
        }

        for rec in &group.records {
            let h = rec.height_pt;
            let fits_here = fi < frames.len() && frames[fi].used_pt + h <= cap(fi);
            if !fits_here {
                // Advance to the next frame.
                fi += 1;
                if fi >= frames.len() {
                    overflow = true;
                    break 'groups;
                }
                // Re-emit the header on the continuation frame — the FULL
                // hierarchy path (ancestors + this leaf) so the context carries
                // over — but only when it still leaves room for the record (so a
                // non-tall record always fits its frame; the property gate relies
                // on this). Single-level → an empty stack → just the leaf header.
                if let (true, Some(leaf_text)) = (opts.repeat_header, &group.header) {
                    let ancestors: Vec<&(usize, String)> = parent_stack
                        .iter()
                        .filter(|(l, _)| *l < group.level)
                        .collect();
                    let path_height = (ancestors.len() + 1) as f64 * opts.header_height_pt;
                    if path_height + h <= cap(fi) {
                        let continued = opts.continued_marker && group_started;
                        for (level, text) in &ancestors {
                            frames[fi].blocks.push(FlowBlock::GroupHeader {
                                text: text.clone(),
                                level: *level,
                                continued,
                            });
                            frames[fi].used_pt += opts.header_height_pt;
                        }
                        frames[fi].blocks.push(FlowBlock::GroupHeader {
                            text: leaf_text.clone(),
                            level: group.level,
                            continued,
                        });
                        frames[fi].used_pt += opts.header_height_pt;
                    }
                }
                // A record taller than the whole frame lands here over-full
                // (its own frame); the next record won't fit it and advances.
            }
            frames[fi].blocks.push(FlowBlock::Record {
                cells: rec.cells.clone(),
                height_pt: h,
            });
            frames[fi].used_pt += h;
            placed += 1;
            group_started = true;
        }

        // The section footer (subtotal/count), if any — an atomic block at the
        // group's end. Advance to the next frame when it does not fit; a footer
        // taller than a whole frame lands over-full (like a tall record). No
        // header is re-emitted for a footer.
        if let Some(footer) = &group.footer {
            let h = footer.height_pt;
            if fi < frames.len() && frames[fi].used_pt + h > cap(fi) {
                fi += 1;
                if fi >= frames.len() {
                    overflow = true;
                    break 'groups;
                }
            }
            if fi >= frames.len() {
                overflow = true;
                break 'groups;
            }
            frames[fi].blocks.push(FlowBlock::GroupFooter {
                cells: footer.cells.clone(),
                height_pt: h,
            });
            frames[fi].used_pt += h;
        }
    }

    // Drop frames the flow never reached (trailing empties).
    frames.retain(|f| !f.blocks.is_empty());

    PaginatedFlow {
        frames,
        overflow,
        placed,
        total,
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
