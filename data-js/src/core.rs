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

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use data_automation::{plan_batch, BatchMode, BatchPlan};
use data_barcode::{encode, Symbology};
use data_bind::{
    diff_resolved, suggest_mappings, BarcodeResolveStatus, ChangeKind, ColumnMapping,
    ResolutionEngine, ResolveError, Resolved, ResolvedBarcode, ResolvedRecordFlow, RuleEvaluation,
};
use data_core::{
    BarcodeSymbology, Binding, BindingDef, BindingId, DataSource, Locale, Placeholder, Query,
    QueryId, RecordSet, Schema, Status, StyleAction, SyncState, Template, Value,
};
use data_lower::{
    lower_barcode, lower_image, lower_table, lower_variable, paginate_flow, FlowGroup,
    FlowLayoutOpts, FlowRecord, FrameCapacity, LowerOpts, LoweredBarcode, LoweredImage,
    LoweredTable, LoweredVariable, PaginatedFlow,
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
    Barcode(LoweredBarcode),
}

/// The default square content box (pt) a barcode lowers into when the bound
/// frame's geometry is not supplied (mirrors the table's `defaultPlacement` —
/// the bundle re-lowers with the real frame box via `lower_barcode`). 1-inch.
const DEFAULT_BARCODE_BOX_PT: f64 = 72.0;

/// Bridge the frozen `data-core` symbology to the `data-barcode` encoder enum.
fn to_encoder_symbology(s: BarcodeSymbology) -> Symbology {
    match s {
        BarcodeSymbology::Ean13 => Symbology::Ean13,
        BarcodeSymbology::UpcA => Symbology::UpcA,
        BarcodeSymbology::Code128 => Symbology::Code128,
        BarcodeSymbology::Qr => Symbology::Qr,
    }
}

/// Encode a resolved barcode + scale it into a content box (spec §9.7). The
/// missing policy already ran in `data-bind`: a `Skipped`/`Flagged` resolution
/// (empty value) yields an empty-module lowering (nothing drawn), never an
/// encoder error. A `Present` value that fails to encode (e.g. a non-numeric
/// EAN) is a typed `SessionError` the panel surfaces.
fn encode_barcode(
    rb: &ResolvedBarcode,
    box_w_pt: f64,
    box_h_pt: f64,
) -> Result<LoweredBarcode, SessionError> {
    if rb.status != BarcodeResolveStatus::Present {
        // Empty/absent value → an empty symbol (no modules), never an error.
        return Ok(LoweredBarcode {
            target: rb.target.clone(),
            symbology: to_encoder_symbology(rb.symbology).id().to_string(),
            modules: Vec::new(),
            modules_x: 0,
            modules_y: 0,
            bounds: data_lower::ContentBox {
                width_pt: box_w_pt,
                height_pt: box_h_pt,
            },
            text: String::new(),
        });
    }
    let geometry = encode(to_encoder_symbology(rb.symbology), &rb.value)
        .map_err(|e| SessionError::Decode(e.to_string()))?;
    Ok(lower_barcode(rb.target.clone(), &geometry, box_w_pt, box_h_pt))
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

/// One binding's entry in the §8 refresh change report crossed to the host
/// (`{binding, kind, before, after}`). `kind` is `"changed"`/`"unchanged"`/
/// `"added"`/`"removed"`; `before`/`after` are the opaque resolved-content
/// fingerprints (present on the side the binding resolved on) — the panel keys
/// off `kind` and may show the fingerprints as an audit trail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEntry {
    pub binding: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
}

/// The §8 refresh change report ("what changed since last sync"): per-binding
/// entries + rolled-up counts the panel headlines. Diffed from the resolved
/// content of every binding before vs after a refresh — pure, deterministic.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeReportOut {
    pub entries: Vec<ChangeEntry>,
    pub changed: usize,
    pub unchanged: usize,
    pub added: usize,
    pub removed: usize,
}

