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

//! Sync review conformance (spec §8, §9.1, §9.5): what the bindings panel shows
//! before it writes anything.
//!
//! - the row diff between the data a document was written from and the data a
//!   refresh delivered (added, removed, changed rows; which bindings read them);
//! - a binding that cannot resolve is in `Error`, unless the user froze it;
//! - a condition's firing preview agrees with the applied rule;
//! - an expression check names parse errors and unknown fields;
//! - a per-binding locale override formats one field for another market, is
//!   saved with the recipe, and never reaches the canonical value.

#![allow(non_snake_case)] // `__feat__<id>`: the cockpit test-to-feature join

use data_core::{
    Binding, BindingDef, BindingId, ColumnBind, FieldType, FrameRef, Locale, MissingPolicy,
    PlaceholderRef, Query, QueryId, RecordSet, ResultShape, Schema, ScopeRef, Status, StyleAction,
    TableOpts, Value,
};
use data_js::core::{DataSession, DocumentPayload, LoweredOutput};
use data_js::review::{
    format_expression, locale_catalog, split_expression, FormatPattern, RowDiffOptions,
};

fn rows(data: &[(&str, &str, f64)]) -> RecordSet {
    RecordSet::new(
        Schema::from_fields([
            ("sku".to_string(), FieldType::Text),
            ("name".to_string(), FieldType::Text),
            ("price".to_string(), FieldType::Float),
        ]),
        vec![
            data.iter().map(|r| Value::text(r.0)).collect(),
            data.iter().map(|r| Value::text(r.1)).collect(),
            data.iter().map(|r| Value::Number(r.2)).collect(),
        ],
    )
    .unwrap()
}

