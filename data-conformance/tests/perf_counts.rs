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

//! Engine COUNT budgets (feature `data.perf.gates`). The
//! file name keeps it under the cockpit test-map's `data-conformance::perf`
//! prefix.
//!
//! A budget is a count of engine work — resolves, `stabilize` sorts, sort-key
//! allocations, fingerprints, diff rows, ingested cells — read from the
//! `perf-counters` feature that data-js turns on (the same counters the
//! shipped wasm exports as `perfCounters()`). Each budget is the MEASURED
//! value on 2026-10-05; it is lowered only in the commit that earns it and
//! never raised. A behaviour assertion stands beside every budget so a
//! "cheaper" engine that stopped doing the work cannot pass.
//!
//! Wall clock is NOT gated here; it is trended by `cargo bench -p
//! data-conformance` (benches/engine.rs) over the same workloads.
//!
//! `PERF_SHOW=1 cargo nextest run -p data-conformance perf_counts
//! --no-capture` prints every workload's full counter set.

use data_automation::BatchMode;
use data_bind::diff;
use data_conformance::perf_workloads::{
    catalog_session, change_report_session, changed_catalog, diff_inputs, grouped_session,
    table_session, REPORT_TABLES,
};
use data_core::{BindingId, QueryId};
use data_js::core::{perf_counters, reset_perf_counters, LoweredOutput, PerfCountersOut};
use data_lower::{FlowBlock, FlowLayoutOpts};

fn show(name: &str, c: &PerfCountersOut) {
    if std::env::var_os("PERF_SHOW").is_some() {
        eprintln!("PERF {name} {c:?}");
    }
}

#[test]
fn data_perf_counters_are_compiled_in() {
    // The budgets below are meaningless against a build that counts nothing.
    assert!(
        perf_counters().enabled,
        "data-js built without perf-counters"
    );
}

#[test]
fn data_perf_count_table_resolve_10k() {
    let mut s = table_session(10_000);
    reset_perf_counters();
    let out = s.resolve_lowered(&BindingId::from("t1")).unwrap();
    let c = perf_counters();
    show("table_resolve_10k", &c);
    match out {
        LoweredOutput::Table(t) => {
            // 10 000 records + the header row.
            assert_eq!(t.rows.len(), 10_001);
            // Behaviour beside the key budget: the rows really are sorted
            // (no keys → every column; the SKU column decides, and the
            // shuffled input puts SKU-000000 … SKU-009999 in order).
            let skus: Vec<&str> = t.rows[1..].iter().map(|r| r.cells[0].as_str()).collect();
            assert!(skus.windows(2).all(|w| w[0] < w[1]), "rows not stabilized");
            assert_eq!(skus[0], "SKU-000000");
        }
        other => panic!("expected a table, got {other:?}"),
    }
    assert_eq!(c.resolves, 1);
    assert_eq!(c.stabilize_calls, 1);
    // stabilize sorts with NO keys → every column is a key. Wave 2 compares
    // values in place (data_query::cmp_values); it used to build two fresh
    // Vec<u8> keys per column per comparison (288 478 at 10k rows).
    assert_eq!(c.key_allocs, BUDGET_TABLE_10K_KEY_ALLOCS);
}
const BUDGET_TABLE_10K_KEY_ALLOCS: u64 = 0;

#[test]
fn data_perf_count_catalog_lower_7k() {
    let (mut s, chain) = catalog_session(7_000);
    reset_perf_counters();
    let flow = s
        .lower_record_flow(&BindingId::from("rf"), chain, FlowLayoutOpts::default())
        .unwrap();
    let c = perf_counters();
    show("catalog_lower_7k", &c);
    assert!(!flow.overflow);
    assert_eq!(flow.placed, 7_000);
    // Behaviour: the flow is in stabilized order — SKU-000000 is row 0.
    match &flow.frames[0].blocks[0] {
        FlowBlock::Record { cells, .. } => assert_eq!(cells[0], "item 0"),
        other => panic!("expected a record first, got {other:?}"),
    }
    assert_eq!(c.resolves, 1);
    assert_eq!(c.stabilize_calls, 1);
    // Was 185 110 (two Vec<u8> per column per comparison); in-place now.
    assert_eq!(c.key_allocs, BUDGET_CATALOG_7K_KEY_ALLOCS);
}
const BUDGET_CATALOG_7K_KEY_ALLOCS: u64 = 0;

#[test]
fn data_perf_count_change_report_50_bindings() {
    let rows = 1_000;
    let mut s = change_report_session(50, rows);
    // The refresh: re-ingest a result with ONE cell changed, then report.
    reset_perf_counters();
    s.ingest_result(QueryId::from("q1"), changed_catalog(rows));
    let report = s.refresh_change_report();
    let c = perf_counters();
    show("change_report_50", &c);
    // Behaviour: the one changed price reaches every table; no variable reads
    // the price, so all of them are unchanged.
    assert_eq!(report.changed, REPORT_TABLES);
    assert_eq!(report.unchanged, 50 - REPORT_TABLES);
    // AS FOUND: fingerprint_all re-resolves EVERY binding (50), and each table
    // re-sorts the whole result — a one-cell change costs 10 full sorts.
    assert_eq!(c.resolves, 50);
    assert_eq!(c.fingerprints, 50);
    assert_eq!(c.stabilize_calls, REPORT_TABLES as u64);
    assert_eq!(c.ingest_cells, (rows * 4) as u64);
    assert_eq!(c.content_hashes, 1);
    assert_eq!(c.diff_rows, 0, "the O(n) row diff() is not on this path");
    assert_eq!(c.key_allocs, BUDGET_REPORT_50_KEY_ALLOCS);
}
// Was 210 560: ten table sorts building keys per comparison.
const BUDGET_REPORT_50_KEY_ALLOCS: u64 = 0;

#[test]
fn data_perf_count_diff_5k() {
    let (old, new) = diff_inputs(5_000);
    reset_perf_counters();
    let delta = diff(&old, &new, &["id".to_string()]);
    let c = perf_counters();
    show("diff_5k", &c);
    assert_eq!(delta.removed.len(), 50);
    assert_eq!(delta.inserted.len(), 50);
    assert_eq!(delta.unchanged, 4_950);
    assert_eq!(c.diff_rows, 10_000);
    assert_eq!(c.resolves, 0);
    assert_eq!(c.key_allocs, 0);
}

#[test]
fn data_perf_count_group_plan_2k_by_100() {
    let s = grouped_session(2_000, 100);
    reset_perf_counters();
    let plan = s
        .plan_batch(
            &QueryId::from("q1"),
            BatchMode::PerGroup {
                by: vec!["cat".into()],
            },
        )
        .unwrap();
    let c = perf_counters();
    show("group_plan_2k_by_100", &c);
    assert_eq!(plan.units.len(), 100);
    assert_eq!(plan.total_records, 2_000);
    assert_eq!(c.stabilize_calls, 1);
    // AS FOUND: group_by finds each row's group by a linear scan of the
    // groups seen so far — O(n·g).
    assert_eq!(c.group_key_compares, BUDGET_GROUP_2K_COMPARES);
    assert_eq!(c.key_allocs, BUDGET_GROUP_2K_KEY_ALLOCS);
}
const BUDGET_GROUP_2K_COMPARES: u64 = 100_900;
// Was 48 166 (the plan's stabilize building keys per comparison).
const BUDGET_GROUP_2K_KEY_ALLOCS: u64 = 0;
