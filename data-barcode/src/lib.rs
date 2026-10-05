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

//! # data-barcode — pure symbology encoders (spec §9.7, the catalog staple)
//!
//! The EasyCatalog "render a barcode from a bound field" feature: a binding's
//! expression resolves to a string (an EAN-13/UPC-A number, or arbitrary text
//! for Code-128 / QR); these encoders turn that string into a frozen
//! [`BarcodeGeometry`] — a list of filled rectangles in a **unit box**
//! (x/y/w/h all in [0, 1]). The lowering ([`data_lower`]) scales the unit box
//! to the bound frame's content box; the bundle emits one native `insertPath`
//! filled-rect per module (the VECTOR lane — resolution-independent, no
//! asset-store door). See `docs/concept.md §9.7`.
//!
//! ## Clean-room
//!
//! Every encoder is derived from the **public ISO/IEC specifications** and the
//! symbology's published encoding tables — NEVER from a GPL barcode library
//! (the §3 license boundary). The crate is dependency-free beyond `data-core`,
//! `serde`, and `thiserror`: the bar patterns, the Code-128 value table, and
//! the QR Reed–Solomon plus masking are all implemented here from first
//! principles.
//!
//! ## Pure kernel
//!
//! Each encoder is `fn encode(data: &str) -> Result<BarcodeGeometry, BarcodeError>`
//! — pure, total, deterministic. No host, no resolution graph, no SDK. The
//! geometry is the unit-box IR; `data-lower` is the only consumer that knows
//! about frames.

use serde::{Deserialize, Serialize};
use thiserror::Error;

mod code128;
mod ean;
mod qr;

pub use code128::encode_code128;
pub use ean::{encode_ean13, encode_upca};
pub use qr::encode_qr;

/// The barcode symbologies paged.data can encode (spec §9.7). The registry
/// `data.barcode.<id>` rows mirror these; `data-core::Binding::Barcode` carries
/// one as its `symbology` discriminant (the frozen contract).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Symbology {
    /// EAN-13 — the 13-digit retail/catalog staple (12 data digits + 1 check).
    Ean13,
    /// UPC-A — the 12-digit North-American retail code (11 data + 1 check). A
    /// structural subset of EAN-13 (leading implicit `0`).
    UpcA,
    /// Code-128 — a high-density general-purpose 1D symbology over the full
    /// ASCII set (auto code-set switching across B/C).
    Code128,
    /// QR — the 2D matrix symbology (byte mode, ISO/IEC 18004), for arbitrary
    /// text/URLs.
    Qr,
}

impl Symbology {
    /// The stable registry / wire id (`"ean13"`, `"upca"`, `"code128"`, `"qr"`).
    pub fn id(self) -> &'static str {
        match self {
            Symbology::Ean13 => "ean13",
            Symbology::UpcA => "upca",
            Symbology::Code128 => "code128",
            Symbology::Qr => "qr",
        }
    }

    /// Whether this symbology lays out modules in 2D (true for QR) or as a 1D
    /// row of full-height bars (the linear symbologies).
    pub fn is_matrix(self) -> bool {
        matches!(self, Symbology::Qr)
    }
}

/// One filled rectangle of a [`BarcodeGeometry`], in the **unit box** — `x`/`y`
/// are the top-left, `w`/`h` the size, all normalized to `[0, 1]`. A 1D barcode
/// emits one full-height rect per dark bar (`y = 0`, `h = 1`); QR emits one rect
/// per dark module. The lowering scales these to the frame's content box (§9.6 —
/// content-space, so frame transforms are honored for free).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BarcodeRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The frozen symbology geometry: the dark modules as filled rects in a unit
/// box, plus the natural module grid (so the lowering can keep modules crisp /
/// pixel-snapped if it wants) and the human-readable text. The geometry carries
/// ONLY dark modules — the light background is the (empty) frame, never a drawn
/// rect — so a lowering emits exactly `rects.len()` vector ops.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BarcodeGeometry {
    /// Which symbology produced this geometry.
    pub symbology: Symbology,
    /// The dark modules as filled rectangles in the unit box.
    pub rects: Vec<BarcodeRect>,
    /// The module grid width (1D: total module columns incl. quiet zone; QR: the
    /// matrix side length incl. quiet zone). Lets a lowering snap to whole
    /// modules. Always > 0.
    pub modules_x: u32,
    /// The module grid height (1D: 1; QR: equals `modules_x`).
    pub modules_y: u32,
    /// The canonical encoded text — the digits (with the computed check digit
    /// for EAN/UPC) or the payload — for the human-readable line beneath a 1D
    /// symbol. Empty for QR (no HRI line).
    pub text: String,
}

