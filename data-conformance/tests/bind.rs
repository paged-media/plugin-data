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

//! Binding + synchronization conformance (spec §8): resolution, sync states,
//! non-destructive conflict policy, record-identity diffing, and invalidation.

use data_bind::{diff, ResolutionEngine, Resolved};
use data_conformance::{n, record_set, t, today};
use data_core::{
    Binding, BindingId, ColumnBind, FieldType, FrameRef, MissingPolicy, PlaceholderRef, Query,
    QueryId, RecordSet, ResultShape, Status, TableOpts,
};

fn query(id: &str, shape: ResultShape) -> Query {
    Query {
        id: QueryId::from(id),
        sql: String::new(),
        params: vec![],
        shape,
    }
}

#[test]
fn data_bind_resolve_variable() {
    let mut e = ResolutionEngine::new(today());
    e.add_query(query("q1", ResultShape::SingleRecord));
    e.add_binding(
        BindingId::from("b1"),
        Binding::Variable {
            target: PlaceholderRef::from("ph1"),
            query: QueryId::from("q1"),
            expr: "UPPER(name)".into(),
            missing: MissingPolicy::Blank,
        },
    );
    e.set_result(
        QueryId::from("q1"),
        record_set(&[("name", FieldType::Text)], vec![vec![t("widget")]]),
    );
    match e.resolve(&BindingId::from("b1")).unwrap() {
        Resolved::Variable(v) => assert_eq!(v.display, "WIDGET"),
        other => panic!("expected variable, got {other:?}"),
    }
    // Resolved → Linked with a stamp.
    let st = e.sync_state(&BindingId::from("b1")).unwrap();
    assert_eq!(st.status, Status::Linked);
    assert!(st.last_resolved.is_some());
}

#[test]
fn data_bind_resolve_table() {
    let mut e = ResolutionEngine::new(today());
    e.add_query(query("q1", ResultShape::RecordStream));
    e.add_binding(
        BindingId::from("t1"),
        Binding::Table {
            region: FrameRef::from("r1"),
            query: QueryId::from("q1"),
            columns: vec![
                ColumnBind {
                    header: "SKU".into(),
                    expr: "sku".into(),
                    style: None,
                },
                ColumnBind {
                    header: "Price".into(),
                    expr: "CURRENCY(price)".into(),
                    style: None,
                },
            ],
            options: TableOpts::default(),
        },
    );
    e.set_result(
        QueryId::from("q1"),
        record_set(
            &[("sku", FieldType::Text), ("price", FieldType::Float)],
            vec![vec![t("A-1"), t("B-2")], vec![n(9.99), n(19.99)]],
        ),
    );
    match e.resolve(&BindingId::from("t1")).unwrap() {
        Resolved::Table(table) => {
            assert_eq!(table.headers, vec!["SKU".to_string(), "Price".to_string()]);
            assert_eq!(table.rows.len(), 2);
            assert_eq!(table.rows[0], vec!["A-1".to_string(), "$9.99".to_string()]);
        }
        other => panic!("expected table, got {other:?}"),
    }
}

#[test]
fn data_bind_sync_states_non_destructive() {
    let mut e = ResolutionEngine::new(today());
    e.add_query(query("q1", ResultShape::SingleRecord));
    e.add_binding(
        BindingId::from("b1"),
        Binding::Variable {
            target: PlaceholderRef::from("ph1"),
            query: QueryId::from("q1"),
            expr: "name".into(),
            missing: MissingPolicy::Blank,
        },
    );
    let id = BindingId::from("b1");
    e.set_result(
        QueryId::from("q1"),
        record_set(&[("name", FieldType::Text)], vec![vec![t("a")]]),
    );
    e.resolve(&id).unwrap();

    // Pin → a refresh with changed data must NOT disturb it (non-destructive).
    e.pin(&id);
    assert_eq!(e.sync_state(&id).unwrap().status, Status::Pinned);
    e.set_result(
        QueryId::from("q1"),
        record_set(&[("name", FieldType::Text)], vec![vec![t("b")]]),
    );
    assert_eq!(e.sync_state(&id).unwrap().status, Status::Pinned);
    // The sync report surfaces the divergence (never silently clobbered).
    assert!(e
        .sync_report()
        .iter()
        .any(|(b, s)| *b == id && *s == Status::Pinned));

    // Override is likewise protected; relink is the explicit user action.
    e.mark_overridden(&id);
    assert_eq!(e.sync_state(&id).unwrap().status, Status::Overridden);
    e.relink(&id);
    assert_eq!(e.sync_state(&id).unwrap().status, Status::Stale);
}

