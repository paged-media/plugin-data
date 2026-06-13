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

//! # data-js — the wasm-bindgen surface (spec §4, the final Rust join)
//!
//! ALL binding/expression/sync/lowering semantics live in the Rust `data-*`
//! crates (constitution hard rule). This crate is the THIN boundary that
//! exposes one wasm class — `DataEngine` — over the plain-Rust
//! [`core::DataSession`]. Every method forwards to the session and serialises
//! its serde structs across the wasm door with `serde-wasm-bindgen`; nothing
//! computes here.
//!
//! ## Two layers, one logic
//!
//! - [`core::DataSession`] — plain Rust, native-typed. The full engine lives
//!   here, so `data-conformance` exercises it WITHOUT a wasm runtime.
//! - `DataEngine` (below) — `#[cfg(target_arch = "wasm32")]` only, because
//!   `JsValue`-returning `#[wasm_bindgen]` methods compile only for wasm32. A
//!   forwarding shim with NO logic of its own.
//!
//! ## The TS consumer contract (`data-bundle/src/engine.ts`)
//!
//! The facade boots `new mod.DataEngine(today)`, then calls the snake_case
//! instance methods `define_source` / `define_query` / `define_binding` /
//! `define_placeholder` / `set_param` / `ingest_result` / `resolve_lowered` /
//! `sync_state` / `pin` / `mark_overridden` / `relink` / `sync_report` /
//! `source_manifest` / `authorize_report` / `payload` / `metadata` / `free`.
//! The query engine itself is the vendored DuckDB-WASM (TS side); it converts
//! its Arrow result to a `RecordSet` JSON which `ingest_result` decodes.

pub mod core;

#[cfg(target_arch = "wasm32")]
mod wasm {
    use crate::core::DataSession;
    use data_core::{BindingId, QueryId};
    use wasm_bindgen::prelude::*;

    /// The wasm class the bundle consumes — a thin shim over [`DataSession`].
    #[wasm_bindgen]
    pub struct DataEngine {
        session: DataSession,
    }

    #[wasm_bindgen]
    impl DataEngine {
        /// Construct a session with an injected `today` serial (days since
        /// 1970-01-01) — deterministic; `TODAY()` reads it.
        #[wasm_bindgen(constructor)]
        pub fn new(today: i32) -> DataEngine {
            DataEngine {
                session: DataSession::new(today),
            }
        }

        /// Define a data source (recipe; used for the §11 manifest + gate).
        pub fn define_source(&mut self, source: JsValue) -> Result<(), JsValue> {
            self.session.define_source(from_js(source)?);
            Ok(())
        }

        /// Define a query.
        pub fn define_query(&mut self, query: JsValue) -> Result<(), JsValue> {
            self.session.define_query(from_js(query)?);
            Ok(())
        }

        /// Define a binding (with its id).
        pub fn define_binding(&mut self, def: JsValue) -> Result<(), JsValue> {
            self.session.define_binding(from_js(def)?);
            Ok(())
        }

        /// Define a per-record template (the "catalog cell", §9.4).
        pub fn define_template(&mut self, template: JsValue) -> Result<(), JsValue> {
            self.session.define_template(from_js(template)?);
            Ok(())
        }

        /// Define a placeholder anchor.
        pub fn define_placeholder(&mut self, placeholder: JsValue) -> Result<(), JsValue> {
            self.session.define_placeholder(from_js(placeholder)?);
            Ok(())
        }

        /// Bind a query parameter value.
        pub fn set_param(&mut self, name: &str, value: JsValue) -> Result<(), JsValue> {
            self.session.set_param(name, from_js(value)?);
            Ok(())
        }

        /// Set the formatting locale for the display kernels (`"en"` | `"de"`).
        pub fn set_locale(&mut self, locale: JsValue) -> Result<(), JsValue> {
            self.session.set_locale(from_js(locale)?);
            Ok(())
        }

        /// Deliver a query's result (the DuckDB-WASM Arrow result, converted to
        /// a `RecordSet` by the TS query layer).
        pub fn ingest_result(&mut self, query: &str, records: JsValue) -> Result<(), JsValue> {
            self.session
                .ingest_result(QueryId::from(query), from_js(records)?);
            Ok(())
        }

        /// Resolve a binding and return its lowered IR.
        pub fn resolve_lowered(&mut self, binding: &str) -> Result<JsValue, JsValue> {
            let out = self
                .session
                .resolve_lowered(&BindingId::from(binding))
                .map_err(map_err)?;
            to_js(&out)
        }

