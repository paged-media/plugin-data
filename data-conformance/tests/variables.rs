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

//! Variables + data sets conformance (spec §9.8/§9.9) — the Illustrator
//! "Variables / data sets" feature set expressed over the shipped binding model.
//!
//! Covers the four Illustrator variable TRAITS and what each one is here:
//!
//! - `textcontent` — already met by `Binding::Variable` (D-01). Pinned below so
//!   "already met" is a test, not a claim.
//! - `filereference` — already met by `Binding::Image` (D-14). Same.
//! - `visibility` — the new `Binding::Visibility` (§9.8).
//! - `graphdata` — carried through the XML, never resolved (RFI D-15).
//!
//! Plus the data-set lane: capture / capture-per-record / apply / delete, the
//! Illustrator variable-library XML round trip, and the tolerant read of a file
//! whose namespace declarations are Adobe's undefined DTD entity references.

use data_bind::{ResolutionEngine, Resolved};
use data_conformance::{record_set, t, today};
use data_core::{
    Binding, BindingDef, BindingId, FieldType, FrameRef, ImgFit, ImgMissing, ImgPolicy,
    MissingPolicy, PlaceholderRef, Query, QueryId, ResultShape, Status, Value, VisibilityMissing,
    VisibilityOpts,
};
use data_dataset::{
    binding_kind_for, from_xml, to_xml, trait_for_binding_kind, DataSet, DataSetValue, VarTrait,
    VariableDecl, VariableSet,
};
use data_js::core::{DataSession, DocumentPayload};
use data_lower::lower_visibility;

// ── fixtures ────────────────────────────────────────────────────────────────

fn q() -> QueryId {
    QueryId::from("q1")
}

/// A three-record catalog: name, image path, and an `in_stock` flag that is
/// truthy on record 0, falsy on record 1, and NULL on record 2 (so the missing
/// policy has something real to decide).
fn catalog() -> data_core::RecordSet {
    record_set(
        &[
            ("name", FieldType::Text),
            ("photo", FieldType::Text),
            ("in_stock", FieldType::Text),
        ],
        vec![
            vec![t("Alpha"), t("Beta"), t("Gamma")],
            vec![
                t("images/alpha.png"),
                t("images/beta.png"),
                t("images/gamma.png"),
            ],
            vec![t("true"), t("false"), Value::Null],
        ],
    )
}

