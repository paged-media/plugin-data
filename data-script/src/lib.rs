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

//! # data-script — the constrained scripting surface (spec §10)
//!
//! "A constrained scripting surface (Boa, capability-gated) exposes the
//! binding/build API for scriptable queries and templated runs — **not arbitrary
//! code execution against the host**." This crate is the engine-neutral half: a
//! sandboxed [Boa](https://boajs.dev) (Rust JS) context in which the script
//! **computes and returns a build spec** — `{ locale?, params?, build? }` — and
//! the host reads + applies it.
//!
//! The safety model is *return-a-value*, not *call-the-host*: the script is
//! handed NO host functions, so it cannot touch the filesystem, the network, or
//! the engine internals (Boa is a bare ECMAScript engine — no Node/DOM globals).
//! It can only run JS logic (loops, conditionals, string building) to DECIDE the
//! parameter set and the run mode — exactly "scriptable queries and templated
//! runs", and nothing more. Native-only (Boa is far over the wasm budget).

use std::collections::HashMap;

use serde::Deserialize;

use boa_engine::{Context, Source};

use data_automation::BatchMode;
use data_core::{Locale, Value};
use data_js::core::DataSession;

/// What a build script returns (spec §10): a declarative description of a run.
/// Every field is optional so a script can parameterize, set the locale, request
/// a build, or any combination.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptSpec {
    /// The formatting locale for the run.
    #[serde(default)]
    pub locale: Option<Locale>,
    /// Query parameters to bind (`name -> scalar`). The script computes these
    /// — the "scriptable queries" half (a query's `?name` params come from here).
    #[serde(default)]
    pub params: HashMap<String, serde_json::Value>,
    /// The build to run, if the script requests one.
    #[serde(default)]
    pub build: Option<BuildSpec>,
}

/// The build a script requests: which record-flow binding, partitioned how.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSpec {
    pub binding: String,
    pub mode: BatchMode,
}

/// Evaluate a constrained build script and return its [`ScriptSpec`] (spec §10).
/// The script runs in a bare, sandboxed Boa context and must **return** a spec
/// object (e.g. `({ build: { binding: "rf", mode: { mode: "oneCatalog" } } })`).
/// It is handed no host access; a reference to an absent global (`require`,
/// `process`, `fetch`) is a `ReferenceError`, surfaced here as an `Err`.
pub fn eval_spec(script: &str) -> Result<ScriptSpec, String> {
    let mut context = Context::default();
    let result = context
        .eval(Source::from_bytes(script))
        .map_err(|e| format!("script error: {e}"))?;
    let json = result
        .to_json(&mut context)
        .map_err(|e| format!("script result is not JSON-serializable: {e}"))?
        .ok_or_else(|| "script returned undefined — return a spec object".to_string())?;
    serde_json::from_value(json).map_err(|e| format!("script spec shape: {e}"))
}

/// Apply a spec's parameterization to a session — set the locale + bind the
/// params. The build itself is run by the caller (which holds the frame chain).
pub fn apply_to_session(session: &mut DataSession, spec: &ScriptSpec) {
    if let Some(locale) = spec.locale {
        session.set_locale(locale);
    }
    for (name, value) in &spec.params {
        session.set_param(name, json_to_value(value));
    }
}

/// Map a JSON scalar to a query-parameter [`Value`]. A param is a scalar;
/// arrays/objects collapse to their JSON text rather than erroring.
fn json_to_value(value: &serde_json::Value) -> Value {
    match value {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Bool(*b),
        serde_json::Value::Number(n) => Value::Number(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(s) => Value::text(s),
        other => Value::text(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use data_core::{
        Binding, BindingDef, BindingId, FieldType, MissingPolicy, PlaceholderRef, Query, QueryId,
        RecordSet, ResultShape, Schema,
    };
    use data_js::core::{DataSession, LoweredOutput};

    #[test]
    fn data_automation_script_evaluates_a_build_spec() {
        // JS logic (an array index) decides the run — "templated runs".
        let script = r#"
            const regions = ["EMEA", "APAC"];
            ({
                locale: "de",
                params: { minPrice: 10, region: regions[0] },
                build: { binding: "rf", mode: { mode: "perGroup", by: ["region"] } }
            })
        "#;
        let spec = eval_spec(script).unwrap();
        assert_eq!(spec.locale, Some(Locale::De));
        assert_eq!(
            spec.params.get("minPrice").and_then(|v| v.as_f64()),
            Some(10.0)
        );
        assert_eq!(
            spec.params.get("region").and_then(|v| v.as_str()),
            Some("EMEA")
        );
        let build = spec.build.expect("a build was requested");
        assert_eq!(build.binding, "rf");
        assert!(matches!(build.mode, BatchMode::PerGroup { .. }));
    }

    #[test]
    fn data_automation_script_syntax_error_is_reported() {
        assert!(eval_spec("this is not ; valid (((").is_err());
    }

    #[test]
    fn data_automation_script_is_sandboxed_no_host_access() {
        // Boa is a bare ECMAScript engine — no Node/DOM/host globals. A script
        // reaching for the host gets a ReferenceError (surfaced as Err).
        assert!(eval_spec("require('fs')").is_err());
        assert!(eval_spec("process.exit(0)").is_err());
        assert!(eval_spec("fetch('http://evil.test')").is_err());
    }

    #[test]
    fn data_automation_script_applies_to_the_session() {
        // End-to-end: a script sets the de locale; applied to a session, a
        // CURRENCY variable resolves in de — the script's decision reached the
        // engine without the script ever touching it.
        let spec = eval_spec(r#"({ locale: "de" })"#).unwrap();
        let mut s = DataSession::new(0);
        s.define_query(Query {
            id: QueryId::from("q1"),
            sql: String::new(),
            params: vec![],
            shape: ResultShape::SingleRecord,
        });
        s.define_binding(BindingDef {
            id: BindingId::from("v1"),
            binding: Binding::Variable {
                target: PlaceholderRef::from("ph"),
                query: QueryId::from("q1"),
                expr: "CURRENCY(price)".into(),
                missing: MissingPolicy::Blank,
            },
        });
        s.ingest_result(
            QueryId::from("q1"),
            RecordSet::new(
                Schema::from_fields([("price".to_string(), FieldType::Float)]),
                vec![vec![Value::Number(1234.5)]],
            )
            .unwrap(),
        );

        apply_to_session(&mut s, &spec);
        match s.resolve_lowered(&BindingId::from("v1")).unwrap() {
            LoweredOutput::Variable(v) => assert_eq!(v.text, "1.234,50 €"),
            other => panic!("expected a variable, got {other:?}"),
        }
    }
}
