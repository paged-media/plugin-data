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

//! # data-bind — the binding + synchronization engine (spec §8)
//!
//! The incremental core, same intellectual architecture as layout and the
//! sibling plugins' recalc/engine. A [`ResolutionEngine`] holds the resolution
//! graph (sources → queries → bindings → targets), the per-query results
//! delivered by the query engine, and a [`SyncState`] per binding. It:
//!
//! - **resolves** a [`Binding`] against its query's result, evaluating the
//!   binding expression(s) through `data-expr` ([`resolve`](ResolutionEngine::resolve));
//! - **invalidates** non-destructively: a result change marks dependent
//!   `Linked` bindings `Stale`, but never disturbs `Pinned`/`Overridden`
//!   content (§8, D-6) — divergences are reported, never silently clobbered;
//! - **diffs** by record identity ([`diff`]) so a refresh yields minimal row
//!   deltas (insert/update/remove), keeping pagination stable and undo granular.

pub mod diff;

use std::collections::HashMap;

use thiserror::Error;

use data_core::{
    BarcodeMissing, BarcodeOpts, BarcodeSymbology, Binding, BindingId, FlowOpts, FooterAgg,
    FrameChainRef, FrameRef, ImageReference, ImageStatus, ImgFit, ImgMissing, ImgPolicy, Locale,
    Placeholder, PlaceholderRef, Query, QueryId, RecordSet, ResolveStamp, ResultShape, ScopeRef,
    Status, StyleAction, SyncState, Template, TemplateRef, Value,
};
use data_expr::{eval_str, EvalCtx, RecordCtx, SimpleCtx};
use data_query::{content_hash, stabilize, stamp};

pub use diff::{diff, RowDelta};

/// A row + parameter view for expression evaluation: the field source is one
/// row of a resolved [`RecordSet`]; params come from the engine's bound set.
struct RowCtx<'a> {
    records: &'a RecordSet,
    row: usize,
    params: &'a HashMap<String, Value>,
}

impl RecordCtx for RowCtx<'_> {
    fn field(&self, name: &str) -> Option<Value> {
        self.records.field(self.row, name).cloned()
    }
    fn param(&self, name: &str) -> Option<Value> {
        self.params.get(name).cloned()
    }
}

/// A resolved binding's content (spec §8) — the input `data-lower` turns into a
/// `LoweredContent` IR.
#[derive(Debug, Clone, PartialEq)]
pub enum Resolved {
    /// A resolved variable: the value + its display string at a placeholder.
    Variable(ResolvedVariable),
    /// A resolved dynamic table: headers + a grid of formatted cell displays.
    Table(ResolvedTable),
    /// A resolved record flow: grouped template instances ready to paginate.
    RecordFlow(ResolvedRecordFlow),
    /// A resolved image placeholder: the classified reference + placement.
    Image(ResolvedImage),
    /// A resolved barcode: the symbology + the value string to encode (§9.7).
    Barcode(ResolvedBarcode),
}

/// A resolved barcode binding (spec §9.7). The binding expression resolved to a
/// `value` string; the engine (`data-lower`) encodes it in `symbology` into the
/// unit-box geometry and scales it to the bound `target` frame. `status`
/// reflects the missing policy when the value is empty (`Present`/`Skipped`/
/// `Flagged`). The encoding itself is NOT done here (data-bind stays free of the
/// symbology encoders) — it carries the resolved value to the lowering.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedBarcode {
    pub target: data_core::FrameRef,
    pub symbology: data_core::BarcodeSymbology,
    /// The value the expression resolved to (empty when absent/null).
    pub value: String,
    /// Extra quiet-zone modules requested beyond the symbology default.
    pub quiet_zone: u32,
    pub status: BarcodeResolveStatus,
}

