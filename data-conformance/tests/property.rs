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

//! ADR 558 conformance — the universal property binding: the expression
//! language's units and colours, coercion against a target schema row, the
//! missing and coerce policies, sync states, data sets over properties, and
//! the migration rule (a canary.10 payload loads; visibility, rule and
//! barcode paint re-express as property triples equal to their old writes).

#![allow(non_snake_case)] // `__feat__<id>`: the cockpit test-to-feature join

use data_bind::{coerce, decide, PropertyOutcome};
use data_conformance::{eval0, n, record_set, t, today};
use data_core::{
    Binding, BindingDef, BindingId, CoercePolicy, ColorIntent, ColorSpec, FieldType, PropValue,
    PropertyMissing, Query, QueryId, ResultShape, Status, StyleAction, TargetRange, TargetRef,
    TargetSchema, TargetType, Value,
};
use data_dataset::{to_xml, DataSetValue, VarTrait};
use data_js::core::{DataSession, DocumentPayload, LoweredOutput};
use data_lower::{barcode_paint, lower_visibility, visibility_as_property};

fn approx(v: Value, want: f64) {
    match v {
        Value::Number(x) => assert!((x - want).abs() < 1e-9, "{x} != {want}"),
        other => panic!("expected a number, got {other:?}"),
    }
}

// ── the expression language (ADR 558 §3) ────────────────────────────────────

#[test]
fn units_convert_to_points__feat__data_bind_property() {
    approx(eval0("MM(25.4)"), 72.0);
    approx(eval0("CM(2.54)"), 72.0);
    approx(eval0("IN(1)"), 72.0);
    approx(eval0("PT(12)"), 12.0);
    approx(eval0("PT(\"1in\")"), 72.0);
    approx(eval0("MM(\"1in\")"), 72.0); // a text keeps its own unit
    approx(eval0("PX(96)"), 72.0);
    approx(eval0("PX(300, 300)"), 72.0);
    // A length is a number: it composes with math and logic.
    approx(eval0("MM(10) + PT(2)"), 10.0 * 72.0 / 25.4 + 2.0);
    approx(eval0("IF(TRUE, IN(1), MM(1))"), 72.0);
    assert_eq!(
        eval0("MM(\"wide\")"),
        Value::Error(data_core::ValueError::Type)
    );
    assert_eq!(eval0("MM(NULL)"), Value::Null);
}

#[test]
fn as_coerces_explicitly__feat__data_bind_property() {
    approx(eval0("AS(\"3mm\", \"length\")"), 3.0 * 72.0 / 25.4);
    approx(eval0("AS(\"12\", \"number\")"), 12.0);
    assert_eq!(eval0("AS(\"yes\", \"bool\")"), Value::Bool(true));
    assert_eq!(eval0("AS(12, \"text\")"), t("12"));
    assert_eq!(eval0("AS(\"#ff0000\", \"color\")"), t("rgb(255,0,0)"));
    assert_eq!(eval0("AS(\"Red\", \"color\")"), t("swatch:Red"));
    assert_eq!(
        eval0("AS(1, \"weird\")"),
        Value::Error(data_core::ValueError::Value)
    );
}

#[test]
fn colour_functions_make_canonical_literals__feat__data_bind_property() {
    assert_eq!(eval0("RGB(255, 0, 0)"), t("rgb(255,0,0)"));
    assert_eq!(eval0("CMYK(0, 100, 100, 0)"), t("cmyk(0,100,100,0)"));
    assert_eq!(eval0("HEX(\"#0f0\")"), t("rgb(0,255,0)"));
    assert_eq!(eval0("HEX(\"0000ff\")"), t("rgb(0,0,255)"));
    assert_eq!(eval0("SWATCH(\"Brand Red\")"), t("swatch:Brand Red"));
    assert_eq!(
        eval0("RGB(256, 0, 0)"),
        Value::Error(data_core::ValueError::Value)
    );
    assert_eq!(
        eval0("HEX(\"nope\")"),
        Value::Error(data_core::ValueError::Parse)
    );
    // Colours are text: they compose with logic.
    assert_eq!(
        eval0("IF(1 > 2, RGB(0,0,0), CMYK(0,0,0,100))"),
        t("cmyk(0,0,0,100)")
    );
}

