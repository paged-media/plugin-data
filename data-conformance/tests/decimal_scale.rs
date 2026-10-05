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

//! A DECIMAL(p, s) column displays with its declared scale (oracle defect
//! DM-8): a bare reference to the field prints `1234.50`, not `1234.5`, in a
//! variable, a table cell and a record-flow line. Any other expression over
//! it formats as before (its value is a plain f64).

// Test names end in `__feat__<id>` (the cockpit feature link).
#![allow(non_snake_case)]

use data_conformance::today;
use data_core::{
    Binding, BindingDef, BindingId, ColumnBind, FieldType, FlowOpts, FrameChainRef, FrameRef,
    MissingPolicy, PlaceholderRef, Query, QueryId, RecordSet, ResultShape, Schema, TableOpts,
    Template, TemplateField, TemplateRef, Value,
};
use data_js::core::{DataSession, LoweredOutput};
use data_lower::{FlowBlock, FlowLayoutOpts, FrameCapacity};

fn session(scale: Option<u8>) -> DataSession {
    let mut schema = Schema::from_fields([("price".to_string(), FieldType::Float)]);
    schema.fields[0].scale = scale;
    let rs = RecordSet::new(
        schema,
        vec![vec![
            Value::Number(1234.5),
            Value::Number(-0.0),
            Value::Number(2.0),
        ]],
    )
    .unwrap();
    let q = QueryId::from("q");
    let mut s = DataSession::new(today());
    s.define_query(Query {
        id: q.clone(),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    let var = |id: &str, expr: &str| BindingDef {
        id: BindingId::from(id),
        binding: Binding::Variable {
            target: PlaceholderRef::from(id),
            query: q.clone(),
            expr: expr.into(),
            missing: MissingPolicy::Blank,
        },
    };
    s.define_binding(var("bare", "price"));
    s.define_binding(var("calc", "price * 2"));
    s.define_binding(BindingDef {
        id: BindingId::from("t"),
        binding: Binding::Table {
            region: FrameRef::from("r"),
            query: q.clone(),
            columns: vec![ColumnBind {
                header: "P".into(),
                expr: "price".into(),
                style: None,
            }],
            options: TableOpts {
                header_row: true,
                group_by: vec![],
            },
        },
    });
    s.define_template(Template {
        id: TemplateRef::from("tm"),
        fields: vec![TemplateField {
            label: "$".into(),
            expr: "price".into(),
        }],
        line_height_pt: 10.0,
    });
    s.define_binding(BindingDef {
        id: BindingId::from("f"),
        binding: Binding::RecordFlow {
            chain: FrameChainRef::from("c"),
            query: q.clone(),
            template: TemplateRef::from("tm"),
            options: FlowOpts {
                group_by: vec![],
                repeat_header: false,
                continued_marker: false,
                footer: None,
            },
        },
    });
    s.ingest_result(q, rs);
    s
}

fn var(s: &mut DataSession, id: &str, record: usize) -> String {
    match s.resolve_lowered_at(&BindingId::from(id), record).unwrap() {
        LoweredOutput::Variable(v) => v.text,
        other => panic!("{other:?}"),
    }
}

#[test]
fn data_query_decimal_scale_displays_trailing_zeros__feat__data_query_seam() {
    let mut s = session(Some(2));
    // Stabilized order: -0.0, 2.0, 1234.5.
    assert_eq!(
        var(&mut s, "bare", 0),
        "0.00",
        "a negative zero prints as 0.00"
    );
    assert_eq!(var(&mut s, "bare", 1), "2.00");
    assert_eq!(var(&mut s, "bare", 2), "1234.50");
    // A computed value is a plain number.
    assert_eq!(var(&mut s, "calc", 2), "2469");
    match s.resolve_lowered(&BindingId::from("t")).unwrap() {
        LoweredOutput::Table(t) => {
            let cells: Vec<&str> = t.rows[1..].iter().map(|r| r.cells[0].as_str()).collect();
            assert_eq!(cells, ["0.00", "2.00", "1234.50"]);
        }
        other => panic!("{other:?}"),
    }
    let chain = vec![FrameCapacity {
        frame: "f".into(),
        page: "p".into(),
        height_pt: 100.0,
    }];
    let flow = s
        .lower_record_flow(&BindingId::from("f"), chain, FlowLayoutOpts::default())
        .unwrap();
    let lines: Vec<String> = flow.frames[0]
        .blocks
        .iter()
        .filter_map(|b| match b {
            FlowBlock::Record { cells, .. } => Some(cells[0].clone()),
            _ => None,
        })
        .collect();
    assert_eq!(lines, ["$0.00", "$2.00", "$1234.50"]);
}

#[test]
fn data_query_no_scale_displays_as_before__feat__data_query_seam() {
    let mut s = session(None);
    assert_eq!(var(&mut s, "bare", 2), "1234.5");
    assert_eq!(var(&mut s, "bare", 1), "2");
}
