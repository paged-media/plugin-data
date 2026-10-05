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

//! Property tests for the Wave 2 optimisations (feature `data.perf.gates`;
//! the file name keeps it under the cockpit test-map's
//! `data-conformance::perf` prefix). Each optimisation that replaced a slow
//! path is held to the slow path's answer here, on arbitrary input:
//!
//! - `stabilize` compares values in place ([`data_query::cmp_values`])
//!   instead of building a `value_key` per comparison: the order is the SAME
//!   total order, and it stays permutation-invariant over every value type.
//! - The engine caches the stabilized order per result content and numbers
//!   records in it: the preview stepper's record N is the same record
//!   whatever order the rows were delivered in, and a cached re-resolve is
//!   the same content as a cold one.
//! - The change report re-resolves only bindings whose dependency stamp
//!   moved: after ANY sequence of data changes its snapshot equals the full
//!   re-resolve of every binding.

use data_bind::ResolutionEngine;
use data_conformance::{record_set, today};
use data_core::{
    Binding, BindingDef, BindingId, ColumnBind, FieldType, FlowOpts, FrameChainRef, FrameRef,
    MissingPolicy, PlaceholderRef, Query, QueryId, ResultShape, TableOpts, Template, TemplateField,
    TemplateRef, Value, ValueError,
};
use data_js::core::DataSession;
use data_query::{cmp_values, order_rows, stabilize, value_key};
use proptest::prelude::*;

/// Any value, every variant — including the ones that share a sort tag
/// (`Date`/`DateTime`), negative zero and NaN, and text that is a prefix of
/// another.
fn any_value() -> impl Strategy<Value = Value> {
    prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        prop_oneof![
            any::<f64>(),
            Just(0.0),
            Just(-0.0),
            Just(f64::NAN),
            -3.0f64..3.0
        ]
        .prop_map(Value::Number),
        "[ab]{0,3}".prop_map(Value::text),
        any::<i32>().prop_map(Value::Date),
        prop_oneof![any::<i64>(), -3i64..3].prop_map(Value::DateTime),
        prop::collection::vec(0u8..3, 0..3).prop_map(Value::Bytes),
        prop_oneof![Just(ValueError::Type), Just(ValueError::Missing)].prop_map(Value::Error),
    ]
}

/// A 3-column record set of `rows` arbitrary values.
fn rows_strategy() -> impl Strategy<Value = Vec<[Value; 3]>> {
    prop::collection::vec([any_value(), any_value(), any_value()], 0..24)
}

