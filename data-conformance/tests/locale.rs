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
    let mut en = engine(Locale::En);
    assert_eq!(display(&mut en, "num"), "1,234.50");
    assert_eq!(display(&mut en, "cur"), "$1,234.50");
    assert_eq!(display(&mut en, "date"), "1970-01-01");

    // German: `.` grouping, `,` decimal, `€` trailing, `DD.MM.YYYY`.
    let mut de = engine(Locale::De);
    assert_eq!(display(&mut de, "num"), "1.234,50");
    assert_eq!(display(&mut de, "cur"), "1.234,50 €");
    assert_eq!(display(&mut de, "date"), "01.01.1970");
}

#[test]
fn data_i18n_locale_default_is_en() {
    // A fresh engine (no set_locale) formats en — the locale-free canonical
    // behavior is unchanged for existing callers.
    let mut e = engine(Locale::En);
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
