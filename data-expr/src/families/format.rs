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

//! Format family (spec §9.1): number / currency / percent / date formatting —
//! the publishing format-code engine (own code; sheet §9 in spirit). All return
//! `Text`; an error or unparseable input propagates as a `Value::Error`.

use data_core::temporal::civil_from_days;
use data_core::{Value, ValueError};

use crate::ctx::EvalCtx;

/// `NUMBER(value, [decimals])` — fixed-decimal with thousands grouping.
pub fn number(args: &[Value], _ctx: &EvalCtx) -> Value {
    let n = match args[0].as_number() {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let decimals = opt_usize(args.get(1), 0);
    Value::text(fmt_fixed(n, decimals))
}

/// `CURRENCY(value, [decimals=2], [symbol="$"])`.
pub fn currency(args: &[Value], _ctx: &EvalCtx) -> Value {
    let n = match args[0].as_number() {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let decimals = opt_usize(args.get(1), 2);
    let symbol = match args.get(2) {
        Some(v) => v.as_display(),
        None => "$".to_string(),
    };
    Value::text(format!("{symbol}{}", fmt_fixed(n, decimals)))
}

/// `PERCENT(fraction, [decimals=0])` — `0.125 → "12.5%"`.
pub fn percent(args: &[Value], _ctx: &EvalCtx) -> Value {
    let n = match args[0].as_number() {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let decimals = opt_usize(args.get(1), 0);
    Value::text(format!("{}%", fmt_fixed(n * 100.0, decimals)))
}

/// `DATEFMT(date, [pattern="YYYY-MM-DD"])`. Supported tokens: `YYYY`, `YY`,
/// `MM`, `DD`.
pub fn datefmt(args: &[Value], _ctx: &EvalCtx) -> Value {
    let days = match super::to_days(&args[0]) {
        Ok(d) => d,
        Err(e) => return Value::Error(e),
    };
    let pattern = match args.get(1) {
        Some(v) => v.as_display(),
        None => "YYYY-MM-DD".to_string(),
    };
    let (y, m, d) = civil_from_days(days);
    let out = pattern
        .replace("YYYY", &format!("{y:04}"))
        .replace("YY", &format!("{:02}", y.rem_euclid(100)))
        .replace("MM", &format!("{m:02}"))
        .replace("DD", &format!("{d:02}"));
    Value::text(out)
}

/// `args.get(i)` as a `usize`, or `default` if absent/unparseable.
fn opt_usize(v: Option<&Value>, default: usize) -> usize {
    match v {
        Some(v) => v
            .as_number()
            .ok()
            .map(|n| n.max(0.0) as usize)
            .unwrap_or(default),
        None => default,
    }
}

/// Fixed-decimal formatting with thousands grouping. Bit-stable (no locale).
fn fmt_fixed(n: f64, decimals: usize) -> String {
    if !n.is_finite() {
        return ValueError::Value.code().to_string();
    }
    let neg = n.is_sign_negative() && n != 0.0;
    let s = format!("{:.*}", decimals, n.abs());
    let (int_part, frac) = match s.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (s.as_str(), None),
    };
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    out.push_str(&group_thousands(int_part));
    if let Some(f) = frac {
        out.push('.');
        out.push_str(f);
    }
    out
}

/// Insert `,` every three digits from the right. `int_part` is digits only.
fn group_thousands(int_part: &str) -> String {
    let len = int_part.len();
    let mut out = String::with_capacity(len + len / 3);
    for (i, ch) in int_part.chars().enumerate() {
        if i > 0 && (len - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}
