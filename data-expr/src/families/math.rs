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

//! Math family (spec §9.1): numeric derivation for prices/totals/rounding.
//! `f64`, bit-stable (sheet rules; no tolerance machinery). Aggregations skip
//! `Null`; any error argument propagates.

use data_core::{Value, ValueError};

use crate::ctx::EvalCtx;

/// `ABS(x)`.
pub fn abs(args: &[Value], _ctx: &EvalCtx) -> Value {
    unary(&args[0], f64::abs)
}

/// `FLOOR(x)`.
pub fn floor(args: &[Value], _ctx: &EvalCtx) -> Value {
    unary(&args[0], f64::floor)
}

/// `CEILING(x)`.
pub fn ceiling(args: &[Value], _ctx: &EvalCtx) -> Value {
    unary(&args[0], f64::ceil)
}

/// `ROUND(x, [digits=0])` — round half away from zero (Rust's `f64::round`).
pub fn round(args: &[Value], _ctx: &EvalCtx) -> Value {
    let x = match args[0].as_number() {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let digits = match args.get(1) {
        Some(v) => match v.as_number() {
            Ok(n) => n as i32,
            Err(e) => return Value::Error(e),
        },
        None => 0,
    };
    let factor = 10f64.powi(digits);
    Value::Number((x * factor).round() / factor)
}

/// `MIN(...)` — `Null` if no numeric argument.
pub fn min(args: &[Value], _ctx: &EvalCtx) -> Value {
    fold(args, f64::min)
}

/// `MAX(...)` — `Null` if no numeric argument.
pub fn max(args: &[Value], _ctx: &EvalCtx) -> Value {
    fold(args, f64::max)
}

/// `SUM(...)` — `0` over an all-null argument list.
pub fn sum(args: &[Value], _ctx: &EvalCtx) -> Value {
    let mut acc = 0.0;
    for a in args {
        if a.is_null() {
            continue;
        }
        match a.as_number() {
            Ok(n) => acc += n,
            Err(e) => return Value::Error(e),
        }
    }
    Value::Number(acc)
}

fn unary(v: &Value, f: impl Fn(f64) -> f64) -> Value {
    match v.as_number() {
        Ok(n) => Value::Number(f(n)),
        Err(e) => Value::Error(e),
    }
}

/// Fold the numeric (non-null) arguments; an error argument propagates, an
/// all-null list yields `Null`.
fn fold(args: &[Value], f: impl Fn(f64, f64) -> f64) -> Value {
    let mut acc: Option<f64> = None;
    for a in args {
        if a.is_null() {
            continue;
        }
        match a.as_number() {
            Ok(n) => {
                acc = Some(match acc {
                    Some(prev) => f(prev, n),
                    None => n,
                })
            }
            Err(e) => return Value::Error(e),
        }
    }
    match acc {
        Some(n) => Value::Number(n),
        None => Value::Null,
    }
}

/// `MOD(a, b)` — the remainder, sign following the divisor (Excel semantics:
/// `a - b·floor(a/b)`). `b == 0` is `#DIV/0`.
pub fn mod_(args: &[Value], _ctx: &EvalCtx) -> Value {
    let a = match args[0].as_number() {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let b = match args[1].as_number() {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    if b == 0.0 {
        return Value::Error(ValueError::DivByZero);
    }
    Value::Number(a - b * (a / b).floor())
}

/// `POWER(base, exp)` — `base^exp`. A non-finite result (e.g. a negative base to
/// a fractional power) is `#VALUE`.
pub fn power(args: &[Value], _ctx: &EvalCtx) -> Value {
    let base = match args[0].as_number() {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let exp = match args[1].as_number() {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let result = base.powf(exp);
    if result.is_finite() {
        Value::Number(result)
    } else {
        Value::Error(ValueError::Value)
    }
}

/// `TRUNC(x, [digits=0])` — truncate toward zero to `digits` decimals.
pub fn trunc(args: &[Value], _ctx: &EvalCtx) -> Value {
    let x = match args[0].as_number() {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let digits = match args.get(1) {
        Some(v) => match v.as_number() {
            Ok(n) => n as i32,
            Err(e) => return Value::Error(e),
        },
        None => 0,
    };
    let factor = 10f64.powi(digits);
    Value::Number((x * factor).trunc() / factor)
}

/// `SIGN(x)` — `-1`, `0`, or `1`.
pub fn sign(args: &[Value], _ctx: &EvalCtx) -> Value {
    match args[0].as_number() {
        Ok(n) => Value::Number(if n > 0.0 {
            1.0
        } else if n < 0.0 {
            -1.0
        } else {
            0.0
        }),
        Err(e) => Value::Error(e),
    }
}
