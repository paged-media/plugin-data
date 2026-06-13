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

//! Barcode/QR conformance (spec §9.7 — the EasyCatalog catalog staple). The
//! binding's expression resolves to a string; the engine encodes it in the
//! chosen symbology (`data-barcode`, clean-room from the public ISO/IEC specs);
//! the lowering scales the unit-box module grid to the bound frame's content box
//! as content-space filled rects (the VECTOR lane — `insertPath`, no
//! asset-store door). Pure, deterministic; an invalid value is a typed error,
//! never a panic.

use data_barcode::{encode, BarcodeError, Symbology};
use data_bind::{BarcodeResolveStatus, ResolutionEngine, Resolved};
use data_conformance::{record_set, t, today};
use data_core::{
    BarcodeMissing, BarcodeOpts, BarcodeSymbology, Binding, BindingId, FieldType, FrameRef, Query,
    QueryId, ResultShape,
};
use data_lower::lower_barcode;

fn barcode_binding(symbology: BarcodeSymbology, expr: &str, missing: BarcodeMissing) -> Binding {
    Binding::Barcode {
        target: FrameRef::from("bc-frame"),
        query: QueryId::from("q1"),
        symbology,
        expr: expr.into(),
        options: BarcodeOpts {
            quiet_zone: 0,
            missing,
        },
    }
}

fn engine_with(field: &str, value: &str) -> ResolutionEngine {
    let mut e = ResolutionEngine::new(today());
    e.add_query(Query {
        id: QueryId::from("q1"),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::SingleRecord,
    });
    e.set_result(
        QueryId::from("q1"),
        record_set(&[(field, FieldType::Text)], vec![vec![t(value)]]),
    );
    e
}

// ── data.barcode.encode — the pure encoders (golden-vector correctness) ─────

#[test]
fn data_barcode_encode_ean13_golden() {
    // EAN-13 worked example 400638133393 → check 1; the symbol is 95 modules
    // plus quiet zone, with merged-run bars.
    let g = encode(Symbology::Ean13, "400638133393").unwrap();
    assert_eq!(g.symbology, Symbology::Ean13);
    assert_eq!(g.text, "4006381333931");
    assert_eq!(g.modules_y, 1); // 1D
    assert!(g.rect_count() > 0);
    // A wrong supplied check is a typed error, not a silent re-checksum.
    assert!(matches!(
        encode(Symbology::Ean13, "4006381333932"),
        Err(BarcodeError::CheckDigit { .. })
    ));
}

#[test]
fn data_barcode_encode_upca_golden() {
    let g = encode(Symbology::UpcA, "036000291452").unwrap();
    assert_eq!(g.symbology, Symbology::UpcA);
    assert_eq!(g.text, "036000291452");
    // UPC-A is EAN-13 with a leading 0 → identical bars.
    let ean = encode(Symbology::Ean13, "0036000291452").unwrap();
    assert_eq!(g.rects, ean.rects);
}

#[test]
fn data_barcode_encode_code128_general() {
    let g = encode(Symbology::Code128, "ABC-123").unwrap();
    assert_eq!(g.symbology, Symbology::Code128);
    assert_eq!(g.text, "ABC-123");
    assert!(g.rect_count() > 0);
    // An unencodable (non-Latin-1) char is a typed error.
    assert!(matches!(
        encode(Symbology::Code128, "A\u{1F600}"),
        Err(BarcodeError::Unencodable(_))
    ));
}

#[test]
fn data_barcode_encode_qr_byte_mode() {
    let g = encode(Symbology::Qr, "https://paged.media").unwrap();
    assert_eq!(g.symbology, Symbology::Qr);
    // QR is a square matrix (incl. the 4-module quiet zone) with no HRI line.
    assert_eq!(g.modules_x, g.modules_y);
    assert!(g.text.is_empty());
    assert!(g.rect_count() > 0);
    // Determinism: same payload → identical geometry (bit-stable, §12.4).
    assert_eq!(
        g.rects,
        encode(Symbology::Qr, "https://paged.media").unwrap().rects
    );
    // An oversized payload (past the v10 byte ceiling) is a typed error.
    let big = "x".repeat(10_000);
    assert!(matches!(
        encode(Symbology::Qr, &big),
        Err(BarcodeError::TooLong { .. })
    ));
}

