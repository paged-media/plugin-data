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
