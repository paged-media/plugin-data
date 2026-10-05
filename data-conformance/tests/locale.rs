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

//! Localization conformance (spec §9.1; v1 = en/de, mirroring plugin-sheet D-8):
//! the formatting display kernels honor the session locale — number grouping +
//! decimal separators, the default currency symbol/placement, and the default
//! date pattern. The CANONICAL value form stays locale-free (idempotent
//! re-resolution), so the locale changes ONLY the display strings.

use data_bind::{ResolutionEngine, Resolved};
use data_core::{
    Binding, BindingId, FieldType, Locale, MissingPolicy, PlaceholderRef, Query, QueryId,
    RecordSet, ResultShape, Schema, Value,
};

fn engine(locale: Locale) -> ResolutionEngine {
    let mut e = ResolutionEngine::new(0);
    e.set_locale(locale);
    e.add_query(Query {
        id: QueryId::from("q1"),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::SingleRecord,
    });
    for (id, expr) in [
        ("num", "NUMBER(price, 2)"),
        ("cur", "CURRENCY(price)"),
        ("date", "DATEFMT(d)"),
    ] {
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
    // price = 1234.5, d = 1970-01-01 (day 0).
    let records = RecordSet::new(
        Schema::from_fields([
            ("price".to_string(), FieldType::Float),
            ("d".to_string(), FieldType::Date),
        ]),
        vec![vec![Value::Number(1234.5)], vec![Value::Date(0)]],
    )
    .unwrap();
    e.set_result(QueryId::from("q1"), records);
    e
}

fn display(e: &mut ResolutionEngine, id: &str) -> String {
    match e.resolve(&BindingId::from(id)).unwrap() {
        Resolved::Variable(v) => v.display,
        other => panic!("expected a variable, got {other:?}"),
    }
}

#[test]
fn data_i18n_locale() {
    // English: `,` grouping, `.` decimal, `$` leading, `YYYY-MM-DD`.
    let mut en = engine(Locale::EN);
    assert_eq!(display(&mut en, "num"), "1,234.50");
    assert_eq!(display(&mut en, "cur"), "$1,234.50");
    assert_eq!(display(&mut en, "date"), "1970-01-01");

    // German: `.` grouping, `,` decimal, `€` trailing, `DD.MM.YYYY`.
    let mut de = engine(Locale::DE);
    assert_eq!(display(&mut de, "num"), "1.234,50");
    assert_eq!(display(&mut de, "cur"), "1.234,50 €");
    assert_eq!(display(&mut de, "date"), "01.01.1970");
}

#[test]
fn data_i18n_locale_default_is_en() {
    // A fresh engine (no set_locale) formats en — the locale-free canonical
    // behavior is unchanged for existing callers.
    let mut e = engine(Locale::EN);
    let mut default = ResolutionEngine::new(0);
    // Mirror `engine` without the set_locale call.
    default.add_query(Query {
        id: QueryId::from("q1"),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::SingleRecord,
    });
    default.add_binding(
        BindingId::from("cur"),
        Binding::Variable {
            target: PlaceholderRef::from("cur"),
            query: QueryId::from("q1"),
            expr: "CURRENCY(price)".into(),
            missing: MissingPolicy::Blank,
        },
    );
    default.set_result(
        QueryId::from("q1"),
        RecordSet::new(
            Schema::from_fields([("price".to_string(), FieldType::Float)]),
            vec![vec![Value::Number(1234.5)]],
        )
        .unwrap(),
    );
    assert_eq!(display(&mut default, "cur"), display(&mut e, "cur"));
}

/// Every row of the locale table, through the real resolve path. The expected
/// strings are the CLDR facts the table cites (data-core/src/locale.rs):
/// separators, minimum grouping, currency placement with its no-break space,
/// and date order. `en` and `de` keep their pre-table output (ISO dates; an
/// ASCII space before `€`).
#[test]
#[allow(non_snake_case)] // `__feat__<id>`: the cockpit test-to-feature join
fn data_i18n_locale_table_rows__feat__data_i18n_locale_table() {
    let cases: &[(&str, &str, &str, &str)] = &[
        ("en", "1,234.50", "$1,234.50", "1970-01-01"),
        ("de", "1.234,50", "1.234,50 €", "01.01.1970"),
        ("en-GB", "1,234.50", "£1,234.50", "01/01/1970"),
        (
            "de-AT",
            "1\u{a0}234,50",
            "€\u{a0}1\u{a0}234,50",
            "01.01.1970",
        ),
        ("de-CH", "1’234.50", "CHF\u{a0}1’234.50", "01.01.1970"),
        (
            "fr",
            "1\u{202f}234,50",
            "1\u{202f}234,50\u{a0}€",
            "01/01/1970",
        ),
        ("it", "1.234,50", "1.234,50\u{a0}€", "01/01/1970"),
        // es: minimumGroupingDigits 2 — a four-digit integer is not grouped.
        ("es", "1234,50", "1234,50\u{a0}€", "01/01/1970"),
        ("nl", "1.234,50", "€\u{a0}1.234,50", "01-01-1970"),
    ];
    for &(tag, num, cur, date) in cases {
        let locale = Locale::from_tag(tag).unwrap_or_else(|| panic!("no locale {tag}"));
        let mut e = engine(locale);
        assert_eq!(display(&mut e, "num"), num, "{tag} NUMBER");
        assert_eq!(display(&mut e, "cur"), cur, "{tag} CURRENCY");
        assert_eq!(display(&mut e, "date"), date, "{tag} DATEFMT");
    }
    // Every table row is covered by a case above.
    assert_eq!(Locale::all().count(), cases.len());
}

/// es groups from five integer digits on (CLDR minimumGroupingDigits = 2).
#[test]
#[allow(non_snake_case)]
fn data_i18n_locale_min_grouping__feat__data_i18n_locale_table() {
    let mut e = ResolutionEngine::new(0);
    e.set_locale(Locale::from_tag("es").unwrap());
    e.add_query(Query {
        id: QueryId::from("q1"),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::SingleRecord,
    });
    e.add_binding(
        BindingId::from("big"),
        Binding::Variable {
            target: PlaceholderRef::from("big"),
            query: QueryId::from("q1"),
            expr: "NUMBER(n, 0)".into(),
            missing: MissingPolicy::Blank,
        },
    );
    e.set_result(
        QueryId::from("q1"),
        RecordSet::new(
            Schema::from_fields([("n".to_string(), FieldType::Float)]),
            vec![vec![Value::Number(12345.0)]],
        )
        .unwrap(),
    );
    assert_eq!(display(&mut e, "big"), "12.345");
}

/// Content hashing is locale-free: every locale resolves with the same
/// resolve stamp (source content + query + params), so a refresh's change
/// detection never depends on the locale a document is viewed in.
#[test]
#[allow(non_snake_case)]
fn data_i18n_locale_stamp_is_locale_free__feat__data_i18n_locale_table() {
    let stamps: Vec<_> = Locale::all()
        .map(|l| {
            let mut e = engine(l);
            e.resolve(&BindingId::from("num")).unwrap();
            e.sync_state(&BindingId::from("num")).unwrap().last_resolved
        })
        .collect();
    assert!(stamps[0].is_some());
    assert!(stamps.windows(2).all(|w| w[0] == w[1]), "{stamps:?}");
}
