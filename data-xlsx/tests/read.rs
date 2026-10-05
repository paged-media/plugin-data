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

//! The committed fixture `conformance/sources/products.xlsx` (written by
//! openpyxl) read end to end: header naming, per-column types, dates, the
//! skipped empty row, error cells and the second worksheet.

// `__feat__<id>` test names: the cockpit test-to-feature join.
#![allow(non_snake_case)]

use data_xlsx::{read_sheet, sheet_names, ColumnType, XlsxError};
use serde_json::{json, Value};

fn fixture() -> Vec<u8> {
    std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../conformance/sources/products.xlsx"
    ))
    .expect("fixture")
}

#[test]
fn sheet_names_in_workbook_order__feat__data_source_adapters() {
    assert_eq!(sheet_names(&fixture()).unwrap(), vec!["Products", "Prices"]);
}

#[test]
fn first_sheet_reads_as_typed_records__feat__data_source_adapters() {
    let t = read_sheet(&fixture(), None).unwrap();
    assert_eq!(t.sheet, "Products");
    assert_eq!(
        t.columns,
        vec!["sku", "price", "qty", "launched", "updated", "active", "note", "column_8", "sku_2"]
    );
    use ColumnType::*;
    assert_eq!(
        t.types,
        vec![Varchar, Double, BigInt, Date, Timestamp, Boolean, Varchar, Varchar, Varchar]
    );
    // The empty row 4 is not a record.
    assert_eq!(t.rows.len(), 4);
    assert_eq!(t.error_cells, 1);
    assert_eq!(
        t.rows[0],
        vec![
            json!("A-1"),
            json!(9.99),
            json!(3),
            json!("2026-01-15"),
            json!("2026-01-15 09:30:00"),
            json!(true),
            json!("first"),
            Value::Null,
            json!("x"),
        ]
    );
    // An integral price in a DOUBLE column stays a number; a midnight
    // date-time in a TIMESTAMP column keeps its time of day.
    assert_eq!(t.rows[2][1], json!(7.0));
    assert_eq!(t.rows[1][4], json!("2026-02-01 00:00:00"));
    // A number in a text column is written as text.
    assert_eq!(t.rows[2][6], json!("42"));
    // The error cell is NULL.
    assert_eq!(t.rows[3][1], Value::Null);
    assert_eq!(t.rows[3][6], json!("Grüße, \"quoted\""));
}

#[test]
fn json_records_carry_every_column__feat__data_source_adapters() {
    let t = read_sheet(&fixture(), Some("Prices")).unwrap();
    assert_eq!(t.types, vec![ColumnType::Varchar, ColumnType::Double]);
    let parsed: Value = serde_json::from_str(&t.to_json()).unwrap();
    assert_eq!(
        parsed,
        json!([{ "region": "en", "factor": 1.0 }, { "region": "de", "factor": 1.19 }])
    );
}

#[test]
fn unknown_sheet_is_an_error__feat__data_source_adapters() {
    assert_eq!(
        read_sheet(&fixture(), Some("Nope")),
        Err(XlsxError::NoSuchSheet("Nope".into()))
    );
}