#[test]
fn enum_checks_members__feat__data_bind_property() {
    assert_eq!(eval0("ENUM(\"left\", \"left\", \"right\")"), t("left"));
    assert_eq!(
        eval0("ENUM(\"middle\", \"left\", \"right\")"),
        Value::Error(data_core::ValueError::Value)
    );
    assert_eq!(eval0("ENUM(NULL, \"left\")"), Value::Null);
}

// ── coercion against the target schema (ADR 558 §2) ─────────────────────────

fn schema(value_type: TargetType) -> TargetSchema {
    TargetSchema {
        value_type,
        nullable: false,
        range: None,
        default: None,
    }
}

#[test]
fn coercion_follows_the_target_schema__feat__data_bind_property() {
    let length = schema(TargetType::Length);
    assert_eq!(
        coerce(&n(12.0), Some(&length)).unwrap().0,
        PropValue::Number(12.0)
    );
    match coerce(&t("3mm"), Some(&length)).unwrap().0 {
        PropValue::Number(x) => assert!((x - 3.0 * 72.0 / 25.4).abs() < 1e-9),
        other => panic!("{other:?}"),
    }
    let err = coerce(&t("wide"), Some(&length)).unwrap_err();
    assert!(err.contains("expected a length"), "{err}");

    let mut ranged = schema(TargetType::Number {
        integer: true,
        unit: Some("percent".into()),
    });
    ranged.range = Some(TargetRange {
        min: Some(0.0),
        max: Some(100.0),
    });
    assert_eq!(
        coerce(&t("50%"), Some(&ranged)).unwrap().0,
        PropValue::Number(50.0)
    );
    assert!(coerce(&n(150.0), Some(&ranged))
        .unwrap_err()
        .contains("above the maximum"));
    assert!(coerce(&n(1.5), Some(&ranged))
        .unwrap_err()
        .contains("whole number"));

    let colour = schema(TargetType::Color);
    let (v, intent) = coerce(&t("cmyk(0,100,100,0)"), Some(&colour)).unwrap();
    assert_eq!(v, PropValue::Text("C=0 M=100 Y=100 K=0".into()));
    assert_eq!(
        intent,
        Some(ColorIntent {
            name: "C=0 M=100 Y=100 K=0".into(),
            spec: Some(ColorSpec {
                space: "CMYK".into(),
                value: vec![0.0, 100.0, 100.0, 0.0],
            }),
        })
    );
    // A bare name is a swatch name; the host resolves it.
    let (v, intent) = coerce(&t("Paper"), Some(&colour)).unwrap();
    assert_eq!(v, PropValue::Text("Paper".into()));
    assert_eq!(intent.unwrap().spec, None);
    assert!(coerce(&n(3.0), Some(&colour)).is_err());

    let align = schema(TargetType::Enum {
        members: vec!["TopAlign".into(), "CenterAlign".into()],
    });
    assert_eq!(
        coerce(&t("CenterAlign"), Some(&align)).unwrap().0,
        PropValue::Text("CenterAlign".into())
    );
    let err = coerce(&t("Middle"), Some(&align)).unwrap_err();
    assert!(err.contains("not one of TopAlign, CenterAlign"), "{err}");

    assert_eq!(
        coerce(&t("no"), Some(&schema(TargetType::Bool))).unwrap().0,
        PropValue::Bool(false)
    );
    assert!(coerce(&t("maybe"), Some(&schema(TargetType::Bool))).is_err());

    let short = schema(TargetType::Text {
        multiline: false,
        max_length: Some(3),
    });
    assert!(coerce(&t("four"), Some(&short)).is_err());
    assert_eq!(
        coerce(&t("0, 0, 10mm, 1in"), Some(&schema(TargetType::Bounds)))
            .unwrap()
            .0,
        PropValue::List(vec![0.0, 0.0, 10.0 * 72.0 / 25.4, 72.0])
    );
    assert!(coerce(&t("x"), Some(&schema(TargetType::Unsupported))).is_err());
    // Untyped: written as the expression produced it.
    assert_eq!(coerce(&n(2.0), None).unwrap().0, PropValue::Number(2.0));
}