/// The resolution status of a barcode binding after the missing policy (§9.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BarcodeResolveStatus {
    /// A value resolved — the symbol is rendered.
    Present,
    /// Absent + the `Skip` policy — nothing rendered.
    Skipped,
    /// Absent + the `Flag` policy — flagged for review.
    Flagged,
}

/// A resolved image binding (spec §9.2). The field value is classified into an
/// [`ImageReference`]; the missing policy decides the [`ImageStatus`] when
/// absent. The host places `reference` into the `target` frame through the core
/// asset mechanism, honoring `fit` — never via `plugin-image` (§2.1).
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedImage {
    pub target: PlaceholderRef,
    pub reference: ImageReference,
    pub fit: ImgFit,
    pub status: ImageStatus,
}

/// The evaluation of a data-driven formatting rule (spec §9.5): which records
/// (by stabilized index) the `when` condition fired on, and the document-style
/// action to apply to them. The host applies `apply` to the fired content
/// through document styles — never a parallel styling system (§9.5). The
/// per-cell application is gated on the style-read door + cell-level `applyStyle`
/// (BREAKAGE D-13); the evaluation here is the data-driven decision.
#[derive(Debug, Clone, PartialEq)]
pub struct RuleEvaluation {
    pub scope: ScopeRef,
    /// Stabilized record indices where the rule fired.
    pub fires: Vec<usize>,
    pub apply: StyleAction,
    /// Total records evaluated (so a consumer knows the fire rate).
    pub total: usize,
}

/// A resolved variable binding (spec §9.1).
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedVariable {
    pub target: PlaceholderRef,
    pub value: Value,
    /// The display string after expression evaluation + the missing policy.
    pub display: String,
    /// True when the `HideParagraph` missing policy applies (value absent).
    pub hidden: bool,
}

/// A resolved dynamic-table binding (spec §9.3).
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedTable {
    pub region: data_core::FrameRef,
    pub headers: Vec<String>,
    /// Row-major grid of formatted cell display strings (record order is the
    /// deterministically stabilized order — stable identity, §8).
    pub rows: Vec<Vec<String>>,
}

/// A resolved record flow (spec §9.4): groups of rendered template instances,
/// in stable record order — the input the paginator packs into a frame chain.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedRecordFlow {
    pub chain: FrameChainRef,
    pub groups: Vec<ResolvedFlowGroup>,
}

/// One section of a [`ResolvedRecordFlow`]. With multi-level `group_by`, parent
/// levels appear as header-only sections (`records` empty) preceding their leaf
/// sections; `level` (0 = outermost) lets the host indent/style the hierarchy.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedFlowGroup {
    /// The section header text (this level's group-by key), or `None` when
    /// ungrouped.
    pub header: Option<String>,
    /// The nesting level (0 = outermost group). Single-level/ungrouped → 0.
    pub level: usize,
    pub records: Vec<ResolvedFlowRecord>,
    /// The section footer (a subtotal/count row), or `None` when no footer is
    /// configured (§9.4 "section headers/footers"). Header-only parent sections
    /// never carry a footer.
    pub footer: Option<ResolvedFlowRecord>,
}

/// One rendered record instance (the "catalog cell" for a record).
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedFlowRecord {
    /// One line per template field (`label` + the field's resolved display).
    pub cells: Vec<String>,
    /// The measured instance height (fields × line height) the paginator packs.
    pub height_pt: f64,
}

/// A resolution failure (a missing binding/query/result/template, or a kind not
/// lowered at M0).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ResolveError {
    #[error("unknown binding: {0}")]
    UnknownBinding(BindingId),
    #[error("binding {0} has no query")]
    NoQuery(BindingId),
    #[error("no result delivered for query {0}")]
    NoResult(QueryId),
    #[error("no template registered: {0}")]
    NoTemplate(TemplateRef),
    #[error("binding kind not lowered at M0: {0}")]
    Unsupported(&'static str),
}

