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

use data_automation::{plan_batch, BatchMode, BatchPlan};
use data_bind::{ResolutionEngine, ResolveError, Resolved, ResolvedRecordFlow, RuleEvaluation};
use data_core::{
    Binding, BindingDef, BindingId, DataSource, Locale, Placeholder, Query, QueryId, RecordSet,
    Schema, Status, StyleAction, SyncState, Template, Value,
};
use data_lower::{
    lower_image, lower_table, lower_variable, paginate_flow, FlowGroup, FlowLayoutOpts, FlowRecord,
    FrameCapacity, LowerOpts, LoweredImage, LoweredTable, LoweredVariable, PaginatedFlow,
};
use data_query::{content_hash, stabilize};
use data_sources::{
    authorize, build_manifest, enrich_schema, DatasetMetadata, GovernedCatalog,
    GrantedCapabilities, SourceManifest,
};

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
    Image(LoweredImage),
}

/// The evaluation of a data-driven formatting rule (spec §9.5) crossed to the
/// host: which records fired + the document-style action to apply. The host
/// applies `apply` to the fired content through document styles (the per-cell
/// application is gated on D-13; the evaluation is the data-driven decision).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleResult {
    pub scope: String,
    /// Stabilized record indices where the rule fired.
    pub fires: Vec<usize>,
    pub apply: StyleAction,
    pub total: usize,
}

/// One executed batch unit (spec §10): a deterministic label + the paginated
/// flow for that output document. The batch runner partitions a resolved record
/// flow by [`BatchMode`] (per-record / per-group / one-catalog) and paginates
/// each unit through the SAME `data-lower` path the live document uses — so a
/// headless batch and an interactive lower agree. Nothing renders here; the
/// `PaginatedFlow` is the IR `data-host-model` turns into mutations.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRun {
    pub label: String,
    pub flow: PaginatedFlow,
}