#[test]
fn missing_and_coerce_policies_decide__feat__data_bind_property() {
    let mut s = schema(TargetType::Length);
    s.default = Some(PropValue::Number(1.0));
    // A missing value under each missing policy.
    assert!(matches!(
        decide(
            &Value::Null,
            Some(&s),
            CoercePolicy::Strict,
            PropertyMissing::KeepLast
        ),
        PropertyOutcome::Keep { .. }
    ));
    assert_eq!(
        decide(
            &Value::Null,
            Some(&s),
            CoercePolicy::Strict,
            PropertyMissing::Default
        ),
        PropertyOutcome::Write {
            value: PropValue::Number(1.0),
            color: None
        }
    );
    // Clear needs a nullable target.
    assert!(matches!(
        decide(
            &Value::Null,
            Some(&s),
            CoercePolicy::Strict,
            PropertyMissing::Clear
        ),
        PropertyOutcome::Fail { .. }
    ));
    s.nullable = true;
    assert_eq!(
        decide(
            &Value::Null,
            Some(&s),
            CoercePolicy::Strict,
            PropertyMissing::Clear
        ),
        PropertyOutcome::Write {
            value: PropValue::Null,
            color: None
        }
    );
    assert!(matches!(
        decide(
            &Value::Null,
            Some(&s),
            CoercePolicy::Strict,
            PropertyMissing::Error
        ),
        PropertyOutcome::Fail { .. }
    ));
    // A mismatch: strict fails, lenient takes the missing policy.
    assert!(matches!(
        decide(
            &t("wide"),
            Some(&s),
            CoercePolicy::Strict,
            PropertyMissing::Default
        ),
        PropertyOutcome::Fail { .. }
    ));
    assert_eq!(
        decide(
            &t("wide"),
            Some(&s),
            CoercePolicy::Lenient,
            PropertyMissing::Default
        ),
        PropertyOutcome::Write {
            value: PropValue::Number(1.0),
            color: None
        }
    );
}

// ── the engine: resolve, sync, data sets ────────────────────────────────────

fn q() -> QueryId {
    QueryId::from("q")
}

fn catalog() -> data_core::RecordSet {
    record_set(
        &[
            ("name", FieldType::Text),
            ("width_mm", FieldType::Float),
            ("tint", FieldType::Text),
            ("align", FieldType::Text),
        ],
        vec![
            vec![t("Alpha"), t("Beta"), t("Gamma")],
            vec![n(10.0), n(20.0), Value::Null],
            vec![t("#ff0000"), t("Paper"), t("cmyk(0,0,0,100)")],
            vec![t("TopAlign"), t("Sideways"), t("CenterAlign")],
        ],
    )
}

fn property(path: &str, expr: &str, value_type: TargetType) -> Binding {
    Binding::Property {
        target: TargetRef::Selector("frame[label.x-paged:media.paged.data*=\"oid-1\"]".into()),
        path: path.into(),
        query: q(),
        expr: expr.into(),
        schema: Some(schema(value_type)),
        coerce: CoercePolicy::Strict,
        missing: PropertyMissing::KeepLast,
    }
}

