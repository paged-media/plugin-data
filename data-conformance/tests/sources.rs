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

//! Source-adapter conformance (spec §6.2): inline + file (M0), the remote
//! adapter (M1 — transport-agnostic, consent-gated, content-addressed), and
//! the §11 data-source manifest.

use std::collections::BTreeSet;

use data_core::{
    CapabilityRef, DataSource, DbEngine, FileFormat, RefreshPolicy, SourceId, SourceKind,
};
use data_sources::{
    adapter_for, attach_plan, authorize, build_manifest, remote_invalidation_key, validate_remote,
    AttachError, GrantedCapabilities, RemoteError, RequiredCapability,
};

fn src(id: &str, kind: SourceKind) -> DataSource {
    DataSource {
        id: SourceId::from(id),
        kind,
        capability: CapabilityRef::from("cap"),
        refresh: RefreshPolicy::Manual,
    }
}

#[test]
fn data_source_inline_needs_no_capability() {
    let s = src(
        "seed",
        SourceKind::InlineSeed {
            table: "pricing".into(),
        },
    );
    assert_eq!(adapter_for(&s.kind).kind_name(), "inline");
    assert_eq!(
        adapter_for(&s.kind).required_capability(&s),
        RequiredCapability::None
    );
    // Authorized even with nothing granted.
    assert!(authorize(&s, &GrantedCapabilities::default()).is_ok());
}

#[test]
fn data_source_file_requires_file_import() {
    let s = src(
        "csv",
        SourceKind::File {
            format: FileFormat::Csv,
            name: "products.csv".into(),
        },
    );
    assert_eq!(adapter_for(&s.kind).kind_name(), "file");
    assert_eq!(
        adapter_for(&s.kind).required_capability(&s),
        RequiredCapability::FileImport
    );
    assert!(authorize(&s, &GrantedCapabilities::m0_default()).is_ok());
    assert!(authorize(&s, &GrantedCapabilities::default()).is_err());
}

#[test]
fn data_source_manifest_lists_every_target() {
    let sources = vec![
        src("seed", SourceKind::InlineSeed { table: "t".into() }),
        src(
            "csv",
            SourceKind::File {
                format: FileFormat::Csv,
                name: "p.csv".into(),
            },
        ),
    ];
    let m = build_manifest(&sources);
    assert_eq!(m.entries.len(), 2);
    assert_eq!(m.entries[1].kind, "file");
    assert_eq!(m.entries[1].target, "p.csv");
}

fn remote_kind(url: &str, params: &[(&str, &str)]) -> SourceKind {
    SourceKind::Remote {
        url: url.into(),
        format: Some(FileFormat::Csv),
        params: params
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        credential_ref: None,
    }
}

#[test]
fn data_source_remote_requires_per_origin_consent() {
    let s = src("api", remote_kind("https://api.test/feed.csv", &[]));
    assert_eq!(adapter_for(&s.kind).kind_name(), "remote");
    assert_eq!(
        adapter_for(&s.kind).required_capability(&s),
        RequiredCapability::Network {
            origin: Some("https://api.test".into())
        }
    );
    // Inert at the M0 default grant AND under network-without-consent; live
    // only once its origin is consented (§11/D-03).
    assert!(authorize(&s, &GrantedCapabilities::m0_default()).is_err());
    let mut granted = GrantedCapabilities {
        file_import: true,
        network: true,
        consented_origins: BTreeSet::new(),
    };
    assert!(authorize(&s, &granted).is_err());
    granted.consented_origins.insert("https://api.test".into());
    assert!(authorize(&s, &granted).is_ok());
    // The §11 manifest shows the ORIGIN the document will touch.
    let m = build_manifest(std::slice::from_ref(&s));
    assert_eq!(m.entries[0].target, "https://api.test");
}

#[test]
fn data_source_remote_descriptor_validates() {
    // Transport-agnostic descriptor validation: http(s) only, host required,
    // and NO embedded credentials (credential_ref strings instead, D-11).
    assert!(validate_remote(&remote_kind("https://api.test/d.csv", &[])).is_ok());
    assert_eq!(
        validate_remote(&remote_kind("ftp://api.test/d.csv", &[])),
        Err(RemoteError::UnsupportedScheme("ftp://".into()))
    );
    assert_eq!(
        validate_remote(&remote_kind("https://u:p@api.test/d.csv", &[])),
        Err(RemoteError::EmbeddedCredentials)
    );
    assert_eq!(
        validate_remote(&SourceKind::InlineSeed { table: "t".into() }),
        Err(RemoteError::NotRemote)
    );
}

