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

//! The variable-library XML codec (spec §9.9) — Illustrator-compatible.
//!
//! ## The shape
//!
//! ```xml
//! <svg xmlns:v="http://ns.adobe.com/Variables/1.0/" ...>
//!   <variableSets xmlns="http://ns.adobe.com/Variables/1.0/">
//!     <variableSet varSetName="binding1" locked="none">
//!       <variables>
//!         <variable varName="Name"  trait="textcontent"   category="..."/>
//!         <variable varName="Photo" trait="filereference" category="..."/>
//!         <variable varName="Badge" trait="visibility"    category="..."/>
//!       </variables>
//!       <v:sampleDataSets xmlns="http://ns.adobe.com/GenericCustomNamespace/1.0/">
//!         <v:sampleDataSet dataSetName="Data Set 1">
//!           <Name><p>Alice</p></Name>
//!           <Photo><p>images/alice.png</p></Photo>
//!           <Badge><p>true</p></Badge>
//!         </v:sampleDataSet>
//!       </v:sampleDataSets>
//!     </variableSet>
//!   </variableSets>
//! </svg>
//! ```
//!
//! ## The TWO declared deviations (do not discover these later)
//!
//! 1. **We do not emit Adobe's DTD entity subset.** Illustrator writes its
//!    namespace declarations as *entity references* — `xmlns:v="&ns_vars;"` —
//!    backed by an internal DTD subset. Those entities are undefined to every
//!    conforming XML parser but Adobe's, so a strict parser rejects the file. We
//!    WRITE the resolved namespace URIs instead (well-formed XML, same
//!    namespaces) and we READ either form, because the reader matches on LOCAL
//!    NAMES and never resolves an entity. Consequence to state plainly: our
//!    export is valid XML that carries the same information; whether the
//!    Illustrator importer accepts a URI where it wrote an entity is UNVERIFIED
//!    here — no Illustrator was run (clean-room, §3).
//!
//! 2. **`graphdata` values are opaque.** We round-trip the element body verbatim
//!    but never interpret it (there is no chart surface in this plugin and the
//!    isolation contract forbids reaching into the one that has it — RFI D-15).
//!
//! Everything else — element names, attribute names, the `<p>`-per-line body,
//! the `varSetName`/`dataSetName`/`varName`/`trait` attributes — matches.
//!
//! The reader is deliberately namespace-INSENSITIVE: it dispatches on the local
//! name after the last `:`. Illustrator moves these elements between the default
//! and the `v:` prefix depending on version and on whether the library was saved
//! from the palette or embedded in a document, and a prefix-sensitive reader
//! silently reads such a file as empty.

use quick_xml::escape::{escape, unescape};
use quick_xml::events::Event;
use quick_xml::Reader;
use thiserror::Error;

use crate::{DataSet, DataSetValue, VarTrait, VariableDecl, VariableSet};

/// The Adobe Variables namespace (the `ns_vars` entity's value).
pub const NS_VARS: &str = "http://ns.adobe.com/Variables/1.0/";
/// The Adobe generic-custom namespace the sample data sets live in (`ns_custom`).
pub const NS_CUSTOM: &str = "http://ns.adobe.com/GenericCustomNamespace/1.0/";
/// The Adobe Flows namespace used as the default variable `category` (`ns_flows`).
pub const NS_FLOWS: &str = "http://ns.adobe.com/Flows/1.0/";
/// The Adobe Graphs namespace — the `category` a `graphdata` variable carries.
pub const NS_GRAPHS: &str = "http://ns.adobe.com/Graphs/1.0/";
/// The Adobe Illustrator namespace (`ns_ai`), declared on the root like Adobe does.
pub const NS_AI: &str = "http://ns.adobe.com/AdobeIllustrator/10.0/";
/// The Adobe Extensibility namespace (`ns_extend`), declared on the root.
pub const NS_EXTEND: &str = "http://ns.adobe.com/Extensibility/1.0/";

/// A variable-library XML failure. Every arm names the offending thing — a
/// library that will not load must say which variable broke it.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum XmlError {
    /// The document is not well-formed.
    #[error("malformed variable-library XML: {0}")]
    Malformed(String),
    /// No `<variableSets>`/`<variableSet>` element anywhere in the document.
    #[error("no <variableSet> found — this is not a variable library")]
    NoVariableSet,
    /// A `<variable>` element carried an unknown `trait`.
    #[error(
        "unknown variable trait '{0}' (expected textcontent/filereference/visibility/graphdata)"
    )]
    UnknownTrait(String),
    /// A `<variable>` element carried no `varName`.
    #[error("a <variable> element has no varName attribute")]
    UnnamedVariable,
    /// A data set carried a value for a variable that is not declared.
    #[error("data set '{data_set}' has a value for undeclared variable '{variable}'")]
    UndeclaredVariable { data_set: String, variable: String },
    /// A visibility value was neither true nor false.
    #[error("visibility value '{0}' is neither true nor false")]
    BadVisibility(String),
}

