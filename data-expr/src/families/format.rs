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

//! Format family (spec §9.1): number / currency / percent / date formatting —
//! the publishing format-code engine (own code; sheet §9 in spirit). All return
//! `Text`; an error or unparseable input propagates as a `Value::Error`.

use data_core::temporal::civil_from_days;
use data_core::{Locale, Value, ValueError};

use crate::ctx::EvalCtx;

/// `NUMBER(value, [decimals])` — fixed-decimal with locale-aware grouping.
pub fn number(args: &[Value], ctx: &EvalCtx) -> Value {
    let n = match args[0].as_number() {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let decimals = opt_usize(args.get(1), 0);
    Value::text(fmt_fixed(n, decimals, ctx.locale()))
}

/// `CURRENCY(value, [decimals=2], [symbol])` — `symbol` defaults to the locale's
/// (`$` leading for en, `€` trailing for de).
pub fn currency(args: &[Value], ctx: &EvalCtx) -> Value {
    let n = match args[0].as_number() {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let decimals = opt_usize(args.get(1), 2);
    let amount = fmt_fixed(n, decimals, ctx.locale());
    let (default_symbol, trailing) = ctx.locale().currency();
    let symbol = match args.get(2) {
        Some(v) => v.as_display(),
        None => default_symbol.to_string(),
    };
    if trailing {
        Value::text(format!("{amount} {symbol}"))
    } else {
        Value::text(format!("{symbol}{amount}"))
    }
}

/// `PERCENT(fraction, [decimals=0])` — `0.125 → "12.5%"` (locale-aware decimal).
pub fn percent(args: &[Value], ctx: &EvalCtx) -> Value {
    let n = match args[0].as_number() {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let decimals = opt_usize(args.get(1), 0);
    Value::text(format!("{}%", fmt_fixed(n * 100.0, decimals, ctx.locale())))
}

/// `DATEFMT(date, [pattern])` — `pattern` defaults to the locale's (`YYYY-MM-DD`
/// for en, `DD.MM.YYYY` for de). Supported tokens: `YYYY`, `YY`, `MM`, `DD`.
pub fn datefmt(args: &[Value], ctx: &EvalCtx) -> Value {
    let days = match super::to_days(&args[0]) {
        Ok(d) => d,
        Err(e) => return Value::Error(e),
    };
    let pattern = match args.get(1) {
        Some(v) => v.as_display(),
        None => ctx.locale().date_pattern().to_string(),
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

/// Fixed-decimal formatting with locale-aware grouping + decimal separators.
/// Deterministic given the locale (re-resolution stays idempotent).
fn fmt_fixed(n: f64, decimals: usize, locale: Locale) -> String {
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
    out.push_str(&group_thousands(int_part, locale.group_sep()));
    if let Some(f) = frac {
        out.push(locale.decimal_sep());
        out.push_str(f);
    }
    out
}

/// Insert `sep` every three digits from the right. `int_part` is digits only.
fn group_thousands(int_part: &str, sep: char) -> String {
    let len = int_part.len();
    let mut out = String::with_capacity(len + len / 3);
    for (i, ch) in int_part.chars().enumerate() {
        if i > 0 && (len - i).is_multiple_of(3) {
            out.push(sep);
        }
        out.push(ch);
    }
    out
}