#[test]
fn data_source_remote_invalidation_key_is_content_addressed() {
    // The invalidation key is deterministic over descriptor + SUPPLIED bytes
    // (the adapter never fetches — the bundle hands the bytes in, the same
    // seam the file adapter uses).
    let k = remote_kind("https://api.test/d.csv", &[("region", "eu")]);
    let bytes = b"sku,price\nA,1\n";
    let a = remote_invalidation_key(&k, bytes).unwrap();
    assert_eq!(a, remote_invalidation_key(&k, bytes).unwrap());
    // Changed payload bytes invalidate.
    assert_ne!(a, remote_invalidation_key(&k, b"sku,price\nA,2\n").unwrap());
    // Changed params invalidate; param ORDER does not (BTreeMap descriptor).
    let reordered = remote_kind("https://api.test/d.csv", &[("region", "eu")]);
    assert_eq!(a, remote_invalidation_key(&reordered, bytes).unwrap());
    let other = remote_kind("https://api.test/d.csv", &[("region", "us")]);
    assert_ne!(a, remote_invalidation_key(&other, bytes).unwrap());
    // An invalid descriptor has NO key.
    assert!(remote_invalidation_key(&remote_kind("ftp://x/y", &[]), bytes).is_err());
}

#[test]
fn data_source_db_attach_credential_ref_indirection() {
    // The D-11 DB-attach shape carries a credentialRef STRING + a non-secret
    // locator — never a connection string. SQLite is the file tier; Postgres/
    // MySQL are network+credential, honestly scoped to the headless/proxy lane
    // via attach_plan().in_browser.
    use data_js::core::DataSession;

    let sqlite = src(
        "books",
        SourceKind::DbAttach {
            db: DbEngine::Sqlite,
            target: "books.sqlite".into(),
            credential_ref: None,
            dsn: None,
        },
    );
    assert_eq!(adapter_for(&sqlite.kind).kind_name(), "dbAttach");
    // SQLite attach is a file import (pure-web reachable).
    assert_eq!(
        adapter_for(&sqlite.kind).required_capability(&sqlite),
        RequiredCapability::FileImport
    );
    assert!(attach_plan(&sqlite).unwrap().in_browser);

    let pg = src(
        "wh",
        SourceKind::DbAttach {
            db: DbEngine::Postgres,
            target: "db.host:5432/sales".into(),
            credential_ref: Some("keychain:wh".into()),
            dsn: None,
        },
    );
    // Network + credential handling; the plan is NOT in-browser (proxy lane).
    assert!(matches!(
        adapter_for(&pg.kind).required_capability(&pg),
        RequiredCapability::NetworkCredential { .. }
    ));
    let plan = attach_plan(&pg).unwrap();
    assert!(!plan.in_browser);
    assert_eq!(plan.credential_ref.as_deref(), Some("keychain:wh"));
    // A network engine with no credentialRef refuses to form a plan.
    let bad = src(
        "wh2",
        SourceKind::DbAttach {
            db: DbEngine::Mysql,
            target: "db.host:3306/app".into(),
            credential_ref: None,
            dsn: None,
        },
    );
    assert_eq!(
        attach_plan(&bad),
        Err(AttachError::MissingCredentialRef("mysql"))
    );

    // The recipe round-trips with the credentialRef intact and NO secret.
    let mut session = DataSession::new(0);
    session.define_source(pg);
    let json = serde_json::to_string(&session.payload()).unwrap();
    assert!(json.contains("keychain:wh"));
    assert!(json.contains("db.host"));
    assert!(!json.contains("password"));

    // A pre-D-11 payload (the bare `{dsn}` M0 shape) still decodes — the new
    // fields default (the versioned-amendment compat rule).
    let m0_json = r#"{"sources":[{"id":"old","kind":{"kind":"dbAttach","db":"postgres","target":"h:5432/d","dsn":"postgres://u:p@h:5432/d"},"capability":"cap"}]}"#;
    let payload: data_js::core::DocumentPayload = serde_json::from_str(m0_json).unwrap();
    assert!(matches!(
        &payload.sources[0].kind,
        SourceKind::DbAttach {
            db: DbEngine::Postgres,
            credential_ref: None,
            dsn: Some(_),
            ..
        }
    ));
}

#[test]
fn data_source_duckdb_engine_purpose() {
    // D-07b / D-11 — DuckDB-WASM loads first-class via the `engine` wasm purpose
    // class (the governed 64 MiB ceiling), NOT the 8 MiB compute cap. Assert the
    // bundle manifest declares it as purpose:"engine" so the plugin-cli size-gate
    // admits the ~36 MiB artifact (it would REJECT it as compute).
    let manifest_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../packages/data-bundle/manifest.json"
    );
    let text = std::fs::read_to_string(manifest_path).expect("bundle manifest readable");
    let manifest: serde_json::Value = serde_json::from_str(&text).expect("manifest is valid JSON");
    let wasm = manifest["capabilities"]["wasm"]
        .as_array()
        .expect("capabilities.wasm is an array");
    let duckdb = wasm
        .iter()
        .find(|a| a["name"] == "duckdb-engine")
        .expect("a duckdb-engine wasm artifact is declared");
    assert_eq!(
        duckdb["purpose"], "engine",
        "DuckDB must be declared purpose:engine (the 64 MiB ceiling, D-07b) — \
         NOT compute/codec (the 8 MiB cap)"
    );
    // Its self-imposed ceiling must stay within the 64 MiB engine ceiling.
    let max_bytes = duckdb["maxBytes"].as_u64().expect("maxBytes present");
    assert!(
        max_bytes <= 64 * 1024 * 1024,
        "duckdb-engine maxBytes within the engine ceiling"
    );
}

