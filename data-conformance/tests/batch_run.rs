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

//! Batch-run conformance (spec §10): the headless-generation EXECUTOR. It
//! resolves a record-flow binding, partitions the resolved flow by `BatchMode`
//! into per-document units (per-record flyers / per-group catalogs / one
//! catalog), and paginates each unit through the SAME `data-lower` path the live
//! document uses. The plan (`plan_batch`) says which records feed which document;
//! the run produces each document's `PaginatedFlow`. Nothing renders here.

use data_automation::BatchMode;
use data_conformance::{n, record_set, t, today};
use data_core::{
    Binding, BindingDef, BindingId, FieldType, FlowOpts, FrameChainRef, Query, QueryId,
    ResultShape, Template, TemplateField, TemplateRef,
};
use data_js::core::DataSession;
use data_lower::{FlowLayoutOpts, FrameCapacity};

fn session() -> DataSession {
    let mut s = DataSession::new(today());
    s.define_query(Query {
        id: QueryId::from("q1"),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    s.define_template(Template {
        id: TemplateRef::from("tmpl"),
        fields: vec![TemplateField {
            label: String::new(),
            expr: "name".into(),
        }],
        line_height_pt: 10.0,
    });
    s.define_binding(BindingDef {
        id: BindingId::from("rf"),
        binding: Binding::RecordFlow {
            chain: FrameChainRef::from("chain"),
            query: QueryId::from("q1"),
            template: TemplateRef::from("tmpl"),
            options: FlowOpts {
                group_by: vec!["region".into()],
                repeat_header: true,
                continued_marker: true,
            },
        },
    });
    // 3 records across 2 regions (east: 2, west: 1).
    s.ingest_result(
        QueryId::from("q1"),
        record_set(
            &[
                ("region", FieldType::Text),
                ("name", FieldType::Text),
                ("qty", FieldType::Float),
            ],
            vec![
                vec![t("west"), t("east"), t("east")],
                vec![t("Store W"), t("Store E1"), t("Store E2")],
                vec![n(1.0), n(2.0), n(3.0)],
            ],
        ),
    );
    s
}

fn chain() -> Vec<FrameCapacity> {
    (0..8)
        .map(|i| FrameCapacity {
            frame: format!("f{i}"),
            page: format!("p{i}"),
            height_pt: 200.0,
        })
        .collect()
}

#[test]
fn data_automation_run() {
    // Per group → one document per region (east, west), each paginated.
    let mut s = session();
    let per_group = s
        .run_record_flow_batch(
            &BindingId::from("rf"),
            BatchMode::PerGroup {
                by: vec!["region".into()],
            },
            chain(),
            FlowLayoutOpts::default(),
        )
        .unwrap();
    assert_eq!(per_group.len(), 2);
    assert_eq!(per_group[0].label, "east");
    assert_eq!(per_group[1].label, "west");
    assert!(
        !per_group[0].flow.frames.is_empty(),
        "east doc should paginate"
    );
    assert_eq!(per_group[0].flow.total, 2, "east has 2 records");

    // Per record → one document per record (3), labelled by the rendered name.
    let per_record = s
        .run_record_flow_batch(
            &BindingId::from("rf"),
            BatchMode::PerRecord { key: None },
            chain(),
            FlowLayoutOpts::default(),
        )
        .unwrap();
    assert_eq!(per_record.len(), 3);
    assert_eq!(per_record[0].label, "Store E1");
    assert_eq!(
        per_record[0].flow.total, 1,
        "a per-record doc has one record"
    );

    // One catalog → a single document over all records.
    let one = s
        .run_record_flow_batch(
            &BindingId::from("rf"),
            BatchMode::OneCatalog,
            chain(),
            FlowLayoutOpts::default(),
        )
        .unwrap();
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].label, "catalog");
    assert_eq!(one[0].flow.total, 3, "the catalog spans all 3 records");
}

#[test]
fn data_automation_run_non_flow_binding_errors() {
    // run on a non-record-flow binding is a typed error.
    let mut s = DataSession::new(today());
    s.define_query(Query {
        id: QueryId::from("q1"),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::SingleRecord,
    });
    s.define_binding(BindingDef {
        id: BindingId::from("v1"),
        binding: Binding::Variable {
            target: data_core::PlaceholderRef::from("ph"),
            query: QueryId::from("q1"),
            expr: "name".into(),
            missing: data_core::MissingPolicy::Blank,
        },
    });
    s.ingest_result(
        QueryId::from("q1"),
        record_set(&[("name", FieldType::Text)], vec![vec![t("x")]]),
    );
    assert!(s
        .run_record_flow_batch(
            &BindingId::from("v1"),
            BatchMode::OneCatalog,
            chain(),
            FlowLayoutOpts::default(),
        )
        .is_err());
}
