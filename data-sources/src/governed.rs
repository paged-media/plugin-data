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

//! # Governed-extract column metadata (spec §7)
//!
//! The on-thesis enterprise feature, built **engine-neutrally** (§3): the user
//! produces governed datasets in their own platform; `paged.data` consumes the
//! *outputs* — the materialized table (read by the file/DB/remote adapter) plus
//! an optional **column-metadata sidecar**: a JSON description of the columns
//! (labels, descriptions, types, provenance). The effect is a **governed catalog**
//! experience — the author binds to *documented* datasets (`fct_products` with
//! human-readable columns), not raw anonymous tables.
//!
//! This module owns the pure, engine-neutral half: the sidecar **model**, the
//! **enrichment** that merges a sidecar onto a live schema, and the **drift
//! diagnostics** that keep it honest — an undocumented column, a stale sidecar
//! entry, or a documented type that disagrees with the data is *surfaced*, never
//! silently papered over (the governance conviction §7 expresses). The byte IO
//! that fetches the table + the sidecar JSON is the DuckDB/bundle layer; nothing
//! here touches the network.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use data_core::{FieldType, Schema};

/// One column's governance metadata, as carried by the sidecar (§7). Every field
/// but `name` is optional — a sparse sidecar documents what it can.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMetadata {
    /// The column name — the join key against the live schema.
    pub name: String,
    /// A human-readable label (the catalog shows this instead of the raw name).
    #[serde(default)]
    pub label: Option<String>,
    /// A description of what the column means (governance documentation).
    #[serde(default)]
    pub description: Option<String>,
    /// The documented logical type — checked against the live type for drift.
    #[serde(default)]
    pub data_type: Option<FieldType>,
    /// Where the column comes from (e.g. the upstream model / source system).
    #[serde(default)]
    pub provenance: Option<String>,
}

/// The column-metadata sidecar for a governed dataset (§7): a JSON description of
/// its columns. The bundle reads this from `GovernedExtract.metadata_sidecar`
/// (a file/URL) and hands the parsed structure to the engine — like a RecordSet,
/// it is *data*, never engine code (§3 license boundary).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetMetadata {
    /// The dataset's documented name (e.g. `"fct_products"`), if the sidecar
    /// names it.
    #[serde(default)]
    pub dataset: Option<String>,
    pub columns: Vec<ColumnMetadata>,
}

/// One column of the governed catalog: a live data column enriched with the
/// sidecar's documentation. `label`/`data_type` always resolve (label falls back
/// to the raw name; the type is always the *actual* live type).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogColumn {
    pub name: String,
    /// The sidecar label, or the raw column name when undocumented.
    pub label: String,
    /// The **actual** live data type (never the documented one — the data wins;
    /// a disagreement is reported as a `TypeMismatch` diagnostic instead).
    pub data_type: FieldType,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub provenance: Option<String>,
    /// Whether the sidecar documented this column.
    pub documented: bool,
}

/// A governance-drift diagnostic between the live schema and the sidecar (§7).
/// Drift is surfaced, never hidden — the catalog stays honest about how well the
/// documentation matches the data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CatalogDiagnostic {
    /// A live column the sidecar does not document.
    UndocumentedColumn { name: String },
    /// A sidecar column absent from the live data (a stale sidecar / schema drift).
    MissingColumn { name: String },
    /// The sidecar's documented type disagrees with the live data type.
    TypeMismatch {
        name: String,
        documented: FieldType,
        actual: FieldType,
    },
}

/// The governed catalog: a live schema enriched with the sidecar, plus the drift
/// diagnostics (§7). Deterministic — live columns in schema order, then any
/// missing-column diagnostics in sidecar order.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GovernedCatalog {
    pub columns: Vec<CatalogColumn>,
    pub diagnostics: Vec<CatalogDiagnostic>,
}