/// The resolution + synchronization engine (spec §8).
#[derive(Default)]
pub struct ResolutionEngine {
    queries: HashMap<QueryId, Query>,
    bindings: HashMap<BindingId, Binding>,
    templates: HashMap<TemplateRef, Template>,
    placeholders: HashMap<PlaceholderRef, Placeholder>,
    /// Per-query results delivered by the query engine (DuckDB → RecordSet).
    results: HashMap<QueryId, RecordSet>,
    results_hash: HashMap<QueryId, u64>,
    sync: HashMap<BindingId, SyncState>,
    params: HashMap<String, Value>,
    today: i32,
    locale: Locale,
}

impl ResolutionEngine {
    /// A fresh engine with an injected `today` serial (days since 1970-01-01).
    /// The formatting locale defaults to [`Locale::En`]; set it with
    /// [`set_locale`].
    pub fn new(today: i32) -> Self {
        ResolutionEngine {
            today,
            ..Default::default()
        }
    }

    /// Set the formatting locale for the display kernels (§9.1).
    pub fn set_locale(&mut self, locale: Locale) {
        self.locale = locale;
    }

    /// Register a query (the recipe).
    pub fn add_query(&mut self, query: Query) {
        self.queries.insert(query.id.clone(), query);
    }

    /// Register a binding (the recipe). Starts `Linked`, unresolved.
    pub fn add_binding(&mut self, id: BindingId, binding: Binding) {
        self.sync
            .entry(id.clone())
            .or_insert_with(SyncState::linked);
        self.bindings.insert(id, binding);
    }

    /// Register a per-record template (the "catalog cell", §9.4).
    pub fn add_template(&mut self, template: Template) {
        self.templates.insert(template.id.clone(), template);
    }

    /// Register a placeholder (the anchor).
    pub fn add_placeholder(&mut self, placeholder: Placeholder) {
        self.placeholders
            .insert(placeholder.id.clone(), placeholder);
    }

    /// Bind a query parameter value.
    pub fn set_param(&mut self, name: &str, value: Value) {
        self.params.insert(name.to_string(), value);
    }

    /// Deliver (or refresh) a query's result from the query engine. A genuine
    /// data change marks dependent `Linked` bindings `Stale`; `Pinned`/
    /// `Overridden` bindings are left untouched (non-destructive, §8/D-6).
    pub fn set_result(&mut self, query: QueryId, records: RecordSet) {
        let new_hash = content_hash(&records);
        let changed = self.results_hash.get(&query) != Some(&new_hash);
        self.results.insert(query.clone(), records);
        self.results_hash.insert(query.clone(), new_hash);
        if !changed {
            return;
        }
        let dependents: Vec<BindingId> = self
            .bindings
            .iter()
            .filter(|(_, b)| b.query() == Some(&query))
            .map(|(id, _)| id.clone())
            .collect();
        for id in dependents {
            let st = self.sync.entry(id).or_insert_with(SyncState::linked);
            if st.accepts_refresh() {
                st.status = Status::Stale;
            }
            // Pinned/Overridden stay as-is — reported by `sync_report`.
        }
    }

    /// The raw result currently ingested for a query, if any. Read-only — the
    /// §7.1 data-provider snapshot stabilizes and content-hashes this; it does
    /// NOT let a consumer mutate the graph (provider exposes *data*, not the
    /// ability to define queries/sources — §7.1 security note).
    pub fn result(&self, query: &QueryId) -> Option<&RecordSet> {
        self.results.get(query)
    }

    /// The number of records ingested for a query (the stepper's "of N" bound,
    /// §9 record-preview). `0` when no result is ingested yet.
    pub fn record_count(&self, query: &QueryId) -> usize {
        self.results.get(query).map(|r| r.row_count).unwrap_or(0)
    }

    /// The sync state of a binding.
    pub fn sync_state(&self, id: &BindingId) -> Option<SyncState> {
        self.sync.get(id).copied()
    }