// ── data.barcode.bind — resolving a barcode binding to its value ────────────

#[test]
fn data_barcode_bind_round_trips_through_serde() {
    // The barcode binding is part of the document's serializable recipe — it
    // must JSON round-trip (kind tag + camelCase symbology + options).
    use data_core::BindingDef;
    let def = BindingDef {
        id: BindingId::from("bc1"),
        binding: barcode_binding(BarcodeSymbology::Qr, "url", BarcodeMissing::Flag),
    };
    let json = serde_json::to_string(&def).unwrap();
    assert!(json.contains("\"kind\":\"barcode\""));
    assert!(json.contains("\"symbology\":\"qr\""));
    let back: BindingDef = serde_json::from_str(&json).unwrap();
    assert_eq!(def, back);
}

#[test]
fn data_barcode_bind_resolves_field_value() {
    let mut e = engine_with("sku", "4006381333931");
    e.add_binding(
        BindingId::from("b"),
        barcode_binding(BarcodeSymbology::Ean13, "sku", BarcodeMissing::Skip),
    );
    match e.resolve(&BindingId::from("b")).unwrap() {
        Resolved::Barcode(rb) => {
            assert_eq!(rb.value, "4006381333931");
            assert_eq!(rb.symbology, BarcodeSymbology::Ean13);
            assert_eq!(rb.status, BarcodeResolveStatus::Present);
            assert_eq!(rb.target, FrameRef::from("bc-frame"));
        }
        other => panic!("expected barcode, got {other:?}"),
    }
}

#[test]
fn data_barcode_bind_missing_policy() {
    for (missing, status) in [
        (BarcodeMissing::Skip, BarcodeResolveStatus::Skipped),
        (BarcodeMissing::Flag, BarcodeResolveStatus::Flagged),
    ] {
        let mut e = engine_with("sku", ""); // empty value → missing
        e.add_binding(
            BindingId::from("b"),
            barcode_binding(BarcodeSymbology::Code128, "sku", missing),
        );
        match e.resolve(&BindingId::from("b")).unwrap() {
            Resolved::Barcode(rb) => {
                assert!(rb.value.is_empty());
                assert_eq!(rb.status, status);
            }
            other => panic!("expected barcode, got {other:?}"),
        }
    }
}

// ── data.barcode.lower — scaling the unit box to a content box ──────────────

#[test]
fn data_barcode_lower_scales_to_content_box() {
    // Encode then lower into a 144×72 pt frame box: modules are content-space
    // (offsets from the region top-left), scaled by the box size.
    let g = encode(Symbology::Code128, "SKU-42").unwrap();
    let lowered = lower_barcode(FrameRef::from("bc-frame"), &g, 144.0, 72.0);
    assert_eq!(lowered.symbology, "code128");
    assert_eq!(lowered.modules.len(), g.rect_count());
    assert_eq!(lowered.bounds.width_pt, 144.0);
    assert_eq!(lowered.bounds.height_pt, 72.0);
    // Every module is inside the content box (content-space, §9.6 — never
    // display geometry; a positive, in-bounds offset).
    for m in &lowered.modules {
        assert!(m.x_pt >= 0.0 && m.y_pt >= 0.0);
        assert!(m.x_pt + m.w_pt <= 144.0 + 1e-6);
        assert!(m.y_pt + m.h_pt <= 72.0 + 1e-6);
    }
    // A 1D barcode's modules span the full box height (full-height bars).
    assert!(lowered.modules.iter().all(|m| (m.h_pt - 72.0).abs() < 1e-6));
}

#[test]
fn data_barcode_lower_qr_modules_are_square_cells() {
    let g = encode(Symbology::Qr, "PAGED").unwrap();
    // Lower into a SQUARE box so the QR cells stay square.
    let lowered = lower_barcode(FrameRef::from("bc-frame"), &g, 100.0, 100.0);
    assert_eq!(lowered.symbology, "qr");
    assert_eq!(lowered.modules_x, lowered.modules_y);
    // Each module is a unit-grid cell scaled to the box → square, ≤ the box.
    let cell = 100.0 / g.modules_x as f64;
    for m in &lowered.modules {
        assert!((m.w_pt - cell).abs() < 1e-6);
        assert!((m.h_pt - cell).abs() < 1e-6);
    }
}
