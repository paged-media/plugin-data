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

//! The pure expression-function kernels, one module per family (spec §9.1). The
//! registry-generated [`crate::dispatch`] routes each registered name to one of
//! these `fn(&[Value], &EvalCtx) -> Value` kernels after an arity guard. A
//! kernel never sees the resolution graph or the SDK (spec §4 rule 1).
//!
//! Arity is guaranteed by the dispatch guard, so kernels index `args` directly.

pub mod format;
pub mod logic;
pub mod math;
pub mod temporal;
pub mod text;

use data_core::{Value, ValueError};

/// Coerce a value to a count of days since 1970-01-01 — shared by the `format`
/// (DATEFMT) and `temporal` (YEAR/MONTH/DAY) families.
pub(crate) fn to_days(v: &Value) -> Result<i32, ValueError> {
    match v {
        Value::Date(d) => Ok(*d),
        Value::DateTime(ms) => Ok(ms.div_euclid(86_400_000) as i32),
        Value::Number(n) => Ok(*n as i32),
        Value::Text(t) => data_core::temporal::parse_iso_date(t).ok_or(ValueError::Parse),
        Value::Null => Err(ValueError::Missing),
        Value::Error(e) => Err(*e),
        Value::Bool(_) | Value::Bytes(_) => Err(ValueError::Type),
    }
}