fn session() -> DataSession {
    let mut s = DataSession::new(today());
    s.define_query(Query {
        id: q(),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    s.ingest_result(q(), catalog());
    for (id, b) in [
        (
            "weight",
            property("frameStrokeWeight", "MM(width_mm)", TargetType::Length),
        ),
        (
            "fill",
            property("frameFillColor", "tint", TargetType::Color),
        ),
        (
            "valign",
            property(
                "textFrameVerticalJustification",
                "align",
                TargetType::Enum {
                    members: vec![
                        "TopAlign".into(),
                        "CenterAlign".into(),
                        "BottomAlign".into(),
                    ],
                },
            ),
        ),
    ] {
        s.define_binding(BindingDef {
            id: BindingId::from(id),
            binding: b,
        });
    }
    s
}

fn writes(s: &mut DataSession, record: usize) -> Vec<(String, PropertyOutcome)> {
    let mut out: Vec<_> = s
        .resolve_properties_at(record, false, None)
        .into_iter()
        .map(|a| (a.binding, a.property.outcome))
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[test]
fn property_bindings_resolve_per_record_with_typed_values__feat__data_bind_property() {
    let mut s = session();
    let r0 = writes(&mut s, 0);
    assert_eq!(r0.len(), 3);
    assert_eq!(r0[0].0, "fill");
    assert!(
        matches!(&r0[0].1, PropertyOutcome::Write { value: PropValue::Text(n), color: Some(_) } if n == "R=255 G=0 B=0")
    );
    assert_eq!(
        r0[1].1,
        PropertyOutcome::Write {
            value: PropValue::Text("TopAlign".into()),
            color: None
        }
    );
    match &r0[2].1 {
        PropertyOutcome::Write {
            value: PropValue::Number(x),
            ..
        } => {
            assert!((x - 10.0 * 72.0 / 25.4).abs() < 1e-9)
        }
        other => panic!("{other:?}"),
    }
    // Record 1: an enum value outside the members fails (strict) and the
    // binding is in Error; the others still write.
    let r1 = writes(&mut s, 1);
    assert!(matches!(&r1[1].1, PropertyOutcome::Fail { message } if message.contains("Sideways")));
    assert_eq!(
        s.sync_state(&BindingId::from("valign")).unwrap().status,
        Status::Error
    );
    assert_eq!(
        s.sync_state(&BindingId::from("fill")).unwrap().status,
        Status::Linked
    );
    // Record 2: a null width keeps the document's value (KeepLast).
    let r2 = writes(&mut s, 2);
    assert!(matches!(r2[2].1, PropertyOutcome::Keep { .. }));
    // Out of range: every binding keeps.
    assert!(writes(&mut s, 9)
        .iter()
        .all(|(_, o)| matches!(o, PropertyOutcome::Keep { .. })));
}

#[test]
fn pinned_property_bindings_are_kept_and_one_binding_narrows__feat__data_bind_property() {
    let mut s = session();
    s.pin(&BindingId::from("fill"));
    let only = s.resolve_properties_at(
        0,
        false,
        Some(&[BindingId::from("fill"), BindingId::from("weight")]),
    );
    assert_eq!(only.len(), 2);
    let fill = only.iter().find(|a| a.binding == "fill").unwrap();
    assert!(
        matches!(&fill.property.outcome, PropertyOutcome::Keep { reason } if reason.contains("pinned"))
    );
}

#[test]
fn the_change_report_sees_a_property_change__feat__data_bind_property() {
    let mut s = session();
    let _ = s.refresh_change_report();
    let mut changed = catalog();
    changed.columns[1][0] = n(11.0);
    s.ingest_result(q(), changed);
    let report = s.refresh_change_report();
    let weight = report
        .entries
        .iter()
        .find(|e| e.binding == "weight")
        .unwrap();
    assert_eq!(weight.kind, "changed");
    let fill = report.entries.iter().find(|e| e.binding == "fill").unwrap();
    assert_eq!(fill.kind, "unchanged");
}

#[test]
fn data_sets_capture_and_apply_any_property__feat__data_bind_property() {
    let mut s = session();
    let set = s.capture_data_set("Red", 0);
    assert!(matches!(
        set.values.get("weight"),
        Some(DataSetValue::Property {
            value: PropValue::Number(_),
            ..
        })
    ));
    assert!(matches!(
        set.values.get("fill"),
        Some(DataSetValue::Property { color: Some(_), .. })
    ));
    let applies = s.apply_data_set("Red").unwrap();
    let fill = applies.iter().find(|a| a.variable == "fill").unwrap();
    assert_eq!(fill.kind, "property");
    let p = fill
        .property
        .as_ref()
        .expect("the property row carries target + path + value");
    assert_eq!(p.path, "frameFillColor");
    assert!(matches!(&p.target, TargetRef::Selector(sel) if sel.contains("oid-1")));
    // Applied bindings stand in front of live data: Overridden (§9.9).
    assert_eq!(
        s.sync_state(&BindingId::from("fill")).unwrap().status,
        Status::Overridden
    );
    // The Illustrator library never carries a paged-only trait (deviation 3).
    let declared = s
        .variables()
        .variables
        .iter()
        .filter(|v| v.var_trait == VarTrait::Property)
        .count();
    assert_eq!(declared, 3);
    assert!(!to_xml(s.variables()).contains("property"));
}

// ── migration (ADR 558 §4 + the additive rule) ─────────────────────────────

const CANARY10: &str = include_str!("fixtures/canary10-payload.json");

#[test]
fn a_canary10_payload_loads_and_round_trips__feat__data_bind_property() {
    let payload: DocumentPayload =
        serde_json::from_str(CANARY10).expect("the canary.10 payload decodes");
    let kinds: Vec<&str> = payload
        .bindings
        .iter()
        .map(|b| b.binding.kind_name())
        .collect();
    assert_eq!(
        kinds,
        [
            "variable",
            "image",
            "visibility",
            "rule",
            "barcode",
            "table"
        ]
    );
    let s = DataSession::from_payload(payload, today());
    // Byte-level: today's engine writes the same JSON back (nothing it did
    // not know is added; the new optional fields stay absent).
    let again = serde_json::to_value(s.payload()).unwrap();
    let was: serde_json::Value = serde_json::from_str(CANARY10).unwrap();
    assert_eq!(again, was);
}

#[test]
fn old_kinds_re_express_as_property_triples_equal_to_their_old_writes__feat__data_bind_property() {
    let payload: DocumentPayload = serde_json::from_str(CANARY10).unwrap();
    let mut s = DataSession::from_payload(payload, today());
    s.ingest_result(
        q(),
        record_set(
            &[
                ("name", FieldType::Text),
                ("photo", FieldType::Text),
                ("in_stock", FieldType::Text),
                ("price", FieldType::Float),
                ("ean", FieldType::Text),
            ],
            vec![
                vec![t("Alpha")],
                vec![t("a.png")],
                vec![t("true")],
                vec![n(12.0)],
                vec![t("4006381333931")],
            ],
        ),
    );
    // Visibility: the old lowering said `visible: false` (invert over a
    // truthy value); the triple writes `elementVisible = false` on the same
    // element — the engine op the old `setElementProperty` wrote.
    let old = match s.resolve_lowered(&BindingId::from("badge")).unwrap() {
        LoweredOutput::Visibility(v) => v,
        other => panic!("{other:?}"),
    };
    assert_eq!(old, lower_visibility("u1b3".into(), Some(false)));
    let triple = s
        .resolve_properties_at(0, true, Some(&[BindingId::from("badge")]))
        .pop()
        .unwrap()
        .property;
    assert_eq!(triple, visibility_as_property(&old));
    assert_eq!(triple.path, "elementVisible");
    assert_eq!(triple.target, TargetRef::Selector("frame:u1b3".into()));
    assert_eq!(
        triple.outcome,
        PropertyOutcome::Write {
            value: PropValue::Bool(false),
            color: None
        }
    );
    let binding = s
        .payload()
        .bindings
        .into_iter()
        .find(|b| b.id.as_str() == "badge")
        .unwrap();
    assert_eq!(
        binding.binding.property_view().unwrap().path,
        "elementVisible"
    );

    // Rule: the style action is the applied-style path the host writes (the
    // TS `ruleMutations` scopes: paragraph / character / cell).
    assert_eq!(
        StyleAction::ParagraphStyle {
            name: "Sale".into()
        }
        .property(),
        ("appliedParagraphStyle", "Sale")
    );
    assert_eq!(
        StyleAction::CharacterStyle { name: "Em".into() }.property(),
        ("appliedCharacterStyle", "Em")
    );
    assert_eq!(
        StyleAction::TableStyle { name: "Hot".into() }.property(),
        ("appliedCellStyle", "Hot")
    );

    // Barcode paint: the triples are the constants the host painted before.
    let paint = barcode_paint();
    assert_eq!(paint[0].path, "frameFillColor");
    assert_eq!(paint[0].value, PropValue::Text("Color/Black".into()));
    assert_eq!(paint[1].path, "frameStrokeColor");
    assert_eq!(paint[1].value, PropValue::Text("Swatch/None".into()));
    let bc = s
        .lower_barcode_sized(&BindingId::from("ean"), 72.0, 72.0)
        .unwrap();
    assert_eq!(bc.paint, paint);
}

#[test]
fn a_property_binding_round_trips_through_the_payload__feat__data_bind_property() {
    let s = session();
    let json = serde_json::to_string(&s.payload()).unwrap();
    assert!(json.contains("\"kind\":\"property\""));
    assert!(json.contains("\"selector\":"));
    let back: DocumentPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(back, s.payload());
    // `host` targets (a binding carried by its element's label, ADR 559).
    let host: Binding = serde_json::from_str(
        r#"{"kind":"property","target":"host","path":"frameOpacity","query":"q","expr":"50"}"#,
    )
    .unwrap();
    assert!(matches!(
        host,
        Binding::Property {
            target: TargetRef::Host,
            coerce: CoercePolicy::Strict,
            missing: PropertyMissing::KeepLast,
            schema: None,
            ..
        }
    ));
}
