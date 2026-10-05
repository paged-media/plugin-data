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

//! Property oracles (docs/design/oracles.md, campaign Wave 3): the invariants
//! the engine's identity, refresh and save machinery stand on, checked over
//! generated inputs, plus barcode encode → independent decode.
//!
//! - `stabilize` is a permutation-invariant TOTAL order: any delivery order
//!   of the same rows stabilizes to the same record set, the result is a
//!   permutation of the input, stabilizing twice changes nothing, and within
//!   one value kind it follows the value order.
//! - `diff(old, new)` applied to `old` gives `new` (keyed rows).
//! - The document payload round-trips save → JSON → load → save.
//! - Re-resolving and re-reporting without a data change is a no-op.
//! - EAN-13 / UPC-A and Code-128 decode with independent symbol tables (the
//!   published tables, written in another form than the encoder's); QR decodes
//!   with `rqrr` (a separate implementation; MIT OR Apache-2.0).
//!
//! Defects found here are pinned by `defect_*` tests that assert today's
//! wrong behaviour, so they fail the day the defect is fixed.

// `__feat__<id>` test names: the cockpit test-to-feature join.
#![allow(non_snake_case)]

use std::collections::BTreeMap;

use data_barcode::{encode, BarcodeGeometry, Symbology};
use data_bind::diff;
use data_conformance::{record_set, today};
use data_core::{
    Binding, BindingDef, BindingId, CapabilityRef, ColumnBind, DataSource, FieldType, FlowOpts,
    FrameChainRef, FrameRef, MissingPolicy, PlaceholderRef, Query, QueryId, RecordSet,
    RefreshPolicy, ResultShape, SourceId, SourceKind, TableOpts, Template, TemplateField,
    TemplateRef, Value,
};
use data_js::core::{DataSession, DocumentPayload};
use data_query::stabilize;
use proptest::prelude::*;

// ── generators ──────────────────────────────────────────────────────────────

/// Any value kind a result can carry (Date/DateTime non-negative: see
/// `defect_dp1_*`), including NaN, ±0 and ±∞.
fn value() -> impl Strategy<Value = Value> {
    prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        prop_oneof![
            any::<f64>(),
            Just(f64::NAN),
            Just(-0.0),
            Just(f64::INFINITY),
            Just(f64::NEG_INFINITY)
        ]
        .prop_map(Value::Number),
        "\\PC{0,6}".prop_map(|s| Value::text(&s)),
        (0i32..40_000).prop_map(Value::Date),
        (0i64..4_000_000_000_000).prop_map(Value::DateTime),
    ]
}

/// A 3-column result with mixed kinds per cell.
fn rows() -> impl Strategy<Value = Vec<[Value; 3]>> {
    prop::collection::vec([value(), value(), value()], 0..14)
}

fn rs(rows: &[[Value; 3]]) -> RecordSet {
    record_set(
        &[
            ("a", FieldType::Text),
            ("b", FieldType::Text),
            ("c", FieldType::Text),
        ],
        (0..3)
            .map(|c| rows.iter().map(|r| r[c].clone()).collect())
            .collect(),
    )
}

/// Structural equality that treats NaN as equal to itself (Value's
/// PartialEq does not).
fn same(a: &RecordSet, b: &RecordSet) -> bool {
    format!("{a:?}") == format!("{b:?}")
}