/// A §7.1 data-provider publication: a query's resolved result exposed as a
/// named, discoverable dataset for **other** consumers (most importantly the
/// sheets plugin — a sheet sourced from a governed query) through the core SDK
/// data-provider registry. `paged.data` declares the provider and never knows
/// who consumes it; consumers discover by `category`, never by plugin identity
/// (§7.1). The publication carries *data*, never the ability to drive
/// `paged.data`'s queries/sources (§7.1 security note). Registration with the
/// core registry is gated on the data-provider contract RFC (D-09); this is the
/// engine-side payload ready to hand to `host.dataProviders.register` the moment
/// that door lands — a wiring change, like D-02/D-03.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPublication {
    /// The provider's stable, discoverable id (the neutral rendezvous key).
    pub id: String,
    /// Discovery category/capability (e.g. `"dataset"`) — consumers find
    /// providers by category, never by plugin identity (§7.1).
    pub category: String,
    /// An opaque content revision (an etag over the stabilized data): it changes
    /// iff the published rows change. Consumers re-pull when it differs from the
    /// revision they last saw — the §7.1 "sync flows through the contract".
    pub revision: String,
    /// The published schema (the descriptor half — what `discover` surfaces
    /// without shipping the rows).
    pub schema: Schema,
    pub row_count: usize,
    /// The resolved data, **stabilized** to a deterministic order (the snapshot
    /// half — Arrow-shaped, the same interchange used internally, §7.1).
    pub records: RecordSet,
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
    pub templates: Vec<Template>,
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
    templates: Vec<Template>,
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
            templates: Vec::new(),
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

    /// Register a per-record template (the "catalog cell", §9.4).
    pub fn define_template(&mut self, template: Template) {
        self.engine.add_template(template.clone());
        self.templates.push(template);
    }

    /// Register a placeholder anchor.
    pub fn define_placeholder(&mut self, placeholder: Placeholder) {
        self.engine.add_placeholder(placeholder);
    }

    /// Bind a query parameter value.
    pub fn set_param(&mut self, name: &str, value: Value) {
        self.engine.set_param(name, value);
    }

    /// Set the formatting locale for the display kernels (§9.1; en/de). Affects
    /// `NUMBER`/`CURRENCY`/`PERCENT`/`DATEFMT` output only — the canonical value
    /// form (and content hashing) stays locale-free.
    pub fn set_locale(&mut self, locale: Locale) {
        self.engine.set_locale(locale);
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
            Resolved::Image(img) => Ok(LoweredOutput::Image(lower_image(
                img.target,
                img.reference,
                img.fit,
                img.status,
            ))),
            // A record flow needs a frame chain to paginate against — use
            // `lower_record_flow`. (The host frame-chain read is SDK-blocked,
            // D-12; the chain is caller-supplied until it lands.)
            Resolved::RecordFlow(_) => Err(SessionError::Decode(
                "record flow: call lower_record_flow(id, chain)".to_string(),
            )),
        }
    }

    /// Resolve a record-flow binding and paginate it over a caller-supplied
    /// frame chain (spec §9.4; the host chain is SDK-blocked — D-12).
    pub fn lower_record_flow(
        &mut self,
        id: &BindingId,
        chain: Vec<FrameCapacity>,
        opts: FlowLayoutOpts,
    ) -> Result<PaginatedFlow, SessionError> {
        match self.engine.resolve(id)? {
            Resolved::RecordFlow(rf) => Ok(paginate_flow(&to_flow_groups(&rf), &chain, &opts)),
            _ => Err(SessionError::Decode(
                "binding is not a record flow".to_string(),
            )),
        }
    }

    /// Evaluate a data-driven formatting rule (spec §9.5) over a query's records
    /// — which records fired the `when` condition + the document-style action to
    /// apply. A rule carries no query of its own (it styles content within a
    /// scope), so the caller names the records to evaluate against.
    pub fn evaluate_rule(
        &self,
        rule_id: &BindingId,
        query_id: &QueryId,
    ) -> Result<RuleResult, SessionError> {
        let RuleEvaluation {
            scope,
            fires,
            apply,
            total,
        } = self.engine.evaluate_rule(rule_id, query_id)?;
        Ok(RuleResult {
            scope: scope.to_string(),
            fires,
            apply,
            total,
        })
    }

    /// Publish a query's resolved result as a §7.1 data-provider snapshot — a
    /// schema + the **stabilized** RecordSet + an opaque content-revision token,
    /// ready to register with the core data-provider registry once that SDK
    /// contract lands (D-09). The data is stabilized to a deterministic order so
    /// the snapshot — and its revision etag — is identity-stable across
    /// refreshes regardless of DuckDB's unordered iteration (§6.1), the
    /// precondition for a meaningful refresh signal. Errors if the query has no
    /// ingested result yet.
    pub fn publish_provider(
        &self,
        query_id: &QueryId,
        provider_id: &str,
        category: &str,
    ) -> Result<ProviderPublication, SessionError> {
        let records = self.engine.result(query_id).ok_or_else(|| {
            SessionError::Decode(format!("no result ingested for query '{query_id}'"))
        })?;
        let stable = stabilize(records, &[]);
        let revision = format!("{:016x}", content_hash(&stable));
        Ok(ProviderPublication {
            id: provider_id.to_string(),
            category: category.to_string(),
            revision,
            row_count: stable.row_count,
            schema: stable.schema.clone(),
            records: stable,
        })
    }

    /// **Run** a batch over a record-flow binding (spec §10): resolve the flow,
    /// partition it by `mode` into per-document units (one document per record /
    /// per group / one catalog), and paginate each unit over the supplied frame
    /// chain — the headless-generation executor. Partitioning the **resolved**
    /// flow (already stabilized by the binding's grouping) keeps each unit's
    /// record order identical to the live document; the napi-rs native binding
    /// (server/CI) is a thin wrapper over this (D — `data.automation.native`).
    pub fn run_record_flow_batch(
        &mut self,
        id: &BindingId,
        mode: BatchMode,
        chain: Vec<FrameCapacity>,
        opts: FlowLayoutOpts,
    ) -> Result<Vec<BatchRun>, SessionError> {
        let rf = match self.engine.resolve(id)? {
            Resolved::RecordFlow(rf) => rf,
            _ => {
                return Err(SessionError::Decode(
                    "binding is not a record flow".to_string(),
                ))
            }
        };
        let groups = to_flow_groups(&rf);
        let units: Vec<(String, Vec<FlowGroup>)> = match mode {
            BatchMode::OneCatalog => vec![("catalog".to_string(), groups)],
            BatchMode::PerGroup { .. } => groups
                .into_iter()
                .enumerate()
                .map(|(i, g)| {
                    let label = g.header.clone().unwrap_or_else(|| format!("group-{i}"));
                    (label, vec![g])
                })
                .collect(),
            BatchMode::PerRecord { .. } => {
                let mut out = Vec::new();
                for g in &groups {
                    for (i, rec) in g.records.iter().enumerate() {
                        // Keep the group header so a per-record document retains
                        // its section context; the label is the record's first
                        // rendered field (its name), else the row position.
                        let label = rec
                            .cells
                            .first()
                            .cloned()
                            .unwrap_or_else(|| format!("row-{i}"));
                        out.push((
                            label,
                            // A per-record document is one record — no section
                            // subtotal (a footer over a single record is noise).
                            vec![FlowGroup {
                                header: g.header.clone(),
                                level: g.level,
                                records: vec![rec.clone()],
                                footer: None,
                            }],
                        ));
                    }
                }
                out
            }
        };
        Ok(units
            .into_iter()
            .map(|(label, gs)| BatchRun {
                label,
                flow: paginate_flow(&gs, &chain, &opts),
            })
            .collect())
    }

    /// Plan a **batch run** over a query's result (spec §10): partition it into
    /// the deterministic sequence of generation units — one document per record
    /// (per-store flyers), per group (per-category catalogs), or one paginated
    /// catalog. Returns the plan (which records feed which document); the executor
    /// (in-app, or the napi-rs native binding) resolves + lowers + paginates each
    /// unit through the normal pipeline — nothing renders here. Errors if the
    /// query has no ingested result yet.
    pub fn plan_batch(
        &self,
        query_id: &QueryId,
        mode: BatchMode,
    ) -> Result<BatchPlan, SessionError> {
        let records = self.engine.result(query_id).ok_or_else(|| {
            SessionError::Decode(format!("no result ingested for query '{query_id}'"))
        })?;
        Ok(plan_batch(records, &mode))
    }

    /// Build the **governed catalog** for a query's result (spec §7): enrich the
    /// live result schema with a column-metadata sidecar (labels, descriptions,
    /// types, provenance) and surface governance drift (undocumented / stale /
    /// type-mismatched columns). The author binds to *documented* datasets, not
    /// raw anonymous tables. The bundle reads the sidecar JSON from the source's
    /// `metadata_sidecar` location and passes the parsed structure here — like a
    /// RecordSet, it is data, never engine code (§3). Errors if the query has no
    /// ingested result yet (the catalog enriches a real schema).
    pub fn governed_catalog(
        &self,
        query_id: &QueryId,
        metadata: DatasetMetadata,
    ) -> Result<GovernedCatalog, SessionError> {
        let records = self.engine.result(query_id).ok_or_else(|| {
            SessionError::Decode(format!("no result ingested for query '{query_id}'"))
        })?;
        Ok(enrich_schema(&records.schema, &metadata))
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
            templates: self.templates.clone(),
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
        for tmpl in payload.templates {
            s.define_template(tmpl);
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

/// Bridge a resolved record flow (data-bind) into the paginator's plain input
/// (data-lower) — the data-js join, keeping data-lower decoupled from data-bind.
fn to_flow_groups(rf: &ResolvedRecordFlow) -> Vec<FlowGroup> {
    rf.groups
        .iter()
        .map(|g| FlowGroup {
            header: g.header.clone(),
            level: g.level,
            records: g
                .records
                .iter()
                .map(|r| FlowRecord {
                    cells: r.cells.clone(),
                    height_pt: r.height_pt,
                })
                .collect(),
            footer: g.footer.as_ref().map(|f| FlowRecord {
                cells: f.cells.clone(),
                height_pt: f.height_pt,
            }),
        })
        .collect()
}