#[test]
fn data_bind_preview_step_record() {
    // The §9 record-preview stepper: resolve a per-record variable binding
    // against a CHOSEN record index, not just record 0. Stepping the index
    // re-resolves the bound field against that record (the "show the document
    // against record N" affordance before a batch run).
    let mut e = ResolutionEngine::new(today());
    e.add_query(query("q1", ResultShape::RecordStream));
    let id = BindingId::from("v1");
    e.add_binding(
        id.clone(),
        Binding::Variable {
            target: PlaceholderRef::from("ph1"),
            query: QueryId::from("q1"),
            expr: "UPPER(name)".into(),
            missing: MissingPolicy::Blank,
        },
    );
    e.set_result(
        QueryId::from("q1"),
        record_set(
            &[("name", FieldType::Text)],
            vec![vec![t("alpha"), t("beta"), t("gamma")]],
        ),
    );
    // The stepper bound: 3 records to walk.
    assert_eq!(e.record_count(&QueryId::from("q1")), 3);
    // record 0 (the default resolve), then step to 1 and 2.
    for (rec, want) in [(0usize, "ALPHA"), (1, "BETA"), (2, "GAMMA")] {
        match e.resolve_at(&id, rec).unwrap() {
            Resolved::Variable(v) => assert_eq!(v.display, want, "record {rec}"),
            other => panic!("expected variable, got {other:?}"),
        }
    }
    // An out-of-range preview index degrades to the missing policy (Blank), never
    // a panic — the stepper clamps, the engine stays total.
    match e.resolve_at(&id, 99).unwrap() {
        Resolved::Variable(v) => assert_eq!(v.display, ""),
        other => panic!("expected variable, got {other:?}"),
    }
    // resolve() is still resolve_at(0) — record 0, unchanged behaviour.
    match e.resolve(&id).unwrap() {
        Resolved::Variable(v) => assert_eq!(v.display, "ALPHA"),
        other => panic!("expected variable, got {other:?}"),
    }
}

#[test]
fn data_bind_identity_diff_minimal() {
    let old = record_set(
        &[("id", FieldType::Text), ("qty", FieldType::Float)],
        vec![vec![t("a"), t("b"), t("c")], vec![n(1.0), n(2.0), n(3.0)]],
    );
    let new = record_set(
        &[("id", FieldType::Text), ("qty", FieldType::Float)],
        vec![vec![t("a"), t("b"), t("d")], vec![n(1.0), n(9.0), n(4.0)]],
    );
    let delta = diff(&old, &new, &["id".to_string()]);
    assert_eq!(delta.unchanged, 1); // a
    assert_eq!(delta.updated, vec![1]); // b
    assert_eq!(delta.inserted, vec![2]); // d
    assert_eq!(delta.removed.len(), 1); // c
}

#[test]
fn data_bind_change_report_resolved_diff() {
    // The §8 refresh change report ("what changed since last sync"): fingerprint
    // every binding's resolved content before vs after a refresh and surface a
    // per-binding changed / unchanged / added / removed summary.
    use data_bind::{diff_resolved, resolved_fingerprint, ChangeKind};
    use std::collections::HashMap;

    let mut e = ResolutionEngine::new(today());
    e.add_query(query("q1", ResultShape::SingleRecord));
    // Two variable bindings off the same query: one will change, one won't.
    for (id, expr) in [("v_name", "name"), ("v_const", "\"fixed\"")] {
        e.add_binding(
            BindingId::from(id),
            Binding::Variable {
                target: PlaceholderRef::from(id),
                query: QueryId::from("q1"),
                expr: expr.into(),
                missing: MissingPolicy::Blank,
            },
        );
    }
    e.set_result(
        QueryId::from("q1"),
        record_set(&[("name", FieldType::Text)], vec![vec![t("alpha")]]),
    );

    // BEFORE snapshot: fingerprint each binding's resolved content (read-only —
    // resolve_content never mutates sync state).
    let snap = |eng: &ResolutionEngine| -> HashMap<String, String> {
        let mut m = HashMap::new();
        for id in ["v_name", "v_const"] {
            let r = eng.resolve_content(&BindingId::from(id), 0).unwrap();
            m.insert(id.to_string(), resolved_fingerprint(&r));
        }
        m
    };
    let before = snap(&e);

    // Refresh with changed data for `name` (v_name changes, v_const does not).
    e.set_result(
        QueryId::from("q1"),
        record_set(&[("name", FieldType::Text)], vec![vec![t("beta")]]),
    );
    let after = snap(&e);

    let report = diff_resolved(&before, &after);
    assert_eq!(report.changed, 1);
    assert_eq!(report.unchanged, 1);
    assert_eq!(report.added, 0);
    assert_eq!(report.removed, 0);
    // Entries are sorted by id: v_const (unchanged) then v_name (changed).
    let kinds: Vec<(&str, ChangeKind)> = report
        .entries
        .iter()
        .map(|c| (c.binding.as_str(), c.kind))
        .collect();
    assert_eq!(
        kinds,
        vec![
            ("v_const", ChangeKind::Unchanged),
            ("v_name", ChangeKind::Changed),
        ]
    );

    // The session-level convenience (fingerprint_all) snapshots all resolvables
    // at once and feeds the same diff.
    let all = e.fingerprint_all();
    assert_eq!(all.len(), 2);

    // An absent-before / present-after binding is `Added`; the reverse `Removed`.
    let mut b2 = before.clone();
    b2.remove("v_name"); // pretend v_name did not exist before
    let r2 = diff_resolved(&b2, &after);
    assert_eq!(r2.added, 1); // v_name newly resolved
    let r3 = diff_resolved(&after, &b2);
    assert_eq!(r3.removed, 1); // v_name went away
}

