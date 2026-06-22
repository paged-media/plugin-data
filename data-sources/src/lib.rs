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

mod governed;
pub use governed::{
    enrich_schema, CatalogColumn, CatalogDiagnostic, ColumnMetadata, DatasetMetadata,
    GovernedCatalog,
};
mod remote;
pub use remote::{
    content_hash_bytes, remote_descriptor_hash, remote_invalidation_key, validate_remote,
    RemoteError,
};

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
            SourceKind::Remote { url, .. } => origin_of(url),
            _ => None,
        };
        RequiredCapability::Network { origin }
    }
    fn manifest_target(&self, src: &DataSource) -> String {
        match &src.kind {
            SourceKind::Remote { url, .. } => origin_of(url).unwrap_or_else(|| url.clone()),
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
        match &src.kind {
            SourceKind::DbAttach {
                db, target, dsn, ..
            } => {
                // SQLite attach is a FILE import (file/OPFS) — no network.
                // Postgres/MySQL need network + credential handling; the
                // origin is the non-secret `host:port` (from `target`, or
                // the redacted legacy `dsn` if that is all we have).
                if db.reachable_in_browser() {
                    RequiredCapability::FileImport
                } else {
                    let origin = db_origin(target).or_else(|| dsn.as_deref().and_then(origin_of));
                    RequiredCapability::NetworkCredential { origin }
                }
            }
            _ => RequiredCapability::None,
        }
    }
    fn manifest_target(&self, src: &DataSource) -> String {
        match &src.kind {
            // Show only the non-secret locator: the file/OPFS name (SQLite)
            // or host:port/db (Postgres/MySQL) — NEVER user:pass@. A legacy
            // `dsn` is redacted to host-only.
            SourceKind::DbAttach { target, dsn, .. } => {
                if !target.is_empty() {
                    target.clone()
                } else {
                    dsn.as_deref().map(redact_dsn).unwrap_or_default()
                }
            }
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

// ── DB-attach host-injection seam (D-11) ────────────────────────────────────
//
// The plugin NEVER holds the secret. For a DbAttach source it knows only the
// engine, the non-secret target, and the `credential_ref`. To attach, the
// HOST resolves the ref (via `host.secrets`, host-side) and injects the live
// connection string; the plugin hands the host an [`AttachPlan`] (what to
// attach, under which alias, with which credential ref + the engine's secret
// requirement), and the host produces the final `ATTACH` SQL on ITS side —
// the secret is substituted where `{credential}` appears, never seen here.

/// An attach error — the plan cannot be formed (the source is not a DbAttach,
/// or a network engine has no credential ref while one is required).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum AttachError {
    #[error("source is not a DbAttach")]
    NotDbAttach,
    #[error("the {0} engine requires a credentialRef (host-resolved); none was set")]
    MissingCredentialRef(&'static str),
    #[error(
        "the {0} engine's transport is not reachable in the browser — \
         attach runs in the headless/napi + proxy lane (named deferral)"
    )]
    TransportNotInBrowser(&'static str),
}

/// What the host needs to attach a DbAttach source (D-11). The HOST resolves
/// `credential_ref` (if any) via `host.secrets` and injects the live secret
/// into the connection on its side — this struct carries NO secret, only the
/// indirection the host needs. `in_browser` is the honest transport verdict:
/// `false` for Postgres/MySQL (the headless/proxy lane).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachPlan {
    /// The engine being attached.
    pub engine: data_core::DbEngine,
    /// The DuckDB alias the attached DB is exposed under (the source id).
    pub alias: String,
    /// The non-secret locator (file/OPFS name or host:port/db).
    pub target: String,
    /// The host-store ref the host resolves (`None` for an open SQLite file).
    pub credential_ref: Option<String>,
    /// Whether the live transport is reachable in the pure-web tier (SQLite
    /// yes; Postgres/MySQL no — the headless/proxy lane).
    pub in_browser: bool,
}

/// Build the [`AttachPlan`] for a DbAttach source (D-11). Pure: it derives
/// WHAT the host must attach + WHICH credential ref it must resolve — it does
/// NOT resolve the secret (that is host-side, by design). A network engine
/// (Postgres/MySQL) MUST carry a `credential_ref`; a SQLite file may omit it.
pub fn attach_plan(src: &DataSource) -> Result<AttachPlan, AttachError> {
    let SourceKind::DbAttach {
        db,
        target,
        credential_ref,
        ..
    } = &src.kind
    else {
        return Err(AttachError::NotDbAttach);
    };
    if !db.reachable_in_browser() && credential_ref.is_none() {
        // A remote engine with no credential ref cannot be authenticated —
        // refuse to form a plan rather than attach unauthenticated.
        return Err(AttachError::MissingCredentialRef(engine_name(*db)));
    }
    Ok(AttachPlan {
        engine: *db,
        alias: src.id.to_string(),
        target: target.clone(),
        credential_ref: credential_ref.clone(),
        in_browser: db.reachable_in_browser(),
    })
}

/// The stable engine name (for diagnostics + the DuckDB attach idiom).
fn engine_name(db: data_core::DbEngine) -> &'static str {
    match db {
        data_core::DbEngine::Sqlite => "sqlite",
        data_core::DbEngine::Postgres => "postgres",
        data_core::DbEngine::Mysql => "mysql",
    }
}