fn row_strings(r: &RecordSet) -> Vec<String> {
    let mut v: Vec<String> = (0..r.row_count)
        .map(|i| {
            format!(
                "{:?}",
                (0..r.columns.len())
                    .map(|c| r.value(i, c))
                    .collect::<Vec<_>>()
            )
        })
        .collect();
    v.sort();
    v
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn data_prop_stabilize_permutation_invariant__feat__data_query_seam(
        (rows, shuffled) in rows().prop_flat_map(|r| (Just(r.clone()), Just(r).prop_shuffle())),
        keyed in any::<bool>(),
    ) {
        let keys: Vec<String> = if keyed { vec!["b".into()] } else { vec![] };
        let a = stabilize(&rs(&rows), &keys);
        let b = stabilize(&rs(&shuffled), &keys);
        prop_assert!(same(&a, &b), "{a:?}\n≠\n{b:?}");
    }

    #[test]
    fn data_prop_stabilize_is_an_idempotent_permutation__feat__data_query_seam(rows in rows(), keyed in any::<bool>()) {
        let keys: Vec<String> = if keyed { vec!["c".into(), "a".into()] } else { vec![] };
        let input = rs(&rows);
        let once = stabilize(&input, &keys);
        prop_assert_eq!(row_strings(&once), row_strings(&input));
        prop_assert!(same(&stabilize(&once, &keys), &once));
    }

    /// Within one value kind the order is the value order: numbers by IEEE
    /// total order, text by bytes, dates/times ascending, false < true.
    #[test]
    fn data_prop_stabilize_follows_value_order__feat__data_query_seam(
        nums in prop::collection::vec(any::<f64>(), 0..12),
        texts in prop::collection::vec("\\PC{0,5}", 0..12),
        days in prop::collection::vec(0i32..40_000, 0..12),
    ) {
        let col = |v: Vec<Value>| record_set(&[("k", FieldType::Text)], vec![v]);
        let keys = ["k".to_string()];

        let got: Vec<f64> = stabilize(&col(nums.iter().map(|n| Value::Number(*n)).collect()), &keys)
            .columns[0].iter().map(|v| match v { Value::Number(n) => *n, _ => unreachable!() }).collect();
        let mut want = nums.clone();
        want.sort_by(f64::total_cmp);
        prop_assert_eq!(got.iter().map(|n| n.to_bits()).collect::<Vec<_>>(), want.iter().map(|n| n.to_bits()).collect::<Vec<_>>());

        let got: Vec<String> = stabilize(&col(texts.iter().map(Value::text).collect()), &keys)
            .columns[0].iter().map(|v| v.as_display()).collect();
        let mut want = texts.clone();
        want.sort();
        prop_assert_eq!(got, want);

        let got: Vec<Value> = stabilize(&col(days.iter().map(|d| Value::Date(*d)).collect()), &keys).columns[0].clone();
        let mut want = days.clone();
        want.sort();
        prop_assert_eq!(got, want.into_iter().map(Value::Date).collect::<Vec<_>>());
    }

    /// `diff(old, new)` applied to `old` yields `new`: drop `removed`, take
    /// `inserted` and `updated` rows from `new`, keep the rest.
    #[test]
    fn data_prop_diff_applied_yields_new__feat__data_bind_engine(
        old in prop::collection::btree_map(0u8..24, 0i32..4, 0..16),
        new in prop::collection::btree_map(0u8..24, 0i32..4, 0..16),
    ) {
        let make = |m: &BTreeMap<u8, i32>| record_set(
            &[("id", FieldType::Text), ("v", FieldType::Float)],
            vec![
                m.keys().map(|k| Value::text(format!("k{k}"))).collect(),
                m.values().map(|v| Value::Number(*v as f64)).collect(),
            ],
        );
        let (o, n) = (make(&old), make(&new));
        let delta = diff(&o, &n, &["id".to_string()]);

        let key = |r: &RecordSet, i: usize| r.value(i, 0).unwrap().as_display();
        let mut applied: BTreeMap<String, String> =
            (0..o.row_count).map(|i| (key(&o, i), format!("{:?}", o.value(i, 1)))).collect();
        // `removed` carries diff's internal key encoding (DP-3), so learn each
        // old row's encoded key from a one-row diff against nothing.
        let encoded: BTreeMap<String, String> = old
            .iter()
            .map(|(k, v)| {
                let one = make(&BTreeMap::from([(*k, *v)]));
                (diff(&one, &make(&BTreeMap::new()), &["id".to_string()]).removed[0].clone(), format!("k{k}"))
            })
            .collect();
        for k in &delta.removed {
            let raw = encoded.get(k).unwrap_or_else(|| panic!("removed key {k} is no old row's key"));
            prop_assert!(applied.remove(raw).is_some());
        }
        for &i in delta.inserted.iter().chain(&delta.updated) {
            applied.insert(key(&n, i), format!("{:?}", n.value(i, 1)));
        }
        let want: BTreeMap<String, String> =
            (0..n.row_count).map(|i| (key(&n, i), format!("{:?}", n.value(i, 1)))).collect();
        prop_assert_eq!(applied, want);
        prop_assert_eq!(delta.inserted.len() + delta.updated.len() + delta.unchanged, n.row_count);
    }

    /// save → JSON → load → save is the identity for any recipe.
    #[test]
    fn data_prop_payload_round_trips__feat__data_plugin_bundle(
        names in prop::collection::vec("\\PC{1,8}", 1..5),
        exprs in prop::collection::vec("[a-z]{1,6}|UPPER\\([a-z]{1,4}\\)|\"\\PC{0,6}\"", 1..5),
        sets in prop::collection::vec("\\PC{1,6}", 0..3),
        line in (8u32..240).prop_map(|e| e as f64 / 8.0),
    ) {
        let mut s = DataSession::new(today());
        for (i, name) in names.iter().enumerate() {
            s.define_source(DataSource {
                id: SourceId::from(format!("s{i}").as_str()),
                kind: SourceKind::InlineSeed { table: name.clone() },
                capability: CapabilityRef::from("inline"),
                refresh: RefreshPolicy::Manual,
            });
            s.define_query(Query {
                id: QueryId::from(format!("q{i}").as_str()),
                sql: format!("SELECT * FROM \"{name}\""),
                params: vec![],
                shape: ResultShape::RecordStream,
            });
        }
        s.define_template(Template {
            id: TemplateRef::from("t"),
            fields: exprs.iter().map(|e| TemplateField { label: format!("{e}: "), expr: e.clone() }).collect(),
            line_height_pt: line,
        });
        for (i, e) in exprs.iter().enumerate() {
            let q = QueryId::from(format!("q{}", i % names.len()).as_str());
            s.define_binding(BindingDef {
                id: BindingId::from(format!("v{i}").as_str()),
                binding: Binding::Variable {
                    target: PlaceholderRef::from(format!("ph{i}").as_str()),
                    query: q.clone(),
                    expr: e.clone(),
                    missing: MissingPolicy::Blank,
                },
            });
            s.define_binding(BindingDef {
                id: BindingId::from(format!("t{i}").as_str()),
                binding: Binding::Table {
                    region: FrameRef::from("r"),
                    query: q.clone(),
                    columns: vec![ColumnBind { header: e.clone(), expr: e.clone(), style: None }],
                    options: TableOpts::default(),
                },
            });
        }
        s.define_binding(BindingDef {
            id: BindingId::from("rf"),
            binding: Binding::RecordFlow {
                chain: FrameChainRef::from("c"),
                query: QueryId::from("q0"),
                template: TemplateRef::from("t"),
                options: FlowOpts::default(),
            },
        });
        s.ingest_result(QueryId::from("q0"), record_set(&[("a", FieldType::Text)], vec![vec![Value::text("x")]]));
        for name in &sets {
            s.capture_data_set(name, 0);
        }

        let saved = s.payload();
        let json = serde_json::to_string(&saved).unwrap();
        let loaded: DocumentPayload = serde_json::from_str(&json).unwrap();
        prop_assert_eq!(&loaded, &saved);
        prop_assert_eq!(DataSession::from_payload(loaded, today()).payload(), saved);
    }

    /// With no data change, a second resolve and a second change report are
    /// no-ops: identical output, nothing changed/added/removed.
    #[test]
    fn data_prop_refresh_and_resolve_are_idempotent__feat__data_bind_change_report(rows in rows()) {
        let mut s = DataSession::new(today());
        s.define_query(Query { id: QueryId::from("q"), sql: String::new(), params: vec![], shape: ResultShape::RecordStream });
        s.define_binding(BindingDef {
            id: BindingId::from("t"),
            binding: Binding::Table {
                region: FrameRef::from("r"),
                query: QueryId::from("q"),
                columns: ["a", "b", "c"].iter().map(|c| ColumnBind { header: c.to_string(), expr: c.to_string(), style: None }).collect(),
                options: TableOpts::default(),
            },
        });
        s.define_binding(BindingDef {
            id: BindingId::from("v"),
            binding: Binding::Variable { target: PlaceholderRef::from("p"), query: QueryId::from("q"), expr: "a".into(), missing: MissingPolicy::Blank },
        });
        s.ingest_result(QueryId::from("q"), rs(&rows));
        let first = format!("{:?}", s.resolve_lowered(&BindingId::from("t")));
        let _baseline = s.refresh_change_report();
        prop_assert_eq!(format!("{:?}", s.resolve_lowered(&BindingId::from("t"))), first);
        let again = s.refresh_change_report();
        prop_assert_eq!((again.changed, again.added, again.removed), (0, 0, 0));

        // Re-ingesting the same rows (same delivery order) is still no change;
        // another delivery order is DP-4.
        s.ingest_result(QueryId::from("q"), rs(&rows));
        let after = s.refresh_change_report();
        prop_assert_eq!((after.changed, after.added, after.removed), (0, 0, 0));
    }

    #[test]
    fn data_prop_ean13_decodes_back__feat__data_barcode_symbology(digits in prop::collection::vec(0u8..10, 12)) {
        // Every first digit: 1–9 select a parity row with G symbols (DB-1).
        let s: String = digits.iter().map(|d| (b'0' + d) as char).collect();
        let g = encode(Symbology::Ean13, &s).unwrap();
        prop_assert_eq!(decode_ean13(&g), Some(g.text.clone()));
        prop_assert!(g.text.starts_with(&s));
    }

    #[test]
    fn data_prop_upca_decodes_back__feat__data_barcode_symbology(digits in prop::collection::vec(0u8..10, 11)) {
        let s: String = digits.iter().map(|d| (b'0' + d) as char).collect();
        let g = encode(Symbology::UpcA, &s).unwrap();
        // UPC-A is EAN-13 with an implicit leading 0.
        prop_assert_eq!(decode_ean13(&g), Some(format!("0{}", g.text)));
    }

    #[test]
    fn data_prop_qr_decodes_back__feat__data_barcode_symbology(
        payload in prop_oneof![
            "[ -~]{1,213}",
            "\\PC{1,60}",
            prop::collection::vec(any::<char>(), 1..50).prop_map(|c| c.into_iter().collect::<String>()),
        ].prop_filter("fits v10-M byte mode", |p| p.len() <= 213)
    ) {
        // Byte mode, level M, v1–v10: up to 213 bytes, so every version.
        let g = encode(Symbology::Qr, &payload).unwrap();
        prop_assert_eq!(decode_qr(&g), Ok(payload));
    }
    #[test]
    fn data_prop_code128_decodes_back__feat__data_barcode_symbology(
        payload in prop_oneof![
            "[ -~\\x7f]{1,40}",
            "[0-9]{1,40}",
            "([A-Z]{0,3}[0-9]{0,9}){1,4}",
        ].prop_filter("non-empty", |p| !p.is_empty())
    ) {
        // Every printable ASCII string, and digit runs that exercise the B↔C
        // switching (odd and even, leading, inner and trailing).
        let g = encode(Symbology::Code128, &payload).unwrap();
        prop_assert_eq!(decode_code128(&g), Ok(payload));
    }
}

