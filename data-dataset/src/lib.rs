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

//! # data-dataset — variables + data sets (spec §9.9)
//!
//! The Illustrator "Variables / data sets" model expressed over paged.data's
//! own bindings. A [`VariableDecl`] is a NAME + a [`VarTrait`]; a [`DataSet`] is
//! a captured snapshot of every variable's value; a [`VariableSet`] holds both
//! and is what the variable-library XML carries.
//!
//! ## What a variable IS here
//!
//! Nothing new. A variable is a **view of a binding** — the binding id is the
//! variable name and the binding kind is the trait:
//!
//! | Illustrator trait | paged.data binding | status |
//! |---|---|---|
//! | `textcontent`   | `Binding::Variable`   | shipped (D-01 tagged placeholder) |
//! | `filereference` | `Binding::Image`      | shipped (D-14 `placeImage`) |
//! | `visibility`    | `Binding::Visibility` | added with this module (§9.8) |
//! | `graphdata`     | — | **NOT bound.** See [`VarTrait::GraphData`]. |
//!
//! So "add variables" is a projection over the shipped binding model, not a
//! second data model. Capture resolves the bindings; apply writes the captured
//! values back through the same host doors the live resolution uses.
//!
//! ## Clean-room note (§3)
//!
//! The XML shape is derived from Adobe's PUBLISHED Variables-namespace
//! documentation and from the structure of files the application itself
//! emits — never from Illustrator source. See [`xml`] for the two deviations
//! this codec declares.

pub mod xml;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub use xml::{from_xml, to_xml, XmlError};

/// The four Illustrator variable traits (§9.9). Serialized in the
/// lowercase-no-separator spelling the XML attribute uses (`textcontent`,
/// `filereference`, `visibility`, `graphdata`) so the wire form round-trips
/// without a translation table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VarTrait {
    /// A text string substituted into content — `Binding::Variable`, placed as a
    /// D-01 tagged placeholder field.
    TextContent,
    /// A linked file that swaps a placed image — `Binding::Image`, placed
    /// through the core asset mechanism (`placeImage`, D-14).
    FileReference,
    /// A shown/hidden decision for a page element — `Binding::Visibility`,
    /// written as the element's own `elementVisible` property (§9.8).
    Visibility,
    /// Graph series data.
    ///
    /// **Carried, never resolved.** paged.data has no chart surface and the
    /// isolation contract (§2.1) forbids reaching into the plugin that does, so
    /// a `graphdata` variable is READ, PRESERVED and RE-EMITTED by this codec
    /// but has no binding to resolve against and is never applied to a document.
    /// Closing it needs a cross-plugin chart-data contract through the core SDK
    /// (RFI D-15) — not a dependency. Round-tripping it instead of dropping it
    /// is the honest half: an imported Illustrator library keeps its graph
    /// variables so re-export does not silently lose the author's work.
    GraphData,
}

impl VarTrait {
    /// The XML `trait` attribute spelling.
    pub fn as_xml(&self) -> &'static str {
        match self {
            VarTrait::TextContent => "textcontent",
            VarTrait::FileReference => "filereference",
            VarTrait::Visibility => "visibility",
            VarTrait::GraphData => "graphdata",
        }
    }

    /// Parse the XML `trait` attribute (case-insensitive). Unknown traits are
    /// rejected rather than coerced — a library from a newer Illustrator would
    /// otherwise import as the wrong kind.
    pub fn from_xml(s: &str) -> Option<VarTrait> {
        match s.trim().to_ascii_lowercase().as_str() {
            "textcontent" => Some(VarTrait::TextContent),
            "filereference" => Some(VarTrait::FileReference),
            "visibility" => Some(VarTrait::Visibility),
            "graphdata" => Some(VarTrait::GraphData),
            _ => None,
        }
    }

    /// Whether this trait is backed by a resolvable paged.data binding. `false`
    /// for [`VarTrait::GraphData`] (see its docs).
    pub fn is_bindable(&self) -> bool {
        !matches!(self, VarTrait::GraphData)
    }
}

/// A declared variable: the name authors see + the trait that decides which
/// binding kind resolves it. The name IS the binding id (§9.9) — one namespace,
/// so a data set and the resolution graph can never drift apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableDecl {
    pub name: String,
    #[serde(rename = "trait")]
    pub var_trait: VarTrait,
}

/// One captured value in a data set. The variant matches its variable's trait;
/// a mismatch is a load-time rejection, never a coercion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DataSetValue {
    /// A captured display string (`textcontent`). Multi-paragraph values keep
    /// their `\n` separators — the XML carries one `<p>` per line.
    Text { text: String },
    /// A captured file reference (`filereference`) — the URI/path the image
    /// binding resolved to.
    FileRef { href: String },
    /// A captured visibility decision (`visibility`).
    Visible { visible: bool },
    /// An opaque captured graph payload (`graphdata`), preserved verbatim for
    /// re-export. Never applied to a document (see [`VarTrait::GraphData`]).
    GraphData { raw: String },
}

impl DataSetValue {
    /// The trait this value belongs to.
    pub fn var_trait(&self) -> VarTrait {
        match self {
            DataSetValue::Text { .. } => VarTrait::TextContent,
            DataSetValue::FileRef { .. } => VarTrait::FileReference,
            DataSetValue::Visible { .. } => VarTrait::Visibility,
            DataSetValue::GraphData { .. } => VarTrait::GraphData,
        }
    }

