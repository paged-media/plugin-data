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

//! Logic family (spec §9.1): conditionals + null/error handling. `ISBLANK` /
//! `ISERROR` / `COALESCE` are error/null-transparent by design (they inspect
//! their arguments rather than propagating). `IF`/`AND`/`OR`/`NOT` propagate a
//! genuine condition error.

use data_core::Value;

use crate::ctx::EvalCtx;

/// `IF(cond, a, b)`.
pub fn if_(args: &[Value], _ctx: &EvalCtx) -> Value {
    match args[0].as_bool() {
        Ok(true) => args[1].clone(),
        Ok(false) => args[2].clone(),
        Err(e) => Value::Error(e),
    }
}

/// `AND(...)` — short-circuit false; a non-boolean condition is `#TYPE`.
pub fn and(args: &[Value], _ctx: &EvalCtx) -> Value {
    for a in args {
        match a.as_bool() {
            Ok(true) => continue,
            Ok(false) => return Value::Bool(false),
            Err(e) => return Value::Error(e),
        }
    }
    Value::Bool(true)
}

/// `OR(...)` — short-circuit true.
pub fn or(args: &[Value], _ctx: &EvalCtx) -> Value {
    for a in args {
        match a.as_bool() {
            Ok(true) => return Value::Bool(true),
            Ok(false) => continue,
            Err(e) => return Value::Error(e),
        }
    }
    Value::Bool(false)
}

/// `NOT(x)`.
pub fn not(args: &[Value], _ctx: &EvalCtx) -> Value {
    match args[0].as_bool() {
        Ok(b) => Value::Bool(!b),
        Err(e) => Value::Error(e),
    }
}

/// `ISBLANK(x)` — true for `Null` or empty text.
pub fn isblank(args: &[Value], _ctx: &EvalCtx) -> Value {
    let blank = match &args[0] {
        Value::Null => true,
        Value::Text(t) => t.is_empty(),
        _ => false,
    };
    Value::Bool(blank)
}

/// `ISERROR(x)`.
pub fn iserror(args: &[Value], _ctx: &EvalCtx) -> Value {
    Value::Bool(args[0].is_error())
}

/// `COALESCE(...)` — the first value that is neither `Null` nor an error;
/// `Null` if there is none.
pub fn coalesce(args: &[Value], _ctx: &EvalCtx) -> Value {
    for a in args {
        if !a.is_null() && !a.is_error() {
            return a.clone();
        }
    }
    Value::Null
}

/// `SWITCH(value, case1, result1, [case2, result2, ...], [default])` — return
/// the result whose case matches `value` (compared by display, so `1` matches
/// `"1"`); an odd trailing argument is the default. No match + no default → a
/// blank (`Null`). A `value` that is itself an error propagates.
pub fn switch(args: &[Value], _ctx: &EvalCtx) -> Value {
    if args[0].is_error() {
        return args[0].clone();
    }
    let target = args[0].as_display();
    let rest = &args[1..];
    let mut i = 0;
    while i + 1 < rest.len() {
        if rest[i].as_display() == target {
            return rest[i + 1].clone();
        }
        i += 2;
    }
    // An odd trailing argument is the default value.
    if rest.len() % 2 == 1 {
        return rest[rest.len() - 1].clone();
    }
    Value::Null
}
