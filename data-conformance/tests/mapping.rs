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

//! Field-mapping wizard conformance (spec §9): the pure schema → column-mapping
//! suggestion kernel that drives the first-run CSV/file-import affordance —
//! columns → variable bindings with one click, the bound expression = the column
//! reference. The DSL's bare-field-identifier rule decides one-click mappability;
//! a non-identifier column name is flagged for a manual expression (the grammar
//! has no quoting), never silently mapped to a broken expression.

use data_bind::{suggest_mappings, ColumnMapping};
use data_core::{FieldType, Schema};
use data_expr::{eval_str, is_field_ident, EvalCtx, SimpleCtx};

fn schema(fields: &[(&str, FieldType)]) -> Schema {
    Schema::from_fields(fields.iter().map(|(n, t)| (n.to_string(), *t)))
}

#[test]
fn data_bind_field_mapping_suggests_column_bindings() {
    // A CSV import's schema → one suggested variable-binding mapping per column.
    let s = schema(&[
        ("sku", FieldType::Text),
        ("unit_price", FieldType::Float),
        ("in_stock", FieldType::Bool),
        ("photo", FieldType::Bytes),
    ]);
    let maps = suggest_mappings(&s);
    assert_eq!(maps.len(), 4);

    // Column order is preserved; the expression is a bare field reference; the
    // header is humanised; the type hint mirrors the schema.
    assert_eq!(
        maps[0],
        ColumnMapping {
            column: "sku".to_string(),
            header: "Sku".to_string(),
            expr: "sku".to_string(),
            field_type: FieldType::Text,
            mappable: true,
        }
    );
    assert_eq!(maps[1].header, "Unit Price"); // unit_price → Unit Price
    assert_eq!(maps[1].expr, "unit_price");
    assert_eq!(maps[1].field_type, FieldType::Float);
    assert!(maps[1].mappable);
    // The bytes column carries its type hint (the wizard can suggest an image
    // binding) but is still produced as a mappable reference.
    assert_eq!(maps[3].field_type, FieldType::Bytes);
    assert_eq!(maps[3].expr, "photo");

    // The generated expression actually RESOLVES against a record (the wizard's
    // one-click mapping is a real, evaluable binding expression).
    let ctx = SimpleCtx::new().with_field("unit_price", data_core::Value::Number(9.99));
    let ec = EvalCtx::new(&ctx, 20613);
    assert_eq!(eval_str(&maps[1].expr, &ec), data_core::Value::Number(9.99));
}

#[test]
fn data_bind_field_mapping_flags_non_identifier_columns() {
    // The DSL has NO quoted/bracketed field syntax, so a column whose name is not
    // a bare identifier (space, punctuation, leading digit, reserved word) cannot
    // be referenced bare — the wizard flags it for a manual expression instead of
    // emitting a broken one (honest, never faked).
    let s = schema(&[
        ("Unit Price", FieldType::Float), // space
        ("2024", FieldType::Int),         // leading digit
        ("price-usd", FieldType::Float),  // hyphen
        ("NULL", FieldType::Text),        // reserved word
        ("name", FieldType::Text),        // valid
    ]);
    let maps = suggest_mappings(&s);
    assert!(!maps[0].mappable && maps[0].expr.is_empty());
    assert!(!maps[1].mappable && maps[1].expr.is_empty());
    assert!(!maps[2].mappable && maps[2].expr.is_empty());
    assert!(!maps[3].mappable && maps[3].expr.is_empty());
    assert!(maps[4].mappable && maps[4].expr == "name");

    // A non-mappable column still carries a humanised header for the wizard's UI.
    assert_eq!(maps[0].header, "Unit Price");

    // The identifier predicate itself (the grammar mirror).
    assert!(is_field_ident("name") && is_field_ident("_x9") && is_field_ident("Quantity"));
    assert!(!is_field_ident("") && !is_field_ident("a b") && !is_field_ident("3x"));
    assert!(!is_field_ident("TRUE") && !is_field_ident("FALSE") && !is_field_ident("NULL"));
}
