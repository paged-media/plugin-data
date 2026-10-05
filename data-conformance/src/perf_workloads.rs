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

//! The engine workloads the Wave 1 perf harness measures — shared by the
//! criterion benches (`benches/engine.rs`, wall clock, trended) and the count
//! budgets (`tests/perf_counts.rs`, gated). One builder per workload, so the
//! bench and the budget can never drift apart on what they run.

use data_core::{
    Binding, BindingDef, BindingId, ColumnBind, FieldType, FlowOpts, FrameChainRef, FrameRef,
    MissingPolicy, PlaceholderRef, Query, QueryId, RecordSet, ResultShape, TableOpts, Template,
    TemplateField, TemplateRef, Value,
};
use data_js::core::DataSession;
use data_lower::FrameCapacity;

use crate::{n, record_set, t, today};

/// A product catalog of `rows` records: `sku` (text, a deterministic
/// SHUFFLE of `0..rows`, so `stabilize` has real sorting to do — a sorted or
/// reversed input is one run the sort finishes in n-1 comparisons), `name`
/// (text), `price` (float), `cat` (text, `groups` distinct values).
pub fn catalog(rows: usize, groups: usize) -> RecordSet {
    let sku: Vec<Value> = (0..rows)
        .map(|i| t(&format!("SKU-{:06}", shuffle(i, rows))))
        .collect();
    let name: Vec<Value> = (0..rows).map(|i| t(&format!("item {i}"))).collect();
    let price: Vec<Value> = (0..rows).map(|i| n(i as f64 * 1.25)).collect();
    let cat: Vec<Value> = (0..rows)
        .map(|i| t(&format!("cat-{:03}", i % groups.max(1))))
        .collect();
    record_set(
        &[
            ("sku", FieldType::Text),
            ("name", FieldType::Text),
            ("price", FieldType::Float),
            ("cat", FieldType::Text),
        ],
        vec![sku, name, price, cat],
    )
}

/// `i * 7919 mod rows` — a permutation of `0..rows` whenever `rows` is not a
/// multiple of the prime 7919 (true for every workload size here).
fn shuffle(i: usize, rows: usize) -> usize {
    (i * 7919) % rows.max(1)
}

fn query(s: &mut DataSession, id: &str) {
    s.define_query(Query {
        id: QueryId::from(id),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
}

fn table_binding(id: &str, group_by: Vec<String>) -> BindingDef {
    BindingDef {
        id: BindingId::from(id),
        binding: Binding::Table {
            region: FrameRef::from("region"),
            query: QueryId::from("q1"),
            columns: vec![
                ColumnBind {
                    header: "SKU".into(),
                    expr: "sku".into(),
                    style: None,
                },
                ColumnBind {
                    header: "Name".into(),
                    expr: "UPPER(name)".into(),
                    style: None,
                },
                ColumnBind {
                    header: "Price".into(),
                    expr: "CURRENCY(price)".into(),
                    style: None,
                },
            ],
            options: TableOpts {
                header_row: true,
                group_by,
            },
        },
    }
}

fn variable_binding(id: &str, expr: &str) -> BindingDef {
    BindingDef {
        id: BindingId::from(id),
        binding: Binding::Variable {
            target: PlaceholderRef::from(id),
            query: QueryId::from("q1"),
            expr: expr.into(),
            missing: MissingPolicy::Blank,
        },
    }
}

/// W-R1: one 3-column table binding over a `rows`-row result (resolve it
/// with `resolve_lowered("t1")`).
pub fn table_session(rows: usize) -> DataSession {
    let mut s = DataSession::new(today());
    query(&mut s, "q1");
    s.define_binding(table_binding("t1", vec![]));
    s.ingest_result(QueryId::from("q1"), catalog(rows, 50));
    s
}

/// W-R2: a record-flow catalog of `rows` records (2-field template, 10 pt
/// lines) and a chain long enough to place it all (`lower_record_flow("rf")`).
pub fn catalog_session(rows: usize) -> (DataSession, Vec<FrameCapacity>) {
    let mut s = DataSession::new(today());
    query(&mut s, "q1");
    s.define_template(Template {
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
    });
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
    s.ingest_result(QueryId::from("q1"), catalog(rows, 50));
    // 35 records per 700 pt frame; +20 % head room.
    let frames = rows.div_ceil(35) * 6 / 5 + 1;
    let chain = (0..frames)
        .map(|i| FrameCapacity {
            frame: format!("f{i}"),
            page: format!("p{i}"),
            height_pt: 700.0,
        })
        .collect();
    (s, chain)
}

/// How many of the change-report workload's bindings are tables (the rest
/// are variables).
pub const REPORT_TABLES: usize = 10;

/// W-R3: `bindings` bindings over one `rows`-row query — [`REPORT_TABLES`]
/// tables, the rest variables — with the baseline report already taken.
/// Re-ingest [`changed_catalog`] then call `refresh_change_report()`.
pub fn change_report_session(bindings: usize, rows: usize) -> DataSession {
    let mut s = DataSession::new(today());
    query(&mut s, "q1");
    for i in 0..bindings {
        if i < REPORT_TABLES {
            s.define_binding(table_binding(&format!("t{i}"), vec![]));
        } else {
            s.define_binding(variable_binding(
                &format!("v{i}"),
                "CONCAT(sku, \" \", name)",
            ));
        }
    }
    s.ingest_result(QueryId::from("q1"), catalog(rows, 50));
    let _baseline = s.refresh_change_report();
    s
}

/// The catalog with ONE price changed — a one-cell data change.
pub fn changed_catalog(rows: usize) -> RecordSet {
    let mut r = catalog(rows, 50);
    r.columns[2][rows / 2] = n(-1.0);
    r
}

/// W-R4: the 5k-row record-identity diff inputs — `old` holds ids 0..5000,
/// `new` drops 0..50 and adds 5000..5050 (a 100-row delta).
pub fn diff_inputs(rows: usize) -> (RecordSet, RecordSet) {
    let make = |start: usize| -> RecordSet {
        let ids: Vec<Value> = (start..start + rows)
            .map(|i| t(&format!("id-{i:06}")))
            .collect();
        let prices: Vec<Value> = (start..start + rows).map(|i| n(i as f64)).collect();
        record_set(
            &[("id", FieldType::Text), ("price", FieldType::Float)],
            vec![ids, prices],
        )
    };
    (make(0), make(50))
}

/// W-R5: a per-group batch plan over `rows` rows in `groups` groups
/// (`plan_batch(q1, PerGroup{by:[cat]})`) — the O(n·g) `group_by` scan.
pub fn grouped_session(rows: usize, groups: usize) -> DataSession {
    let mut s = DataSession::new(today());
    query(&mut s, "q1");
    s.ingest_result(QueryId::from("q1"), catalog(rows, groups));
    s
}