#[test]
fn data_source_remote_engine_key_round_trip() {
    // The data-js session join: define a remote source, supply bytes, get the
    // hex invalidation key — and the recipe round-trips with format + params
    // intact (the M0→M1 serde amendment stays compatible).
    use data_js::core::DataSession;
    let mut session = DataSession::new(0);
    let s = src(
        "api",
        remote_kind("https://api.test/d.csv", &[("region", "eu")]),
    );
    session.define_source(s.clone());
    let key = session
        .remote_invalidation_key(&SourceId::from("api"), b"sku\nA\n")
        .unwrap();
    assert_eq!(key.len(), 16);
    // Unknown source → surfaced error, never a silent default.
    assert!(session
        .remote_invalidation_key(&SourceId::from("nope"), b"x")
        .is_err());
    // Round-trip the payload; the descriptor survives intact.
    let reopened = DataSession::from_payload(session.payload(), 0);
    let manifest = reopened.source_manifest();
    assert_eq!(manifest.entries[0].kind, "remote");
    assert_eq!(manifest.entries[0].target, "https://api.test");
    // And an M0-era payload (bare `{url}`) still decodes — defaults fill in.
    let m0_json = r#"{"sources":[{"id":"old","kind":{"kind":"remote","url":"https://old.test/d.csv"},"capability":"cap"}]}"#;
    let payload: data_js::core::DocumentPayload = serde_json::from_str(m0_json).unwrap();
    assert_eq!(payload.sources.len(), 1);
    assert!(matches!(
        &payload.sources[0].kind,
        SourceKind::Remote { url, format: None, params, credential_ref: None }
            if url == "https://old.test/d.csv" && params.is_empty()
    ));
}

/// The refresh-policy SHAPE round-trips on every source variant, and the honest
/// "who acts on it" predicate holds: the interactive editor honors Manual /
/// OnOpen / Never without a background timer; `Interval` is deferred to the
/// batch/automation lane (the document never runs a wall-clock scheduler, §11).
/// This is the policy shape only — no live scheduler is built here (recorded
/// follow-up); the field is stored + persisted so the recipe survives.
#[test]
fn data_source_refresh_policy_roundtrip() {
    use data_js::core::DataSession;

    // The interactive editor acts on these WITHOUT a background timer.
    assert!(RefreshPolicy::Manual.honored_interactively());
    assert!(RefreshPolicy::OnOpen.honored_interactively());
    assert!(RefreshPolicy::Never.honored_interactively());
    // Interval is the one the editor does NOT drive — it's the automation lane's.
    assert!(!RefreshPolicy::Interval { secs: 3600 }.honored_interactively());
    assert_eq!(
        RefreshPolicy::Interval { secs: 3600 }.interval_secs(),
        Some(3600)
    );
    assert_eq!(RefreshPolicy::Manual.interval_secs(), None);

    // Each policy round-trips through a saved document, on its own source.
    let policies = [
        RefreshPolicy::Manual,
        RefreshPolicy::OnOpen,
        RefreshPolicy::Interval { secs: 900 },
        RefreshPolicy::Never,
    ];
    let mut session = DataSession::new(0);
    for (i, policy) in policies.iter().enumerate() {
        session.define_source(DataSource {
            id: SourceId::from(format!("s{i}")),
            kind: SourceKind::InlineSeed {
                table: format!("t{i}"),
            },
            capability: CapabilityRef::from("inline"),
            refresh: *policy,
        });
    }
    let reopened = DataSession::from_payload(session.payload(), 0);
    let mut sources = reopened.payload().sources;
    sources.sort_by(|a, b| a.id.to_string().cmp(&b.id.to_string()));
    assert_eq!(sources.len(), 4);
    for (src, expected) in sources.iter().zip(policies.iter()) {
        assert_eq!(
            &src.refresh, expected,
            "refresh policy must survive save/load"
        );
    }
    // The interval value specifically survives (the automation lane reads it).
    let interval = sources
        .iter()
        .find_map(|s| s.refresh.interval_secs())
        .expect("an Interval policy must round-trip its secs");
    assert_eq!(interval, 900);
}
