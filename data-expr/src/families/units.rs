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

//! Units family (ADR 558 §3): lengths for property bindings. A length is a
//! NUMBER in points — `MM(3)` is 8.5039… — so it composes with every math
//! and logic function. `AS(value, type)` is the explicit coercion the
//! property binding's schema coercion also performs implicitly.

use data_core::{parse_color, parse_length, points_per, Value, ValueError};

use crate::ctx::EvalCtx;

fn scaled(v: &Value, factor: f64) -> Value {
    match v {
        Value::Error(_) => v.clone(),
        Value::Null => Value::Null,
        Value::Text(t) => match parse_length(t) {
            // A text with its own unit keeps it ("3mm" stays 3 mm under PT());
            // a bare number takes this function's unit.
            Some(pt) if t.trim().ends_with(|c: char| c.is_ascii_alphabetic()) => Value::Number(pt),
            Some(n) => Value::Number(n * factor),
            None => Value::Error(ValueError::Type),
        },
        other => match other.as_number() {
            Ok(n) => Value::Number(n * factor),
            Err(e) => Value::Error(e),
        },
    }
}

/// `MM(x)` — millimetres to points.
pub fn mm(args: &[Value], _ctx: &EvalCtx) -> Value {
    scaled(&args[0], points_per("mm").unwrap_or(1.0))
}

/// `CM(x)` — centimetres to points.
pub fn cm(args: &[Value], _ctx: &EvalCtx) -> Value {
    scaled(&args[0], points_per("cm").unwrap_or(1.0))
}

/// `IN(x)` — inches to points.
pub fn inch(args: &[Value], _ctx: &EvalCtx) -> Value {
    scaled(&args[0], 72.0)
}

/// `PT(x)` — points (a text with a unit converts: `PT("3mm")`).
pub fn pt(args: &[Value], _ctx: &EvalCtx) -> Value {
    scaled(&args[0], 1.0)
}

/// `PX(x, [dpi=96])` — pixels at `dpi` to points.
pub fn px(args: &[Value], _ctx: &EvalCtx) -> Value {
    let dpi = match args.get(1) {
        Some(v) => match v.as_number() {
            Ok(n) if n > 0.0 => n,
            Ok(_) => return Value::Error(ValueError::Value),
            Err(e) => return Value::Error(e),
        },
        None => 96.0,
    };
    scaled(&args[0], 72.0 / dpi)
}

/// `AS(value, type)` — explicit coercion to `"number"`, `"length"` (pt),
/// `"bool"`, `"text"` or `"color"` (a canonical colour literal; a bare
/// name is a swatch name). An unknown type is `#VALUE`.
pub fn as_(args: &[Value], _ctx: &EvalCtx) -> Value {
    let v = &args[0];
    if v.is_error() {
        return v.clone();
    }
    let ty = args[1].as_display().trim().to_ascii_lowercase();
    match ty.as_str() {
        "number" => v.as_number().map_or_else(Value::Error, Value::Number),
        "length" => match v {
            Value::Text(t) => parse_length(t).map_or(Value::Error(ValueError::Type), Value::Number),
            _ => v.as_number().map_or_else(Value::Error, Value::Number),
        },
        "bool" => v.as_bool().map_or_else(Value::Error, Value::Bool),
        "text" => Value::text(v.as_display()),
        "color" => {
            let t = v.as_display();
            match parse_color(&t) {
                Some(c) => Value::text(c.canonical()),
                None if !t.trim().is_empty() => Value::text(format!("swatch:{}", t.trim())),
                None => Value::Null,
            }
        }
        _ => Value::Error(ValueError::Value),
    }
}
