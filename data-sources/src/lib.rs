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

//! # data-sources — source adapters + the capability/consent gate
//!
//! The source-adapter layer (spec §6.2) and **the only crate touching
//! network/file capability declarations** (spec §4 rule 2). The actual byte IO
//! is performed by DuckDB-WASM in the bundle realm; this crate owns the
//! engine-neutral parts:
//!
//! - the [`SourceAdapter`] trait + one ZST adapter per [`SourceKind`], selected
//!   by [`adapter_for`] (registry-style — an unregistered kind is unreachable
//!   by construction, §12.2);
//! - [`authorize`] — the §11 capability gate: a source cannot be created
//!   without the granting capability present and (for network) consented. This
//!   is the M0 `data.security.*` hard gate;
//! - [`build_manifest`] — the §11 **visible data-source manifest**: every
//!   origin/file a document will touch, with DB credentials redacted (never
//!   serialized into a document — §11, BREAKAGE D-11).

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use data_core::{DataSource, SourceKind};

/// The capability a source requires before it can be created/resolved (§11).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "cap", rename_all = "camelCase")]
pub enum RequiredCapability {
    /// Inline data travels with the document — no capability needed.
    None,
    /// A local file import (CSV/Excel/Parquet via OPFS — D-04).
    FileImport,
    /// Network reach to a specific origin (per-origin consent — D-03).
    Network { origin: Option<String> },
    /// Network reach plus credential handling (DB attach — D-11).
    NetworkCredential { origin: Option<String> },
}

/// The capabilities the host has granted + the origins the user has consented
/// to (§11). M0 default: `file_import` on (in-panel `<input type=file>`),
/// `network` off (the manifest declares `network:false`).
#[derive(Debug, Clone, Default)]
pub struct GrantedCapabilities {
    pub file_import: bool,
    pub network: bool,
    pub consented_origins: BTreeSet<String>,
}

impl GrantedCapabilities {
    /// The M0 grant: file import only, no network (spec §11 / manifest).
    pub fn m0_default() -> Self {
        GrantedCapabilities {
            file_import: true,
            network: false,
            consented_origins: BTreeSet::new(),
        }
    }
}

/// A capability/consent violation (§11). Surfaced — never bypassed.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CapabilityError {
    #[error("file-import capability not granted")]
    FileImportNotGranted,
    #[error("network capability not granted")]
    NetworkNotGranted,
    #[error("origin not consented: {0}")]
    OriginNotConsented(String),
}

/// Authorize creating/resolving a source against the granted capabilities
/// (§11). **No silent fetch, ever** — a network source is inert until its
/// origin is consented. This is the M0 security gate.
pub fn authorize(src: &DataSource, granted: &GrantedCapabilities) -> Result<(), CapabilityError> {
    match adapter_for(&src.kind).required_capability(src) {
        RequiredCapability::None => Ok(()),
        RequiredCapability::FileImport => {
            if granted.file_import {
                Ok(())
            } else {
                Err(CapabilityError::FileImportNotGranted)
            }
        }
        RequiredCapability::Network { origin }
        | RequiredCapability::NetworkCredential { origin } => {
            if !granted.network {
                return Err(CapabilityError::NetworkNotGranted);
            }
            match origin {
                Some(o) if !granted.consented_origins.contains(&o) => {
                    Err(CapabilityError::OriginNotConsented(o))
                }
                _ => Ok(()),
            }
        }
    }
}

// ── The source-manifest (spec §11) ─────────────────────────────────────────

/// One row of the visible data-source manifest (§11).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub source: String,
    pub kind: String,
    pub capability: RequiredCapability,
    /// The file name or origin the source will touch (credentials redacted).
    pub target: String,
    /// True when DB credentials were stripped from `target` (never serialized).
    pub credential_redacted: bool,
}

/// The visible data-source manifest: every origin/file a document will touch
/// (§11). The consent UI renders this; nothing fetches until the user reviews
/// it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SourceManifest {
    pub entries: Vec<ManifestEntry>,
}

