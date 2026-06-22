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

//! Record-flow conformance (spec §9.4 — the catalog engine): grouped template
//! resolution, pagination over a caller-supplied frame chain (repeated/continued
//! headers, atomic records, tall-record convergence), and the end-to-end
//! resolve → paginate path through `DataSession`.

use data_bind::{ResolutionEngine, Resolved};
use data_conformance::{n, record_set, t, today};
use data_core::{
    Binding, BindingId, FieldType, FlowOpts, FooterAgg, FrameChainRef, GroupFooter, Query, QueryId,
    ResultShape, Template, TemplateField, TemplateRef,
};
use data_js::core::DataSession;
use data_lower::{paginate_flow, FlowBlock, FlowGroup, FlowLayoutOpts, FlowRecord, FrameCapacity};

fn template() -> Template {
    Template {
        id: TemplateRef::from("tmpl"),
        fields: vec![
            TemplateField {
                label: String::new(),
                expr: "name".into(),
            },
            TemplateField {
                label: "$".into(),
                expr: "NUMBER(price, 2)".into(),
            },
        ],
        line_height_pt: 10.0,
    }
}

#[test]
fn data_bind_record_flow_grouped() {
    let mut e = ResolutionEngine::new(today());
    e.add_query(Query {
        id: QueryId::from("q1"),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    e.add_template(template());
    e.add_binding(
        BindingId::from("rf"),
        Binding::RecordFlow {
            chain: FrameChainRef::from("chain1"),
            query: QueryId::from("q1"),
            template: TemplateRef::from("tmpl"),
            options: FlowOpts {
                group_by: vec!["cat".into()],
                repeat_header: true,
                continued_marker: true,
                footer: None,
            },
        },
    );
    e.set_result(
        QueryId::from("q1"),
        record_set(
            &[
                ("cat", FieldType::Text),
                ("name", FieldType::Text),
                ("price", FieldType::Float),
            ],
            vec![
                vec![t("A"), t("B"), t("A")],
                vec![t("x"), t("y"), t("z")],
                vec![n(1.0), n(2.0), n(3.0)],
            ],
        ),
    );
    match e.resolve(&BindingId::from("rf")).unwrap() {
        Resolved::RecordFlow(rf) => {
            // Grouped by cat (stable order): A = {x, z}, B = {y}.
            assert_eq!(rf.groups.len(), 2);
            assert_eq!(rf.groups[0].header.as_deref(), Some("A"));
            assert_eq!(rf.groups[0].records.len(), 2);
            assert_eq!(rf.groups[1].header.as_deref(), Some("B"));
            // Each instance renders its template fields (label + value).
            assert_eq!(
                rf.groups[0].records[0].cells,
                vec!["x".to_string(), "$1.00".to_string()]
            );
            // Height = 2 fields × 10pt.
            assert_eq!(rf.groups[0].records[0].height_pt, 20.0);
        }
        other => panic!("expected record flow, got {other:?}"),
    }
}

fn rec(label: &str, height: f64) -> FlowRecord {
    FlowRecord {
        cells: vec![label.to_string()],
        height_pt: height,
    }
}

fn frame(id: &str, h: f64) -> FrameCapacity {
    FrameCapacity {
        frame: id.to_string(),
        page: "p1".to_string(),
        height_pt: h,
    }
}

#[test]
fn data_lower_paginate_packs_with_continued_headers() {
    let chain = vec![frame("f1", 60.0), frame("f2", 60.0)];
    let groups = vec![FlowGroup {
        header: Some("Cat A".into()),
        level: 0,
        records: vec![rec("r1", 20.0), rec("r2", 20.0), rec("r3", 20.0)],
        footer: None,
    }];
    let flow = paginate_flow(&groups, &chain, &FlowLayoutOpts::default());

    assert_eq!(flow.total, 3);
    assert_eq!(flow.placed, 3);
    assert!(!flow.overflow);
    assert_eq!(flow.frames.len(), 2);

    // f1: header (16) + r1 + r2 = 56 ≤ 60; r3 spills.
    assert_eq!(flow.frames[0].blocks.len(), 3);
    assert!(matches!(
        flow.frames[0].blocks[0],
        FlowBlock::GroupHeader {
            continued: false,
            ..
        }
    ));
    // f2: the header is re-emitted, marked continued.
    assert!(matches!(
        flow.frames[1].blocks[0],
        FlowBlock::GroupHeader {
            continued: true,
            ..
        }
    ));
    // No non-tall frame exceeds its capacity.
    assert!(flow.frames.iter().all(|f| f.used_pt <= 60.0));
}

#[test]
fn data_recordflow_pagination_converges_on_tall_record() {
    // A record taller than any frame must still converge (§9.4): it gets its
    // own (over-full) frame, and the pass terminates with every record placed.
    let chain = vec![frame("f1", 50.0), frame("f2", 50.0), frame("f3", 50.0)];
    let groups = vec![FlowGroup {
        header: None,
        level: 0,
        records: vec![rec("small", 10.0), rec("tall", 80.0), rec("after", 10.0)],
        footer: None,
    }];
    let flow = paginate_flow(&groups, &chain, &FlowLayoutOpts::default());

    assert_eq!(flow.placed, 3);
    assert!(!flow.overflow);
    assert_eq!(flow.frames.len(), 3);
    // The middle frame holds exactly the tall record, over-full (the ONLY
    // allowed capacity overflow).
    assert_eq!(flow.frames[1].blocks.len(), 1);
    assert!(flow.frames[1].used_pt > 50.0);
    // Every other frame respects its capacity.
    assert!(flow.frames[0].used_pt <= 50.0 && flow.frames[2].used_pt <= 50.0);
}

#[test]
fn data_recordflow_e2e_via_session() {
    // resolve → paginate, end-to-end through the DataSession bridge.
    let mut s = DataSession::new(today());
    s.define_query(Query {
        id: QueryId::from("q1"),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    s.define_template(template());
    s.define_binding(data_core::BindingDef {
        id: BindingId::from("rf"),
        binding: Binding::RecordFlow {
            chain: FrameChainRef::from("chain1"),
            query: QueryId::from("q1"),
            template: TemplateRef::from("tmpl"),
            options: FlowOpts::default(),
        },
    });
    s.ingest_result(
        QueryId::from("q1"),
        record_set(
            &[("name", FieldType::Text), ("price", FieldType::Float)],
            vec![vec![t("a"), t("b")], vec![n(1.0), n(2.0)]],
        ),
    );
    let chain = vec![frame("f1", 100.0)];
    let flow = s
        .lower_record_flow(&BindingId::from("rf"), chain, FlowLayoutOpts::default())
        .unwrap();
    assert_eq!(flow.placed, 2);
    assert_eq!(flow.total, 2);
    assert!(!flow.overflow);
}

#[test]
fn data_bind_record_flow_footer() {
    // §9.4 section footers: each group gets a subtotal/count row. `{count}` is
    // substituted; `sum_field` totals a numeric column (locale-aware, 2 dp).
    let mut e = ResolutionEngine::new(today());
    e.add_query(Query {
        id: QueryId::from("q1"),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    e.add_template(template());
    e.add_binding(
        BindingId::from("rf"),
        Binding::RecordFlow {
            chain: FrameChainRef::from("chain1"),
            query: QueryId::from("q1"),
            template: TemplateRef::from("tmpl"),
            options: FlowOpts {
                group_by: vec!["cat".into()],
                repeat_header: true,
                continued_marker: true,
                footer: Some(GroupFooter {
                    label: "Subtotal ({count})".into(),
                    sum_field: Some("price".into()),
                    ..Default::default()
                }),
            },
        },
    );
    // cat A,B,A → stabilized A:{x=1, z=3}, B:{y=2}. Sums: A=4.00, B=2.00.
    e.set_result(
        QueryId::from("q1"),
        record_set(
            &[
                ("cat", FieldType::Text),
                ("name", FieldType::Text),
                ("price", FieldType::Float),
            ],
            vec![
                vec![t("A"), t("B"), t("A")],
                vec![t("x"), t("y"), t("z")],
                vec![n(1.0), n(2.0), n(3.0)],
            ],
        ),
    );
    match e.resolve(&BindingId::from("rf")).unwrap() {
        Resolved::RecordFlow(rf) => {
            let fa = rf.groups[0].footer.as_ref().expect("group A has a footer");
            assert_eq!(fa.cells[0], "Subtotal (2)");
            assert_eq!(fa.cells[1], "4.00");
            let fb = rf.groups[1].footer.as_ref().expect("group B has a footer");
            assert_eq!(fb.cells[0], "Subtotal (1)");
            assert_eq!(fb.cells[1], "2.00");
        }
        other => panic!("expected a record flow, got {other:?}"),
    }
}

#[test]
fn data_lower_paginate_emits_a_footer_block() {
    // A group footer paginates as an atomic block at the group's end.
    let groups = vec![FlowGroup {
        header: Some("Cat A".into()),
        level: 0,
        records: vec![rec("r1", 20.0), rec("r2", 20.0)],
        footer: Some(FlowRecord {
            cells: vec!["Subtotal".into(), "40.00".into()],
            height_pt: 10.0,
        }),
    }];
    let flow = paginate_flow(&groups, &[frame("f1", 100.0)], &FlowLayoutOpts::default());
    let footers: Vec<_> = flow
        .frames
        .iter()
        .flat_map(|f| &f.blocks)
        .filter(|b| matches!(b, FlowBlock::GroupFooter { .. }))
        .collect();
    assert_eq!(footers.len(), 1, "exactly one footer block");
    match footers[0] {
        FlowBlock::GroupFooter { cells, .. } => assert_eq!(cells[0], "Subtotal"),
        _ => unreachable!(),
    }
}

#[test]
fn data_bind_record_flow_nested() {
    // Multi-level group_by [region, category] nests: each parent level is a
    // header-only section preceding its leaf sections (§9.4 advanced grouping).
    let mut e = ResolutionEngine::new(today());
    e.add_query(Query {
        id: QueryId::from("q1"),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    e.add_template(Template {
        id: TemplateRef::from("tmpl"),
        fields: vec![TemplateField {
            label: String::new(),
            expr: "name".into(),
        }],
        line_height_pt: 10.0,
    });
    e.add_binding(
        BindingId::from("rf"),
        Binding::RecordFlow {
            chain: FrameChainRef::from("chain1"),
            query: QueryId::from("q1"),
            template: TemplateRef::from("tmpl"),
            options: FlowOpts {
                group_by: vec!["region".into(), "category".into()],
                repeat_header: true,
                continued_marker: true,
                footer: None,
            },
        },
    );
    // Stabilized by [region, category]: north/a, north/b, south/a.
    e.set_result(
        QueryId::from("q1"),
        record_set(
            &[
                ("region", FieldType::Text),
                ("category", FieldType::Text),
                ("name", FieldType::Text),
            ],
            vec![
                vec![t("north"), t("north"), t("south")],
                vec![t("b"), t("a"), t("a")],
                vec![t("x"), t("y"), t("z")],
            ],
        ),
    );
    match e.resolve(&BindingId::from("rf")).unwrap() {
        Resolved::RecordFlow(rf) => {
            // north(L0,header-only) · a(L1) · b(L1) · south(L0,header-only) · a(L1)
            let shape: Vec<(Option<&str>, usize, usize)> = rf
                .groups
                .iter()
                .map(|g| (g.header.as_deref(), g.level, g.records.len()))
                .collect();
            assert_eq!(
                shape,
                vec![
                    (Some("north"), 0, 0),
                    (Some("a"), 1, 1),
                    (Some("b"), 1, 1),
                    (Some("south"), 0, 0),
                    (Some("a"), 1, 1),
                ]
            );
        }
        other => panic!("expected a record flow, got {other:?}"),
    }
}

#[test]
fn data_lower_paginate_repeats_parent_path_on_spill() {
    // Nested: a header-only region parent + a category leaf whose records spill.
    // The continuation frame repeats the FULL path (region then category).
    let groups = vec![
        FlowGroup {
            header: Some("EMEA".into()),
            level: 0,
            records: vec![],
            footer: None,
        },
        FlowGroup {
            header: Some("Widgets".into()),
            level: 1,
            records: vec![rec("r1", 20.0), rec("r2", 20.0)],
            footer: None,
        },
    ];
    let chain = vec![frame("f1", 60.0), frame("f2", 60.0)];
    let flow = paginate_flow(&groups, &chain, &FlowLayoutOpts::default());

    assert_eq!(flow.placed, 2);
    assert!(!flow.overflow);
    // Frame 1: EMEA(16) + Widgets(16) + r1(20) = 52; r2 spills.
    // Frame 2 repeats the whole path before r2.
    let f2 = &flow.frames[1].blocks;
    match (&f2[0], &f2[1]) {
        (
            FlowBlock::GroupHeader {
                text: t0,
                level: 0,
                continued: true,
            },
            FlowBlock::GroupHeader {
                text: t1,
                level: 1,
                continued: true,
            },
        ) => {
            assert_eq!(t0.as_str(), "EMEA");
            assert_eq!(t1.as_str(), "Widgets");
        }
        other => panic!("frame 2 should repeat the EMEA/Widgets path, got {other:?}"),
    }
}

#[test]
fn data_bind_record_flow_footer_agg() {
    // Group A (stabilized) = {price 1, 3}: AVG 2.00, MAX 3.00, MIN 1.00.
    let footer_value = |agg: FooterAgg| -> String {
        let mut e = ResolutionEngine::new(today());
        e.add_query(Query {
            id: QueryId::from("q1"),
            sql: String::new(),
            params: vec![],
            shape: ResultShape::RecordStream,
        });
        e.add_template(template());
        e.add_binding(
            BindingId::from("rf"),
            Binding::RecordFlow {
                chain: FrameChainRef::from("chain1"),
                query: QueryId::from("q1"),
                template: TemplateRef::from("tmpl"),
                options: FlowOpts {
                    group_by: vec!["cat".into()],
                    repeat_header: true,
                    continued_marker: true,
                    footer: Some(GroupFooter {
                        label: "X".into(),
                        sum_field: Some("price".into()),
                        agg,
                    }),
                },
            },
        );
        e.set_result(
            QueryId::from("q1"),
            record_set(
                &[
                    ("cat", FieldType::Text),
                    ("name", FieldType::Text),
                    ("price", FieldType::Float),
                ],
                vec![
                    vec![t("A"), t("B"), t("A")],
                    vec![t("x"), t("y"), t("z")],
                    vec![n(1.0), n(2.0), n(3.0)],
                ],
            ),
        );
        match e.resolve(&BindingId::from("rf")).unwrap() {
            Resolved::RecordFlow(rf) => rf.groups[0].footer.as_ref().unwrap().cells[1].clone(),
            other => panic!("expected a record flow, got {other:?}"),
        }
    };
    assert_eq!(footer_value(FooterAgg::Avg), "2.00");
    assert_eq!(footer_value(FooterAgg::Max), "3.00");
    assert_eq!(footer_value(FooterAgg::Min), "1.00");
}