impl BarcodeGeometry {
    /// The number of dark modules (filled rects) — a quick non-emptiness check.
    pub fn rect_count(&self) -> usize {
        self.rects.len()
    }
}

/// An encoding failure — the data did not satisfy the symbology's input
/// contract (wrong length, a non-numeric digit, an over-capacity payload). The
/// resolver surfaces this as a binding diagnostic; nothing panics.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum BarcodeError {
    /// The input was empty (no value resolved to encode).
    #[error("empty barcode data")]
    Empty,
    /// A numeric symbology (EAN/UPC) received a non-digit character.
    #[error("non-digit character in numeric symbology: {0:?}")]
    NonDigit(char),
    /// Wrong number of digits for a fixed-length numeric symbology.
    #[error("expected {expected} digits, got {got}")]
    WrongLength { expected: usize, got: usize },
    /// A supplied check digit did not match the computed one.
    #[error("check digit mismatch: expected {expected}, got {got}")]
    CheckDigit { expected: u8, got: u8 },
    /// A character is outside the symbology's encodable set (Code-128 / QR byte
    /// mode encode Latin-1; a char above U+00FF cannot be carried).
    #[error("character {0:?} is not encodable in this symbology")]
    Unencodable(char),
    /// The payload exceeds the symbology's capacity (QR version ceiling).
    #[error("payload too large: {len} bytes exceeds the capacity of {symbology}")]
    TooLong { len: usize, symbology: &'static str },
}

/// Encode `data` in `symbology` to the unit-box [`BarcodeGeometry`] (the §9.7
/// entry point). Pure + deterministic; an invalid input is a typed
/// [`BarcodeError`], never a panic.
pub fn encode(symbology: Symbology, data: &str) -> Result<BarcodeGeometry, BarcodeError> {
    match symbology {
        Symbology::Ean13 => encode_ean13(data),
        Symbology::UpcA => encode_upca(data),
        Symbology::Code128 => encode_code128(data),
        Symbology::Qr => encode_qr(data),
    }
}

/// Widen a geometry's quiet zone by `extra` light modules on each side, beyond
/// the symbology default the encoder already applied (the binding's
/// `quiet_zone` option, §9.7). The module grid grows by `2 * extra` columns —
/// and rows for a matrix symbology, whose quiet zone surrounds all four sides
/// — and every rect is re-expressed in the wider unit box, so the bars keep
/// their module widths relative to each other and move inward. `extra == 0`
/// returns the geometry unchanged. Pure.
pub fn with_quiet_zone(geometry: BarcodeGeometry, extra: u32) -> BarcodeGeometry {
    if extra == 0 {
        return geometry;
    }
    let mx = f64::from(geometry.modules_x);
    let my = f64::from(geometry.modules_y);
    let e = f64::from(extra);
    let matrix = geometry.symbology.is_matrix();
    let nx = mx + 2.0 * e;
    let (ny, ey) = if matrix { (my + 2.0 * e, e) } else { (my, 0.0) };
    let rects = geometry
        .rects
        .iter()
        .map(|r| BarcodeRect {
            x: (r.x * mx + e) / nx,
            w: r.w * mx / nx,
            y: (r.y * my + ey) / ny,
            h: r.h * my / ny,
        })
        .collect();
    BarcodeGeometry {
        rects,
        modules_x: geometry.modules_x + 2 * extra,
        modules_y: if matrix {
            geometry.modules_y + 2 * extra
        } else {
            geometry.modules_y
        },
        ..geometry
    }
}

// ── Shared 1D helpers ───────────────────────────────────────────────────────

/// Build a 1D [`BarcodeGeometry`] from a module bitmap (true = dark) + a quiet
/// zone of `quiet` light modules on each side. Each run of dark modules becomes
/// ONE full-height rect (merging adjacent dark modules into a single bar keeps
/// the rect count — and the emitted vector ops — minimal). The unit box width is
/// `modules.len() + 2*quiet` modules.
fn linear_geometry(
    symbology: Symbology,
    modules: &[bool],
    quiet: u32,
    text: String,
) -> BarcodeGeometry {
    let total = modules.len() as u32 + 2 * quiet;
    let unit = 1.0 / total as f64;
    let mut rects = Vec::new();
    let mut run_start: Option<u32> = None;
    for (i, &dark) in modules.iter().enumerate() {
        let col = quiet + i as u32;
        match (dark, run_start) {
            (true, None) => run_start = Some(col),
            (false, Some(start)) => {
                rects.push(bar_rect(start, col, unit));
                run_start = None;
            }
            _ => {}
        }
    }
    if let Some(start) = run_start {
        rects.push(bar_rect(start, quiet + modules.len() as u32, unit));
    }
    BarcodeGeometry {
        symbology,
        rects,
        modules_x: total,
        modules_y: 1,
        text,
    }
}