/// Build the manifest for a set of sources (§11). DB attach targets have their
/// credentials redacted — the manifest never carries a secret.
pub fn build_manifest(sources: &[DataSource]) -> SourceManifest {
    let entries = sources
        .iter()
        .map(|src| {
            let adapter = adapter_for(&src.kind);
            ManifestEntry {
                source: src.id.to_string(),
                kind: adapter.kind_name().to_string(),
                capability: adapter.required_capability(src),
                target: adapter.manifest_target(src),
                credential_redacted: adapter.redacts_credentials(),
            }
        })
        .collect();
    SourceManifest { entries }
}

// ── Source adapters (spec §6.2) ─────────────────────────────────────────────

/// A source adapter: the engine-neutral declaration for one [`SourceKind`].
pub trait SourceAdapter {
    /// The stable kind name (mirrors the registry `data.source.*` id tail).
    fn kind_name(&self) -> &'static str;
    /// The capability this source requires (§11).
    fn required_capability(&self, src: &DataSource) -> RequiredCapability;
    /// The manifest target string (file name / origin, credentials redacted).
    fn manifest_target(&self, src: &DataSource) -> String;
    /// Whether the manifest target had credentials stripped.
    fn redacts_credentials(&self) -> bool {
        false
    }
}

/// Select the adapter for a source kind. Exhaustive over the closed
/// [`SourceKind`] enum — an unregistered kind cannot exist (§12.2).
pub fn adapter_for(kind: &SourceKind) -> &'static dyn SourceAdapter {
    match kind {
        SourceKind::InlineSeed { .. } => &InlineSeedAdapter,
        SourceKind::File { .. } => &FileAdapter,
        SourceKind::Remote { .. } => &RemoteAdapter,
        SourceKind::DbAttach { .. } => &DbAttachAdapter,
        SourceKind::GovernedExtract { .. } => &GovernedExtractAdapter,
    }
}

struct InlineSeedAdapter;
impl SourceAdapter for InlineSeedAdapter {
    fn kind_name(&self) -> &'static str {
        "inline"
    }
    fn required_capability(&self, _src: &DataSource) -> RequiredCapability {
        RequiredCapability::None
    }
    fn manifest_target(&self, src: &DataSource) -> String {
        match &src.kind {
            SourceKind::InlineSeed { table } => format!("inline:{table}"),
            _ => String::new(),
        }
    }
}

struct FileAdapter;
impl SourceAdapter for FileAdapter {
    fn kind_name(&self) -> &'static str {
        "file"
    }
    fn required_capability(&self, _src: &DataSource) -> RequiredCapability {
        RequiredCapability::FileImport
    }
    fn manifest_target(&self, src: &DataSource) -> String {
        match &src.kind {
            SourceKind::File { name, .. } => name.clone(),
            _ => String::new(),
        }
    }
}

struct RemoteAdapter;
impl SourceAdapter for RemoteAdapter {
    fn kind_name(&self) -> &'static str {
        "remote"
    }
    fn required_capability(&self, src: &DataSource) -> RequiredCapability {
        let origin = match &src.kind {
            SourceKind::Remote { url } => origin_of(url),
            _ => None,
        };
        RequiredCapability::Network { origin }
    }
    fn manifest_target(&self, src: &DataSource) -> String {
        match &src.kind {
            SourceKind::Remote { url } => origin_of(url).unwrap_or_else(|| url.clone()),
            _ => String::new(),
        }
    }
}

struct DbAttachAdapter;
impl SourceAdapter for DbAttachAdapter {
    fn kind_name(&self) -> &'static str {
        "dbAttach"
    }
    fn required_capability(&self, src: &DataSource) -> RequiredCapability {
        let origin = match &src.kind {
            SourceKind::DbAttach { dsn } => origin_of(dsn),
            _ => None,
        };
        RequiredCapability::NetworkCredential { origin }
    }
    fn manifest_target(&self, src: &DataSource) -> String {
        match &src.kind {
            // Redact credentials: show only the host, never user:pass@.
            SourceKind::DbAttach { dsn } => redact_dsn(dsn),
            _ => String::new(),
        }
    }
    fn redacts_credentials(&self) -> bool {
        true
    }
}

