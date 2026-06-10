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

//! Performance gates (spec §12.5, the Rust-engine half). The DuckDB-WASM query
//! gate (1M-row CSV → grouped RecordSet < 1.5 s) runs in the worker, not here;
//! these two gate the ENGINE path the spec budgets: resolve + lower a 200-page
//! record-flow catalog (< 5 s) and an incremental 100-record-delta diff
//! (< 300 ms). Pure-Rust pagination/diff is millisecond-scale, so the real
//! budgets pass with huge margin — they exist to catch an O(n²) regression, not
//! to micro-benchmark.

use std::time::Instant;

use data_bind::diff;
use data_conformance::{n, record_set, t, today};
use data_core::{
    Binding, BindingDef, BindingId, FieldType, FlowOpts, FrameChainRef, Query, QueryId, RecordSet,
    ResultShape, Template, TemplateField, TemplateRef, Value,
};
use data_js::core::DataSession;
use data_lower::{FlowLayoutOpts, FrameCapacity};

fn template() -> Template {
    Template {
        id: TemplateRef::from("tmpl"),
        fields: vec![
            TemplateField {
                label: String::new(),
                expr: "name".into(),
            },
            TemplateField {
                label: "$".into(),
                expr: "NUMBER(price, 2)".into(),
            },
        ],
        line_height_pt: 10.0,
    }
}

#[test]
fn data_perf_catalog_lower_under_budget() {
    // ~7000 records → ~200 frames at 35 records/frame (each instance is
    // 2 fields × 10pt = 20pt; a 700pt frame holds 35). The §12.5 "200-page
    // record-flow catalog < 5 s" gate.
    let n_records = 7000usize;
    let names: Vec<Value> = (0..n_records).map(|i| t(&format!("item-{i:05}"))).collect();
    let prices: Vec<Value> = (0..n_records).map(|i| n(i as f64 * 1.5)).collect();
    let records = record_set(
        &[("name", FieldType::Text), ("price", FieldType::Float)],
        vec![names, prices],
    );

    let mut s = DataSession::new(today());
    s.define_query(Query {
        id: QueryId::from("q1"),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    s.define_template(template());
    s.define_binding(BindingDef {
        id: BindingId::from("rf"),
        binding: Binding::RecordFlow {
            chain: FrameChainRef::from("chain"),
            query: QueryId::from("q1"),
            template: TemplateRef::from("tmpl"),
            options: FlowOpts {
                group_by: vec![],
                repeat_header: false,
                continued_marker: false,
                footer: None,
            },
        },
    });
    s.ingest_result(QueryId::from("q1"), records);

    let chain: Vec<FrameCapacity> = (0..240)
        .map(|i| FrameCapacity {
            frame: format!("f{i}"),
            page: format!("p{i}"),
            height_pt: 700.0,
        })
        .collect();

    let start = Instant::now();
    let flow = s
        .lower_record_flow(&BindingId::from("rf"), chain, FlowLayoutOpts::default())
        .unwrap();
    let elapsed = start.elapsed();

    assert!(
        !flow.overflow,
        "chain too short — only {} of {} records placed",
        flow.placed, flow.total
    );
    assert!(
        flow.frames.len() > 100,
        "expected catalog-scale pagination, got {} frames",
        flow.frames.len()
    );
    assert!(
        elapsed.as_secs_f64() < 5.0,
        "200-page catalog lower took {elapsed:?} — over the §12.5 5s budget"
    );
    eprintln!(
        "perf: {n_records} records → {} frames in {elapsed:?}",
        flow.frames.len()
    );
}

#[test]
fn data_perf_incremental_diff_under_budget() {
    // §12.5 "incremental refresh < 300 ms for a 100-record delta": the
    // record-identity diff over a 5000-record set with a 100-row change.
    let make = |start: usize, count: usize| -> RecordSet {
        let ids: Vec<Value> = (start..start + count)
            .map(|i| t(&format!("id-{i:06}")))
            .collect();
        let prices: Vec<Value> = (start..start + count).map(|i| n(i as f64)).collect();
        record_set(
            &[("id", FieldType::Text), ("price", FieldType::Float)],
            vec![ids, prices],
        )
    };
    let old = make(0, 5000);
    let new = make(50, 5000); // drop ids 0..50, add ids 5000..5050 → a 100-row delta

    let start = Instant::now();
    let delta = diff(&old, &new, &["id".to_string()]);
    let elapsed = start.elapsed();

    assert_eq!(delta.removed.len(), 50, "expected 50 removed keys");
    assert_eq!(delta.inserted.len(), 50, "expected 50 inserted rows");
    assert!(
        elapsed.as_secs_f64() < 0.3,
        "100-record delta diff took {elapsed:?} — over the §12.5 300ms budget"
    );
    eprintln!("perf: 5000-record diff (100-delta) in {elapsed:?}");
}
