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

//! Conformance harness (spec §12) — the TEST-ONLY crate. The shared helpers
//! used by the per-family / per-subsystem tier tests; the coverage gate
//! (`bin/coverage-gate`) and an env-gated native-DuckDB differential oracle
//! skeleton live alongside (the oracle ships at M1 with the real engine
//! wiring — spec §12.4). Determinism: expression eval + binding resolution are
//! CPU/`f64` bit-stable (no GPU, no tolerance).

use data_core::{FieldType, RecordSet, Schema, Value};
use data_expr::{eval_str, EvalCtx, SimpleCtx};

/// The injected eval clock for tests: 2026-06-08 (days since 1970-01-01).
pub fn today() -> i32 {
    data_core::temporal::days_from_civil(2026, 6, 8)
}

/// Parse + evaluate an expression against a context with the test clock.
pub fn eval1(src: &str, ctx: &SimpleCtx) -> Value {
    let ec = EvalCtx::new(ctx, today());
    eval_str(src, &ec)
}

/// Evaluate against an empty context (literal-argument expressions).
pub fn eval0(src: &str) -> Value {
    eval1(src, &SimpleCtx::new())
}

/// Build a columnar [`RecordSet`] from `(name, type)` fields + columns.
pub fn record_set(fields: &[(&str, FieldType)], columns: Vec<Vec<Value>>) -> RecordSet {
    let schema = Schema::from_fields(fields.iter().map(|(n, t)| (n.to_string(), *t)));
    RecordSet::new(schema, columns).expect("well-formed record set")
}

/// A text value (terser than `Value::text` at call sites).
pub fn t(s: &str) -> Value {
    Value::text(s)
}

/// A number value.
pub fn n(x: f64) -> Value {
    Value::Number(x)
}