/// A full-height bar rect spanning columns `[start, end)` (module units → unit
/// box via `unit`).
fn bar_rect(start: u32, end: u32, unit: f64) -> BarcodeRect {
    BarcodeRect {
        x: start as f64 * unit,
        y: 0.0,
        w: (end - start) as f64 * unit,
        h: 1.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_barcode_symbology_ids_are_stable() {
        assert_eq!(Symbology::Ean13.id(), "ean13");
        assert_eq!(Symbology::UpcA.id(), "upca");
        assert_eq!(Symbology::Code128.id(), "code128");
        assert_eq!(Symbology::Qr.id(), "qr");
        assert!(Symbology::Qr.is_matrix());
        assert!(!Symbology::Code128.is_matrix());
    }

    #[test]
    #[allow(non_snake_case)] // `__feat__<id>`: the cockpit test-to-feature join
    fn data_barcode_with_quiet_zone_pads_a_linear_symbol__feat__data_barcode_symbology() {
        // dark, light, dark with no default quiet zone: 3 modules.
        let g = linear_geometry(Symbology::Code128, &[true, false, true], 0, String::new());
        let w = with_quiet_zone(g.clone(), 2);
        assert_eq!((w.modules_x, w.modules_y), (7, 1));
        // The bars sit at module columns 2 and 4 of 7, one module wide, full height.
        let cols: Vec<(f64, f64)> = w.rects.iter().map(|r| (r.x * 7.0, r.w * 7.0)).collect();
        for ((x, wd), (ex, ew)) in cols.iter().zip([(2.0, 1.0), (4.0, 1.0)]) {
            assert!(
                (x - ex).abs() < 1e-12 && (wd - ew).abs() < 1e-12,
                "{cols:?}"
            );
        }
        assert!(w.rects.iter().all(|r| r.y == 0.0 && r.h == 1.0));
        // Zero is the identity.
        assert_eq!(with_quiet_zone(g.clone(), 0), g);
    }

    #[test]
    #[allow(non_snake_case)] // `__feat__<id>`: the cockpit test-to-feature join
    fn data_barcode_with_quiet_zone_pads_all_four_sides_of_a_matrix__feat__data_barcode_symbology()
    {
        let g = encode(Symbology::Qr, "paged").unwrap();
        let w = with_quiet_zone(g.clone(), 3);
        assert_eq!(w.modules_x, g.modules_x + 6);
        assert_eq!(w.modules_y, g.modules_y + 6);
        assert_eq!(w.rects.len(), g.rects.len());
        // Each module keeps its grid cell, shifted by 3 in x and y.
        let (mx, nx) = (f64::from(g.modules_x), f64::from(w.modules_x));
        for (a, b) in g.rects.iter().zip(&w.rects) {
            assert!((b.x * nx - (a.x * mx + 3.0)).abs() < 1e-9);
            assert!((b.y * nx - (a.y * mx + 3.0)).abs() < 1e-9);
            assert!((b.w * nx - a.w * mx).abs() < 1e-9);
        }
    }

    #[test]
    fn data_barcode_linear_geometry_merges_runs() {
        // dark, dark, light, dark → two bars (the first 2 modules merge).
        let g = linear_geometry(
            Symbology::Code128,
            &[true, true, false, true],
            0,
            "x".into(),
        );
        assert_eq!(g.rects.len(), 2);
        assert_eq!(g.modules_x, 4);
        assert_eq!(g.modules_y, 1);
        // The merged bar spans 2 modules; the lone bar spans 1.
        assert!((g.rects[0].w - 0.5).abs() < 1e-9);
        assert!((g.rects[1].w - 0.25).abs() < 1e-9);
    }

    #[test]
    fn data_barcode_dispatch_routes_each_symbology() {
        assert!(encode(Symbology::Ean13, "4006381333931").is_ok());
        assert!(encode(Symbology::UpcA, "036000291452").is_ok());
        assert!(encode(Symbology::Code128, "ABC-123").is_ok());
        assert!(encode(Symbology::Qr, "https://paged.media").is_ok());
    }

    #[test]
    fn data_barcode_empty_is_an_error_not_a_panic() {
        assert_eq!(encode(Symbology::Code128, ""), Err(BarcodeError::Empty));
        assert_eq!(encode(Symbology::Qr, ""), Err(BarcodeError::Empty));
        assert_eq!(encode(Symbology::Ean13, ""), Err(BarcodeError::Empty));
    }
}
