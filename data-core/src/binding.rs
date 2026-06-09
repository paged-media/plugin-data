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

//! The binding + placeholder + sync types (spec §5.1, §5.2, §8). [`Binding`] is
//! the heart of the plugin — it connects a query result to a document target.
//! Expressions are carried as **source strings** (not the AST), so the binding
//! is the document's serializable *recipe*; `data-bind` parses + caches them.
//!
//! M0 implements the `Variable` + `Table` kinds end-to-end (resolve + lower).
//! `Image`, `RecordFlow`, and `Rule` are constructible (the frozen contract)
//! but lower at M1+ (BREAKAGE D-02b/D-12/D-13).

use serde::{Deserialize, Serialize};

use crate::ids::{
    BindingId, FrameChainRef, FrameRef, PlaceholderRef, QueryId, ScopeRef, TemplateRef,
};

/// A binding definition with its document-scoped id (spec §5.1). The id is the
/// payload key; the inner [`Binding`] is the recipe.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BindingDef {
    pub id: BindingId,
    #[serde(flatten)]
    pub binding: Binding,
}

/// The binding kinds (spec §5.1). Expressions are source strings (re-parsed by
/// `data-expr`); `query` names the result the expression/columns resolve
/// against.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Binding {
    /// A tagged placeholder in a text run resolves to a formatted field value
    /// via a binding expression (§9.1). M0.
    Variable {
        target: PlaceholderRef,
        query: QueryId,
        /// The binding expression (source). Evaluated against the resolved
        /// record; `missing` governs null/absent results.
        expr: String,
        #[serde(default)]
        missing: MissingPolicy,
    },
    /// A field yields an image reference placed through the core asset mechanism
    /// (§9.2, never `plugin-image`). M1.
    Image {
        target: PlaceholderRef,
        query: QueryId,
        expr: String,
        #[serde(default)]
        policy: ImgPolicy,
    },
    /// A query result lowers to native table content — one row per record (§9.3).
    /// M0 (single region; lowering degrades to tab-text + rules, D-02).
    Table {
        region: FrameRef,
        query: QueryId,
        columns: Vec<ColumnBind>,
        #[serde(default)]
        options: TableOpts,
    },
    /// Records flow through a frame chain, one template instance per record
    /// (§9.4 — the catalog engine). M1.
    RecordFlow {
        chain: FrameChainRef,
        query: QueryId,
        template: TemplateRef,
        #[serde(default)]
        options: FlowOpts,
    },
    /// A conditional rule drives styling through document styles (§9.5). M1.
    Rule {
        scope: ScopeRef,
        /// The condition (source) — `when: Expr → apply: StyleAction`.
        when: String,
        apply: StyleAction,
    },
}

impl Binding {
    /// The query this binding resolves against, if any (a `Rule` has none — it
    /// applies over a scope's resolved context).
    pub fn query(&self) -> Option<&QueryId> {
        match self {
            Binding::Variable { query, .. }
            | Binding::Image { query, .. }
            | Binding::Table { query, .. }
            | Binding::RecordFlow { query, .. } => Some(query),
            Binding::Rule { .. } => None,
        }
    }
}

/// A column → field mapping for a dynamic table (§9.3). The per-column `expr`
/// (source) formats/derives the cell from the record; `style` names a document
/// style (never a literal).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColumnBind {
    pub header: String,
    pub expr: String,
    #[serde(default)]
    pub style: Option<String>,
}

/// Per-binding policy for a missing/null variable value (§9.1).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "missing", rename_all = "camelCase")]
pub enum MissingPolicy {
    /// Render nothing (the empty string).
    #[default]
    Blank,
    /// Render a fixed placeholder text.
    PlaceholderText { text: String },
    /// Hide the containing paragraph entirely.
    HideParagraph,
}

