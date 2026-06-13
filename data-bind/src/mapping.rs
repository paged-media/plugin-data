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

//! The field-mapping wizard's pure suggestion kernel (spec §9 — the first-run
//! CSV/file-import affordance). Instead of raw SQL only, the author sees the
//! source's COLUMNS (the query result's [`Schema`]) and maps each column → a
//! variable binding with one click. This module computes, per column, the
//! suggested mapping the bundle's wizard renders + (on confirm) generates the
//! binding from: the bound expression is the column REFERENCE, the header is a
//! humanised label, and a kind hint reflects the column's logical type.
//!
//! ALL the data semantics stay in Rust (CLAUDE.md constitution): the bundle does
//! NOT decide what a column maps to or how it is referenced — it renders these
//! suggestions and, on confirm, emits `addVariableBinding(id, …, expr)` with the
//! engine-computed `expr`. The DSL has no bracketed/quoted field syntax, so a
//! column whose name is not a bare identifier is flagged `mappable: false` with
//! an empty `expr` (the wizard asks for a manual expression rather than inventing
//! a quoting grammar the DSL does not have — honest, never faked).

use data_core::{FieldType, Schema};
use data_expr::is_field_ident;
use serde::{Deserialize, Serialize};

/// One column's suggested mapping in the field-mapping wizard (§9). Serialised
/// across the wasm door for the bundle to render + (on confirm) generate the
/// binding from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMapping {
    /// The source column name (the schema field name, verbatim).
    pub column: String,
    /// A humanised header label suggestion (the column name title-cased over
    /// `_`/`-`/space separators — `unit_price` → `Unit Price`). The author may
    /// override it in the wizard.
    pub header: String,
    /// The binding EXPRESSION to generate: a bare field reference to `column`
    /// when that name is a valid DSL identifier, else empty (see `mappable`).
    pub expr: String,
    /// The column's logical type (a kind hint the wizard surfaces — e.g. a
    /// `bytes` column hints an image binding, a `date`/`float` a formatted
    /// variable). Mirrors `data-core::FieldType`.
    pub field_type: FieldType,
    /// Whether the column is one-click mappable: true iff its name is a bare DSL
    /// field identifier, so `expr` references it directly. False → the DSL has no
    /// way to reference this name bare (spaces/punctuation/reserved word); the
    /// wizard asks for a manual expression and `expr` is empty.
    pub mappable: bool,
}

/// Suggest a column → variable-binding mapping for every field of a result
/// schema (spec §9 field-mapping wizard). Pure: schema in, suggestions out —
/// no resolution graph, no SDK. Column order is preserved (the wizard lists the
/// source's headers in their schema order).
pub fn suggest_mappings(schema: &Schema) -> Vec<ColumnMapping> {
    schema
        .fields
        .iter()
        .map(|f| {
            let mappable = is_field_ident(&f.name);
            ColumnMapping {
                column: f.name.clone(),
                header: humanise(&f.name),
                expr: if mappable {
                    f.name.clone()
                } else {
                    String::new()
                },
                field_type: f.ty,
                mappable,
            }
        })
        .collect()
}

/// Humanise a column name into a header label: split on `_`/`-`/space, drop
/// empty segments, and title-case each segment (`unit_price` → `Unit Price`,
/// `SKU` → `SKU`). A name with no separators and mixed case is left as-is apart
/// from capitalising a leading lowercase letter.
fn humanise(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut first_seg = true;
    for seg in name.split(['_', '-', ' ']).filter(|s| !s.is_empty()) {
        if !first_seg {
            out.push(' ');
        }
        first_seg = false;
        // Already-uppercase acronyms (SKU, ID) stay as-is; otherwise capitalise
        // the first letter and keep the rest verbatim.
        if seg.chars().all(|c| c.is_uppercase() || !c.is_alphabetic()) {
            out.push_str(seg);
        } else {
            let mut cs = seg.chars();
            if let Some(c0) = cs.next() {
                out.extend(c0.to_uppercase());
                out.push_str(cs.as_str());
            }
        }
    }
    if out.is_empty() {
        name.to_string()
    } else {
        out
    }
}