fn session() -> DataSession {
    let mut s = DataSession::new(0);
    s.define_query(Query {
        id: QueryId::from("q"),
        sql: "SELECT * FROM t".into(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    s.define_binding(BindingDef {
        id: BindingId::from("v_name"),
        binding: Binding::Variable {
            target: PlaceholderRef::from("v_name"),
            query: QueryId::from("q"),
            expr: "name".into(),
            missing: MissingPolicy::Blank,
        },
    });
    s.define_binding(BindingDef {
        id: BindingId::from("v_price"),
        binding: Binding::Variable {
            target: PlaceholderRef::from("v_price"),
            query: QueryId::from("q"),
            expr: "CURRENCY(price)".into(),
            missing: MissingPolicy::Blank,
        },
    });
    s.define_binding(BindingDef {
        id: BindingId::from("t_all"),
        binding: Binding::Table {
            region: FrameRef::from("r"),
            query: QueryId::from("q"),
            columns: vec![ColumnBind {
                header: "Name".into(),
                expr: "name".into(),
                style: None,
            }],
            options: TableOpts::default(),
        },
    });
    s.define_binding(BindingDef {
        id: BindingId::from("rule_cheap"),
        binding: Binding::Rule {
            scope: ScopeRef::from("rule_cheap"),
            when: "price < 5".into(),
            apply: StyleAction::TableStyle {
                name: "CellStyle/Cheap".into(),
            },
        },
    });
    s
}

fn diff_opts() -> RowDiffOptions {
    let mut o = RowDiffOptions::default();
    o.rule_queries.insert("rule_cheap".into(), "q".into());
    o
}

#[test]
fn data_bind_row_diff_lists_rows_and_the_bindings_they_reach__feat__data_bind_row_diff() {
    let mut s = session();
    s.ingest_result(
        QueryId::from("q"),
        rows(&[
            ("a1", "Apple", 3.0),
            ("b2", "Bread", 4.0),
            ("c3", "Cheese", 9.0),
        ]),
    );

    // Before anything was written from the data, every row is new.
    let first = s.row_diff(&diff_opts());
    assert_eq!(first.len(), 1);
    assert!(first[0].baseline);
    assert_eq!(first[0].inserted_count, 3);
    s.mark_rows_applied();

    // An unchanged refresh reaches nothing.
    let same = s.row_diff(&diff_opts());
    assert!(!same[0].baseline);
    assert_eq!(
        (
            same[0].inserted_count,
            same[0].removed_count,
            same[0].updated_count,
            same[0].unchanged
        ),
        (0, 0, 0, 3)
    );
    assert!(same[0].affected.is_empty(), "{:?}", same[0].affected);

    // Bread's price changes: one updated row, keyed by the unique `sku` column.
    s.ingest_result(
        QueryId::from("q"),
        rows(&[
            ("a1", "Apple", 3.0),
            ("b2", "Bread", 6.5),
            ("c3", "Cheese", 9.0),
        ]),
    );
    let d = &s.row_diff(&diff_opts())[0];
    assert_eq!(d.key, vec!["sku".to_string()]);
    assert_eq!(
        (d.inserted_count, d.removed_count, d.updated_count),
        (0, 0, 1)
    );
    assert_eq!(d.updated[0].key, "b2");
    assert_eq!(d.updated[0].changes.len(), 1);
    assert_eq!(d.updated[0].changes[0].column, "price");
    assert_eq!(d.updated[0].changes[0].before, "4");
    assert_eq!(d.updated[0].changes[0].after, "6.5");
    assert_eq!(d.changed_columns, vec!["price".to_string()]);
    // Only what reads `price` is reached: the price field and the rule — not
    // the name field, not the name-only table.
    let reached: Vec<&str> = d.affected.iter().map(|a| a.binding.as_str()).collect();
    assert_eq!(reached, vec!["v_price", "rule_cheap"]);
    assert!(d.affected[0].reason.contains("price"));

    // The diff is read-only: asking again gives the same answer, and no sync
    // state moved.
    assert_eq!(&s.row_diff(&diff_opts())[0], d);

    // A row removed and one added: their values are listed, and a
    // whole-result binding is reached even though no column it reads changed.
    s.mark_rows_applied();
    s.ingest_result(
        QueryId::from("q"),
        rows(&[
            ("a1", "Apple", 3.0),
            ("b2", "Bread", 6.5),
            ("d4", "Dates", 2.0),
        ]),
    );
    let d = &s.row_diff(&diff_opts())[0];
    assert_eq!(
        (d.inserted_count, d.removed_count, d.updated_count),
        (1, 1, 0)
    );
    assert_eq!(d.inserted[0].values, vec!["d4", "Dates", "2"]);
    assert_eq!(d.removed[0].key, "c3");
    assert_eq!(d.removed[0].values, vec!["c3", "Cheese", "9"]);
    let reached: Vec<&str> = d.affected.iter().map(|a| a.binding.as_str()).collect();
    assert!(reached.contains(&"t_all"), "{reached:?}");
    assert!(reached.contains(&"rule_cheap"), "{reached:?}");
}

#[test]
fn data_bind_row_diff_honours_a_declared_key__feat__data_bind_row_diff() {
    let mut s = session();
    s.ingest_result(QueryId::from("q"), rows(&[("a1", "Apple", 3.0)]));
    s.mark_rows_applied();
    s.ingest_result(QueryId::from("q"), rows(&[("a1", "Apricot", 3.0)]));
    // Keyed by `name`, a renamed row is one removal and one insertion.
    let mut o = diff_opts();
    o.keys.insert("q".into(), vec!["name".into()]);
    let d = &s.row_diff(&o)[0];
    assert_eq!(
        (d.inserted_count, d.removed_count, d.updated_count),
        (1, 1, 0)
    );
    // Keyed by default (`sku`, unique), it is one update of `name`.
    let d = &s.row_diff(&diff_opts())[0];
    assert_eq!(
        (d.inserted_count, d.removed_count, d.updated_count),
        (0, 0, 1)
    );
    assert_eq!(d.updated[0].changes[0].column, "name");
}

#[test]
fn data_bind_unresolvable_binding_is_error_unless_frozen__feat__data_bind_sync_review() {
    let mut s = session();
    // No result ingested: resolving fails, and the binding is in Error.
    assert!(s.resolve_lowered(&BindingId::from("v_name")).is_err());
    assert_eq!(
        s.sync_state(&BindingId::from("v_name")).unwrap().status,
        Status::Error
    );
    // A pinned binding that cannot resolve stays pinned.
    s.pin(&BindingId::from("v_price"));
    assert!(s.resolve_lowered(&BindingId::from("v_price")).is_err());
    assert_eq!(
        s.sync_state(&BindingId::from("v_price")).unwrap().status,
        Status::Pinned
    );
    // Once data arrives, a resolve re-links the errored binding.
    s.ingest_result(QueryId::from("q"), rows(&[("a1", "Apple", 3.0)]));
    assert!(s.resolve_lowered(&BindingId::from("v_name")).is_ok());
    assert_eq!(
        s.sync_state(&BindingId::from("v_name")).unwrap().status,
        Status::Linked
    );
    let report: Vec<(String, Status)> = s
        .sync_report()
        .into_iter()
        .map(|e| (e.binding, e.status))
        .collect();
    assert!(
        report.contains(&("v_price".to_string(), Status::Pinned)),
        "{report:?}"
    );
    assert!(!report.iter().any(|(b, _)| b == "v_name"), "{report:?}");
}

#[test]
fn data_bind_accept_source_relinks_an_overridden_binding__feat__data_bind_sync_review() {
    let mut s = session();
    s.ingest_result(QueryId::from("q"), rows(&[("a1", "Apple", 3.0)]));
    let id = BindingId::from("v_name");
    s.resolve_lowered(&id).unwrap();
    s.mark_overridden(&id);
    // A refresh with new data leaves the overridden binding alone…
    s.ingest_result(QueryId::from("q"), rows(&[("a1", "Apricot", 3.0)]));
    assert_eq!(s.sync_state(&id).unwrap().status, Status::Overridden);
    // …until the user accepts the source: relink (Stale), then resolve (Linked)
    // with the source's value.
    s.relink(&id);
    assert_eq!(s.sync_state(&id).unwrap().status, Status::Stale);
    match s.resolve_lowered(&id).unwrap() {
        LoweredOutput::Variable(v) => assert_eq!(v.text, "Apricot"),
        other => panic!("{other:?}"),
    }
    assert_eq!(s.sync_state(&id).unwrap().status, Status::Linked);
}

#[test]
fn data_rule_preview_agrees_with_the_applied_rule__feat__data_rule_authoring() {
    let mut s = session();
    s.ingest_result(
        QueryId::from("q"),
        rows(&[
            ("a1", "Apple", 3.0),
            ("b2", "Bread", 6.5),
            ("d4", "Dates", 2.0),
        ]),
    );
    let preview = s
        .preview_condition(&QueryId::from("q"), "price < 5")
        .unwrap();
    let applied = s
        .evaluate_rule(&BindingId::from("rule_cheap"), &QueryId::from("q"))
        .unwrap();
    assert_eq!(preview.fires, applied.fires);
    assert_eq!(preview.total, 3);
    assert_eq!(preview.fires.len(), 2);
    assert!(preview.error.is_none());

    // A condition that does not parse, or reads a field the data lacks, fires
    // nowhere and says why.
    let bad = s.preview_condition(&QueryId::from("q"), "price <").unwrap();
    assert!(bad.fires.is_empty());
    assert!(bad.error.unwrap().contains("unexpected end"));
    let unknown = s
        .preview_condition(&QueryId::from("q"), "stock < 5")
        .unwrap();
    assert_eq!(unknown.error.as_deref(), Some("no such field: stock"));

    let check = s.check_expression("IF(price > 5, name, sku)", Some(&QueryId::from("q")));
    assert!(check.ok);
    assert_eq!(check.fields, vec!["name", "price", "sku"]);
    let check = s.check_expression("NOPE(price)", None);
    assert!(!check.ok);
    assert!(check.error.unwrap().contains("unknown function"));
}

#[test]
fn data_i18n_binding_locale_override__feat__data_i18n_locale_table() {
    let mut s = session();
    s.ingest_result(QueryId::from("q"), rows(&[("a1", "Apple", 1234.5)]));
    let price = BindingId::from("v_price");
    let text = |s: &mut DataSession| match s.resolve_lowered(&price).unwrap() {
        LoweredOutput::Variable(v) => v.text,
        other => panic!("{other:?}"),
    };
    assert_eq!(text(&mut s), "$1,234.50");
    // The session goes German; one field is formatted for France.
    s.set_locale(Locale::DE);
    assert_eq!(text(&mut s), "1.234,50 €");
    s.set_binding_locale(&price, Locale::from_tag("fr"));
    assert_eq!(text(&mut s), "1\u{202f}234,50\u{a0}€");
    // The preview reads the same text and does not re-link.
    s.pin(&price);
    assert_eq!(
        s.preview_display(&price, 0).unwrap().as_deref(),
        Some("1\u{202f}234,50\u{a0}€")
    );
    assert_eq!(s.sync_state(&price).unwrap().status, Status::Pinned);

    // The override is saved with the recipe and restored.
    let payload = s.payload();
    let json = serde_json::to_string(&payload).unwrap();
    assert!(json.contains(r#""locales":{"v_price":"fr"}"#), "{json}");
    let mut back =
        DataSession::from_payload(serde_json::from_str::<DocumentPayload>(&json).unwrap(), 0);
    back.ingest_result(QueryId::from("q"), rows(&[("a1", "Apple", 1234.5)]));
    match back.resolve_lowered(&price).unwrap() {
        LoweredOutput::Variable(v) => assert_eq!(v.text, "1\u{202f}234,50\u{a0}€"),
        other => panic!("{other:?}"),
    }
    // Clearing it removes it from the payload entirely (no empty map).
    s.set_binding_locale(&price, None);
    assert!(!serde_json::to_string(&s.payload())
        .unwrap()
        .contains("locales"));
    assert_eq!(text(&mut s), "1.234,50 €");
}

#[test]
fn data_i18n_format_patterns_and_catalog__feat__data_i18n_locale_table() {
    let p = FormatPattern::Currency {
        decimals: 0,
        symbol: Some("CHF".into()),
    };
    let src = format_expression("price", p.clone());
    assert_eq!(src, "CURRENCY(price, 0, \"CHF\")");
    let back = split_expression(&src);
    assert_eq!((back.inner.as_str(), back.pattern), ("price", p));
    // The catalog lists every locale with samples from the real kernels.
    let cat = locale_catalog();
    assert!(cat.len() >= 9);
    let fr = cat.iter().find(|l| l.tag == "fr").unwrap();
    assert_eq!(fr.number, "1\u{202f}234\u{202f}567,89");
    assert_eq!(fr.date, "05/10/2026");
    let ch = cat.iter().find(|l| l.tag == "de-CH").unwrap();
    assert_eq!(ch.currency, "CHF\u{a0}1’234’567.89");
}
