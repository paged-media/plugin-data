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

//! # data-cli — headless batch generation (spec §10, the native route)
//!
//! A plain-Rust path for server/CI batch: drive the SAME engine the editor uses
//! ([`data_js::core::DataSession`]), no browser, no napi toolchain. A [`Job`]
//! carries the binding **recipe**, the **pre-materialized** query results, and
//! the run parameters (which record-flow binding, the batch mode, the frame
//! chain); [`run_job`] produces the per-document lowered IR.
//!
//! The query engine is deliberately **NOT embedded** (§3 license boundary): the
//! user's platform materializes the results (a warehouse extract, native DuckDB,
//! files) and hands them in, exactly as the in-app bundle hands DuckDB-WASM
//! results to `ingest_result`. And nothing renders here — `runs[].flow` is the
//! `PaginatedFlow` IR the core's headless export turns into documents (§10:
//! "nothing bypasses the normal render/export pipeline").
//!
//! The `paged-data-batch` binary wraps [`run_job`] with stdin/file → stdout JSON.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use data_automation::BatchMode;
use data_core::{BindingId, Locale, QueryId, RecordSet};
use data_js::core::{BatchRun, DataSession, DocumentPayload};
use data_lower::{FlowLayoutOpts, FrameCapacity};

/// A headless batch job (spec §10).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    /// The `today` serial (days since 1970-01-01) for deterministic `TODAY()`.
    #[serde(default)]
    pub today: i32,
    /// The formatting locale for the display kernels (default en).
    #[serde(default)]
    pub locale: Option<Locale>,
    /// The binding recipe (sources + queries + templates + binding defs).
    pub payload: DocumentPayload,
    /// Pre-materialized query results, keyed by query id. The user's platform
    /// produces these — the CLI does not query.
    #[serde(default)]
    pub results: HashMap<String, RecordSet>,
    /// The record-flow binding to generate documents from.
    pub binding: String,
    /// How the run partitions into documents (per-record / per-group / one).
    pub mode: BatchMode,
    /// The frame-chain capacities each document paginates into.
    pub chain: Vec<FrameCapacity>,
    /// Pagination options (header repetition, etc.). Defaults when absent.
    #[serde(default)]
    pub opts: Option<FlowLayoutOpts>,
}

/// The result of a batch job: one [`BatchRun`] per generated document.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobOutput {
    /// A document count up front so a CI log is readable without parsing the IR.
    pub document_count: usize,
    pub runs: Vec<BatchRun>,
}

/// Run a batch job through the engine. Pure (no IO) so it is unit-testable; the
/// binary wraps it with stdin/stdout/exit handling.
pub fn run_job(job: Job) -> Result<JobOutput, String> {
    let mut session = DataSession::from_payload(job.payload, job.today);
    if let Some(locale) = job.locale {
        session.set_locale(locale);
    }
    for (qid, records) in job.results {
        session.ingest_result(QueryId::from(qid.as_str()), records);
    }
    let opts = job.opts.unwrap_or_default();
    let runs = session
        .run_record_flow_batch(
            &BindingId::from(job.binding.as_str()),
            job.mode,
            job.chain,
            opts,
        )
        .map_err(|e| e.to_string())?;
    Ok(JobOutput {
        document_count: runs.len(),
        runs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use data_core::{
        Binding, BindingDef, FieldType, Query, ResultShape, Schema, Template, TemplateField,
        TemplateRef, Value,
    };

    fn job_json() -> String {
        // A full job as the user's automation platform would emit it — proving
        // the serde boundary (recipe + results + run params) end-to-end.
        serde_json::json!({
            "today": 0,
            "locale": "de",
            "payload": {
                "queries": [{ "id": "q1", "sql": "", "params": [], "shape": { "shape": "recordStream" } }],
                "templates": [{
                    "id": "tmpl",
                    "fields": [{ "label": "", "expr": "name" }, { "label": "$", "expr": "CURRENCY(price)" }],
                    "lineHeightPt": 10.0
                }],
                "bindings": [{
                    "id": "rf",
                    "kind": "recordFlow",
                    "chain": "chain",
                    "query": "q1",
                    "template": "tmpl",
                    "options": { "groupBy": ["region"], "repeatHeader": true, "continuedMarker": true }
                }]
            },
            "results": {
                "q1": {
                    "schema": { "fields": [
                        { "name": "region", "ty": "text", "nullable": true },
                        { "name": "name", "ty": "text", "nullable": true },
                        { "name": "price", "ty": "float", "nullable": true }
                    ]},
                    "columns": [
                        [{ "t": "text", "v": "east" }, { "t": "text", "v": "west" }],
                        [{ "t": "text", "v": "Store E" }, { "t": "text", "v": "Store W" }],
                        [{ "t": "number", "v": 9.99 }, { "t": "number", "v": 19.99 }]
                    ],
                    "row_count": 2
                }
            },
            "binding": "rf",
            "mode": { "mode": "perGroup", "by": ["region"] },
            "chain": [
                { "frame": "f0", "page": "p0", "heightPt": 200.0 },
                { "frame": "f1", "page": "p1", "heightPt": 200.0 }
            ]
        })
        .to_string()
    }

    #[test]
    fn data_automation_cli_runs_a_batch_job_from_json() {
        let job: Job = serde_json::from_str(&job_json()).expect("job JSON deserializes");
        let out = run_job(job).expect("job runs");
        // Per-group over region → one document per region (east, west).
        assert_eq!(out.document_count, 2);
        assert_eq!(out.runs[0].label, "east");
        assert_eq!(out.runs[1].label, "west");
        // The de locale threaded through: CURRENCY renders a trailing €.
        let east_cells = &out.runs[0].flow.frames[0];
        let json = serde_json::to_string(east_cells).unwrap();
        assert!(
            json.contains('€'),
            "de locale should reach the batch output: {json}"
        );
        // The output re-serializes (the binary prints this).
        assert!(serde_json::to_string(&out).is_ok());
    }

    #[test]
    fn data_automation_cli_non_flow_binding_errors() {
        let payload = DocumentPayload {
            sources: vec![],
            queries: vec![Query {
                id: data_core::QueryId::from("q1"),
                sql: String::new(),
                params: vec![],
                shape: ResultShape::SingleRecord,
            }],
            templates: vec![Template {
                id: TemplateRef::from("tmpl"),
                fields: vec![TemplateField {
                    label: String::new(),
                    expr: "name".into(),
                }],
                line_height_pt: 10.0,
            }],
            bindings: vec![BindingDef {
                id: data_core::BindingId::from("v1"),
                binding: Binding::Variable {
                    target: data_core::PlaceholderRef::from("ph"),
                    query: data_core::QueryId::from("q1"),
                    expr: "name".into(),
                    missing: data_core::MissingPolicy::Blank,
                },
            }],
        };
        let mut results = HashMap::new();
        results.insert(
            "q1".to_string(),
            RecordSet::new(
                Schema::from_fields([("name".to_string(), FieldType::Text)]),
                vec![vec![Value::text("x")]],
            )
            .unwrap(),
        );
        let job = Job {
            today: 0,
            locale: None,
            payload,
            results,
            binding: "v1".into(),
            mode: BatchMode::OneCatalog,
            chain: vec![FrameCapacity {
                frame: "f0".into(),
                page: "p0".into(),
                height_pt: 200.0,
            }],
            opts: None,
        };
        assert!(run_job(job).is_err());
    }
}