// ── independent decoders ────────────────────────────────────────────────────

/// The module row of a 1D symbol (true = dark), from its unit-box rects.
fn modules_1d(g: &BarcodeGeometry) -> Vec<bool> {
    let n = g.modules_x as usize;
    let mut bits = vec![false; n];
    for r in &g.rects {
        let start = (r.x * n as f64).round() as usize;
        let len = (r.w * n as f64).round() as usize;
        bits[start..start + len].iter_mut().for_each(|b| *b = true);
    }
    bits
}

/// EAN-13 from the published symbol tables (GS1 General Specifications
/// §5.2.1): L codes, G = reversed R, R = complemented L, and the first digit
/// carried by the L/G parity of the left half.
fn decode_ean13(g: &BarcodeGeometry) -> Option<String> {
    const L: [&str; 10] = [
        "0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011",
        "0110111", "0001011",
    ];
    const PARITY: [&str; 10] = [
        "LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL",
        "LGGLGL",
    ];
    let bits = modules_1d(g);
    let start = bits.iter().position(|b| *b)?;
    let body: String = bits
        .get(start..start + 95)?
        .iter()
        .map(|b| if *b { '1' } else { '0' })
        .collect();
    if &body[0..3] != "101" || &body[45..50] != "01010" || &body[92..95] != "101" {
        return None;
    }
    let r = |l: &str| {
        l.chars()
            .map(|c| if c == '0' { '1' } else { '0' })
            .collect::<String>()
    };
    let mut digits = String::new();
    let mut parity = String::new();
    for i in 0..6 {
        let sym = &body[3 + 7 * i..10 + 7 * i];
        if let Some(d) = L.iter().position(|l| *l == sym) {
            digits.push((b'0' + d as u8) as char);
            parity.push('L');
        } else if let Some(d) = L
            .iter()
            .position(|l| r(l).chars().rev().collect::<String>() == sym)
        {
            digits.push((b'0' + d as u8) as char);
            parity.push('G');
        } else {
            return None;
        }
    }
    for i in 0..6 {
        let sym = &body[50 + 7 * i..57 + 7 * i];
        let d = L.iter().position(|l| r(l) == sym)?;
        digits.push((b'0' + d as u8) as char);
    }
    let first = PARITY.iter().position(|p| *p == parity)?;
    Some(format!("{first}{digits}"))
}