/// Image placeholder policy (§9.2). M1 lowering — the fields are frozen now.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ImgPolicy {
    #[serde(default)]
    pub fit: ImgFit,
    #[serde(default)]
    pub missing: ImgMissing,
}

/// How a placed image fits its frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImgFit {
    #[default]
    Fit,
    Fill,
    Crop,
}

/// What to do when an image asset is missing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImgMissing {
    #[default]
    Skip,
    Flag,
    Fallback,
}

/// Dynamic-table options (§9.3). M0 honors `header_row`; grouping is M1.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TableOpts {
    #[serde(default = "default_true")]
    pub header_row: bool,
    #[serde(default)]
    pub group_by: Vec<String>,
}

fn default_true() -> bool {
    true
}

/// Record-flow options (§9.4). M1 — frozen now.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct FlowOpts {
    #[serde(default)]
    pub group_by: Vec<String>,
    #[serde(default)]
    pub keep_together: bool,
    #[serde(default)]
    pub continued_marker: bool,
}

/// A data-driven styling action (§9.5) — always a document-style reference,
/// never a color literal. M1 — frozen now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum StyleAction {
    /// Apply a named character style.
    CharacterStyle { name: String },
    /// Apply a named paragraph style.
    ParagraphStyle { name: String },
    /// Apply a named table/cell style.
    TableStyle { name: String },
}

// ── Synchronization state (spec §8) ────────────────────────────────────────

/// The sync status of a binding/target (spec §8). The conflict policy is
/// **non-destructive**: a refresh never overwrites `Overridden`/`Pinned`
/// without explicit user action (§8, D-6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// Tracks the source live.
    #[default]
    Linked,
    /// Frozen to a snapshot (EasyCatalog "pinning"); ignores refreshes.
    Pinned,
    /// A manual edit replaced the resolved value; flagged + preserved.
    Overridden,
    /// Source changed but not re-resolved.
    Stale,
    /// Resolution failed (carries a diagnostic elsewhere).
    Error,
}

/// A content fingerprint of the inputs that produced a resolved value (spec §8).
/// Two stamps are equal iff source content + query + params match — the
/// invalidation key for the resolution graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ResolveStamp {
    /// Hash of the source content + query SQL/shape.
    pub source_query_hash: u64,
    /// Hash of the bound parameter set.
    pub param_hash: u64,
}

/// Per binding/target sync state (spec §5.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SyncState {
    pub status: Status,
    #[serde(default)]
    pub last_resolved: Option<ResolveStamp>,
}

impl SyncState {
    /// A freshly-linked, never-resolved state.
    pub fn linked() -> Self {
        SyncState {
            status: Status::Linked,
            last_resolved: None,
        }
    }

    /// Whether a refresh is allowed to overwrite this target's content. The
    /// non-destructive policy protects `Pinned` + `Overridden` (§8, D-6).
    pub fn accepts_refresh(&self) -> bool {
        !matches!(self.status, Status::Pinned | Status::Overridden)
    }
}

// ── Placeholders (spec §5.2) ───────────────────────────────────────────────

/// A named, edit-surviving insertion point in document content (spec §5.2). The
/// binding's anchor. Depends on the SDK tagged-placeholder model (BREAKAGE
/// D-01); M0 anchors coarsely by element id (the `anchor` element), the named
/// in-run `slot` awaiting D-01.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Placeholder {
    pub id: PlaceholderRef,
    pub kind: PlaceholderKind,
    /// The host element this placeholder lives in.
    pub anchor: String,
    /// An optional named slot within a text run (D-01; `None` at M0).
    #[serde(default)]
    pub slot: Option<String>,
}

/// What a placeholder anchors (spec §5.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaceholderKind {
    /// A tagged text run for a variable (§9.1).
    TextVariable,
    /// An empty frame marked image-target (§9.2).
    ImageTarget,
    /// A frame marked table region (§9.3).
    TableRegion,
    /// A frame (chain) marked flow region (§9.4).
    FlowRegion,
}
