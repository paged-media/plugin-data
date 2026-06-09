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

use data_core::{CapabilityRef, DataSource, FileFormat, RefreshPolicy, SourceId, SourceKind};
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

#[test]
fn data_security_no_network_pre_consent() {
    let remote = src(
        "api",
        SourceKind::Remote {
            url: "https://api.test/v".into(),
        },
    );
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
    session.define_source(src(
        "db",
        SourceKind::DbAttach {
            dsn: "postgres://user:SuperSecret@db.host:5432/sales".into(),
        },
    ));
    // The payload (the serialized recipe) MUST NOT carry the credential.
    let payload = session.payload();
    let json = serde_json::to_string(&payload).unwrap();
    assert!(
        !json.contains("SuperSecret"),
        "credentials leaked into the document payload: {json}"
    );
    // The redacted DSN keeps the host (so the source is still identifiable).
    assert!(json.contains("db.host"));
}
