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

//! Colour family (ADR 558 §3). A colour is a canonical colour-literal TEXT
//! (`rgb(255,0,0)`, `cmyk(0,100,100,0)`, `swatch:Red`) that a property
//! binding coerces to a swatch reference on the target; the host reuses a
//! swatch of that name or value, or mints one under InDesign's
//! unnamed-colour name (`R=255 G=0 B=0`). `ENUM` checks a text against the
//! members a target accepts.

use data_core::{parse_color, ColorLiteral, Value, ValueError};

use crate::ctx::EvalCtx;

fn channel(v: &Value, max: f64) -> Result<f64, ValueError> {
    let n = v.as_number()?;
    if !(0.0..=max).contains(&n) {
        return Err(ValueError::Value);
    }
    Ok(n)
}

fn first_error(args: &[Value]) -> Option<Value> {
    args.iter().find(|a| a.is_error()).cloned()
}

/// `RGB(r, g, b)` — channels 0–255.
pub fn rgb(args: &[Value], _ctx: &EvalCtx) -> Value {
    if let Some(e) = first_error(args) {
        return e;
    }
    let mut c = [0.0; 3];
    for (i, a) in args.iter().take(3).enumerate() {
        match channel(a, 255.0) {
            Ok(n) => c[i] = n,
            Err(e) => return Value::Error(e),
        }
    }
    Value::text(ColorLiteral::Rgb(c).canonical())
}

/// `CMYK(c, m, y, k)` — channels 0–100 (percent).
pub fn cmyk(args: &[Value], _ctx: &EvalCtx) -> Value {
    if let Some(e) = first_error(args) {
        return e;
    }
    let mut c = [0.0; 4];
    for (i, a) in args.iter().take(4).enumerate() {
        match channel(a, 100.0) {
            Ok(n) => c[i] = n,
            Err(e) => return Value::Error(e),
        }
    }
    Value::text(ColorLiteral::Cmyk(c).canonical())
}

/// `HEX(text)` — `"#ff0000"`, `"ff0000"` or `"#f00"` to an RGB colour.
pub fn hex(args: &[Value], _ctx: &EvalCtx) -> Value {
    let v = &args[0];
    if v.is_error() || v.is_null() {
        return v.clone();
    }
    let t = v.as_display();
    let t = t.trim();
    let with_hash = if t.starts_with('#') {
        t.to_string()
    } else {
        format!("#{t}")
    };
    match parse_color(&with_hash) {
        Some(c @ ColorLiteral::Rgb(_)) => Value::text(c.canonical()),
        _ => Value::Error(ValueError::Parse),
    }
}

/// `SWATCH(name)` — a document swatch by name (`"Red"`, `"Color/Red"`).
pub fn swatch(args: &[Value], _ctx: &EvalCtx) -> Value {
    let v = &args[0];
    if v.is_error() || v.is_null() {
        return v.clone();
    }
    let name = v.as_display();
    if name.trim().is_empty() {
        return Value::Error(ValueError::Value);
    }
    Value::text(ColorLiteral::Swatch(name.trim().to_string()).canonical())
}

/// `ENUM(text, member, …)` — `text` when it is one of the members, else
/// `#VALUE`. The schema coercion does the same against the target's members.
pub fn enum_(args: &[Value], _ctx: &EvalCtx) -> Value {
    if let Some(e) = first_error(args) {
        return e;
    }
    if args[0].is_null() {
        return Value::Null;
    }
    let text = args[0].as_display();
    if args[1..].iter().any(|m| m.as_display() == text) {
        Value::text(text)
    } else {
        Value::Error(ValueError::Value)
    }
}