#[test]
fn data_bind_invalidation_affected_cut() {
    let mut e = ResolutionEngine::new(today());
    e.add_query(query("q1", ResultShape::SingleRecord));
    let id = BindingId::from("b1");
    e.add_binding(
        id.clone(),
        Binding::Variable {
            target: PlaceholderRef::from("ph1"),
            query: QueryId::from("q1"),
            expr: "name".into(),
            missing: MissingPolicy::Blank,
        },
    );
    let a: RecordSet = record_set(&[("name", FieldType::Text)], vec![vec![t("a")]]);
    e.set_result(QueryId::from("q1"), a.clone());
    e.resolve(&id).unwrap();
    assert_eq!(e.sync_state(&id).unwrap().status, Status::Linked);

    // Same data again → no invalidation.
    e.set_result(QueryId::from("q1"), a);
    assert_eq!(e.sync_state(&id).unwrap().status, Status::Linked);

    // Changed data → dependent binding goes Stale (only the affected cut).
    e.set_result(
        QueryId::from("q1"),
        record_set(&[("name", FieldType::Text)], vec![vec![t("b")]]),
    );
    assert_eq!(e.sync_state(&id).unwrap().status, Status::Stale);
}

/// Incremental resolution is scoped to the dependency cut ACROSS queries: a
/// change to one query's result invalidates only the bindings that read THAT
/// query, never bindings that read a different, unchanged query. This is the
/// "recompute only the affected cut" property (§8) at the cross-query
/// granularity — the existing `_affected_cut` test proves same-vs-changed data
/// for one query; this proves the cut does not bleed across queries (no
/// whole-set recompute on any single-source change).
#[test]
fn data_bind_invalidation_cross_query_cut() {
    let mut e = ResolutionEngine::new(today());
    e.add_query(query("q1", ResultShape::SingleRecord));
    e.add_query(query("q2", ResultShape::SingleRecord));
    let b1 = BindingId::from("b1");
    let b2 = BindingId::from("b2");
    e.add_binding(
        b1.clone(),
        Binding::Variable {
            target: PlaceholderRef::from("ph1"),
            query: QueryId::from("q1"),
            expr: "name".into(),
            missing: MissingPolicy::Blank,
        },
    );
    e.add_binding(
        b2.clone(),
        Binding::Variable {
            target: PlaceholderRef::from("ph2"),
            query: QueryId::from("q2"),
            expr: "name".into(),
            missing: MissingPolicy::Blank,
        },
    );

    // Both queries deliver + both bindings resolve → both Linked.
    e.set_result(
        QueryId::from("q1"),
        record_set(&[("name", FieldType::Text)], vec![vec![t("a")]]),
    );
    e.set_result(
        QueryId::from("q2"),
        record_set(&[("name", FieldType::Text)], vec![vec![t("x")]]),
    );
    e.resolve(&b1).unwrap();
    e.resolve(&b2).unwrap();
    assert_eq!(e.sync_state(&b1).unwrap().status, Status::Linked);
    assert_eq!(e.sync_state(&b2).unwrap().status, Status::Linked);

    // Change ONLY q1's data: b1 (reads q1) goes Stale; b2 (reads the unchanged
    // q2) stays Linked — the cut did not bleed across queries.
    e.set_result(
        QueryId::from("q1"),
        record_set(&[("name", FieldType::Text)], vec![vec![t("b")]]),
    );
    assert_eq!(e.sync_state(&b1).unwrap().status, Status::Stale);
    assert_eq!(
        e.sync_state(&b2).unwrap().status,
        Status::Linked,
        "a change to q1 must NOT invalidate a binding reading q2 (no whole-set recompute)"
    );
}