    /// Pin a binding to its current snapshot (ignores refreshes until unpinned).
    pub fn pin(&mut self, id: &BindingId) {
        if let Some(st) = self.sync.get_mut(id) {
            st.status = Status::Pinned;
        }
    }

    /// Mark a binding overridden (a manual edit replaced the resolved value).
    pub fn mark_overridden(&mut self, id: &BindingId) {
        if let Some(st) = self.sync.get_mut(id) {
            st.status = Status::Overridden;
        }
    }

    /// Re-link a pinned/overridden binding so the next refresh tracks the
    /// source again (the explicit user action the non-destructive policy
    /// requires, §8).
    pub fn relink(&mut self, id: &BindingId) {
        if let Some(st) = self.sync.get_mut(id) {
            st.status = Status::Stale;
        }
    }

    /// Bindings whose source changed but whose content was preserved
    /// (`Pinned`/`Overridden`/`Stale`/`Error`) — the sync report the panel
    /// shows for review (§8 — never silently clobbered).
    pub fn sync_report(&self) -> Vec<(BindingId, Status)> {
        let mut out: Vec<(BindingId, Status)> = self
            .sync
            .iter()
            .filter(|(_, st)| st.status != Status::Linked)
            .map(|(id, st)| (id.clone(), st.status))
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// Resolve a binding against its query's delivered result. Updates the sync
    /// state to `Linked` with a fresh [`ResolveStamp`]. Re-resolution is
    /// idempotent (same inputs → identical content, §12.4).
    ///
    /// Per-record bindings (variable / image / barcode) resolve against the
    /// FIRST record (row 0). To preview the document against a chosen record
    /// (the §9 record-preview stepper), use [`resolve_at`](Self::resolve_at).
    pub fn resolve(&mut self, id: &BindingId) -> Result<Resolved, ResolveError> {
        self.resolve_at(id, 0)
    }

    /// Resolve a binding against a chosen RECORD INDEX `record` (the §9
    /// record-preview stepper — "show the document resolved against record N").
    /// For the per-record kinds (variable / image / barcode) the expression is
    /// evaluated over `records[record]` (clamped harmlessly to "missing" when
    /// out of range). Whole-result kinds (table / record-flow) resolve their
    /// entire stabilized set regardless of `record` — a per-record preview index
    /// is meaningless for them, so they render in full (the stepper greys their
    /// control). Stamping + the non-destructive sync policy are identical to
    /// [`resolve`](Self::resolve); a preview resolve is still an explicit user
    /// action that re-links. Re-resolution is idempotent (§12.4).
    pub fn resolve_at(
        &mut self,
        id: &BindingId,
        record: usize,
    ) -> Result<Resolved, ResolveError> {
        let binding = self
            .bindings
            .get(id)
            .ok_or_else(|| ResolveError::UnknownBinding(id.clone()))?
            .clone();
        let query_id = binding
            .query()
            .ok_or_else(|| ResolveError::NoQuery(id.clone()))?;
        let records = self
            .results
            .get(query_id)
            .ok_or_else(|| ResolveError::NoResult(query_id.clone()))?;
        let query = self.queries.get(query_id);

        let resolved = match &binding {
            Binding::Variable {
                target,
                expr,
                missing,
                ..
            } => Resolved::Variable(resolve_variable(
                target.clone(),
                expr,
                missing,
                records,
                record,
                &self.params,
                self.today,
                self.locale,
                query.map(|q| &q.shape),
            )),
            Binding::Table {
                region,
                columns,
                options,
                ..
            } => Resolved::Table(resolve_table(
                region.clone(),
                columns,
                options,
                records,
                &self.params,
                self.today,
                self.locale,
            )),
            Binding::RecordFlow {
                chain,
                template,
                options,
                ..
            } => {
                let tmpl = self
                    .templates
                    .get(template)
                    .ok_or_else(|| ResolveError::NoTemplate(template.clone()))?;
                Resolved::RecordFlow(resolve_record_flow(
                    chain.clone(),
                    tmpl,
                    options,
                    records,
                    &self.params,
                    self.today,
                    self.locale,
                ))
            }
            Binding::Image {
                target,
                expr,
                policy,
                ..
            } => Resolved::Image(resolve_image(
                target.clone(),
                expr,
                policy,
                records,
                record,
                &self.params,
                self.today,
                self.locale,
            )),
            Binding::Barcode {
                target,
                symbology,
                expr,
                options,
                ..
            } => Resolved::Barcode(resolve_barcode(
                target.clone(),
                *symbology,
                expr,
                options,
                records,
                record,
                &self.params,
                self.today,
                self.locale,
            )),
            Binding::Rule { .. } => return Err(ResolveError::Unsupported("rule")),
        };

        // Stamp + relink (non-destructive policy already protected pinned/
        // overridden by short-circuiting before a manual resolve is requested;
        // an explicit resolve is the user action that re-links).
        let stamp = self.stamp_for(query_id);
        let st = self
            .sync
            .entry(id.clone())
            .or_insert_with(SyncState::linked);
        st.status = Status::Linked;
        st.last_resolved = Some(stamp);
        Ok(resolved)
    }

    /// Evaluate a data-driven formatting rule (spec §9.5) over a query's records.
    /// A rule is not a standalone resolvable (it carries no query of its own — it
    /// styles content within a scope), so the caller names the records the `when`
    /// condition evaluates against. Returns the stabilized indices that fired +
    /// the [`StyleAction`] to apply. Bit-stable (sheet rules; §12.4).
    pub fn evaluate_rule(
        &self,
        rule_id: &BindingId,
        query_id: &QueryId,
    ) -> Result<RuleEvaluation, ResolveError> {
        let binding = self
            .bindings
            .get(rule_id)
            .ok_or_else(|| ResolveError::UnknownBinding(rule_id.clone()))?;
        let (scope, when, apply) = match binding {
            Binding::Rule { scope, when, apply } => (scope.clone(), when.clone(), apply.clone()),
            _ => return Err(ResolveError::Unsupported("not a rule")),
        };
        let records = self
            .results
            .get(query_id)
            .ok_or_else(|| ResolveError::NoResult(query_id.clone()))?;
        let stable = stabilize(records, &[]);
        let mut fires = Vec::new();
        for row in 0..stable.row_count {
            let ctx = RowCtx {
                records: &stable,
                row,
                params: &self.params,
            };
            if eval_str(
                &when,
                &EvalCtx::new(&ctx, self.today).with_locale(self.locale),
            )
            .as_bool()
            .unwrap_or(false)
            {
                fires.push(row);
            }
        }
        Ok(RuleEvaluation {
            scope,
            fires,
            apply,
            total: stable.row_count,
        })
    }

    /// The resolve stamp for a query's current result + params (§8).
    fn stamp_for(&self, query_id: &QueryId) -> ResolveStamp {
        let content = self.results_hash.get(query_id).copied().unwrap_or(0);
        let params: Vec<(String, Value)> = self
            .params
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        match self.queries.get(query_id) {
            Some(q) => stamp(content, q, &params),
            None => ResolveStamp {
                source_query_hash: content,
                param_hash: data_query::param_hash(&params),
            },
        }
    }
}

/// Resolve a variable binding: pick the record (single/scalar → row 0; a stream
/// → its first record by default, or the preview `record` index, §9), evaluate
/// the expression, and apply the missing policy. An out-of-range `record` is
/// treated as missing (the policy applies), never a panic.
#[allow(clippy::too_many_arguments)]
fn resolve_variable(
    target: PlaceholderRef,
    expr: &str,
    missing: &data_core::MissingPolicy,
    records: &RecordSet,
    record: usize,
    params: &HashMap<String, Value>,
    today: i32,
    locale: Locale,
    _shape: Option<&ResultShape>,
) -> ResolvedVariable {
    if record >= records.row_count {
        // No such record (empty set or out-of-range preview index) → missing.
        return apply_missing(target, Value::Null, missing);
    }
    let ctx = RowCtx {
        records,
        row: record,
        params,
    };
    let ec = EvalCtx::new(&ctx, today).with_locale(locale);
    let value = eval_str(expr, &ec);
    if value.is_null() {
        return apply_missing(target, value, missing);
    }
    ResolvedVariable {
        target,
        display: value.as_display(),
        value,
        hidden: false,
    }
}

/// Apply the missing/null policy to a variable whose value is absent (§9.1).
fn apply_missing(
    target: PlaceholderRef,
    value: Value,
    missing: &data_core::MissingPolicy,
) -> ResolvedVariable {
    use data_core::MissingPolicy;
    match missing {
        MissingPolicy::Blank => ResolvedVariable {
            target,
            value,
            display: String::new(),
            hidden: false,
        },
        MissingPolicy::PlaceholderText { text } => ResolvedVariable {
            target,
            value,
            display: text.clone(),
            hidden: false,
        },
        MissingPolicy::HideParagraph => ResolvedVariable {
            target,
            value,
            display: String::new(),
            hidden: true,
        },
    }
}

/// Resolve a dynamic table: stabilize the rows (stable identity), then evaluate
/// each column's expression per record into a grid of display strings.
#[allow(clippy::too_many_arguments)]
fn resolve_table(
    region: data_core::FrameRef,
    columns: &[data_core::ColumnBind],
    options: &data_core::TableOpts,
    records: &RecordSet,
    params: &HashMap<String, Value>,
    today: i32,
    locale: Locale,
) -> ResolvedTable {
    let stable = stabilize(records, &options.group_by);
    let headers: Vec<String> = columns.iter().map(|c| c.header.clone()).collect();
    let mut rows = Vec::with_capacity(stable.row_count);
    for row in 0..stable.row_count {
        let ctx = RowCtx {
            records: &stable,
            row,
            params,
        };
        let ec = EvalCtx::new(&ctx, today).with_locale(locale);
        let cells: Vec<String> = columns
            .iter()
            .map(|c| eval_str(&c.expr, &ec).as_display())
            .collect();
        rows.push(cells);
    }
    ResolvedTable {
        region,
        headers,
        rows,
    }
}

/// Per-group footer accumulator (§9.4): record count + the running aggregate of
/// the footer's numeric field.
#[derive(Clone, Copy)]
struct FooterAcc {
    count: usize,
    sum: f64,
    min: f64,
    max: f64,
    num: usize,
}

impl FooterAcc {
    fn new() -> Self {
        FooterAcc {
            count: 0,
            sum: 0.0,
            min: f64::INFINITY,
            max: f64::NEG_INFINITY,
            num: 0,
        }
    }

