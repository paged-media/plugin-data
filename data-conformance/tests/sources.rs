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

//! Source-adapter conformance (spec §6.2): inline + file at M0, and the §11
//! data-source manifest.

use data_core::{CapabilityRef, DataSource, FileFormat, RefreshPolicy, SourceId, SourceKind};
use data_sources::{
    adapter_for, authorize, build_manifest, GrantedCapabilities, RequiredCapability,
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