        /// The number of records ingested for a query — the §9 record-preview
        /// stepper's "of N" upper bound (0 when no result is ingested yet).
        pub fn query_record_count(&self, query: &str) -> usize {
            self.session.query_record_count(&QueryId::from(query))
        }

        /// Resolve a binding against a chosen RECORD INDEX and return its lowered
        /// IR — the §9 record-preview stepper. Per-record kinds (variable/image)
        /// evaluate over `records[record]`; a table renders in full.
        pub fn resolve_lowered_at(
            &mut self,
            binding: &str,
            record: usize,
        ) -> Result<JsValue, JsValue> {
            let out = self
                .session
                .resolve_lowered_at(&BindingId::from(binding), record)
                .map_err(map_err)?;
            to_js(&out)
        }

        /// Resolve a record-flow binding and paginate it over a caller-supplied
        /// frame chain (§9.4). `chain` is `FrameCapacity[]`, `opts` is
        /// `FlowLayoutOpts` (or undefined for defaults).
        pub fn lower_record_flow(
            &mut self,
            binding: &str,
            chain: JsValue,
            opts: JsValue,
        ) -> Result<JsValue, JsValue> {
            let chain: Vec<data_lower::FrameCapacity> = from_js(chain)?;
            let opts: data_lower::FlowLayoutOpts = if opts.is_undefined() || opts.is_null() {
                data_lower::FlowLayoutOpts::default()
            } else {
                from_js(opts)?
            };
            let flow = self
                .session
                .lower_record_flow(&BindingId::from(binding), chain, opts)
                .map_err(map_err)?;
            to_js(&flow)
        }

        /// Resolve a barcode binding (§9.7) and lower it scaled to the bound
        /// frame's content box (`box_w_pt` × `box_h_pt`, pt). Returns the
        /// `LoweredBarcode` IR — filled-rect modules in content-space the bundle
        /// emits as native `insertPath` rects (the VECTOR lane).
        pub fn lower_barcode(
            &mut self,
            binding: &str,
            box_w_pt: f64,
            box_h_pt: f64,
        ) -> Result<JsValue, JsValue> {
            let out = self
                .session
                .lower_barcode_sized(&BindingId::from(binding), box_w_pt, box_h_pt)
                .map_err(map_err)?;
            to_js(&out)
        }

        /// Resolve a barcode binding against a chosen RECORD INDEX (the §9
        /// preview stepper) and lower it scaled to the bound frame's content box.
        pub fn lower_barcode_at(
            &mut self,
            binding: &str,
            record: usize,
            box_w_pt: f64,
            box_h_pt: f64,
        ) -> Result<JsValue, JsValue> {
            let out = self
                .session
                .lower_barcode_at(&BindingId::from(binding), record, box_w_pt, box_h_pt)
                .map_err(map_err)?;
            to_js(&out)
        }

        /// Evaluate a data-driven formatting rule (§9.5) over a query's records:
        /// `{ scope, fires, apply, total }`.
        pub fn evaluate_rule(&self, rule: &str, query: &str) -> Result<JsValue, JsValue> {
            let result = self
                .session
                .evaluate_rule(&BindingId::from(rule), &QueryId::from(query))
                .map_err(map_err)?;
            to_js(&result)
        }

        /// Run a §10 batch over a record-flow binding: resolve, partition by
        /// `mode`, and paginate each unit. Returns `BatchRun[]`
        /// (`{ label, flow }`). `chain` is `FrameCapacity[]`, `opts` is
        /// `FlowLayoutOpts` (or undefined for defaults).
        pub fn run_record_flow_batch(
            &mut self,
            binding: &str,
            mode: JsValue,
            chain: JsValue,
            opts: JsValue,
        ) -> Result<JsValue, JsValue> {
            let mode = from_js(mode)?;
            let chain: Vec<data_lower::FrameCapacity> = from_js(chain)?;
            let opts: data_lower::FlowLayoutOpts = if opts.is_undefined() || opts.is_null() {
                data_lower::FlowLayoutOpts::default()
            } else {
                from_js(opts)?
            };
            let runs = self
                .session
                .run_record_flow_batch(&BindingId::from(binding), mode, chain, opts)
                .map_err(map_err)?;
            to_js(&runs)
        }