/// The full engine session.
pub struct DataSession {
    engine: ResolutionEngine,
    sources: Vec<DataSource>,
    queries: Vec<Query>,
    templates: Vec<Template>,
    bindings: Vec<BindingDef>,
    today: i32,
    /// The last per-binding resolved-content fingerprint snapshot (§8 change
    /// report). `refresh_change_report` diffs the current resolution against this
    /// then updates it; `None` until the first report (where every binding shows
    /// as `added` — the baseline).
    last_fingerprints: Option<HashMap<String, String>>,
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
            last_fingerprints: None,
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
        self.resolve_lowered_at(id, 0)
    }

    /// The number of records ingested for a query — the record-preview stepper's
    /// "of N" upper bound (§9). `0` when no result is ingested yet (refresh
    /// first).
    pub fn query_record_count(&self, query: &QueryId) -> usize {
        self.engine.record_count(query)
    }

    /// The field-mapping wizard's column suggestions for a query's ingested
    /// result (spec §9): one [`ColumnMapping`] per result column — a humanised
    /// header, the bare-field-reference expression (when the name is a valid DSL
    /// identifier), the logical type, and a `mappable` flag. The bundle renders
    /// these as a header → variable-binding mapping UI and, on confirm, generates
    /// each binding from the engine-computed `expr` (never deciding the mapping
    /// itself — the data semantics stay in Rust). Errors if the query has no
    /// ingested result yet (the wizard maps a real schema; `refreshData` first).
    pub fn query_mappings(&self, query_id: &QueryId) -> Result<Vec<ColumnMapping>, SessionError> {
        let records = self.engine.result(query_id).ok_or_else(|| {
            SessionError::Decode(format!("no result ingested for query '{query_id}'"))
        })?;
        Ok(suggest_mappings(&records.schema))
    }

    /// The §8 refresh change report — "what changed since last sync". Fingerprints
    /// every binding's CURRENT resolved content and diffs it against the snapshot
    /// taken at the previous report, then stores the new snapshot. The bundle
    /// calls this AFTER re-ingesting the queries (so "current" reflects the fresh
    /// data): the result is a per-binding changed / unchanged / added / removed
    /// summary the panel renders. Read-only over the resolution graph — it does
    /// NOT mutate sync states (the sync-state machine is driven by `set_result` /
    /// `resolve`; the change report only describes the delta). The FIRST call (no
    /// prior snapshot) reports every binding as `added` — the baseline; a caller
    /// that wants the baseline silent can prime it with one discarded call after
    /// the first lower.
    pub fn refresh_change_report(&mut self) -> ChangeReportOut {
        let current = self.engine.fingerprint_all();
        let before = self.last_fingerprints.take().unwrap_or_default();
        let report = diff_resolved(&before, &current);
        self.last_fingerprints = Some(current);
        ChangeReportOut {
            entries: report
                .entries
                .into_iter()
                .map(|e| ChangeEntry {
                    binding: e.binding,
                    kind: match e.kind {
                        ChangeKind::Changed => "changed",
                        ChangeKind::Unchanged => "unchanged",
                        ChangeKind::Added => "added",
                        ChangeKind::Removed => "removed",
                    }
                    .to_string(),
                    before: e.before,
                    after: e.after,
                })
                .collect(),
            changed: report.changed,
            unchanged: report.unchanged,
            added: report.added,
            removed: report.removed,
        }
    }

    /// Resolve a binding against a chosen RECORD INDEX and lower it — the §9
    /// record-preview stepper ("show the document resolved against record N").
    /// Per-record kinds (variable / image) evaluate over `records[record]`;
    /// whole-result kinds (table) render in full (the index is irrelevant). A
    /// record-flow still needs a frame chain (call `lower_record_flow`); a
    /// barcode still needs the frame box (`lower_barcode_at`). The preview re-runs
    /// the SAME resolve + lower lanes the batch will use, so the preview and the
    /// generated output agree.
    pub fn resolve_lowered_at(
        &mut self,
        id: &BindingId,
        record: usize,
    ) -> Result<LoweredOutput, SessionError> {
        match self.engine.resolve_at(id, record)? {
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
            // A barcode encodes + scales into a default 1-inch square box; the
            // bundle re-lowers with the bound frame's real geometry via
            // `lower_barcode_sized` (like the table's defaultPlacement → frame).
            Resolved::Barcode(rb) => Ok(LoweredOutput::Barcode(encode_barcode(
                &rb,
                DEFAULT_BARCODE_BOX_PT,
                DEFAULT_BARCODE_BOX_PT,
            )?)),
            // A record flow needs a frame chain to paginate against — use
            // `lower_record_flow`. (The host frame-chain read is SDK-blocked,
            // D-12; the chain is caller-supplied until it lands.)
            Resolved::RecordFlow(_) => Err(SessionError::Decode(
                "record flow: call lower_record_flow(id, chain)".to_string(),
            )),
        }
    }

    /// Resolve a barcode binding and lower it scaled to the bound frame's actual
    /// content box (spec §9.7). The bundle reads the frame's content-box size
    /// (`elementGeometry`) and passes it here so the symbol fills the frame; the
    /// modules are content-space (§9.6 — frame transforms honored for free).
    pub fn lower_barcode_sized(
        &mut self,
        id: &BindingId,
        box_w_pt: f64,
        box_h_pt: f64,
    ) -> Result<LoweredBarcode, SessionError> {
        self.lower_barcode_at(id, 0, box_w_pt, box_h_pt)
    }

    /// Resolve a barcode binding against a chosen RECORD INDEX (the §9 preview
    /// stepper) and lower it scaled to the bound frame's content box. Identical
    /// to [`lower_barcode_sized`](Self::lower_barcode_sized) but evaluates the
    /// expression over `records[record]` so the preview shows the symbol for the
    /// stepped-to record.
    pub fn lower_barcode_at(
        &mut self,
        id: &BindingId,
        record: usize,
        box_w_pt: f64,
        box_h_pt: f64,
    ) -> Result<LoweredBarcode, SessionError> {
        match self.engine.resolve_at(id, record)? {
            Resolved::Barcode(rb) => encode_barcode(&rb, box_w_pt, box_h_pt),
            _ => Err(SessionError::Decode("binding is not a barcode".to_string())),
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

    /// The **remote invalidation key** (§6.2/§8, the M1 remote slice): the
    /// content-addressed key for a defined remote source over caller-supplied
    /// bytes. The bundle fetches the bytes (edit-time, post-consent, D-03) and
    /// hands them here — the engine validates the descriptor (no embedded
    /// credentials, http(s) only) and computes the deterministic key; it never
    /// fetches. Returned as a hex string (the stamp the bundle records).
    pub fn remote_invalidation_key(
        &self,
        id: &data_core::SourceId,
        bytes: &[u8],
    ) -> Result<String, SessionError> {
        let src = self
            .sources
            .iter()
            .find(|s| &s.id == id)
            .ok_or_else(|| SessionError::Decode(format!("no source '{id}' defined")))?;
        let key = data_sources::remote_invalidation_key(&src.kind, bytes)
            .map_err(|e| SessionError::Decode(e.to_string()))?;
        Ok(format!("{key:016x}"))
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
