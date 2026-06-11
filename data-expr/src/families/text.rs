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

use data_core::{Value, ValueError};

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

/// `MID(text, start, len)` — `len` characters from 1-based `start` (char-based).
/// `start < 1` or `len < 0` is `#VALUE`; a start past the end yields `""`.
pub fn mid(args: &[Value], _ctx: &EvalCtx) -> Value {
    if args[0].is_error() {
        return args[0].clone();
    }
    let start = match args[1].as_number() {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let len = match args[2].as_number() {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    if start < 1.0 || len < 0.0 {
        return Value::Error(ValueError::Value);
    }
    let begin = (start as usize) - 1;
    let out: String = args[0]
        .as_display()
        .chars()
        .skip(begin)
        .take(len as usize)
        .collect();
    Value::text(out)
}

/// `PROPER(text)` — title-case: the first letter of each word upper, the rest
/// lower (a "word" starts after any non-alphabetic character).
pub fn proper(args: &[Value], _ctx: &EvalCtx) -> Value {
    if args[0].is_error() {
        return args[0].clone();
    }
    let s = args[0].as_display();
    let mut out = String::with_capacity(s.len());
    let mut new_word = true;
    for ch in s.chars() {
        if ch.is_alphabetic() {
            if new_word {
                out.extend(ch.to_uppercase());
            } else {
                out.extend(ch.to_lowercase());
            }
            new_word = false;
        } else {
            out.push(ch);
            new_word = true;
        }
    }
    Value::text(out)
}

/// `FIND(needle, haystack, [start=1])` — the 1-based character position of
/// `needle` in `haystack` at or after `start`; `#VALUE` when not found or
/// `start < 1`. An empty `needle` returns `start`.
pub fn find(args: &[Value], _ctx: &EvalCtx) -> Value {
    if args[0].is_error() {
        return args[0].clone();
    }
    if args[1].is_error() {
        return args[1].clone();
    }
    let needle: Vec<char> = args[0].as_display().chars().collect();
    let hay: Vec<char> = args[1].as_display().chars().collect();
    let start = match args.get(2) {
        Some(v) => match v.as_number() {
            Ok(n) => n as i64,
            Err(e) => return Value::Error(e),
        },
        None => 1,
    };
    if start < 1 {
        return Value::Error(ValueError::Value);
    }
    let begin = (start - 1) as usize;
    if needle.is_empty() {
        return if begin <= hay.len() {
            Value::Number(start as f64)
        } else {
            Value::Error(ValueError::Value)
        };
    }
    if begin >= hay.len() || needle.len() > hay.len() - begin {
        return Value::Error(ValueError::Value);
    }
    for i in begin..=(hay.len() - needle.len()) {
        if hay[i..i + needle.len()] == needle[..] {
            return Value::Number((i + 1) as f64);
        }
    }
    Value::Error(ValueError::Value)
}

/// `TEXTJOIN(delimiter, ...values)` — join the values with `delimiter`, skipping
/// `Null`/empty (the composite-field idiom, e.g. `"Brand - Model - Color"`). An
/// error value propagates.
pub fn textjoin(args: &[Value], _ctx: &EvalCtx) -> Value {
    if args[0].is_error() {
        return args[0].clone();
    }
    for v in &args[1..] {
        if v.is_error() {
            return v.clone();
        }
    }
    let delim = args[0].as_display();
    let parts: Vec<String> = args[1..]
        .iter()
        .filter(|v| !v.is_null())
        .map(|v| v.as_display())
        .filter(|s| !s.is_empty())
        .collect();
    Value::text(parts.join(&delim))
}

/// `REPT(text, count)` — `text` repeated `count` times; `#VALUE` for a negative
/// count.
pub fn rept(args: &[Value], _ctx: &EvalCtx) -> Value {
    if args[0].is_error() {
        return args[0].clone();
    }
    let count = match args[1].as_number() {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    if count < 0.0 {
        return Value::Error(ValueError::Value);
    }
    Value::text(args[0].as_display().repeat(count as usize))
}