        /// Plan a §10 batch run over a query's result (`mode` is `BatchMode`):
        /// `{ mode, units: [{ label, recordIndices }], totalRecords }` — which
        /// records feed which output document (per-record / per-group / one
        /// catalog). The executor lowers each unit through the normal pipeline.
        pub fn plan_batch(&self, query: &str, mode: JsValue) -> Result<JsValue, JsValue> {
            let mode = from_js(mode)?;
            let plan = self
                .session
                .plan_batch(&QueryId::from(query), mode)
                .map_err(map_err)?;
            to_js(&plan)
        }

        /// Build the §7 governed catalog for a query's result: enrich its schema
        /// with a column-metadata sidecar (`metadata` is `DatasetMetadata`) and
        /// return `{ columns, diagnostics }` — documented columns + governance
        /// drift. The bundle reads the sidecar JSON from the source's
        /// `metadata_sidecar` location and passes it here.
        pub fn governed_catalog(&self, query: &str, metadata: JsValue) -> Result<JsValue, JsValue> {
            let meta = from_js(metadata)?;
            let catalog = self
                .session
                .governed_catalog(&QueryId::from(query), meta)
                .map_err(map_err)?;
            to_js(&catalog)
        }

        /// Publish a query's resolved result as a §7.1 data-provider snapshot
        /// (`{ id, category, revision, schema, rowCount, records }`) — the
        /// engine-side payload the bundle hands to the core data-provider
        /// registry once that contract lands (D-09).
        pub fn publish_provider(
            &self,
            query: &str,
            provider_id: &str,
            category: &str,
        ) -> Result<JsValue, JsValue> {
            let pub_ = self
                .session
                .publish_provider(&QueryId::from(query), provider_id, category)
                .map_err(map_err)?;
            to_js(&pub_)
        }

        /// The remote invalidation key (§6.2/§8): the content-addressed key for
        /// a defined remote source over caller-supplied bytes (the bundle's
        /// post-consent, edit-time fetch). Hex string; the engine never fetches.
        pub fn remote_invalidation_key(
            &self,
            source: &str,
            bytes: &[u8],
        ) -> Result<String, JsValue> {
            self.session
                .remote_invalidation_key(&data_core::SourceId::from(source), bytes)
                .map_err(map_err)
        }

        /// The sync state of a binding.
        pub fn sync_state(&self, binding: &str) -> JsValue {
            to_js(&self.session.sync_state(&BindingId::from(binding))).unwrap_or(JsValue::NULL)
        }

        /// Pin a binding to its current snapshot.
        pub fn pin(&mut self, binding: &str) {
            self.session.pin(&BindingId::from(binding));
        }

        /// Mark a binding overridden.
        pub fn mark_overridden(&mut self, binding: &str) {
            self.session.mark_overridden(&BindingId::from(binding));
        }

        /// Re-link a pinned/overridden binding.
        pub fn relink(&mut self, binding: &str) {
            self.session.relink(&BindingId::from(binding));
        }

        /// The sync report (`[{binding,status}]`).
        pub fn sync_report(&self) -> JsValue {
            to_js(&self.session.sync_report()).unwrap_or(JsValue::NULL)
        }

        /// The visible data-source manifest (§11).
        pub fn source_manifest(&self) -> JsValue {
            to_js(&self.session.source_manifest()).unwrap_or(JsValue::NULL)
        }

        /// The capability/consent verdict per source (§11).
        pub fn authorize_report(&self) -> JsValue {
            to_js(&self.session.authorize_report()).unwrap_or(JsValue::NULL)
        }

        /// The document payload (recipe; credentials redacted, §11/D-11).
        pub fn payload(&self) -> JsValue {
            to_js(&self.session.payload()).unwrap_or(JsValue::NULL)
        }

        /// Session metadata.
        pub fn metadata(&self) -> JsValue {
            to_js(&self.session.metadata()).unwrap_or(JsValue::NULL)
        }
    }

    fn map_err(e: crate::core::SessionError) -> JsValue {
        JsValue::from_str(&e.to_string())
    }

    fn from_js<T: serde::de::DeserializeOwned>(value: JsValue) -> Result<T, JsValue> {
        serde_wasm_bindgen::from_value(value).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    fn to_js<T: serde::Serialize>(value: &T) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(value).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(start)]
    fn start() {
        console_error_panic_hook::set_once();
    }
}