fn engine() -> ResolutionEngine {
    let mut e = ResolutionEngine::new(today());
    e.add_query(Query {
        id: q(),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    e.set_result(q(), catalog());
    e
}

fn visibility_binding(expr: &str, options: VisibilityOpts) -> Binding {
    Binding::Visibility {
        target: FrameRef::from("frame-badge"),
        query: q(),
        expr: expr.into(),
        options,
    }
}

/// A session with all three bindable variable kinds defined over the catalog.
fn session() -> DataSession {
    let mut s = DataSession::new(today());
    s.define_query(Query {
        id: q(),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    s.ingest_result(q(), catalog());
    s.define_binding(BindingDef {
        id: BindingId::from("Name"),
        binding: Binding::Variable {
            target: PlaceholderRef::from("ph-name"),
            query: q(),
            expr: "name".into(),
            missing: MissingPolicy::Blank,
        },
    });
    s.define_binding(BindingDef {
        id: BindingId::from("Photo"),
        binding: Binding::Image {
            target: PlaceholderRef::from("ph-photo"),
            query: q(),
            expr: "photo".into(),
            policy: ImgPolicy {
                fit: ImgFit::Fit,
                missing: ImgMissing::Skip,
            },
        },
    });
    s.define_binding(BindingDef {
        id: BindingId::from("Badge"),
        binding: visibility_binding("in_stock", VisibilityOpts::default()),
    });
    s
}

// ── §9.8 — the VISIBILITY variable (the one kind that was NOT met) ──────────

#[test]
fn data_bind_visibility_truthiness_decides_shown_or_hidden() {
    let mut e = engine();
    let id = BindingId::from("vis");
    e.add_binding(
        id.clone(),
        visibility_binding("in_stock", Default::default()),
    );

    let Resolved::Visibility(r0) = e.resolve_at(&id, 0).unwrap() else {
        panic!("expected a visibility resolution");
    };
    assert_eq!(r0.visible, Some(true), "'true' shows the element");
    assert_eq!(r0.target, FrameRef::from("frame-badge"));

    let Resolved::Visibility(r1) = e.resolve_at(&id, 1).unwrap() else {
        panic!("expected a visibility resolution");
    };
    assert_eq!(r1.visible, Some(false), "'false' hides the element");
}

#[test]
fn data_bind_visibility_invert_flips_the_data_decision() {
    let mut e = engine();
    let id = BindingId::from("vis");
    e.add_binding(
        id.clone(),
        visibility_binding(
            "in_stock",
            VisibilityOpts {
                invert: true,
                missing: VisibilityMissing::Hide,
            },
        ),
    );
    let Resolved::Visibility(r) = e.resolve_at(&id, 0).unwrap() else {
        panic!("expected a visibility resolution");
    };
    assert_eq!(
        r.visible,
        Some(false),
        "invert flips a truthy value to hidden"
    );
}

#[test]
fn data_bind_visibility_missing_policy_leave_writes_nothing() {
    let mut e = engine();

    // Record 2 is NULL. Hide (the default) hides it...
    let hide = BindingId::from("vis-hide");
    e.add_binding(
        hide.clone(),
        visibility_binding("in_stock", Default::default()),
    );
    let Resolved::Visibility(r) = e.resolve_at(&hide, 2).unwrap() else {
        panic!("expected a visibility resolution");
    };
    assert_eq!(r.visible, Some(false));

    // ...Show shows it...
    let show = BindingId::from("vis-show");
    e.add_binding(
        show.clone(),
        visibility_binding(
            "in_stock",
            VisibilityOpts {
                invert: false,
                missing: VisibilityMissing::Show,
            },
        ),
    );
    let Resolved::Visibility(r) = e.resolve_at(&show, 2).unwrap() else {
        panic!("expected a visibility resolution");
    };
    assert_eq!(r.visible, Some(true));

    // ...and Leave produces NO decision at all — the non-destructive arm. An
    // unresolvable binding must never be able to blank a designer's artwork.
    let leave = BindingId::from("vis-leave");
    e.add_binding(
        leave.clone(),
        visibility_binding(
            "in_stock",
            VisibilityOpts {
                invert: false,
                missing: VisibilityMissing::Leave,
            },
        ),
    );
    let Resolved::Visibility(r) = e.resolve_at(&leave, 2).unwrap() else {
        panic!("expected a visibility resolution");
    };
    assert_eq!(r.visible, None, "Leave means: write nothing");
}

#[test]
fn data_bind_visibility_uncoercible_value_takes_the_missing_policy() {
    let mut e = ResolutionEngine::new(today());
    e.add_query(Query {
        id: q(),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::SingleRecord,
    });
    e.set_result(
        q(),
        record_set(&[("flag", FieldType::Text)], vec![vec![t("maybe")]]),
    );
    let id = BindingId::from("vis");
    e.add_binding(
        id.clone(),
        Binding::Visibility {
            target: FrameRef::from("f"),
            query: q(),
            expr: "flag".into(),
            options: VisibilityOpts {
                invert: false,
                missing: VisibilityMissing::Leave,
            },
        },
    );
    let Resolved::Visibility(r) = e.resolve_at(&id, 0).unwrap() else {
        panic!("expected a visibility resolution");
    };
    assert_eq!(
        r.visible, None,
        "a value that is present but not a boolean is not guessed at"
    );
}

#[test]
fn data_lower_visibility_is_a_pure_pass_through() {
    let l = lower_visibility(FrameRef::from("f1"), Some(false));
    assert_eq!(l.target, FrameRef::from("f1"));
    assert_eq!(l.visible, Some(false));
    assert_eq!(lower_visibility(FrameRef::from("f1"), None).visible, None);
}

// ── §9.9 — the trait ↔ binding projection ───────────────────────────────────

#[test]
fn data_dataset_trait_map_covers_the_three_bindable_illustrator_traits() {
    // textcontent + filereference were ALREADY MET by shipped bindings; the
    // projection is what makes them visible as variables.
    assert_eq!(binding_kind_for(VarTrait::TextContent), Some("variable"));
    assert_eq!(binding_kind_for(VarTrait::FileReference), Some("image"));
    assert_eq!(binding_kind_for(VarTrait::Visibility), Some("visibility"));
    // graphdata has no binding — carried, never resolved (RFI D-15).
    assert_eq!(binding_kind_for(VarTrait::GraphData), None);
    assert!(!VarTrait::GraphData.is_bindable());

    assert_eq!(
        trait_for_binding_kind("variable"),
        Some(VarTrait::TextContent)
    );
    assert_eq!(
        trait_for_binding_kind("image"),
        Some(VarTrait::FileReference)
    );
    assert_eq!(
        trait_for_binding_kind("visibility"),
        Some(VarTrait::Visibility)
    );
    // The paged.data-only kinds are deliberately NOT variables — a palette row
    // you cannot capture is worse than an absent one.
    for kind in ["table", "recordFlow", "rule", "barcode"] {
        assert_eq!(
            trait_for_binding_kind(kind),
            None,
            "{kind} is not a variable"
        );
    }
}

#[test]
fn data_dataset_declarations_derive_from_the_bindings() {
    let mut s = session();
    let vars = s.variables();
    let mut names: Vec<&str> = vars.variables.iter().map(|v| v.name.as_str()).collect();
    names.sort();
    assert_eq!(names, ["Badge", "Name", "Photo"]);
    assert_eq!(
        vars.declaration("Badge").map(|d| d.var_trait),
        Some(VarTrait::Visibility)
    );
    assert_eq!(
        vars.declaration("Photo").map(|d| d.var_trait),
        Some(VarTrait::FileReference)
    );
}

// ── §9.9 — capture ──────────────────────────────────────────────────────────

#[test]
fn data_dataset_capture_snapshots_all_three_kinds_at_a_record() {
    let mut s = session();
    let set = s.capture_data_set("Data Set 1", 0);
    assert_eq!(set.name, "Data Set 1");
    assert_eq!(
        set.values.get("Name"),
        Some(&DataSetValue::Text {
            text: "Alpha".into()
        })
    );
    assert_eq!(
        set.values.get("Photo"),
        Some(&DataSetValue::FileRef {
            href: "images/alpha.png".into()
        })
    );
    assert_eq!(
        set.values.get("Badge"),
        Some(&DataSetValue::Visible { visible: true })
    );

    // A second capture at another record is a DIFFERENT set, not an overwrite.
    let set2 = s.capture_data_set("Data Set 2", 1);
    assert_eq!(
        set2.values.get("Badge"),
        Some(&DataSetValue::Visible { visible: false })
    );
    assert_eq!(s.list_data_sets(), vec!["Data Set 1", "Data Set 2"]);

    // Capturing over an existing name REPLACES it (Illustrator's behavior) and
    // does not reorder the palette.
    s.capture_data_set("Data Set 1", 1);
    assert_eq!(s.list_data_sets(), vec!["Data Set 1", "Data Set 2"]);
    assert_eq!(
        s.variables()
            .data_set("Data Set 1")
            .unwrap()
            .values
            .get("Name"),
        Some(&DataSetValue::Text {
            text: "Beta".into()
        })
    );
}

#[test]
fn data_dataset_capture_every_record_builds_the_whole_palette() {
    let mut s = session();
    let names = s.capture_every_record(&q(), "Data Set", Some("name"));
    assert_eq!(names, vec!["Alpha", "Beta", "Gamma"]);
    assert_eq!(s.list_data_sets().len(), 3);

    // Without a naming column, the Illustrator "Data Set N" convention (1-based).
    let mut s2 = session();
    let names2 = s2.capture_every_record(&q(), "Data Set", None);
    assert_eq!(names2, vec!["Data Set 1", "Data Set 2", "Data Set 3"]);
}

#[test]
fn data_dataset_capture_skips_the_leave_policy_rather_than_inventing_a_value() {
    let mut s = DataSession::new(today());
    s.define_query(Query {
        id: q(),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    s.ingest_result(q(), catalog());
    s.define_binding(BindingDef {
        id: BindingId::from("Badge"),
        binding: visibility_binding(
            "in_stock",
            VisibilityOpts {
                invert: false,
                missing: VisibilityMissing::Leave,
            },
        ),
    });
    // Record 2 is NULL + Leave ⇒ no decision ⇒ nothing captured. A data set must
    // never claim a value the engine did not produce.
    let set = s.capture_data_set("nulls", 2);
    assert!(set.values.is_empty(), "captured {:?}", set.values);
}

// ── §9.9 — apply ────────────────────────────────────────────────────────────

#[test]
fn data_dataset_apply_plans_one_typed_write_per_variable() {
    let mut s = session();
    s.capture_data_set("Alpha", 0);
    s.capture_data_set("Beta", 1);

    let applies = s.apply_data_set("Beta").expect("data set exists");
    assert_eq!(applies.len(), 3);
    assert!(applies.iter().all(|a| a.applicable));

    let name = applies.iter().find(|a| a.variable == "Name").unwrap();
    assert_eq!(name.kind, "text");
    assert_eq!(name.text.as_deref(), Some("Beta"));

    let photo = applies.iter().find(|a| a.variable == "Photo").unwrap();
    assert_eq!(photo.kind, "image");
    assert_eq!(photo.href.as_deref(), Some("images/beta.png"));

    let badge = applies.iter().find(|a| a.variable == "Badge").unwrap();
    assert_eq!(badge.kind, "visibility");
    assert_eq!(badge.visible, Some(false));
}

#[test]
fn data_dataset_apply_marks_the_applied_bindings_overridden() {
    let mut s = session();
    s.capture_data_set("Alpha", 0);
    // Baseline: resolving links a binding.
    let _ = s.resolve_lowered(&BindingId::from("Name")).unwrap();
    assert_eq!(
        s.sync_state(&BindingId::from("Name")).map(|st| st.status),
        Some(Status::Linked)
    );

    s.apply_data_set("Alpha").unwrap();
    // An applied data set is a captured value standing in front of the live
    // resolution — the shipped Overridden state, so the next refresh cannot
    // clobber it and `relink` puts it back on live data.
    assert_eq!(
        s.sync_state(&BindingId::from("Name")).map(|st| st.status),
        Some(Status::Overridden)
    );
    // `relink` returns it to the live lane as STALE (reconnected, not yet
    // re-resolved) — the shipped meaning; only a resolve makes it Linked again.
    s.relink(&BindingId::from("Name"));
    assert_eq!(
        s.sync_state(&BindingId::from("Name")).map(|st| st.status),
        Some(Status::Stale)
    );
    let _ = s.resolve_lowered(&BindingId::from("Name")).unwrap();
    assert_eq!(
        s.sync_state(&BindingId::from("Name")).map(|st| st.status),
        Some(Status::Linked)
    );
}

#[test]
fn data_dataset_apply_protects_a_never_resolved_binding_too() {
    // REGRESSION. `mark_overridden` used to mutate only an EXISTING sync entry,
    // so applying a data set to a freshly-defined binding — one nothing had
    // resolved yet — protected nothing: the next refresh would clobber the
    // applied values and the sync report would never have mentioned it. Found
    // by the real-wasm e2e (Part E), fixed in `data-bind`.
    // The real shape of it: a library brings the VALUES in, so nothing in this
    // session ever resolved the binding — yet applying the set writes to the
    // document all the same.
    let mut s = session();
    let mut vs = VariableSet::new("binding1");
    vs.upsert_variable(VariableDecl {
        name: "Name".into(),
        var_trait: VarTrait::TextContent,
    });
    let mut ds = DataSet {
        name: "FromLibrary".into(),
        values: Default::default(),
    };
    ds.values.insert(
        "Name".into(),
        DataSetValue::Text {
            text: "from the library".into(),
        },
    );
    vs.upsert_data_set(ds);
    s.import_variable_library(&to_xml(&vs)).unwrap();
    assert_eq!(
        s.sync_state(&BindingId::from("Name")).map(|st| st.status),
        Some(Status::Linked),
        "precondition: the binding is defined but has never been RESOLVED"
    );

    s.apply_data_set("FromLibrary").unwrap();
    assert_eq!(
        s.sync_state(&BindingId::from("Name")).map(|st| st.status),
        Some(Status::Overridden),
        "the applied value must be protected from the next refresh"
    );
}

#[test]
fn data_bind_sync_state_survives_the_wasm_boundary() {
    // REGRESSION (found by the real-wasm e2e, Part E). `ResolveStamp`'s two
    // 64-bit fingerprints used to serialize as JS NUMBERS, which the wasm
    // serializer rejects above Number.MAX_SAFE_INTEGER — and `data-js`'s
    // `sync_state` shim swallowed the error as `null`. Net effect: the bundle
    // saw NO sync state for any binding that had ever resolved, so the panel
    // could not distinguish Linked from Overridden from Stale. Neither the Rust
    // tests nor the TS fakes caught it, because both bypass the boundary.
    //
    // This pins the JSON shape that made it representable.
    let mut s = session();
    let _ = s.resolve_lowered(&BindingId::from("Name")).unwrap();
    let st = s.sync_state(&BindingId::from("Name")).unwrap();
    let json = serde_json::to_string(&st).unwrap();
    assert!(
        json.contains("\"sourceQueryHash\":\"") || json.contains("\"source_query_hash\":\""),
        "the fingerprints must serialize as STRINGS, got {json}"
    );
    // ...and still round-trip.
    let back: data_core::SyncState = serde_json::from_str(&json).unwrap();
    assert_eq!(back, st);
    // A hand-written fixture using a small NUMBER still loads (tolerant read).
    let from_number: data_core::ResolveStamp =
        serde_json::from_str(r#"{"source_query_hash":7,"param_hash":0}"#).unwrap();
    assert_eq!(from_number.source_query_hash, 7);
}

#[test]
fn data_dataset_apply_reports_unapplicable_rows_instead_of_faking_them() {
    let mut s = session();
    s.capture_data_set("Alpha", 0);

    // Hand-add a graphdata variable + a bindable one with no binding, exactly as
    // an imported Illustrator library would.
    let xml = to_xml(&{
        let mut vs = s.variables().clone();
        vs.upsert_variable(VariableDecl {
            name: "Sales".into(),
            var_trait: VarTrait::GraphData,
        });
        vs.upsert_variable(VariableDecl {
            name: "Orphan".into(),
            var_trait: VarTrait::TextContent,
        });
        let mut ds = vs.data_set("Alpha").cloned().unwrap();
        ds.values.insert(
            "Sales".into(),
            DataSetValue::GraphData {
                raw: "10,20,30".into(),
            },
        );
        ds.values.insert(
            "Orphan".into(),
            DataSetValue::Text {
                text: "nothing bound".into(),
            },
        );
        vs.upsert_data_set(ds);
        vs
    });
    let report = s.import_variable_library(&xml).unwrap();
    assert_eq!(report.graph_only, vec!["Sales"]);
    assert_eq!(report.unbound, vec!["Orphan"]);

    let applies = s.apply_data_set("Alpha").unwrap();
    let sales = applies.iter().find(|a| a.variable == "Sales").unwrap();
    assert!(!sales.applicable);
    assert!(sales.note.as_deref().unwrap().contains("D-15"));
    let orphan = applies.iter().find(|a| a.variable == "Orphan").unwrap();
    assert!(!orphan.applicable);
    assert!(orphan.note.as_deref().unwrap().contains("no binding"));
    // The three real ones still apply.
    assert_eq!(applies.iter().filter(|a| a.applicable).count(), 3);
}

#[test]
fn data_dataset_apply_rejects_an_unknown_name() {
    let mut s = session();
    assert!(s.apply_data_set("nope").is_err());
}

#[test]
fn data_dataset_delete_removes_one_set() {
    let mut s = session();
    s.capture_data_set("A", 0);
    s.capture_data_set("B", 1);
    assert!(s.delete_data_set("A"));
    assert!(!s.delete_data_set("A"), "deleting twice is honest about it");
    assert_eq!(s.list_data_sets(), vec!["B"]);
}

// ── §9.9 — the variable-library XML ─────────────────────────────────────────

#[test]
fn data_dataset_xml_round_trips_all_four_traits() {
    let mut vs = VariableSet::new("binding1");
    for (name, var_trait) in [
        ("Name", VarTrait::TextContent),
        ("Photo", VarTrait::FileReference),
        ("Badge", VarTrait::Visibility),
        ("Sales", VarTrait::GraphData),
    ] {
        vs.upsert_variable(VariableDecl {
            name: name.into(),
            var_trait,
        });
    }
    let mut ds = DataSet {
        name: "Data Set 1".into(),
        values: Default::default(),
    };
    ds.values.insert(
        "Name".into(),
        DataSetValue::Text {
            text: "Alpha\nsecond line".into(),
        },
    );
    ds.values.insert(
        "Photo".into(),
        DataSetValue::FileRef {
            href: "images/alpha.png".into(),
        },
    );
    ds.values
        .insert("Badge".into(), DataSetValue::Visible { visible: true });
    ds.values.insert(
        "Sales".into(),
        DataSetValue::GraphData {
            raw: "10,20,30".into(),
        },
    );
    vs.upsert_data_set(ds);

    let xml = to_xml(&vs);
    let back = from_xml(&xml).expect("round trip");
    assert_eq!(back, vs);

    // Deterministic: the same model always serializes to the same bytes.
    assert_eq!(to_xml(&back), xml);
    // And the export declares no undefined DTD entities (deviation 1).
    assert!(!xml.contains("&ns_"), "export must be well-formed XML");
    assert!(xml.contains("http://ns.adobe.com/Variables/1.0/"));
}

#[test]
fn data_dataset_xml_reads_the_illustrator_entity_reference_form() {
    // Exactly the shape Illustrator writes: an <svg> root whose namespace
    // declarations are UNDEFINED DTD entity references, the sample data sets
    // under a `v:` prefix, values wrapped in <p>. A prefix-sensitive or
    // entity-resolving reader reads this as empty (or errors); ours does not.
    let src = r#"<?xml version="1.0" encoding="utf-8"?>
<svg xmlns:i="&ns_ai;" xmlns:x="&ns_extend;" xmlns:graph="&ns_graphs;" xmlns:v="&ns_vars;">
<variableSets xmlns="&ns_vars;">
	<variableSet varSetName="binding1" locked="none">
		<variables>
			<variable varName="Name" trait="textcontent" category="&ns_flows;"></variable>
			<variable varName="Photo" trait="filereference" category="&ns_flows;"></variable>
			<variable varName="Badge" trait="visibility" category="&ns_flows;"></variable>
		</variables>
		<v:sampleDataSets xmlns="&ns_custom;" xmlns:v="&ns_vars;">
			<v:sampleDataSet dataSetName="Data Set 1">
				<Name>
					<p>Alpha</p>
				</Name>
				<Photo>
					<p>images/alpha.png</p>
				</Photo>
				<Badge>
					<p>true</p>
				</Badge>
			</v:sampleDataSet>
			<v:sampleDataSet dataSetName="Data Set 2">
				<Name>
					<p>Beta</p>
				</Name>
				<Photo>
					<p>images/beta.png</p>
				</Photo>
				<Badge>
					<p>false</p>
				</Badge>
			</v:sampleDataSet>
		</v:sampleDataSets>
	</variableSet>
</variableSets>
</svg>
"#;
    let vs = from_xml(src).expect("the Illustrator entity form must read");
    assert_eq!(vs.name, "binding1");
    assert_eq!(vs.variables.len(), 3);
    assert_eq!(vs.data_sets.len(), 2);
    assert_eq!(
        vs.data_set("Data Set 2").unwrap().values.get("Badge"),
        Some(&DataSetValue::Visible { visible: false })
    );
    assert_eq!(
        vs.data_set("Data Set 1").unwrap().values.get("Photo"),
        Some(&DataSetValue::FileRef {
            href: "images/alpha.png".into()
        })
    );
    assert!(vs.inconsistencies().is_empty());
}

#[test]
fn data_dataset_xml_rejects_what_it_cannot_honestly_import() {
    // An unknown trait is a hard error — importing it as the wrong kind would
    // apply a text string to a visibility target.
    let bad_trait = r#"<variableSets><variableSet varSetName="s"><variables>
        <variable varName="X" trait="futuretrait"/></variables></variableSet></variableSets>"#;
    assert!(matches!(
        from_xml(bad_trait),
        Err(data_dataset::XmlError::UnknownTrait(_))
    ));

    // A value for a variable nobody declared cannot be typed, so it is refused
    // rather than guessed.
    let undeclared = r#"<variableSets><variableSet varSetName="s"><variables>
        <variable varName="X" trait="textcontent"/></variables>
        <sampleDataSets><sampleDataSet dataSetName="d">
        <Y><p>hi</p></Y></sampleDataSet></sampleDataSets></variableSet></variableSets>"#;
    assert!(matches!(
        from_xml(undeclared),
        Err(data_dataset::XmlError::UndeclaredVariable { .. })
    ));

    // A visibility value that is neither true nor false is refused, not read as
    // "hidden".
    let bad_vis = r#"<variableSets><variableSet varSetName="s"><variables>
        <variable varName="X" trait="visibility"/></variables>
        <sampleDataSets><sampleDataSet dataSetName="d">
        <X><p>sometimes</p></X></sampleDataSet></sampleDataSets></variableSet></variableSets>"#;
    assert!(matches!(
        from_xml(bad_vis),
        Err(data_dataset::XmlError::BadVisibility(_))
    ));

    // Not a variable library at all.
    assert!(matches!(
        from_xml("<svg><g/></svg>"),
        Err(data_dataset::XmlError::NoVariableSet)
    ));
}

#[test]
fn data_dataset_xml_preserves_graph_data_across_a_full_import_export() {
    // The honest half of "graph data is not implemented": an imported library
    // keeps its graph variables so a re-export does not silently lose the
    // author's work.
    let mut s = session();
    let mut vs = VariableSet::new("binding1");
    vs.upsert_variable(VariableDecl {
        name: "Sales".into(),
        var_trait: VarTrait::GraphData,
    });
    let mut ds = DataSet {
        name: "Q1".into(),
        values: Default::default(),
    };
    ds.values.insert(
        "Sales".into(),
        DataSetValue::GraphData {
            raw: "10,20,30".into(),
        },
    );
    vs.upsert_data_set(ds);

    s.import_variable_library(&to_xml(&vs)).unwrap();
    let exported = s.export_variable_library();
    let back = from_xml(&exported).unwrap();
    assert_eq!(
        back.data_set("Q1").unwrap().values.get("Sales"),
        Some(&DataSetValue::GraphData {
            raw: "10,20,30".into()
        })
    );
}

// ── §9.9 — document-payload persistence + the D-08 budget ───────────────────

#[test]
fn data_dataset_payload_round_trips_through_the_document() {
    let mut s = session();
    s.capture_every_record(&q(), "Data Set", Some("name"));
    let payload = s.payload();
    let json = serde_json::to_string(&payload).unwrap();

    let decoded: DocumentPayload = serde_json::from_str(&json).unwrap();
    let mut restored = DataSession::from_payload(decoded, today());
    assert_eq!(restored.list_data_sets(), vec!["Alpha", "Beta", "Gamma"]);
    assert_eq!(restored.variables().variables.len(), 3);
    assert_eq!(
        restored
            .variables()
            .data_set("Beta")
            .unwrap()
            .values
            .get("Name"),
        Some(&DataSetValue::Text {
            text: "Beta".into()
        })
    );
}

#[test]
fn data_dataset_payload_predates_the_amendment_and_still_loads() {
    // A payload written before variables existed has no `variables` key at all.
    // Additive rule: it must still load, with an empty variable set.
    let old = r#"{"sources":[],"queries":[],"templates":[],"bindings":[]}"#;
    let decoded: DocumentPayload = serde_json::from_str(old).unwrap();
    assert!(decoded.variables.variables.is_empty());
    assert!(decoded.variables.data_sets.is_empty());
    let mut s = DataSession::from_payload(decoded, today());
    assert_eq!(s.list_data_sets().len(), 0);
    assert_eq!(s.variables().variables.len(), 0);
}

#[test]
fn data_dataset_payload_budget_is_measured_not_guessed() {
    // D-08: the host caps ONE `setPluginMetadata` value at 64 KiB. Captured data
    // sets are the only payload half that grows with the RECORD COUNT, so this
    // measures the real serialized size and states the ceiling in records
    // instead of hoping. 3 records here; the arithmetic is what matters.
    const CAP: usize = 64 * 1024;
    let mut s = session();
    let empty = s.data_set_payload_bytes();
    s.capture_every_record(&q(), "Data Set", Some("name"));
    let three = s.data_set_payload_bytes();
    assert!(three > empty);
    assert!(three < CAP, "three data sets must be nowhere near the cap");

    let per_set = (three - empty) / 3;
    assert!(per_set > 0);
    // The honest headline: with THIS variable shape, roughly this many data sets
    // fit in one payload. The panel must warn before a bulk capture crosses it.
    let head_room = (CAP - empty) / per_set;
    assert!(
        head_room > 100,
        "a 3-variable catalog should fit hundreds of data sets, got {head_room}"
    );
}