/// Code-128 from the published symbol table (ISO/IEC 15417 Table 1), written as
/// bar/space WIDTHS (b s b s b s), not as the encoder's module strings: read
/// each 11-module symbol's run widths, look the value up, check the weighted
/// mod-103 check symbol, then interpret the values through code sets A, B and
/// C (incl. the code-set switches and SHIFT).
fn decode_code128(g: &BarcodeGeometry) -> Result<String, String> {
    #[rustfmt::skip]
    const WIDTHS: [&str; 106] = [
        "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
        "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
        "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
        "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
        "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
        "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
        "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
        "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
        "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
        "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
        "114131", "311141", "411131", "211412", "211214", "211232",
    ];
    const STOP: &str = "2331112";
    let widths = |m: &[bool]| -> String {
        let mut out = String::new();
        let mut run = 1;
        for i in 1..=m.len() {
            if i < m.len() && m[i] == m[i - 1] {
                run += 1;
            } else {
                out.push((b'0' + run) as char);
                run = 1;
            }
        }
        out
    };
    let bits = modules_1d(g);
    let start = bits.iter().position(|b| *b).ok_or("no bars")?;
    let end = bits.iter().rposition(|b| *b).ok_or("no bars")? + 1;
    let body = &bits[start..end];
    if body.len() < 13 + 2 * 11 || (body.len() - 13) % 11 != 0 {
        return Err(format!("{} modules is not n×11 + 13", body.len()));
    }
    let (symbols, stop) = body.split_at(body.len() - 13);
    if widths(stop) != STOP {
        return Err("no stop pattern".into());
    }
    let values = symbols
        .chunks(11)
        .map(|c| {
            let w = widths(c);
            WIDTHS
                .iter()
                .position(|p| *p == w)
                .ok_or(format!("unknown symbol {w}"))
        })
        .collect::<Result<Vec<usize>, String>>()?;
    let (check, values) = values.split_last().ok_or("no check symbol")?;
    let sum: usize = values[0]
        + values
            .iter()
            .enumerate()
            .skip(1)
            .map(|(i, v)| i * v)
            .sum::<usize>();
    if sum % 103 != *check {
        return Err(format!("check {check} != {}", sum % 103));
    }
    #[derive(Clone, Copy, PartialEq)]
    enum Set {
        A,
        B,
        C,
    }
    let mut set = match values[0] {
        103 => Set::A,
        104 => Set::B,
        105 => Set::C,
        v => return Err(format!("{v} is not a start symbol")),
    };
    let mut out = String::new();
    let mut shift = false;
    for &v in &values[1..] {
        let cur = if shift {
            if set == Set::A {
                Set::B
            } else {
                Set::A
            }
        } else {
            set
        };
        shift = false;
        match (cur, v) {
            (Set::C, 0..=99) => out.push_str(&format!("{v:02}")),
            (Set::C, 100) | (Set::A, 100) => set = Set::B,
            (Set::C, 101) | (Set::B, 101) => set = Set::A,
            (Set::A, 99) | (Set::B, 99) => set = Set::C,
            (Set::A, 98) | (Set::B, 98) => shift = true,
            (Set::A, 0..=63) => out.push((v as u8 + 32) as char),
            (Set::A, 64..=95) => out.push((v as u8 - 64) as char),
            (Set::B, 0..=95) => out.push((v as u8 + 32) as char),
            (_, v) => return Err(format!("unsupported symbol {v} (FNC)")),
        }
    }
    Ok(out)
}