struct GovernedExtractAdapter;
impl SourceAdapter for GovernedExtractAdapter {
    fn kind_name(&self) -> &'static str {
        "governedExtract"
    }
    fn required_capability(&self, src: &DataSource) -> RequiredCapability {
        match &src.kind {
            SourceKind::GovernedExtract { location, .. } => {
                if location.starts_with("http://") || location.starts_with("https://") {
                    RequiredCapability::Network {
                        origin: origin_of(location),
                    }
                } else {
                    RequiredCapability::FileImport
                }
            }
            _ => RequiredCapability::None,
        }
    }
    fn manifest_target(&self, src: &DataSource) -> String {
        match &src.kind {
            SourceKind::GovernedExtract { location, .. } => location.clone(),
            _ => String::new(),
        }
    }
}

/// Extract `scheme://host[:port]` from a URL/DSN, or `None` if it has no scheme.
fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let host = rest.split('/').next().unwrap_or(rest);
    // Drop any `user:pass@` authority prefix.
    let host = host.rsplit('@').next().unwrap_or(host);
    Some(format!("{scheme}://{host}"))
}

/// Return a source kind with any embedded DB credentials stripped — the form
/// safe to serialize into a document payload (§11; credentials are NEVER
/// persisted into the saved file, BREAKAGE D-11). Non-DB kinds are unchanged.
pub fn redact_credentials(kind: &SourceKind) -> SourceKind {
    match kind {
        SourceKind::DbAttach { dsn } => SourceKind::DbAttach {
            dsn: redact_dsn(dsn),
        },
        other => other.clone(),
    }
}

/// Redact a DB DSN to `scheme://host[:port]/path` — drop `user:pass@`.
fn redact_dsn(dsn: &str) -> String {
    match dsn.split_once("://") {
        Some((scheme, rest)) => {
            let rest = rest.rsplit('@').next().unwrap_or(rest);
            format!("{scheme}://{rest}")
        }
        None => dsn.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use data_core::{CapabilityRef, FileFormat, RefreshPolicy, SourceId};

    fn src(id: &str, kind: SourceKind) -> DataSource {
        DataSource {
            id: SourceId::from(id),
            kind,
            capability: CapabilityRef::from("cap"),
            refresh: RefreshPolicy::Manual,
        }
    }

    #[test]
    fn data_source_authorize_m0_gate() {
        let g = GrantedCapabilities::m0_default();
        // Inline + file are allowed at M0.
        assert!(authorize(&src("a", SourceKind::InlineSeed { table: "t".into() }), &g).is_ok());
        assert!(authorize(
            &src(
                "b",
                SourceKind::File {
                    format: FileFormat::Csv,
                    name: "p.csv".into()
                }
            ),
            &g
        )
        .is_ok());
        // Network is NOT granted at M0 — remote/db are inert by construction.
        assert_eq!(
            authorize(
                &src(
                    "c",
                    SourceKind::Remote {
                        url: "https://x.test/d.csv".into()
                    }
                ),
                &g
            ),
            Err(CapabilityError::NetworkNotGranted)
        );
    }

    #[test]
    fn data_source_authorize_origin_consent() {
        let mut g = GrantedCapabilities {
            file_import: true,
            network: true,
            consented_origins: BTreeSet::new(),
        };
        let remote = src(
            "c",
            SourceKind::Remote {
                url: "https://api.test/v".into(),
            },
        );
        // Network granted but origin not consented → rejected (§11).
        assert_eq!(
            authorize(&remote, &g),
            Err(CapabilityError::OriginNotConsented(
                "https://api.test".into()
            ))
        );
        g.consented_origins.insert("https://api.test".into());
        assert!(authorize(&remote, &g).is_ok());
    }

    #[test]
    fn data_source_manifest_redacts_credentials() {
        let sources = vec![src(
            "db",
            SourceKind::DbAttach {
                dsn: "postgres://user:secret@db.host:5432/sales".into(),
            },
        )];
        let m = build_manifest(&sources);
        let entry = &m.entries[0];
        assert!(entry.credential_redacted);
        assert_eq!(entry.target, "postgres://db.host:5432/sales");
        assert!(!entry.target.contains("secret"));
    }
}
