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

//! Temporal family (spec §9.1): civil-date field extraction over the
//! [`super::to_days`] coercion. `TODAY()` reads the **injected** eval clock —
//! deterministic, never the wall clock (sheet rules; spec §12.4).

use data_core::temporal::civil_from_days;
use data_core::Value;

use crate::ctx::EvalCtx;

/// `YEAR(date)`.
pub fn year(args: &[Value], _ctx: &EvalCtx) -> Value {
    field(&args[0], |(y, _, _)| y as f64)
}

/// `MONTH(date)`.
pub fn month(args: &[Value], _ctx: &EvalCtx) -> Value {
    field(&args[0], |(_, m, _)| m as f64)
}

/// `DAY(date)`.
pub fn day(args: &[Value], _ctx: &EvalCtx) -> Value {
    field(&args[0], |(_, _, d)| d as f64)
}

/// `TODAY()` — the injected eval clock as a `Date`.
pub fn today(_args: &[Value], ctx: &EvalCtx) -> Value {
    Value::Date(ctx.today())
}

fn field(v: &Value, pick: impl Fn((i32, u32, u32)) -> f64) -> Value {
    match super::to_days(v) {
        Ok(days) => Value::Number(pick(civil_from_days(days))),
        Err(e) => Value::Error(e),
    }
}

/// `WEEKDAY(date)` — the day of the week, `1` = Sunday … `7` = Saturday
/// (Excel's default). 1970-01-01 (day 0) was a Thursday.
pub fn weekday(args: &[Value], _ctx: &EvalCtx) -> Value {
    match super::to_days(&args[0]) {
        Ok(days) => Value::Number(((days as i64 + 4).rem_euclid(7) + 1) as f64),
        Err(e) => Value::Error(e),
    }
}
