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

//! Record N is the Nth record of the data as its query delivers it, when the
//! query defines that order (spec §6.1): an explicit `ORDER BY`, or a scan of
//! one table, which DuckDB delivers in insertion order (`preserve_insertion_order`,
//! on by default). Only a result whose order is undefined (a join, a grouping,
//! a set operation, no SQL at all) is numbered by content, so a re-delivery in
//! another order is no change (defect DP-4, still fixed).
//!
//! Before this, every result was numbered by content: an unindexed barcode
//! bound to `ean` over a product list encoded the alphabetically first product
//! ("Bookmark set", the 20th row), not the first row the file, the Dataset
//! preview and Data Merge's first page all show.

// `__feat__<id>` test names: the cockpit test-to-feature join.
#![allow(non_snake_case)]

use data_conformance::{record_set, t, today};
use data_core::{
    BarcodeMissing, BarcodeOpts, BarcodeSymbology, Binding, BindingDef, BindingId, ColumnBind,
    FieldType, FrameRef, MissingPolicy, PlaceholderRef, Query, QueryId, RecordSet, ResultShape,
    TableOpts,
};
use data_js::core::{DataSession, LoweredOutput};

/// The first rows of the films' product list (`name`, `ean`), in file order:
/// the first row is not the first by content.
const ROWS: [(&str, &str); 5] = [
    ("Linen notebook", "2000000210018"),
    ("Pocket notebook", "2000000210025"),
    ("Desk pad", "2000000210032"),
    ("Bookmark set", "2000000210209"),
    ("Card holder", "2000000210247"),
];

fn catalogue(order: &[usize]) -> RecordSet {
    record_set(
        &[("name", FieldType::Text), ("ean", FieldType::Text)],
        vec![
            order.iter().map(|&i| t(ROWS[i].0)).collect(),
            order.iter().map(|&i| t(ROWS[i].1)).collect(),
        ],
    )
}

const FILE_ORDER: [usize; 5] = [0, 1, 2, 3, 4];