/// The Code-128 decoder is not vacuous: it reads the published "Wikipedia"
/// vector (start B, check 88) and rejects a symbol with one module flipped.
#[test]
fn data_code128_decoder_reads_the_published_vector__feat__data_barcode_symbology() {
    let g = encode(Symbology::Code128, "Wikipedia").unwrap();
    assert_eq!(decode_code128(&g).as_deref(), Ok("Wikipedia"));
    // Start B + 9 symbols + check + stop = 11×11 + 13 modules.
    let bits = modules_1d(&g);
    let start = bits.iter().position(|b| *b).unwrap();
    assert_eq!(
        bits.iter().rposition(|b| *b).unwrap() + 1 - start,
        11 * 11 + 13
    );
    // Turn one module of the third symbol dark: the widths no longer match.
    let mut broken = g.clone();
    let unit = 1.0 / g.modules_x as f64;
    broken.rects.push(data_barcode::BarcodeRect {
        x: (start + 2 * 11 + 4) as f64 * unit,
        y: 0.0,
        w: unit,
        h: 1.0,
    });
    assert!(decode_code128(&broken).is_err());
}

/// QR through rqrr: rasterise the module grid (4 px per module) and decode.
fn decode_qr(g: &BarcodeGeometry) -> Result<String, String> {
    const PX: usize = 4;
    let n = g.modules_x as usize;
    let side = n * PX;
    let mut dark = vec![false; n * n];
    for r in &g.rects {
        let (x, y) = (
            (r.x * n as f64).round() as usize,
            (r.y * n as f64).round() as usize,
        );
        let (w, h) = (
            (r.w * n as f64).round() as usize,
            (r.h * n as f64).round() as usize,
        );
        for yy in y..y + h {
            for xx in x..x + w {
                dark[yy * n + xx] = true;
            }
        }
    }
    let mut img = rqrr::PreparedImage::prepare_from_greyscale(side, side, |x, y| {
        if dark[(y / PX) * n + x / PX] {
            0
        } else {
            255
        }
    });
    let grids = img.detect_grids();
    let grid = grids.first().ok_or("no QR grid found")?;
    grid.decode()
        .map(|(_, content)| content)
        .map_err(|e| e.to_string())
}