fn make(rows: &[[Value; 3]]) -> data_core::RecordSet {
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

/// The order as the pre-Wave-2 comparator built it: a `value_key` per value
/// per comparison, key columns then every column.
fn reference_order(records: &data_core::RecordSet, keys: &[String]) -> Vec<usize> {
    let key_cols: Vec<usize> = if keys.is_empty() {
        (0..records.columns.len()).collect()
    } else {
        keys.iter()
            .filter_map(|n| records.schema.index_of(n))
            .collect()
    };
    let all: Vec<usize> = (0..records.columns.len()).collect();
    let mut idx: Vec<usize> = (0..records.row_count).collect();
    idx.sort_by(|&a, &b| {
        for &c in key_cols.iter().chain(all.iter()) {
            let va = records.value(a, c).map(value_key).unwrap_or_default();
            let vb = records.value(b, c).map(value_key).unwrap_or_default();
            match va.cmp(&vb) {
                std::cmp::Ordering::Equal => continue,
                other => return other,
            }
        }
        std::cmp::Ordering::Equal
    });
    idx
}

proptest! {
    /// The in-place comparison is exactly the `value_key` order, for every
    /// pair of values of any types.
    #[test]
    fn data_perf_prop_cmp_values_is_value_key_order(a in any_value(), b in any_value()) {
        prop_assert_eq!(cmp_values(Some(&a), Some(&b)), value_key(&a).cmp(&value_key(&b)));
        prop_assert_eq!(cmp_values(None, Some(&b)), (0u8, Vec::new()).cmp(&value_key(&b)));
    }

    /// `order_rows` returns the same permutation the allocating comparator
    /// did — with no keys, with one key, and with a key that is not a column.
    #[test]
    fn data_perf_prop_order_rows_matches_reference(
        rows in rows_strategy(),
        key in prop_oneof![Just(vec![]), Just(vec!["b".to_string()]), Just(vec!["zz".to_string(), "c".to_string()])],
    ) {
        let r = make(&rows);
        prop_assert_eq!(order_rows(&r, &key), reference_order(&r, &key));
    }

    /// Stabilizing is permutation-invariant over every value type: any
    /// delivery order of the same rows stabilizes to the same record set (a
    /// total order — NaN, signed zero and the shared date tag included).
    #[test]
    fn data_perf_prop_stabilize_permutation_invariant(
        rows in rows_strategy(),
        seed in any::<u64>(),
        key in prop_oneof![Just(vec![]), Just(vec!["a".to_string()])],
    ) {
        let mut shuffled = rows.clone();
        // A deterministic Fisher–Yates driven by `seed`.
        let mut s = seed | 1;
        for i in (1..shuffled.len()).rev() {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            shuffled.swap(i, (s % (i as u64 + 1)) as usize);
        }
        let a = stabilize(&make(&rows), &key);
        let b = stabilize(&make(&shuffled), &key);
        // Compare by content hash: NaN != NaN under PartialEq.
        prop_assert_eq!(data_query::content_hash(&a), data_query::content_hash(&b));
    }

    /// Record N (the preview stepper) is the same record for any delivery
    /// order of the same rows, and a session that resolves from the cached
    /// order agrees with a fresh session at every record.
    #[test]
    fn data_perf_prop_record_n_is_delivery_order_free(rows in rows_strategy(), seed in any::<u64>()) {
        let session = |rows: &[[Value; 3]]| {
            let mut s = DataSession::new(today());
            s.define_query(Query { id: QueryId::from("q"), sql: String::new(), params: vec![], shape: ResultShape::RecordStream });
            s.define_binding(BindingDef {
                id: BindingId::from("v"),
                binding: Binding::Variable {
                    target: PlaceholderRef::from("p"),
                    query: QueryId::from("q"),
                    expr: "CONCAT(a, \"|\", b, \"|\", c)".into(),
                    missing: MissingPolicy::Blank,
                },
            });
            s.ingest_result(QueryId::from("q"), make(rows));
            s
        };
        let mut shuffled = rows.clone();
        let mut x = seed | 1;
        for i in (1..shuffled.len()).rev() {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            shuffled.swap(i, (x % (i as u64 + 1)) as usize);
        }
        let (mut a, mut b) = (session(&rows), session(&shuffled));
        let id = BindingId::from("v");
        for record in 0..=rows.len() {
            let ra = format!("{:?}", a.resolve_lowered_at(&id, record));
            let rb = format!("{:?}", b.resolve_lowered_at(&id, record));
            // A fresh session for the same record (no cache warmed by earlier steps).
            let rc = format!("{:?}", session(&rows).resolve_lowered_at(&id, record));
            prop_assert_eq!(&ra, &rb);
            prop_assert_eq!(&ra, &rc);
        }
    }

    /// The incremental change-report snapshot equals the full one after every
    /// step of an arbitrary sequence of re-deliveries (cell edits, reorders,
    /// added and dropped rows) — a stamp never hides a content change.
    #[test]
    fn data_perf_prop_incremental_report_equals_full(
        steps in prop::collection::vec(rows_strategy(), 1..6),
    ) {
        let mut e = ResolutionEngine::new(today());
        let q = QueryId::from("q");
        e.add_query(Query { id: q.clone(), sql: String::new(), params: vec![], shape: ResultShape::RecordStream });
        let var = |expr: &str| Binding::Variable {
            target: PlaceholderRef::from("p"),
            query: q.clone(),
            expr: expr.into(),
            missing: MissingPolicy::Blank,
        };
        e.add_binding(BindingId::from("va"), var("a"));
        e.add_binding(BindingId::from("vbc"), var("CONCAT(b, c)"));
        e.add_binding(BindingId::from("vconst"), var("\"k\""));
        e.add_binding(BindingId::from("t"), Binding::Table {
            region: FrameRef::from("r"),
            query: q.clone(),
            columns: vec![ColumnBind { header: "B".into(), expr: "b".into(), style: None }],
            options: TableOpts { header_row: true, group_by: vec!["c".into()] },
        });
        e.add_template(Template {
            id: TemplateRef::from("tm"),
            fields: vec![TemplateField { label: String::new(), expr: "a".into() }],
            line_height_pt: 10.0,
        });
        e.add_binding(BindingId::from("f"), Binding::RecordFlow {
            chain: FrameChainRef::from("ch"),
            query: q.clone(),
            template: TemplateRef::from("tm"),
            options: FlowOpts { group_by: vec!["b".into()], repeat_header: false, continued_marker: false, footer: None },
        });
        let mut snap = Default::default();
        for rows in &steps {
            e.set_result(q.clone(), make(rows));
            snap = e.fingerprint_incremental(&snap);
            let got: std::collections::HashMap<String, String> = snap
                .iter()
                .filter_map(|(id, (_, fp))| fp.clone().map(|fp| (id.clone(), fp)))
                .collect();
            prop_assert_eq!(got, e.fingerprint_all());
        }
    }
}
