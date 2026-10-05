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

//! Round-trip conformance (spec §12.4): the binding recipe (source defs +
//! queries + binding defs) survives save → load losslessly, and credentials are
//! absent from the saved form (§11).

use data_core::{
    Binding, BindingDef, BindingId, CapabilityRef, ColumnBind, DataSource, DbEngine, FrameRef,
    MissingPolicy, PlaceholderRef, Query, QueryId, RefreshPolicy, ResultShape, SourceId,
    SourceKind, TableOpts,
};
use data_js::core::{DataSession, DocumentPayload};

fn build() -> DataSession {
    let mut s = DataSession::new(0);
    s.define_source(DataSource {
        id: SourceId::from("seed"),
        kind: SourceKind::InlineSeed {
            table: "pricing".into(),
        },
        capability: CapabilityRef::from("inline"),
        refresh: RefreshPolicy::Manual,
    });
    s.define_source(DataSource {
        id: SourceId::from("db"),
        kind: SourceKind::DbAttach {
            db: DbEngine::Postgres,
            target: "warehouse:5432/db".into(),
            credential_ref: Some("keychain:warehouse".into()),
            dsn: None,
        },
        capability: CapabilityRef::from("net"),
        refresh: RefreshPolicy::Manual,
    });
    s.define_query(Query {
        id: QueryId::from("q1"),
        sql: "SELECT sku, price FROM pricing".into(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    s.define_binding(BindingDef {
        id: BindingId::from("v1"),
        binding: Binding::Variable {
            target: PlaceholderRef::from("ph1"),
            query: QueryId::from("q1"),
            expr: "UPPER(sku)".into(),
            missing: MissingPolicy::Blank,
        },
    });
    s.define_binding(BindingDef {
        id: BindingId::from("t1"),
        binding: Binding::Table {
            region: FrameRef::from("r1"),
            query: QueryId::from("q1"),
            columns: vec![ColumnBind {
                header: "Price".into(),
                expr: "CURRENCY(price)".into(),
                style: None,
            }],
            options: TableOpts::default(),
        },
    });
    s
}

#[test]
fn data_plugin_payload_roundtrip() {
    let session = build();
    let payload = session.payload();

    // Serialize → deserialize → rebuild → re-serialize: lossless.
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: DocumentPayload = serde_json::from_str(&json).unwrap();
    let rebuilt = DataSession::from_payload(decoded, 0).payload();
    assert_eq!(payload, rebuilt);

    // The recipe survived in full.
    assert_eq!(rebuilt.sources.len(), 2);
    assert_eq!(rebuilt.queries.len(), 1);
    assert_eq!(rebuilt.bindings.len(), 2);

    // Credentials are absent from the saved form (§11 hard gate): the
    // credentialRef string survives (a ref, not a secret); the non-secret
    // host stays identifiable.
    assert!(
        json.contains("keychain:warehouse"),
        "credentialRef must survive"
    );
    assert!(json.contains("warehouse"), "non-secret host stays: {json}");
    assert!(!json.contains("hunter2"), "credential leaked: {json}");
    assert!(!json.contains("password"), "credential leaked: {json}");
}

/// `load_payload` (the bundle's restore path, `paged.data/session` part):
/// replacing a live session's recipe in place yields the same recipe as
/// `from_payload`, keeps the session's locale, and drops what the old recipe
/// defined (no duplicated sources or bindings when a restore runs over a
/// session that already has state).
#[test]
#[allow(non_snake_case)] // `__feat__<id>`: the cockpit test-to-feature join
fn data_plugin_load_payload_in_place__feat__data_plugin_persistence() {
    let saved = build().payload();

    let mut live = DataSession::new(0);
    live.set_locale(data_core::Locale::DE);
    live.define_query(Query {
        id: QueryId::from("stale"),
        sql: "SELECT 1".into(),
        params: vec![],
        shape: ResultShape::Scalar,
    });
    live.load_payload(saved.clone());

    assert_eq!(
        live.payload(),
        saved,
        "load_payload restores the recipe exactly"
    );
    assert_eq!(
        live.payload().queries.len(),
        1,
        "the old recipe is replaced, not merged"
    );

    // The locale survived the load: CURRENCY formats the German way.
    let mut probe = DataSession::new(0);
    probe.set_locale(data_core::Locale::DE);
    live.ingest_result(QueryId::from("q1"), price_rows());
    probe.load_payload(saved);
    probe.ingest_result(QueryId::from("q1"), price_rows());
    let a = serde_json::to_string(&live.resolve_lowered(&BindingId::from("t1")).unwrap()).unwrap();
    let b = serde_json::to_string(&probe.resolve_lowered(&BindingId::from("t1")).unwrap()).unwrap();
    assert_eq!(a, b);
    assert!(a.contains("€"), "the de locale survived load_payload: {a}");
}

fn price_rows() -> data_core::RecordSet {
    use data_core::{Field, FieldType, RecordSet, Schema, Value};
    RecordSet {
        schema: Schema {
            fields: vec![
                Field {
                    name: "sku".into(),
                    ty: FieldType::Text,
                    nullable: true,
                    scale: None,
                },
                Field {
                    name: "price".into(),
                    ty: FieldType::Float,
                    nullable: true,
                    scale: None,
                },
            ],
        },
        columns: vec![vec![Value::Text("A-1".into())], vec![Value::Number(9.99)]],
        row_count: 1,
    }
}

/// Re-defining a source, query, template or binding under an existing id
/// replaces it in the saved recipe. The panels re-define their query on every
/// action, so an appending recipe grew with each click and every save.
#[test]
#[allow(non_snake_case)] // `__feat__<id>`: the cockpit test-to-feature join
fn data_plugin_redefine_replaces_in_the_payload__feat__data_plugin_persistence() {
    let mut s = build();
    let before = s.payload();
    s.define_query(Query {
        id: QueryId::from("q1"),
        sql: "SELECT sku FROM pricing".into(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    s.define_source(before.sources[0].clone());
    s.define_binding(before.bindings[0].clone());
    let after = s.payload();
    assert_eq!(after.queries.len(), 1);
    assert_eq!(
        after.queries[0].sql, "SELECT sku FROM pricing",
        "the newer definition wins"
    );
    assert_eq!(after.sources.len(), before.sources.len());
    assert_eq!(after.bindings.len(), before.bindings.len());
    assert_eq!(
        after
            .bindings
            .iter()
            .map(|b| b.id.to_string())
            .collect::<Vec<_>>(),
        before
            .bindings
            .iter()
            .map(|b| b.id.to_string())
            .collect::<Vec<_>>(),
        "a replaced definition keeps its place"
    );
}