    /// The XML text body of this value (one entry per `<p>` line).
    pub fn xml_lines(&self) -> Vec<String> {
        match self {
            DataSetValue::Text { text } => text.split('\n').map(|s| s.to_string()).collect(),
            DataSetValue::FileRef { href } => vec![href.clone()],
            DataSetValue::Visible { visible } => {
                vec![if *visible { "true" } else { "false" }.to_string()]
            }
            DataSetValue::GraphData { raw } => vec![raw.clone()],
        }
    }

    /// Rebuild a value of `var_trait` from the joined `<p>` body. Visibility
    /// accepts Illustrator's `true`/`false` and the tolerant `1`/`0`/`yes`/`no`
    /// spellings; anything else is a typed error rather than a silent `false`.
    pub fn from_xml_body(var_trait: VarTrait, body: &str) -> Result<DataSetValue, XmlError> {
        Ok(match var_trait {
            VarTrait::TextContent => DataSetValue::Text {
                text: body.to_string(),
            },
            VarTrait::FileReference => DataSetValue::FileRef {
                href: body.trim().to_string(),
            },
            VarTrait::Visibility => match body.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" => DataSetValue::Visible { visible: true },
                "false" | "0" | "no" => DataSetValue::Visible { visible: false },
                other => return Err(XmlError::BadVisibility(other.to_string())),
            },
            VarTrait::GraphData => DataSetValue::GraphData {
                raw: body.to_string(),
            },
        })
    }
}

/// A named data set: one captured value per variable (§9.9). `BTreeMap` keeps
/// the serialization order deterministic — two captures of the same state emit
/// byte-identical XML, which is what makes the round-trip test meaningful.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSet {
    pub name: String,
    pub values: BTreeMap<String, DataSetValue>,
}

/// A variable set: the declarations + every captured data set (§9.9). This is
/// the unit the variable-library XML carries and the unit the document payload
/// persists.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableSet {
    /// The set name (Illustrator's `varSetName`; `binding1` in its own exports).
    pub name: String,
    pub variables: Vec<VariableDecl>,
    pub data_sets: Vec<DataSet>,
}

impl VariableSet {
    /// A fresh, empty set.
    pub fn new(name: impl Into<String>) -> Self {
        VariableSet {
            name: name.into(),
            variables: Vec::new(),
            data_sets: Vec::new(),
        }
    }

    /// Look a declaration up by name.
    pub fn declaration(&self, name: &str) -> Option<&VariableDecl> {
        self.variables.iter().find(|v| v.name == name)
    }

    /// Look a data set up by name.
    pub fn data_set(&self, name: &str) -> Option<&DataSet> {
        self.data_sets.iter().find(|d| d.name == name)
    }

    /// Insert or replace a data set by name, keeping insertion order stable for
    /// an existing name (capturing over an existing set does not reorder the
    /// palette).
    pub fn upsert_data_set(&mut self, set: DataSet) {
        match self.data_sets.iter_mut().find(|d| d.name == set.name) {
            Some(existing) => *existing = set,
            None => self.data_sets.push(set),
        }
    }

    /// Remove a data set by name; `true` when one was removed.
    pub fn remove_data_set(&mut self, name: &str) -> bool {
        let before = self.data_sets.len();
        self.data_sets.retain(|d| d.name != name);
        self.data_sets.len() != before
    }

    /// Insert or replace a declaration by name.
    pub fn upsert_variable(&mut self, decl: VariableDecl) {
        match self.variables.iter_mut().find(|v| v.name == decl.name) {
            Some(existing) => *existing = decl,
            None => self.variables.push(decl),
        }
    }

    /// Validate that every captured value matches its declaration's trait and
    /// that no captured value names an undeclared variable. Returns the list of
    /// problems (empty ⇒ consistent) rather than a bool, so a panel can say
    /// WHICH variable is wrong.
    pub fn inconsistencies(&self) -> Vec<String> {
        let mut out = Vec::new();
        for set in &self.data_sets {
            for (name, value) in &set.values {
                match self.declaration(name) {
                    None => out.push(format!(
                        "data set '{}': value for undeclared variable '{name}'",
                        set.name
                    )),
                    Some(decl) if decl.var_trait != value.var_trait() => out.push(format!(
                        "data set '{}': variable '{name}' is declared {} but captured {}",
                        set.name,
                        decl.var_trait.as_xml(),
                        value.var_trait().as_xml()
                    )),
                    Some(_) => {}
                }
            }
        }
        out
    }
}

/// The binding kind a variable trait resolves against (§9.9). Returned as the
/// `kind` tag string of [`data_core::Binding`] so callers can match a declared
/// variable to a defined binding without this crate depending on the resolver.
/// `None` for [`VarTrait::GraphData`] — there is nothing to match.
pub fn binding_kind_for(var_trait: VarTrait) -> Option<&'static str> {
    match var_trait {
        VarTrait::TextContent => Some("variable"),
        VarTrait::FileReference => Some("image"),
        VarTrait::Visibility => Some("visibility"),
        VarTrait::GraphData => None,
    }
}

/// The variable trait a binding kind projects to (the inverse of
/// [`binding_kind_for`]). `None` for binding kinds that are not variables in the
/// Illustrator sense (`table`, `recordFlow`, `rule`, `barcode`) — those are
/// paged.data capabilities with no Illustrator variable counterpart, and
/// pretending otherwise would put un-capturable rows in the palette.
pub fn trait_for_binding_kind(kind: &str) -> Option<VarTrait> {
    match kind {
        "variable" => Some(VarTrait::TextContent),
        "image" => Some(VarTrait::FileReference),
        "visibility" => Some(VarTrait::Visibility),
        _ => None,
    }
}
