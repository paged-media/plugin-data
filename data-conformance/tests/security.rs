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

//! Security conformance (spec §11) — the §11 assertions as HARD gates: no
//! network/file access without the granting capability, no resolution of remote
//! sources pre-consent, and no credential leakage into the document payload.

use std::collections::BTreeSet;

use data_core::{
    CapabilityRef, DataSource, DbEngine, FileFormat, RefreshPolicy, SourceId, SourceKind,
};
use data_js::core::DataSession;
use data_sources::{authorize, CapabilityError, GrantedCapabilities};

fn src(id: &str, kind: SourceKind) -> DataSource {
    DataSource {
        id: SourceId::from(id),
        kind,
        capability: CapabilityRef::from("cap"),
        refresh: RefreshPolicy::Manual,
    }
}

fn remote_kind(url: &str) -> SourceKind {
    SourceKind::Remote {
        url: url.into(),
        format: Some(FileFormat::Csv),
        params: Default::default(),
        credential_ref: None,
    }
}

#[test]
fn data_security_no_network_pre_consent() {
    let remote = src("api", remote_kind("https://api.test/v"));
    // M0 default: network off → remote is inert by construction.
    assert_eq!(
        authorize(&remote, &GrantedCapabilities::m0_default()),
        Err(CapabilityError::NetworkNotGranted)
    );
    // Even with network granted, an unconsented origin is rejected (no silent
    // fetch — §11).
    let granted = GrantedCapabilities {
        file_import: true,
        network: true,
        consented_origins: BTreeSet::new(),
    };
    assert_eq!(
        authorize(&remote, &granted),
        Err(CapabilityError::OriginNotConsented(
            "https://api.test".into()
        ))
    );
}

#[test]
fn data_security_capability_gate() {
    let g = GrantedCapabilities::default(); // nothing granted
                                            // File needs file-import.
    let file = src(
        "csv",
        SourceKind::File {
            format: FileFormat::Csv,
            name: "p.csv".into(),
        },
    );
    assert!(authorize(&file, &g).is_err());
    // Inline travels with the doc — always allowed.
    let inline = src("seed", SourceKind::InlineSeed { table: "t".into() });
    assert!(authorize(&inline, &g).is_ok());
}

#[test]
fn data_security_credentials_absent_from_payload() {
    let mut session = DataSession::new(0);
    // The D-11 shape: a structured DB-attach carries a credentialRef STRING
    // (never a connection string with secrets). The save → inspect round-trip
    // MUST show only the ref + the non-secret locator.
    session.define_source(src(
        "db",
        SourceKind::DbAttach {
            db: DbEngine::Postgres,
            target: "db.host:5432/sales".into(),
            credential_ref: Some("keychain:source-4".into()),
            dsn: None,
        },
    ));
    let payload = session.payload();
    let json = serde_json::to_string(&payload).unwrap();
    // Only the ref string + the non-secret locator are present.
    assert!(
        json.contains("keychain:source-4"),
        "credentialRef must survive"
    );
    assert!(
        json.contains("db.host"),
        "the non-secret host stays identifiable"
    );
    // No secret material of any kind.
    assert!(!json.contains("password"), "no secret leaked: {json}");
}

#[test]
fn data_security_credentials_absent_legacy_dsn_redacted() {
    // A pre-D-11 payload that mistakenly carried a connection string in the
    // legacy `dsn` field is REDACTED to host-only on save — the user:pass@ is
    // stripped (the M0 credentials-absent invariant holds for legacy shapes
    // too). New sources carry no dsn at all.
    let mut session = DataSession::new(0);
    session.define_source(src(
        "db",
        SourceKind::DbAttach {
            db: DbEngine::Postgres,
            target: String::new(),
            credential_ref: None,
            dsn: Some("postgres://user:SuperSecret@db.host:5432/sales".into()),
        },
    ));
    let payload = session.payload();
    let json = serde_json::to_string(&payload).unwrap();
    assert!(
        !json.contains("SuperSecret"),
        "credentials leaked into the document payload: {json}"
    );
    // The redacted DSN keeps the host (so the source is still identifiable).
    assert!(json.contains("db.host"));
}

#[test]
fn data_security_no_network_pre_consent_document_loads_inert() {
    // A saved document carrying a remote source loads COLD: reconstructing the
    // session from its payload performs no IO (the engine has no transport at
    // all), and the §11 gate still reports the source unauthorized under the
    // no-consent grant — inert until the user reviews + consents (D-03).
    let mut session = DataSession::new(0);
    session.define_source(src("api", remote_kind("https://api.test/feed.csv")));
    let reopened = DataSession::from_payload(session.payload(), 0);
    let report = reopened.authorize_report();
    assert_eq!(report.len(), 1);
    assert!(
        !report[0].allowed,
        "remote source must load inert: {report:?}"
    );
}

#[test]
fn data_security_credentials_absent_remote_descriptor() {
    // Remote descriptors carry NO credential material (rfc-credential-store):
    // an embedded user:pass@ URL is rejected at validation…
    let bad = remote_kind("https://user:SuperSecret@api.test/feed.csv");
    assert_eq!(
        data_sources::validate_remote(&bad),
        Err(data_sources::RemoteError::EmbeddedCredentials)
    );
    // …and an authenticated source round-trips with its credentialRef STRING
    // only — the ref names a host-store secret, never carries one (§11/D-11).
    let mut session = DataSession::new(0);
    session.define_source(src(
        "api",
        SourceKind::Remote {
            url: "https://api.test/feed.csv".into(),
            format: Some(FileFormat::Csv),
            params: Default::default(),
            credential_ref: Some("keychain:source-api".into()),
        },
    ));
    let json = serde_json::to_string(&session.payload()).unwrap();
    assert!(json.contains("keychain:source-api"));
    assert!(json.contains("https://api.test/feed.csv"));
}