/// Return a source kind with any embedded DB credentials stripped — the form
/// safe to serialize into a document payload (§11; credentials are NEVER
/// persisted into the saved file, BREAKAGE D-11). Non-DB kinds are unchanged.
///
/// For [`SourceKind::DbAttach`]: the `credential_ref` is a REFERENCE (no
/// secret) and survives verbatim; only the legacy `dsn` field is redacted to
/// host-only (its `user:pass@` stripped) so a pre-D-11 payload that carried a
/// connection string still saves clean. New sources carry no `dsn` at all.
pub fn redact_credentials(kind: &SourceKind) -> SourceKind {
    match kind {
        SourceKind::DbAttach {
            db,
            target,
            credential_ref,
            dsn,
        } => SourceKind::DbAttach {
            db: *db,
            target: target.clone(),
            credential_ref: credential_ref.clone(),
            dsn: dsn.as_deref().map(redact_dsn),
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

/// Extract `host[:port]/db` from a DB-attach `target` for the manifest origin.
/// The target is already credential-free (a `host:port/db` locator); this
/// normalizes it to a `scheme`-less origin string used in the consent manifest.
/// Returns `None` for an empty target (a SQLite file has no network origin).
fn db_origin(target: &str) -> Option<String> {
    if target.is_empty() {
        return None;
    }
    // A target like "warehouse:5432/sales" → origin "warehouse:5432".
    let host = target.split('/').next().unwrap_or(target);
    // Defensive: drop any stray user@ that should never be here.
    let host = host.rsplit('@').next().unwrap_or(host);
    Some(host.to_string())
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
                        url: "https://x.test/d.csv".into(),
                        format: None,
                        params: Default::default(),
                        credential_ref: None,
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
                format: None,
                params: Default::default(),
                credential_ref: None,
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
        // Legacy `dsn` path: a pre-D-11 connection string is redacted to
        // host-only in the manifest target (the user:pass@ stripped).
        let sources = vec![src(
            "db",
            SourceKind::DbAttach {
                db: data_core::DbEngine::Postgres,
                target: String::new(),
                credential_ref: None,
                dsn: Some("postgres://user:secret@db.host:5432/sales".into()),
            },
        )];
        let m = build_manifest(&sources);
        let entry = &m.entries[0];
        assert!(entry.credential_redacted);
        assert_eq!(entry.target, "postgres://db.host:5432/sales");
        assert!(!entry.target.contains("secret"));
    }

    #[test]
    fn data_source_db_attach_credential_ref_only() {
        // The D-11 shape: a structured DbAttach carries db + a non-secret
        // target + a credentialRef STRING — never a connection string.
        let sources = vec![src(
            "warehouse",
            SourceKind::DbAttach {
                db: data_core::DbEngine::Postgres,
                target: "db.host:5432/sales".into(),
                credential_ref: Some("keychain:source-4".into()),
                dsn: None,
            },
        )];
        let m = build_manifest(&sources);
        let entry = &m.entries[0];
        assert_eq!(entry.kind, "dbAttach");
        assert!(entry.credential_redacted);
        // The manifest shows the non-secret host:port/db locator.
        assert_eq!(entry.target, "db.host:5432/sales");
        // A network engine requires network + credential handling, origin
        // derived from the non-secret target.
        assert_eq!(
            entry.capability,
            RequiredCapability::NetworkCredential {
                origin: Some("db.host:5432".into())
            }
        );
    }

    #[test]
    fn data_source_db_attach_sqlite_is_file_tier() {
        // SQLite attach (file/OPFS) is a FILE import — no network, reachable
        // in the pure-web tier; no credential ref required.
        let s = src(
            "local",
            SourceKind::DbAttach {
                db: data_core::DbEngine::Sqlite,
                target: "books.sqlite".into(),
                credential_ref: None,
                dsn: None,
            },
        );
        assert_eq!(
            adapter_for(&s.kind).required_capability(&s),
            RequiredCapability::FileImport
        );
        // The attach plan is in-browser-reachable.
        let plan = attach_plan(&s).unwrap();
        assert!(plan.in_browser);
        assert_eq!(plan.alias, "local");
        assert!(plan.credential_ref.is_none());
    }

    #[test]
    fn data_source_db_attach_plan_scopes_network_engines() {
        // Postgres/MySQL: a plan forms (credential indirection + host seam),
        // but it is honestly NOT in-browser-reachable — the headless/proxy
        // lane. A missing credentialRef refuses the plan (no unauthenticated
        // remote attach).
        let pg = src(
            "wh",
            SourceKind::DbAttach {
                db: data_core::DbEngine::Postgres,
                target: "db.host:5432/sales".into(),
                credential_ref: Some("keychain:wh".into()),
                dsn: None,
            },
        );
        let plan = attach_plan(&pg).unwrap();
        assert!(!plan.in_browser, "postgres is the headless/proxy lane");
        assert_eq!(plan.credential_ref.as_deref(), Some("keychain:wh"));

        let no_cred = src(
            "wh2",
            SourceKind::DbAttach {
                db: data_core::DbEngine::Mysql,
                target: "db.host:3306/app".into(),
                credential_ref: None,
                dsn: None,
            },
        );
        assert_eq!(
            attach_plan(&no_cred),
            Err(AttachError::MissingCredentialRef("mysql"))
        );
    }
}
