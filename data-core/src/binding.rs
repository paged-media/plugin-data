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
    /// A field value is rendered as a barcode/QR symbol onto a bound frame
    /// (§9.7 — the EasyCatalog catalog staple). The `expr` resolves to a string
    /// (an EAN/UPC number, or arbitrary text for Code-128/QR); the engine
    /// generates the symbology geometry; the bundle lowers it as filled-rect
    /// vector modules scaled to the frame's content box (the VECTOR lane — no
    /// asset-store door).
    Barcode {
        /// The bound frame the symbol is rendered onto.
        target: FrameRef,
        query: QueryId,
        /// The barcode symbology to render.
        symbology: BarcodeSymbology,
        /// The binding expression (source) — resolves to the value to encode.
        expr: String,
        /// Policy for an empty / unencodable value.
        #[serde(default)]
        options: BarcodeOpts,
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
            | Binding::RecordFlow { query, .. }
            | Binding::Barcode { query, .. } => Some(query),
            Binding::Rule { .. } => None,
        }
    }
}

/// The barcode symbologies a [`Binding::Barcode`] can render (§9.7). The frozen
/// wire shape; `data-barcode::Symbology` mirrors it 1:1 and the engine bridges
/// the two. The registry rows are `data.barcode.<id>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BarcodeSymbology {
    /// EAN-13 — the 13-digit retail/catalog staple.
    Ean13,
    /// UPC-A — the 12-digit North-American retail code.
    UpcA,
    /// Code-128 — a general-purpose 1D symbology over ASCII.
    Code128,
    /// QR — the 2D matrix symbology (byte mode).
    Qr,
}

/// Per-barcode-binding options (§9.7). `quiet_zone` lets the author widen the
/// symbology's default light margin (in module units); `missing` governs an
/// empty resolved value.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BarcodeOpts {
    /// Extra quiet-zone modules added on each side beyond the symbology default
    /// (0 = the symbology's own minimum).
    #[serde(default)]
    pub quiet_zone: u32,
    /// What to do when the resolved value is empty (no record / null).
    #[serde(default)]
    pub missing: BarcodeMissing,
}

/// What a barcode binding does when its value is absent/empty (§9.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BarcodeMissing {
    /// Render nothing (no symbol drawn).
    #[default]
    Skip,
    /// Flag the binding for review (the panel surfaces it).
    Flag,
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

/// A resolved image reference (§9.2). A field value classifies into one of
/// these: a remote `Uri`, a local `Path`, a document `AssetId`, inline `Bytes`,
/// or `None` (missing/absent). The image is placed through the core asset
/// mechanism — never `plugin-image` (§2.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "ref", rename_all = "camelCase")]
pub enum ImageReference {
    Uri { uri: String },
    Path { path: String },
    AssetId { id: String },
    Bytes { bytes: Vec<u8> },
    None,
}

/// The outcome of resolving an image binding after the missing policy (§9.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImageStatus {
    /// A reference resolved.
    Present,
    /// Absent + the `Skip` policy — nothing placed.
    Skipped,
    /// Absent + the `Flag` policy — flagged for review.
    Flagged,
    /// Absent + the `Fallback` policy — a fallback asset is expected.
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

/// Record-flow options (§9.4).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowOpts {
    /// Group records by these field(s); a section header precedes each group.
    #[serde(default)]
    pub group_by: Vec<String>,
    /// Re-emit the group's section header (with a "continued" marker) when the
    /// group spills onto a new frame.
    #[serde(default)]
    pub repeat_header: bool,
    /// Add "continued" markers when a group continues across frames.
    #[serde(default)]
    pub continued_marker: bool,
    /// An optional section FOOTER per group (§9.4 "section headers/footers"): a
    /// subtotal/count row rendered at each group's end.
    #[serde(default)]
    pub footer: Option<GroupFooter>,
}

/// A per-group section footer (§9.4): a labelled subtotal row at the end of each
/// group. `label` may contain `{count}`, replaced with the group's record count;
/// `sum_field`, when set, names a numeric column aggregated across the group by
/// `agg` (the result rendered locale-aware to 2 decimals).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupFooter {
    /// The footer label, e.g. `"Subtotal"` or `"{count} items"`.
    pub label: String,
    /// A numeric column to aggregate across the group, if any.
    #[serde(default)]
    pub sum_field: Option<String>,
    /// Which aggregate of `sum_field` to show (default `Sum`).
    #[serde(default)]
    pub agg: FooterAgg,
}

/// The aggregate a group footer reports over its numeric field (§9.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FooterAgg {
    /// The total (the default).
    #[default]
    Sum,
    /// The mean over the numeric values.
    Avg,
    /// The smallest value.
    Min,
    /// The largest value.
    Max,
}

/// A designed per-record template — the "catalog cell" (§9.4). The engine
/// renders one instance per record (each field is one line); the paginated
/// height of an instance is `fields.len() × line_height_pt`. (Real host layout
/// with measured heights lands with the SDK frame-chain door — BREAKAGE D-12;
/// the M1 engine uses this measurable model over a caller-supplied chain.)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: TemplateRef,
    pub fields: Vec<TemplateField>,
    pub line_height_pt: f64,
}

/// One field line of a [`Template`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TemplateField {
    /// A static label prefix (or empty).
    #[serde(default)]
    pub label: String,
    /// The field expression (source) evaluated per record.
    pub expr: String,
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