// ── pinned defects ──────────────────────────────────────────────────────────

/// DEFECT DP-1: `value_key` writes a Date/DateTime as big-endian
/// two's-complement bytes, so a negative one (before 1970) compares as a huge
/// unsigned value and stabilizes AFTER every later date. Record order, group
/// order and record identity all follow it. (The property above therefore
/// draws non-negative dates; this pin goes red when the order is fixed.)
#[test]
fn defect_dp1_pre_1970_dates_stabilize_after_later_ones__feat__data_query_seam() {
    let col = |v: Vec<Value>| record_set(&[("k", FieldType::Text)], vec![v]);
    let keys = ["k".to_string()];
    let dates = stabilize(&col(vec![Value::Date(1), Value::Date(-1)]), &keys);
    assert_eq!(
        dates.columns[0],
        vec![Value::Date(1), Value::Date(-1)],
        "DP-1 fixed? 1969-12-31 now sorts first: drop this pin"
    );
    let times = stabilize(
        &col(vec![Value::DateTime(1_000), Value::DateTime(-1_000)]),
        &keys,
    );
    assert_eq!(
        times.columns[0],
        vec![Value::DateTime(1_000), Value::DateTime(-1_000)]
    );
}

/// DEFECT DP-2: the payload's f64 fields do not survive serde_json (the
/// workspace builds serde_json without `float_roundtrip`), so a line height
/// drifts by an ulp per save → load. The wasm boundary (serde-wasm-bindgen →
/// JS numbers) is exact; data-cli and any Rust-side JSON are not.
#[test]
fn defect_dp2_payload_f64_drifts_through_json__feat__data_plugin_bundle() {
    let mut s = DataSession::new(today());
    s.define_template(Template {
        id: TemplateRef::from("t"),
        fields: vec![],
        line_height_pt: f64::from_bits(0x402d_0123_4567_c789), // 14.502222222250355
    });
    let saved = s.payload();
    let loaded: DocumentPayload =
        serde_json::from_str(&serde_json::to_string(&saved).unwrap()).unwrap();
    assert_ne!(
        loaded, saved,
        "DP-2 fixed? the payload round-trips: drop this pin"
    );
    assert_eq!(
        loaded.templates[0].line_height_pt.to_bits(),
        0x402d_0123_4567_c78a
    );
}