/// A session over `sql`, the catalogue delivered in `order`, with a variable
/// on `name`, an EAN-13 barcode on `ean` and a table of both columns.
fn session(sql: &str, order: &[usize]) -> DataSession {
    let q = QueryId::from("q_all");
    let mut s = DataSession::new(today());
    s.define_query(Query {
        id: q.clone(),
        sql: sql.to_string(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    s.define_binding(BindingDef {
        id: BindingId::from("name"),
        binding: Binding::Variable {
            target: PlaceholderRef::from("p"),
            query: q.clone(),
            expr: "name".into(),
            missing: MissingPolicy::Blank,
        },
    });
    s.define_binding(BindingDef {
        id: BindingId::from("ean"),
        binding: Binding::Barcode {
            target: FrameRef::from("bc"),
            query: q.clone(),
            symbology: BarcodeSymbology::Ean13,
            expr: "ean".into(),
            options: BarcodeOpts {
                quiet_zone: 0,
                missing: BarcodeMissing::Skip,
            },
        },
    });
    s.define_binding(BindingDef {
        id: BindingId::from("table"),
        binding: Binding::Table {
            region: FrameRef::from("r"),
            query: q.clone(),
            columns: ["name", "ean"]
                .iter()
                .map(|c| ColumnBind {
                    header: c.to_string(),
                    expr: c.to_string(),
                    style: None,
                })
                .collect(),
            options: TableOpts::default(),
        },
    });
    s.ingest_result(q, catalogue(order));
    s
}

fn variable_at(s: &mut DataSession, record: usize) -> String {
    match s
        .resolve_lowered_at(&BindingId::from("name"), record)
        .unwrap()
    {
        LoweredOutput::Variable(v) => v.text,
        other => panic!("expected a variable, got {other:?}"),
    }
}

fn table_names(s: &mut DataSession) -> Vec<String> {
    match s.resolve_lowered(&BindingId::from("table")).unwrap() {
        LoweredOutput::Table(tb) => tb
            .rows
            .iter()
            .filter(|r| !r.header)
            .map(|r| r.cells[0].clone())
            .collect(),
        other => panic!("expected a table, got {other:?}"),
    }
}

/// DATA-1: the barcode the films bound to `ean` over `SELECT * FROM catalogue`
/// encodes the FIRST row's EAN, as the capability record says an unindexed
/// binding does, not the alphabetically first product's.
#[test]
fn data_record_order_unindexed_barcode_encodes_the_first_row__feat__data_barcode_symbology() {
    let mut s = session("SELECT * FROM catalogue", &FILE_ORDER);
    let bc = s
        .lower_barcode_sized(&BindingId::from("ean"), 210.0, 90.0)
        .unwrap();
    assert_eq!(bc.text, "2000000210018");
    // The plain resolve (the lower lane's record 0) agrees.
    match s.resolve_lowered(&BindingId::from("name")).unwrap() {
        LoweredOutput::Variable(v) => assert_eq!(v.text, "Linen notebook"),
        other => panic!("expected a variable, got {other:?}"),
    }
}

/// The preview stepper's record N is the Nth row, as Data Merge numbers it;
/// a table over the same query lists the rows in that order too.
#[test]
fn data_record_order_stepper_and_table_follow_the_scan__feat__data_bind_preview_step() {
    let mut s = session(
        "SELECT name, ean FROM catalogue WHERE ean <> '' LIMIT 100",
        &FILE_ORDER,
    );
    let stepped: Vec<String> = (0..ROWS.len()).map(|r| variable_at(&mut s, r)).collect();
    let file: Vec<String> = ROWS.iter().map(|r| r.0.to_string()).collect();
    assert_eq!(stepped, file);
    assert_eq!(table_names(&mut s), file);
    // The barcode steps with it.
    let at = s
        .lower_barcode_at(&BindingId::from("ean"), 3, 210.0, 90.0)
        .unwrap();
    assert_eq!(at.text, "2000000210209");
}

/// An explicit ORDER BY is the order, whatever the content order is.
#[test]
fn data_record_order_order_by_is_kept__feat__data_bind_preview_step() {
    // name DESC: Pocket, Linen, Desk, Card, Bookmark.
    let delivered = [1, 0, 2, 4, 3];
    let mut s = session("SELECT * FROM catalogue ORDER BY name DESC", &delivered);
    assert_eq!(variable_at(&mut s, 0), "Pocket notebook");
    assert_eq!(variable_at(&mut s, 4), "Bookmark set");
    assert_eq!(
        table_names(&mut s),
        delivered
            .iter()
            .map(|&i| ROWS[i].0.to_string())
            .collect::<Vec<_>>()
    );
}

/// A result whose order the query leaves undefined is still numbered by
/// content: the same rows delivered in another order are the same records,
/// and no change (DP-4).
#[test]
fn data_record_order_undefined_order_is_numbered_by_content__feat__data_bind_change_report() {
    for sql in [
        "",
        "SELECT name, ean FROM catalogue GROUP BY name, ean",
        "SELECT DISTINCT name, ean FROM catalogue",
        "SELECT c.name, c.ean FROM catalogue c JOIN prices p ON p.ean = c.ean",
        "SELECT name, ean FROM catalogue, prices",
        "SELECT name, ean FROM catalogue UNION SELECT name, ean FROM archive",
        "SELECT * FROM catalogue WHERE ean IN (SELECT ean FROM stock)",
    ] {
        let mut a = session(sql, &FILE_ORDER);
        let mut b = session(sql, &[4, 3, 2, 1, 0]);
        assert_eq!(variable_at(&mut a, 0), "Bookmark set", "{sql}");
        assert_eq!(variable_at(&mut a, 0), variable_at(&mut b, 0), "{sql}");
        assert_eq!(table_names(&mut a), table_names(&mut b), "{sql}");
        a.refresh_change_report();
        a.ingest_result(QueryId::from("q_all"), catalogue(&[4, 3, 2, 1, 0]));
        let report = a.refresh_change_report();
        assert_eq!(report.changed, 0, "{sql}");
    }
}
