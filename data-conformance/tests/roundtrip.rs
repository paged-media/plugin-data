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
