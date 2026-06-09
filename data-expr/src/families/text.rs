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

//! Text family (spec §9.1): the workhorse of variable replacement. `Null`
//! renders as empty (via `as_display`); an error argument propagates.

use data_core::Value;

use crate::ctx::EvalCtx;

/// `CONCAT(...)` — join the display of every argument.
pub fn concat(args: &[Value], _ctx: &EvalCtx) -> Value {
    let mut out = String::new();
    for a in args {
        if a.is_error() {
            return a.clone();
        }
        out.push_str(&a.as_display());
    }
    Value::text(out)
}

/// `UPPER(s)`.
pub fn upper(args: &[Value], _ctx: &EvalCtx) -> Value {
    if args[0].is_error() {
        return args[0].clone();
    }
    Value::text(args[0].as_display().to_uppercase())
}

/// `LOWER(s)`.
pub fn lower(args: &[Value], _ctx: &EvalCtx) -> Value {
    if args[0].is_error() {
        return args[0].clone();
    }
    Value::text(args[0].as_display().to_lowercase())
}

/// `TRIM(s)` — strip leading/trailing whitespace.
pub fn trim(args: &[Value], _ctx: &EvalCtx) -> Value {
    if args[0].is_error() {
        return args[0].clone();
    }
    Value::text(args[0].as_display().trim().to_string())
}

/// `LEN(s)` — character count.
pub fn len(args: &[Value], _ctx: &EvalCtx) -> Value {
    if args[0].is_error() {
        return args[0].clone();
    }
    Value::Number(args[0].as_display().chars().count() as f64)
}

/// `LEFT(s, n)` — the first `n` characters.
pub fn left(args: &[Value], _ctx: &EvalCtx) -> Value {
    let n = match args[1].as_number() {
        Ok(n) => n.max(0.0) as usize,
        Err(e) => return Value::Error(e),
    };
    if args[0].is_error() {
        return args[0].clone();
    }
    let s = args[0].as_display();
    Value::text(s.chars().take(n).collect::<String>())
}

/// `RIGHT(s, n)` — the last `n` characters.
pub fn right(args: &[Value], _ctx: &EvalCtx) -> Value {
    let n = match args[1].as_number() {
        Ok(n) => n.max(0.0) as usize,
        Err(e) => return Value::Error(e),
    };
    if args[0].is_error() {
        return args[0].clone();
    }
    let s = args[0].as_display();
    let total = s.chars().count();
    let skip = total.saturating_sub(n);
    Value::text(s.chars().skip(skip).collect::<String>())
}

/// `SUBSTITUTE(s, find, repl)` — replace every occurrence (a no-op when `find`
/// is empty, avoiding the degenerate "insert between every char").
pub fn substitute(args: &[Value], _ctx: &EvalCtx) -> Value {
    for a in args {
        if a.is_error() {
            return a.clone();
        }
    }
    let s = args[0].as_display();
    let find = args[1].as_display();
    let repl = args[2].as_display();
    if find.is_empty() {
        return Value::text(s);
    }
    Value::text(s.replace(&find, &repl))
}