/// DEFECT DP-3: `RowDelta.removed` holds diff's internal key encoding
/// (`"<len>:<value>\u{1f}"`), not the old row's key values or index, so a change
/// report cannot name the rows it removed.
#[test]
fn defect_dp3_diff_removed_keys_are_internal_encodings__feat__data_bind_engine() {
    let old = record_set(&[("id", FieldType::Text)], vec![vec![Value::text("k2")]]);
    let new = record_set(&[("id", FieldType::Text)], vec![vec![]]);
    assert_eq!(
        diff(&old, &new, &["id".to_string()]).removed,
        vec!["3:k2\u{1f}".to_string()]
    );
}

/// DEFECT DP-4: a variable binding reads record 0 of the DELIVERY order, not
/// of the stabilized order, so the same rows delivered in another order (as
/// DuckDB may, without ORDER BY) flip the value and the change report calls
/// it a change. (Tables stabilize and stay unchanged.)
#[test]
fn defect_dp4_variable_follows_delivery_order__feat__data_bind_change_report() {
    let mut s = DataSession::new(today());
    s.define_query(Query {
        id: QueryId::from("q"),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    s.define_binding(BindingDef {
        id: BindingId::from("v"),
        binding: Binding::Variable {
            target: PlaceholderRef::from("p"),
            query: QueryId::from("q"),
            expr: "a".into(),
            missing: MissingPolicy::Blank,
        },
    });
    let rows = [
        [Value::Null, Value::Null, Value::Null],
        [Value::Bool(false), Value::Null, Value::Null],
    ];
    s.ingest_result(QueryId::from("q"), rs(&rows));
    s.refresh_change_report();
    let mut reversed = rows.clone();
    reversed.reverse();
    s.ingest_result(QueryId::from("q"), rs(&reversed));
    let report = s.refresh_change_report();
    assert_eq!(
        report.changed, 1,
        "DP-4 fixed? same rows, other order, no change: drop this pin"
    );
}

/// DB-1 (fixed): the EAN-13 encoder wrote G-parity symbols INVERTED (digit 0
/// as 1011000, not 0100111), so every EAN-13 whose first digit is not 0 — all
/// of GS1 Germany's 400–440, for one — was unscannable. The property above now
/// draws every first digit; this keeps the GS1 worked example and the exact G(0)
/// symbol as a named regression.
#[test]
fn data_db1_ean13_g_parity_symbols_decode__feat__data_barcode_symbology() {
    let g = encode(Symbology::Ean13, "400638133393").unwrap();
    assert_eq!(g.text, "4006381333931");
    assert_eq!(decode_ean13(&g).as_deref(), Some("4006381333931"));
    let g = encode(Symbology::Ean13, "100000000000").unwrap();
    let bits: String = modules_1d(&g)
        .iter()
        .map(|b| if *b { '1' } else { '0' })
        .collect();
    let start = bits.find('1').unwrap();
    // Third digit, G parity for first digit 1 (LLGLGG): G(0) = 0100111.
    assert_eq!(&bits[start + 3 + 14..start + 3 + 21], "0100111");
}

/// DB-2 (fixed): QR symbols did not decode with an independent decoder. The
/// data modules matched a reference encoder (python `qrcode`, same version 1-M
/// and mask 4); the format information was written bit-reversed and the dark
/// module was cleared, so a conformant reader took the wrong mask/level and
/// failed Reed-Solomon (rqrr: DataEcc). The QR property above now decodes
/// every payload; these are the payloads the pin carried.
#[test]
fn data_db2_qr_symbols_decode__feat__data_barcode_symbology() {
    for payload in ["A", "hello world", "https://paged.media/x?y=1"] {
        let g = encode(Symbology::Qr, payload).unwrap();
        assert_eq!(decode_qr(&g).as_deref(), Ok(payload));
    }
}
