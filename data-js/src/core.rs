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

//! The plain-Rust [`DataSession`] — the full engine join (define → ingest →
//! resolve → lower → sync → round-trip), native-typed so `data-conformance`
//! exercises it WITHOUT a wasm runtime. The `#[wasm_bindgen]` `DataEngine`
//! (in `lib.rs`) is a forwarding shim over this; nothing computes there.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use data_bind::{ResolutionEngine, ResolveError, Resolved};
use data_core::{
    Binding, BindingDef, BindingId, DataSource, Placeholder, Query, QueryId, RecordSet, Status,
    SyncState, Value,
};
use data_lower::{lower_table, lower_variable, LowerOpts, LoweredTable, LoweredVariable};
use data_sources::{authorize, build_manifest, GrantedCapabilities, SourceManifest};

/// A session-level failure (resolution or a malformed boundary value).
#[derive(Debug, Clone, PartialEq, Error)]
pub enum SessionError {
    #[error("resolve error: {0}")]
    Resolve(#[from] ResolveError),
    #[error("decode error: {0}")]
    Decode(String),
}

/// The lowered output of resolving a binding — the IR `data-host-model` turns
/// into host mutations.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LoweredOutput {
    Variable(LoweredVariable),
    Table(LoweredTable),
}

/// The document-scoped payload (spec §5.1): the binding *recipe* (sources +
/// queries + binding defs). Credentials are redacted before this is built
/// (§11 — never serialized into the saved file, BREAKAGE D-11).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct DocumentPayload {
    #[serde(default)]
    pub sources: Vec<DataSource>,
    #[serde(default)]
    pub queries: Vec<Query>,
    #[serde(default)]
    pub bindings: Vec<BindingDef>,
}

/// One source's authorization verdict (§11 data-source manifest review).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceAuth {
    pub source: String,
    pub allowed: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

/// Session-level metadata (the panel reads it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub source_count: usize,
    pub query_count: usize,
    pub binding_count: usize,
    pub today: i32,
}

/// A binding's sync entry (`{binding, status}`) for the sync panel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncEntry {
    pub binding: String,
    pub status: Status,
}

/// The full engine session.
pub struct DataSession {
    engine: ResolutionEngine,
    sources: Vec<DataSource>,
    queries: Vec<Query>,
    bindings: Vec<BindingDef>,
    today: i32,
}

impl DataSession {
    /// A fresh session with an injected `today` serial (days since 1970-01-01).
    pub fn new(today: i32) -> Self {
        DataSession {
            engine: ResolutionEngine::new(today),
            sources: Vec::new(),
            queries: Vec::new(),
            bindings: Vec::new(),
            today,
        }
    }

    /// Register a data source (recipe; used for the §11 manifest + gate).
    pub fn define_source(&mut self, source: DataSource) {
        self.sources.push(source);
    }

    /// Register a query.
    pub fn define_query(&mut self, query: Query) {
        self.engine.add_query(query.clone());
        self.queries.push(query);
    }

    /// Register a binding definition.
    pub fn define_binding(&mut self, def: BindingDef) {
        self.engine.add_binding(def.id.clone(), def.binding.clone());
        self.bindings.push(def);
    }

    /// Register a placeholder anchor.
    pub fn define_placeholder(&mut self, placeholder: Placeholder) {
        self.engine.add_placeholder(placeholder);
    }

    /// Bind a query parameter value.
    pub fn set_param(&mut self, name: &str, value: Value) {
        self.engine.set_param(name, value);
    }

    /// Deliver a query's result (from the DuckDB-WASM query layer → RecordSet).
    pub fn ingest_result(&mut self, query: QueryId, records: RecordSet) {
        self.engine.set_result(query, records);
    }

    /// Resolve a binding and lower it to the host IR.
    pub fn resolve_lowered(&mut self, id: &BindingId) -> Result<LoweredOutput, SessionError> {
        match self.engine.resolve(id)? {
            Resolved::Variable(v) => Ok(LoweredOutput::Variable(lower_variable(
                v.target, &v.display, v.hidden,
            ))),
            Resolved::Table(t) => {
                let opts = self.lower_opts_for(&t.region);
                Ok(LoweredOutput::Table(lower_table(
                    t.region, &t.headers, &t.rows, &opts,
                )))
            }
        }
    }

    /// Lowering options for a table binding (honors the binding's `header_row`).
    fn lower_opts_for(&self, region: &data_core::FrameRef) -> LowerOpts {
        let header_row = self
            .bindings
            .iter()
            .find_map(|d| match &d.binding {
                Binding::Table {
                    region: r, options, ..
                } if r == region => Some(options.header_row),
                _ => None,
            })
            .unwrap_or(true);
        LowerOpts {
            header_row,
            ..LowerOpts::default()
        }
    }

    /// The sync state of a binding.
    pub fn sync_state(&self, id: &BindingId) -> Option<SyncState> {
        self.engine.sync_state(id)
    }

    /// Pin a binding to its current snapshot.
    pub fn pin(&mut self, id: &BindingId) {
        self.engine.pin(id);
    }

    /// Mark a binding overridden (a manual edit replaced the value).
    pub fn mark_overridden(&mut self, id: &BindingId) {
        self.engine.mark_overridden(id);
    }

    /// Re-link a pinned/overridden binding (the explicit user action).
    pub fn relink(&mut self, id: &BindingId) {
        self.engine.relink(id);
    }

    /// The sync report (bindings whose content diverges from the live source).
    pub fn sync_report(&self) -> Vec<SyncEntry> {
        self.engine
            .sync_report()
            .into_iter()
            .map(|(id, status)| SyncEntry {
                binding: id.to_string(),
                status,
            })
            .collect()
    }

    /// The visible data-source manifest (§11).
    pub fn source_manifest(&self) -> SourceManifest {
        build_manifest(&self.sources)
    }

    /// Authorize every source against the granted capabilities (§11). M0 uses
    /// the file-only / no-network default grant.
    pub fn authorize_report(&self) -> Vec<SourceAuth> {
        let granted = GrantedCapabilities::m0_default();
        self.sources
            .iter()
            .map(|s| match authorize(s, &granted) {
                Ok(()) => SourceAuth {
                    source: s.id.to_string(),
                    allowed: true,
                    reason: None,
                },
                Err(e) => SourceAuth {
                    source: s.id.to_string(),
                    allowed: false,
                    reason: Some(e.to_string()),
                },
            })
            .collect()
    }

    /// The document payload (recipe), with credentials redacted (§11/D-11).
    pub fn payload(&self) -> DocumentPayload {
        let sources = self
            .sources
            .iter()
            .map(|s| DataSource {
                kind: data_sources::redact_credentials(&s.kind),
                ..s.clone()
            })
            .collect();
        DocumentPayload {
            sources,
            queries: self.queries.clone(),
            bindings: self.bindings.clone(),
        }
    }

    /// Reconstruct a session from a saved payload (recipe round-trip).
    pub fn from_payload(payload: DocumentPayload, today: i32) -> Self {
        let mut s = DataSession::new(today);
        for src in payload.sources {
            s.define_source(src);
        }
        for q in payload.queries {
            s.define_query(q);
        }
        for b in payload.bindings {
            s.define_binding(b);
        }
        s
    }

    /// Session metadata.
    pub fn metadata(&self) -> SessionMeta {
        SessionMeta {
            source_count: self.sources.len(),
            query_count: self.queries.len(),
            binding_count: self.bindings.len(),
            today: self.today,
        }
    }
}