/// The local name of a tag — everything after the last `:` (see the
/// namespace-insensitivity note in the module docs).
fn local(name: &[u8]) -> &str {
    let s = std::str::from_utf8(name).unwrap_or("");
    match s.rfind(':') {
        Some(i) => &s[i + 1..],
        None => s,
    }
}

/// Read an attribute by LOCAL name, raw (never unescaped): the values we care
/// about — `varSetName`, `varName`, `trait`, `dataSetName` — are plain
/// identifiers, and NOT unescaping is exactly what lets an Illustrator file
/// whose sibling attributes hold undefined entity references (`&ns_vars;`) parse
/// at all.
fn attr(e: &quick_xml::events::BytesStart<'_>, want: &str) -> Option<String> {
    for a in e.attributes().with_checks(false).flatten() {
        if local(a.key.as_ref()).eq_ignore_ascii_case(want) {
            return Some(String::from_utf8_lossy(a.value.as_ref()).into_owned());
        }
    }
    None
}

/// Where the reader currently is. A data-set VALUE element is any element
/// directly under a `sampleDataSet` whose name is a declared variable — so the
/// state machine has to know it is inside one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Where {
    Outside,
    InVariables,
    InDataSet,
    InValue,
}

/// Parse a variable library (spec §9.9). Tolerant by design — see the module
/// docs for what "tolerant" covers and what it does NOT (an unknown `trait` is
/// still a hard error: importing it as the wrong kind would corrupt a document).
///
/// Reads the FIRST `<variableSet>` in the document. Illustrator writes exactly
/// one; a file with several is not a shape we can honestly merge, so the extras
/// are ignored rather than silently concatenated.
pub fn from_xml(src: &str) -> Result<VariableSet, XmlError> {
    let mut reader = Reader::from_str(src);
    let config = reader.config_mut();
    config.trim_text(true);
    config.check_end_names = false;

    let mut set: Option<VariableSet> = None;
    let mut state = Where::Outside;
    let mut current_set: Option<DataSet> = None;
    let mut current_var: Option<String> = None;
    let mut current_lines: Vec<String> = Vec::new();
    let mut depth_in_value: usize = 0;
    let mut seen_first_set = false;

    loop {
        let ev = reader
            .read_event()
            .map_err(|e| XmlError::Malformed(e.to_string()))?;
        match ev {
            Event::Eof => break,
            Event::Start(ref e) | Event::Empty(ref e) => {
                let empty = matches!(ev, Event::Empty(_));
                let name = local(e.name().as_ref()).to_string();
                match (state, name.as_str()) {
                    (Where::Outside, "variableSet") => {
                        if seen_first_set {
                            continue;
                        }
                        seen_first_set = true;
                        set = Some(VariableSet::new(
                            attr(e, "varSetName").unwrap_or_else(|| "binding1".to_string()),
                        ));
                    }
                    (Where::Outside, "variables") if !empty => state = Where::InVariables,
                    (Where::InVariables, "variable") => {
                        let vs = set.as_mut().ok_or(XmlError::NoVariableSet)?;
                        let vname = attr(e, "varName").ok_or(XmlError::UnnamedVariable)?;
                        let traw = attr(e, "trait").unwrap_or_default();
                        let var_trait =
                            VarTrait::from_xml(&traw).ok_or(XmlError::UnknownTrait(traw))?;
                        vs.upsert_variable(VariableDecl {
                            name: vname,
                            var_trait,
                        });
                    }
                    (Where::Outside, "sampleDataSet") if !empty => {
                        state = Where::InDataSet;
                        current_set = Some(DataSet {
                            name: attr(e, "dataSetName").unwrap_or_else(|| "Data Set".to_string()),
                            values: Default::default(),
                        });
                    }
                    (Where::InDataSet, _) if !empty => {
                        state = Where::InValue;
                        current_var = Some(name);
                        current_lines.clear();
                        depth_in_value = 0;
                    }
                    // A self-closing value element (`<Photo/>`) is an EMPTY value,
                    // not a missing one — capture it as such.
                    (Where::InDataSet, _) => {
                        let vs = set.as_mut().ok_or(XmlError::NoVariableSet)?;
                        let ds = current_set.as_mut().expect("in a data set");
                        push_value(vs, ds, &name, "")?;
                    }
                    // `<p>` (or any wrapper) inside a value — track depth so the
                    // matching End does not close the value element.
                    (Where::InValue, _) if !empty => depth_in_value += 1,
                    _ => {}
                }
            }
            Event::Text(ref t) => {
                if state == Where::InValue {
                    let raw = t
                        .decode()
                        .map(|c| c.into_owned())
                        .unwrap_or_else(|_| String::from_utf8_lossy(t.as_ref()).into_owned());
                    // An undefined entity inside a value body must not abort the
                    // whole library — keep the raw text when unescaping fails.
                    let s = unescape(&raw).map(|c| c.into_owned()).unwrap_or(raw);
                    if !s.is_empty() {
                        current_lines.push(s);
                    }
                }
            }
            Event::End(ref e) => {
                let name = local(e.name().as_ref()).to_string();
                match state {
                    Where::InVariables if name == "variables" => state = Where::Outside,
                    Where::InValue => {
                        if depth_in_value > 0 {
                            depth_in_value -= 1;
                        } else {
                            let vs = set.as_mut().ok_or(XmlError::NoVariableSet)?;
                            let ds = current_set.as_mut().expect("in a data set");
                            let var = current_var.take().unwrap_or_default();
                            let body = current_lines.join("\n");
                            push_value(vs, ds, &var, &body)?;
                            current_lines.clear();
                            state = Where::InDataSet;
                        }
                    }
                    Where::InDataSet if name == "sampleDataSet" => {
                        let vs = set.as_mut().ok_or(XmlError::NoVariableSet)?;
                        if let Some(ds) = current_set.take() {
                            vs.upsert_data_set(ds);
                        }
                        state = Where::Outside;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    set.ok_or(XmlError::NoVariableSet)
}

/// Record one captured value, typed by its DECLARATION (never guessed from the
/// body). A value naming an undeclared variable is a hard error: silently
/// inventing a declaration is how an import ends up applying a text string to a
/// visibility target.
fn push_value(
    vs: &VariableSet,
    ds: &mut DataSet,
    variable: &str,
    body: &str,
) -> Result<(), XmlError> {
    let decl = vs
        .declaration(variable)
        .ok_or_else(|| XmlError::UndeclaredVariable {
            data_set: ds.name.clone(),
            variable: variable.to_string(),
        })?;
    let value = DataSetValue::from_xml_body(decl.var_trait, body)?;
    ds.values.insert(variable.to_string(), value);
    Ok(())
}

/// The `category` attribute a trait carries (Illustrator puts graph variables in
/// the Graphs namespace and everything else in Flows).
fn category_for(t: VarTrait) -> &'static str {
    match t {
        VarTrait::GraphData => NS_GRAPHS,
        _ => NS_FLOWS,
    }
}

/// Serialize a variable library (spec §9.9). Deterministic: variables in
/// declaration order, data sets in palette order, values in the `BTreeMap`'s
/// sorted order — so capturing the same state twice produces byte-identical XML
/// (which is what the round-trip test asserts).
///
/// Emits the resolved namespace URIs, NOT Adobe's DTD entity references — see
/// deviation 1 in the module docs.
pub fn to_xml(set: &VariableSet) -> String {
    let mut out = String::with_capacity(512);
    out.push_str("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n");
    out.push_str(&format!(
        "<svg xmlns:i=\"{NS_AI}\" xmlns:x=\"{NS_EXTEND}\" xmlns:graph=\"{NS_GRAPHS}\" xmlns:v=\"{NS_VARS}\">\n"
    ));
    out.push_str(&format!("<variableSets xmlns=\"{NS_VARS}\">\n"));
    out.push_str(&format!(
        "\t<variableSet varSetName=\"{}\" locked=\"none\">\n",
        escape(&set.name)
    ));
    out.push_str("\t\t<variables>\n");
    for v in &set.variables {
        out.push_str(&format!(
            "\t\t\t<variable varName=\"{}\" trait=\"{}\" category=\"{}\"></variable>\n",
            escape(&v.name),
            v.var_trait.as_xml(),
            category_for(v.var_trait)
        ));
    }
    out.push_str("\t\t</variables>\n");
    out.push_str(&format!(
        "\t\t<v:sampleDataSets xmlns=\"{NS_CUSTOM}\" xmlns:v=\"{NS_VARS}\">\n"
    ));
    for ds in &set.data_sets {
        out.push_str(&format!(
            "\t\t\t<v:sampleDataSet dataSetName=\"{}\">\n",
            escape(&ds.name)
        ));
        for (name, value) in &ds.values {
            let tag = escape(name);
            out.push_str(&format!("\t\t\t\t<{tag}>\n"));
            for line in value.xml_lines() {
                out.push_str(&format!("\t\t\t\t\t<p>{}</p>\n", escape(&line)));
            }
            out.push_str(&format!("\t\t\t\t</{tag}>\n"));
        }
        out.push_str("\t\t\t</v:sampleDataSet>\n");
    }
    out.push_str("\t\t</v:sampleDataSets>\n");
    out.push_str("\t</variableSet>\n");
    out.push_str("</variableSets>\n");
    out.push_str("</svg>\n");
    out
}