    /// The chosen aggregate; `0.0` when the group has no numeric value.
    fn value(&self, agg: FooterAgg) -> f64 {
        if self.num == 0 {
            return 0.0;
        }
        match agg {
            FooterAgg::Sum => self.sum,
            FooterAgg::Avg => self.sum / self.num as f64,
            FooterAgg::Min => self.min,
            FooterAgg::Max => self.max,
        }
    }
}

/// Resolve a record flow (spec §9.4): stabilize the records (so groups are
/// contiguous + stable), split into sections by the group-by key, and render
/// one template instance per record. Each record instance is atomic (the
/// paginator never splits it); its height is `fields × line_height`.
#[allow(clippy::too_many_arguments)]
fn resolve_record_flow(
    chain: FrameChainRef,
    template: &Template,
    options: &FlowOpts,
    records: &RecordSet,
    params: &HashMap<String, Value>,
    today: i32,
    locale: Locale,
) -> ResolvedRecordFlow {
    let stable = stabilize(records, &options.group_by);
    let key_cols: Vec<usize> = options
        .group_by
        .iter()
        .filter_map(|n| stable.schema.index_of(n))
        .collect();
    let instance_height = template.fields.len() as f64 * template.line_height_pt;

    // The footer's sum column (§9.4 section footer), resolved once.
    let footer_sum_col = options
        .footer
        .as_ref()
        .and_then(|f| f.sum_field.as_ref())
        .and_then(|n| stable.schema.index_of(n));

    let mut groups: Vec<ResolvedFlowGroup> = Vec::new();
    // Per-group footer accumulators (count, sum), aligned with `groups`.
    let mut accums: Vec<FooterAcc> = Vec::new();
    let mut current_key: Option<Vec<Value>> = None;
    for row in 0..stable.row_count {
        let key: Vec<Value> = key_cols
            .iter()
            .map(|&c| stable.value(row, c).cloned().unwrap_or(Value::Null))
            .collect();
        // A new section opens when the group-by key changes. With multi-level
        // grouping, the levels that changed (from the first divergent one) open
        // as a hierarchy: each PARENT level is a header-only section, then the
        // LEAF level (which carries the records). Single-level → one leaf;
        // ungrouped → one headerless leaf.
        if current_key.as_ref() != Some(&key) {
            if key.is_empty() {
                // Ungrouped (or no group-by column resolved) → one section.
                groups.push(ResolvedFlowGroup {
                    header: None,
                    level: 0,
                    records: Vec::new(),
                    footer: None,
                });
                accums.push(FooterAcc::new());
            } else {
                // The first level whose key value changed; open that level and
                // every nested level below it (each parent header-only, the leaf
                // carrying the records).
                let first_changed = match &current_key {
                    None => 0,
                    Some(prev) => (0..key.len())
                        .find(|&i| prev.get(i) != key.get(i))
                        .unwrap_or(0),
                };
                for (level, key_value) in key.iter().enumerate().skip(first_changed) {
                    groups.push(ResolvedFlowGroup {
                        header: Some(key_value.as_display()),
                        level,
                        records: Vec::new(),
                        footer: None,
                    });
                    accums.push(FooterAcc::new());
                }
            }
            current_key = Some(key);
        }

        let ctx = RowCtx {
            records: &stable,
            row,
            params,
        };
        let ec = EvalCtx::new(&ctx, today).with_locale(locale);
        let cells: Vec<String> = template
            .fields
            .iter()
            .map(|f| format!("{}{}", f.label, eval_str(&f.expr, &ec).as_display()))
            .collect();
        groups
            .last_mut()
            .expect("a group was pushed before the first record")
            .records
            .push(ResolvedFlowRecord {
                cells,
                height_pt: instance_height,
            });
        // Accumulate the footer aggregates from the RAW value (not the rendered
        // cell): record count always, sum/min/max over the numeric column.
        let acc = accums.last_mut().expect("an accumulator per group");
        acc.count += 1;
        if let Some(c) = footer_sum_col {
            if let Some(Value::Number(n)) = stable.value(row, c) {
                acc.sum += n;
                acc.min = acc.min.min(*n);
                acc.max = acc.max.max(*n);
                acc.num += 1;
            }
        }
    }

    // Finalize each LEAF group's footer (label `{count}` substitution + the
    // locale-aware aggregate). Header-only parent sections carry no footer.
    if let Some(footer) = &options.footer {
        for (group, acc) in groups.iter_mut().zip(accums) {
            if group.records.is_empty() {
                continue;
            }
            let label = footer.label.replace("{count}", &acc.count.to_string());
            let mut cells = vec![label];
            if footer.sum_field.is_some() {
                // Format the aggregate through the DSL so it honors the locale.
                let ctx = SimpleCtx::new().with_field("__v", Value::Number(acc.value(footer.agg)));
                let ec = EvalCtx::new(&ctx, today).with_locale(locale);
                cells.push(eval_str("NUMBER(__v, 2)", &ec).as_display());
            }
            group.footer = Some(ResolvedFlowRecord {
                cells,
                height_pt: template.line_height_pt,
            });
        }
    }

    ResolvedRecordFlow { chain, groups }
}

/// Resolve an image binding (spec §9.2): evaluate the expression against the
/// record, classify the value into an [`ImageReference`], and apply the missing
/// policy. Text is classified by scheme (`http(s)://` → uri, `asset:` → asset
/// id, else a path); `Bytes` is inline image data; an absent/empty/error value
/// applies the policy (skip / flag / fallback).
#[allow(clippy::too_many_arguments)]
fn resolve_image(
    target: PlaceholderRef,
    expr: &str,
    policy: &ImgPolicy,
    records: &RecordSet,
    record: usize,
    params: &HashMap<String, Value>,
    today: i32,
    locale: Locale,
) -> ResolvedImage {
    let value = if record >= records.row_count {
        Value::Null
    } else {
        let ctx = RowCtx {
            records,
            row: record,
            params,
        };
        eval_str(expr, &EvalCtx::new(&ctx, today).with_locale(locale))
    };

    let reference = match &value {
        Value::Bytes(b) if !b.is_empty() => Some(ImageReference::Bytes { bytes: b.clone() }),
        Value::Text(t) if !t.is_empty() => Some(classify_image_text(t)),
        _ => None, // Null / empty / error → missing
    };

    match reference {
        Some(reference) => ResolvedImage {
            target,
            reference,
            fit: policy.fit,
            status: ImageStatus::Present,
        },
        None => {
            let status = match policy.missing {
                ImgMissing::Skip => ImageStatus::Skipped,
                ImgMissing::Flag => ImageStatus::Flagged,
                ImgMissing::Fallback => ImageStatus::Fallback,
            };
            ResolvedImage {
                target,
                reference: ImageReference::None,
                fit: policy.fit,
                status,
            }
        }
    }
}

/// Resolve a barcode binding (spec §9.7): evaluate the expression against the
/// record into a value string; apply the missing policy when it is empty/null.
/// The symbology encoding is NOT done here — the resolved value is carried to
/// `data-lower` (which owns the encoders). Numbers/dates render through the
/// DSL's display so an EAN expression like a numeric field formats to its digit
/// string.
#[allow(clippy::too_many_arguments)]
fn resolve_barcode(
    target: FrameRef,
    symbology: BarcodeSymbology,
    expr: &str,
    options: &BarcodeOpts,
    records: &RecordSet,
    record: usize,
    params: &HashMap<String, Value>,
    today: i32,
    locale: Locale,
) -> ResolvedBarcode {
    let value = if record >= records.row_count {
        Value::Null
    } else {
        let ctx = RowCtx {
            records,
            row: record,
            params,
        };
        eval_str(expr, &EvalCtx::new(&ctx, today).with_locale(locale))
    };
    let display = if value.is_null() {
        String::new()
    } else {
        value.as_display()
    };
    let status = if display.is_empty() {
        match options.missing {
            BarcodeMissing::Skip => BarcodeResolveStatus::Skipped,
            BarcodeMissing::Flag => BarcodeResolveStatus::Flagged,
        }
    } else {
        BarcodeResolveStatus::Present
    };
    ResolvedBarcode {
        target,
        symbology,
        value: display,
        quiet_zone: options.quiet_zone,
        status,
    }
}

/// Classify an image text reference by scheme.
fn classify_image_text(t: &str) -> ImageReference {
    if t.starts_with("http://") || t.starts_with("https://") {
        ImageReference::Uri { uri: t.to_string() }
    } else if let Some(id) = t.strip_prefix("asset:") {
        ImageReference::AssetId { id: id.to_string() }
    } else {
        ImageReference::Path {
            path: t.to_string(),
        }
    }
}
