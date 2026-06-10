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

//! Data-driven formatting rule conformance (spec §9.5): the rule's `when`
//! condition is evaluated per record (stabilized order); the firing records get
//! the document-style action. The engine decides WHICH content fires WHICH
//! style — the data-driven half; the host applies the named style (the per-cell
//! application is gated on D-13). Styling is always a document-style reference,
//! never a literal (§9.5).

use data_bind::ResolutionEngine;
use data_conformance::{n, record_set, t, today};
use data_core::{
    Binding, BindingId, FieldType, Query, QueryId, ResultShape, ScopeRef, StyleAction,
};

#[test]
fn data_bind_rule_fires_on_matching_records() {
    let mut e = ResolutionEngine::new(today());
    e.add_query(Query {
        id: QueryId::from("q1"),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    e.add_binding(
        BindingId::from("r1"),
        Binding::Rule {
            scope: ScopeRef::from("table-region"),
            when: "stock < 5".into(),
            apply: StyleAction::TableStyle {
                name: "low-stock".into(),
            },
        },
    );
    e.set_result(
        QueryId::from("q1"),
        record_set(
            &[("sku", FieldType::Text), ("stock", FieldType::Float)],
            vec![vec![t("a"), t("b"), t("c")], vec![n(2.0), n(10.0), n(0.0)]],
        ),
    );

    let eval = e
        .evaluate_rule(&BindingId::from("r1"), &QueryId::from("q1"))
        .unwrap();
    // Stabilized by all columns → sku a,b,c. stock 2,10,0 → fires where < 5: a, c.
    assert_eq!(eval.fires, vec![0, 2]);
    assert_eq!(eval.total, 3);
    assert_eq!(eval.scope, ScopeRef::from("table-region"));
    assert_eq!(
        eval.apply,
        StyleAction::TableStyle {
            name: "low-stock".into()
        }
    );
}

#[test]
fn data_bind_rule_non_rule_binding_errors() {
    // evaluate_rule on a non-rule binding is a typed error (it is not a rule).
    let mut e = ResolutionEngine::new(today());
    e.add_query(Query {
        id: QueryId::from("q1"),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::SingleRecord,
    });
    e.add_binding(
        BindingId::from("v1"),
        Binding::Variable {
            target: data_core::PlaceholderRef::from("ph"),
            query: QueryId::from("q1"),
            expr: "name".into(),
            missing: data_core::MissingPolicy::Blank,
        },
    );
    e.set_result(
        QueryId::from("q1"),
        record_set(&[("name", FieldType::Text)], vec![vec![t("x")]]),
    );
    assert!(e
        .evaluate_rule(&BindingId::from("v1"), &QueryId::from("q1"))
        .is_err());
}
