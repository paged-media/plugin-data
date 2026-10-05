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

//! Wall-clock benches for the paged.data engine (campaign Wave 1). TRENDED,
//! not gated: the gated budgets are the counts in `tests/perf_counts.rs`,
//! which run the same workloads (`data_conformance::perf_workloads`).
//!
//! `CARGO_INCREMENTAL=0 cargo bench -p data-conformance --bench engine`

use std::hint::black_box;

use criterion::{criterion_group, criterion_main, BatchSize, Criterion};
use data_automation::BatchMode;
use data_bind::diff;
use data_conformance::perf_workloads::{
    catalog_session, change_report_session, changed_catalog, diff_inputs, grouped_session,
    table_session,
};
use data_core::{BindingId, QueryId};
use data_lower::FlowLayoutOpts;

fn table_resolve_10k(c: &mut Criterion) {
    let mut s = table_session(10_000);
    let id = BindingId::from("t1");
    c.bench_function("table_resolve_10k", |b| {
        b.iter(|| black_box(s.resolve_lowered(&id).unwrap()))
    });
}

fn catalog_lower_7k(c: &mut Criterion) {
    let (mut s, chain) = catalog_session(7_000);
    let id = BindingId::from("rf");
    c.bench_function("catalog_lower_7k", |b| {
        b.iter_batched(
            || chain.clone(),
            |chain| black_box(s.lower_record_flow(&id, chain, FlowLayoutOpts::default())),
            BatchSize::SmallInput,
        )
    });
}

fn change_report_50(c: &mut Criterion) {
    let rows = 1_000;
    let changed = changed_catalog(rows);
    let original = data_conformance::perf_workloads::catalog(rows, 50);
    let mut s = change_report_session(50, rows);
    let mut flip = false;
    c.bench_function("change_report_50_bindings", |b| {
        b.iter_batched(
            || {
                flip = !flip;
                if flip {
                    changed.clone()
                } else {
                    original.clone()
                }
            },
            |records| {
                s.ingest_result(QueryId::from("q1"), records);
                black_box(s.refresh_change_report())
            },
            BatchSize::SmallInput,
        )
    });
}

fn diff_5k(c: &mut Criterion) {
    let (old, new) = diff_inputs(5_000);
    let key = vec!["id".to_string()];
    c.bench_function("diff_5k", |b| b.iter(|| black_box(diff(&old, &new, &key))));
}

fn group_plan_2k(c: &mut Criterion) {
    let s = grouped_session(2_000, 100);
    let q = QueryId::from("q1");
    c.bench_function("group_plan_2k_by_100", |b| {
        b.iter(|| {
            black_box(
                s.plan_batch(
                    &q,
                    BatchMode::PerGroup {
                        by: vec!["cat".into()],
                    },
                )
                .unwrap(),
            )
        })
    });
}

criterion_group!(
    engine,
    table_resolve_10k,
    catalog_lower_7k,
    change_report_50,
    diff_5k,
    group_plan_2k
);
criterion_main!(engine);
