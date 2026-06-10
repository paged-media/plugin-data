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
    Binding, BindingId, FlowOpts, FrameChainRef, ImageReference, ImageStatus, ImgFit, ImgMissing,
    ImgPolicy, Placeholder, PlaceholderRef, Query, QueryId, RecordSet, ResolveStamp, ResultShape,
    ScopeRef, Status, StyleAction, SyncState, Template, TemplateRef, Value,
};
use data_expr::{eval_str, EvalCtx, RecordCtx};
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

/// One section of a [`ResolvedRecordFlow`].
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedFlowGroup {
    /// The section header text (the group-by key), or `None` when ungrouped.
    pub header: Option<String>,
    pub records: Vec<ResolvedFlowRecord>,
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
}

impl ResolutionEngine {
    /// A fresh engine with an injected `today` serial (days since 1970-01-01).
    pub fn new(today: i32) -> Self {
        ResolutionEngine {
            today,
            ..Default::default()
        }
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
    pub fn resolve(&mut self, id: &BindingId) -> Result<Resolved, ResolveError> {
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
                &self.params,
                self.today,
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
                &self.params,
                self.today,
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
            if eval_str(&when, &EvalCtx::new(&ctx, self.today))
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
/// → its first record), evaluate the expression, and apply the missing policy.
#[allow(clippy::too_many_arguments)]
fn resolve_variable(
    target: PlaceholderRef,
    expr: &str,
    missing: &data_core::MissingPolicy,
    records: &RecordSet,
    params: &HashMap<String, Value>,
    today: i32,
    _shape: Option<&ResultShape>,
) -> ResolvedVariable {
    if records.row_count == 0 {
        // No record at all → treat as missing.
        return apply_missing(target, Value::Null, missing);
    }
    let ctx = RowCtx {
        records,
        row: 0,
        params,
    };
    let ec = EvalCtx::new(&ctx, today);
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
fn resolve_table(
    region: data_core::FrameRef,
    columns: &[data_core::ColumnBind],
    options: &data_core::TableOpts,
    records: &RecordSet,
    params: &HashMap<String, Value>,
    today: i32,
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
        let ec = EvalCtx::new(&ctx, today);
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

/// Resolve a record flow (spec §9.4): stabilize the records (so groups are
/// contiguous + stable), split into sections by the group-by key, and render
/// one template instance per record. Each record instance is atomic (the
/// paginator never splits it); its height is `fields × line_height`.
fn resolve_record_flow(
    chain: FrameChainRef,
    template: &Template,
    options: &FlowOpts,
    records: &RecordSet,
    params: &HashMap<String, Value>,
    today: i32,
) -> ResolvedRecordFlow {
    let stable = stabilize(records, &options.group_by);
    let key_cols: Vec<usize> = options
        .group_by
        .iter()
        .filter_map(|n| stable.schema.index_of(n))
        .collect();
    let instance_height = template.fields.len() as f64 * template.line_height_pt;

    let mut groups: Vec<ResolvedFlowGroup> = Vec::new();
    let mut current_key: Option<Vec<Value>> = None;
    for row in 0..stable.row_count {
        let key: Vec<Value> = key_cols
            .iter()
            .map(|&c| stable.value(row, c).cloned().unwrap_or(Value::Null))
            .collect();
        // A new group starts whenever the group-by key changes (ungrouped → one
        // group, since the key is always the empty tuple).
        if current_key.as_ref() != Some(&key) {
            let header = if options.group_by.is_empty() {
                None
            } else {
                Some(
                    key.iter()
                        .map(Value::as_display)
                        .collect::<Vec<_>>()
                        .join(" · "),
                )
            };
            groups.push(ResolvedFlowGroup {
                header,
                records: Vec::new(),
            });
            current_key = Some(key);
        }

        let ctx = RowCtx {
            records: &stable,
            row,
            params,
        };
        let ec = EvalCtx::new(&ctx, today);
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
    }

    ResolvedRecordFlow { chain, groups }
}

/// Resolve an image binding (spec §9.2): evaluate the expression against the
/// record, classify the value into an [`ImageReference`], and apply the missing
/// policy. Text is classified by scheme (`http(s)://` → uri, `asset:` → asset
/// id, else a path); `Bytes` is inline image data; an absent/empty/error value
/// applies the policy (skip / flag / fallback).
fn resolve_image(
    target: PlaceholderRef,
    expr: &str,
    policy: &ImgPolicy,
    records: &RecordSet,
    params: &HashMap<String, Value>,
    today: i32,
) -> ResolvedImage {
    let value = if records.row_count == 0 {
        Value::Null
    } else {
        let ctx = RowCtx {
            records,
            row: 0,
            params,
        };
        eval_str(expr, &EvalCtx::new(&ctx, today))
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
