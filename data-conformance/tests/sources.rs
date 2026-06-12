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

use data_core::{CapabilityRef, DataSource, FileFormat, RefreshPolicy, SourceId, SourceKind};
use data_sources::{
    adapter_for, authorize, build_manifest, remote_invalidation_key, validate_remote,
    GrantedCapabilities, RemoteError, RequiredCapability,
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