/// Enrich a live schema with a column-metadata sidecar → a documented catalog +
/// governance-drift diagnostics (§7). The data is authoritative: every catalog
/// column carries the *actual* live type; the sidecar contributes labels,
/// descriptions, provenance, and a documented type that — if it disagrees — is
/// reported as drift rather than overriding reality.
pub fn enrich_schema(schema: &Schema, meta: &DatasetMetadata) -> GovernedCatalog {
    let by_name: BTreeMap<&str, &ColumnMetadata> =
        meta.columns.iter().map(|c| (c.name.as_str(), c)).collect();
    let live: BTreeSet<&str> = schema.fields.iter().map(|f| f.name.as_str()).collect();

    let mut columns = Vec::with_capacity(schema.fields.len());
    let mut diagnostics = Vec::new();

    for f in &schema.fields {
        match by_name.get(f.name.as_str()) {
            Some(m) => {
                if let Some(documented) = m.data_type {
                    if documented != f.ty {
                        diagnostics.push(CatalogDiagnostic::TypeMismatch {
                            name: f.name.clone(),
                            documented,
                            actual: f.ty,
                        });
                    }
                }
                columns.push(CatalogColumn {
                    name: f.name.clone(),
                    label: m.label.clone().unwrap_or_else(|| f.name.clone()),
                    data_type: f.ty,
                    description: m.description.clone(),
                    provenance: m.provenance.clone(),
                    documented: true,
                });
            }
            None => {
                diagnostics.push(CatalogDiagnostic::UndocumentedColumn {
                    name: f.name.clone(),
                });
                columns.push(CatalogColumn {
                    name: f.name.clone(),
                    label: f.name.clone(),
                    data_type: f.ty,
                    description: None,
                    provenance: None,
                    documented: false,
                });
            }
        }
    }

    // Sidecar columns absent from the live data — in sidecar order (deterministic).
    for c in &meta.columns {
        if !live.contains(c.name.as_str()) {
            diagnostics.push(CatalogDiagnostic::MissingColumn {
                name: c.name.clone(),
            });
        }
    }

    GovernedCatalog {
        columns,
        diagnostics,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> DatasetMetadata {
        DatasetMetadata {
            dataset: Some("fct_products".into()),
            columns: vec![
                ColumnMetadata {
                    name: "sku".into(),
                    label: Some("SKU".into()),
                    description: Some("Stock-keeping unit".into()),
                    data_type: Some(FieldType::Text),
                    provenance: Some("dim_products".into()),
                },
                ColumnMetadata {
                    name: "price".into(),
                    label: Some("List price".into()),
                    description: None,
                    // Documented as Int but the data is Float → drift.
                    data_type: Some(FieldType::Int),
                    provenance: None,
                },
                ColumnMetadata {
                    // Documented but absent from the data → stale sidecar.
                    name: "discount".into(),
                    label: Some("Discount".into()),
                    description: None,
                    data_type: Some(FieldType::Float),
                    provenance: None,
                },
            ],
        }
    }

    #[test]
    fn data_governed_catalog_enriches_and_reports_drift() {
        // Live schema: sku (documented), price (type drift), secret (undocumented).
        let schema = Schema::from_fields([
            ("sku".to_string(), FieldType::Text),
            ("price".to_string(), FieldType::Float),
            ("secret".to_string(), FieldType::Text),
        ]);
        let cat = enrich_schema(&schema, &meta());

        // Columns are in live-schema order, every one carrying its ACTUAL type.
        assert_eq!(cat.columns.len(), 3);
        assert_eq!(cat.columns[0].label, "SKU");
        assert_eq!(cat.columns[0].provenance.as_deref(), Some("dim_products"));
        assert!(cat.columns[0].documented);
        assert_eq!(cat.columns[1].data_type, FieldType::Float); // data wins
        assert_eq!(cat.columns[2].label, "secret"); // undocumented → raw name
        assert!(!cat.columns[2].documented);

        // Drift: a type mismatch on price, an undocumented `secret`, a stale
        // `discount` — all surfaced.
        assert!(cat.diagnostics.contains(&CatalogDiagnostic::TypeMismatch {
            name: "price".into(),
            documented: FieldType::Int,
            actual: FieldType::Float,
        }));
        assert!(cat
            .diagnostics
            .contains(&CatalogDiagnostic::UndocumentedColumn {
                name: "secret".into()
            }));
        assert!(cat.diagnostics.contains(&CatalogDiagnostic::MissingColumn {
            name: "discount".into()
        }));
    }

    #[test]
    fn data_governed_catalog_empty_sidecar_is_all_undocumented() {
        let schema = Schema::from_fields([("a".to_string(), FieldType::Text)]);
        let cat = enrich_schema(&schema, &DatasetMetadata::default());
        assert_eq!(cat.columns.len(), 1);
        assert!(!cat.columns[0].documented);
        assert_eq!(
            cat.diagnostics,
            vec![CatalogDiagnostic::UndocumentedColumn { name: "a".into() }]
        );
    }
}
