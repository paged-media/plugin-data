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

//! # data-automation — print automation / batch generation (spec §10)
//!
//! The EasyCatalog "build" capability. The **batch-plan engine** is implemented:
//! [`plan_batch`] partitions a resolved result into the deterministic sequence of
//! **generation units** a batch run produces — one document **per record**
//! (per-store flyers), **per group** (per-category catalogs), or **one** large
//! paginated catalog. The plan says WHICH records feed WHICH document; the actual
//! per-unit resolve → lower → paginate → export reuses the normal pipeline
//! (§10: "outputs are ordinary Paged documents/exports; nothing bypasses the
//! normal render/export pipeline" — this crate renders nothing).
//!
//! Still **reserved** (the remaining T2 work, `status: planned`): the napi-rs
//! **native execution** binding (so a server/CI run drives a batch without a
//! browser) and the constrained **Boa scripting** surface for scriptable
//! queries/builds. Pipelines/scheduling/webhooks stay out (D-7) — that is the
//! user's automation platform calling the napi-rs binding.

use serde::{Deserialize, Serialize};

use data_core::{RecordSet, ResultShape, Value};
use data_query::{shape, stabilize, Shaped};

/// The milestone this crate ships in.
pub const MILESTONE: &str = "T2 (M2) — batch/headless generation; spec §10.";

/// The two execution modes one crate exposes (spec §10).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionMode {
    /// The document is bound and regenerates live as data changes (the default).
    Interactive,
    /// Generate many outputs from data (per-record / per-group / one catalog),
    /// natively (napi-rs) or in-app.
    Batch,
}

/// How a batch run partitions a dataset into generation units (spec §10, D-7:
/// parameterized multi-document/multi-section generation from a single template).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum BatchMode {
    /// One document **per record** (e.g. per-store flyers). `key` names a column
    /// whose value labels each unit; absent → the stabilized row position.
    PerRecord {
        #[serde(default)]
        key: Option<String>,
    },
    /// One document **per group** (e.g. per-category catalogs), grouped by `by`
    /// (first-seen group order, stabilized).
    PerGroup { by: Vec<String> },
    /// **One** paginated catalog over every record.
    OneCatalog,
}

/// One generation unit: the records that feed exactly one output document
/// (spec §10).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchUnit {
    /// A deterministic label for the unit (a file/section name).
    pub label: String,
    /// Indices into the **stabilized** record set that feed this unit.
    pub record_indices: Vec<usize>,
}

/// A batch plan: the deterministic sequence of generation units (spec §10). It
/// declares WHICH records feed WHICH document — the executor (in-app, or the
/// napi-rs native binding) resolves + lowers + paginates each unit through the
/// normal pipeline. Permutation-invariant: the plan is computed over the
/// stabilized result, so the same data always yields the same units in the same
/// order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPlan {
    /// `"perRecord" | "perGroup" | "oneCatalog"`.
    pub mode: String,
    pub units: Vec<BatchUnit>,
    pub total_records: usize,
}

/// Partition a resolved result into a [`BatchPlan`] per the [`BatchMode`]
/// (spec §10). The result is **stabilized** first (deterministic record
/// identity, §6.1/§8), so `record_indices` index into that stable order and the
/// plan is reproducible across refreshes that don't change the data.
pub fn plan_batch(records: &RecordSet, mode: &BatchMode) -> BatchPlan {
    let stable = stabilize(records, &[]);
    let total_records = stable.row_count;

    let (mode_name, units): (&str, Vec<BatchUnit>) = match mode {
        BatchMode::OneCatalog => (
            "oneCatalog",
            vec![BatchUnit {
                label: "catalog".to_string(),
                record_indices: (0..total_records).collect(),
            }],
        ),
        BatchMode::PerRecord { key } => {
            let col = key.as_ref().and_then(|k| stable.schema.index_of(k));
            let units = (0..total_records)
                .map(|i| BatchUnit {
                    label: col
                        .and_then(|c| stable.value(i, c))
                        .map(value_label)
                        .unwrap_or_else(|| format!("row-{i}")),
                    record_indices: vec![i],
                })
                .collect();
            ("perRecord", units)
        }
        BatchMode::PerGroup { by } => {
            let units = match shape(&stable, &ResultShape::Grouped { by: by.clone() }) {
                Shaped::Grouped(groups) => groups
                    .into_iter()
                    .map(|g| BatchUnit {
                        label: g
                            .key
                            .iter()
                            .map(value_label)
                            .collect::<Vec<_>>()
                            .join(" / "),
                        record_indices: g.rows,
                    })
                    .collect(),
                _ => Vec::new(),
            };
            ("perGroup", units)
        }
    };

    BatchPlan {
        mode: mode_name.to_string(),
        units,
        total_records,
    }
}

/// A deterministic, human-readable label for a value (the unit's file/section
/// name). Distinct from a *bound display value* (that is `data-expr`'s job) — a
/// label only needs to be stable and readable.
fn value_label(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) if n.fract() == 0.0 => format!("{}", *n as i64),
        Value::Number(n) => n.to_string(),
        Value::Text(t) => t.to_string(),
        Value::Date(d) => d.to_string(),
        Value::DateTime(ms) => ms.to_string(),
        Value::Bytes(_) => "<bytes>".to_string(),
        Value::Error(e) => format!("#{}", e.code()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use data_core::{FieldType, Schema};

    fn rs() -> RecordSet {
        // cat: a,b,a  qty: 2,5,9 — unordered on purpose.
        RecordSet::new(
            Schema::from_fields([
                ("cat".to_string(), FieldType::Text),
                ("qty".to_string(), FieldType::Float),
            ]),
            vec![
                vec![Value::text("b"), Value::text("a"), Value::text("a")],
                vec![Value::Number(5.0), Value::Number(2.0), Value::Number(9.0)],
            ],
        )
        .unwrap()
    }

    #[test]
    fn data_automation_one_catalog_is_a_single_unit() {
        let plan = plan_batch(&rs(), &BatchMode::OneCatalog);
        assert_eq!(plan.mode, "oneCatalog");
        assert_eq!(plan.units.len(), 1);
        assert_eq!(plan.units[0].record_indices, vec![0, 1, 2]);
        assert_eq!(plan.total_records, 3);
    }

    #[test]
    fn data_automation_per_record_one_unit_each_labelled_by_key() {
        let plan = plan_batch(
            &rs(),
            &BatchMode::PerRecord {
                key: Some("cat".to_string()),
            },
        );
        assert_eq!(plan.mode, "perRecord");
        // Stabilized by all columns → (a,2),(a,9),(b,5). One unit per row.
        assert_eq!(plan.units.len(), 3);
        assert_eq!(plan.units[0].label, "a");
        assert_eq!(plan.units[0].record_indices, vec![0]);
        assert_eq!(plan.units[2].label, "b");
    }

    #[test]
    fn data_automation_per_group_one_unit_per_group() {
        let plan = plan_batch(
            &rs(),
            &BatchMode::PerGroup {
                by: vec!["cat".to_string()],
            },
        );
        assert_eq!(plan.mode, "perGroup");
        // Two groups: a (2 records), b (1 record).
        assert_eq!(plan.units.len(), 2);
        assert_eq!(plan.units[0].label, "a");
        assert_eq!(plan.units[0].record_indices.len(), 2);
        assert_eq!(plan.units[1].label, "b");
        assert_eq!(plan.units[1].record_indices.len(), 1);
    }
}
