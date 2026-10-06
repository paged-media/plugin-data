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

//! ADR 558 — resolving a [`Binding::Property`](data_core::Binding::Property):
//! evaluate the expression over one record, then COERCE the result against
//! the target's schema row ([`TargetSchema`]). The coercion is the whole of
//! the type semantics: the host only writes what comes out (CLAUDE.md hard
//! rule — no binding semantics in TypeScript).
//!
//! | target   | accepted                                                     |
//! |----------|--------------------------------------------------------------|
//! | bool     | anything `as_bool` reads (true/false/yes/no/1/0)             |
//! | number   | a number or numeric text (`50%` for a percent unit); integer |
//! |          | and range checked                                            |
//! | length   | a number (pt) or a text with a unit (`"3mm"`), range checked |
//! | color    | a colour literal (`rgb()`, `cmyk()`, `#hex`, `swatch:`) or a |
//! |          | swatch name                                                  |
//! | enum     | a text that is one of the members                            |
//! | text     | any value's display, `maxLength` checked                     |
//! | ref      | a non-empty name or id                                       |
//! | asset    | a non-empty URL, path or asset id                            |
//! | bounds / point / transform | comma-separated numbers (units allowed)    |

use std::collections::HashMap;

use data_core::{
    parse_color, parse_length, CoercePolicy, ColorIntent, ColorLiteral, Locale, PropValue,
    PropertyMissing, PropertyOutcome, RecordSet, TargetRef, TargetSchema, TargetType, Value,
};
use data_expr::{eval_str, EvalCtx};

use crate::RowCtx;

/// One resolved property binding (ADR 558): what to write where, or why
/// nothing is written.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedProperty {
    pub target: TargetRef,
    pub path: String,
    /// The expression's raw result (before coercion) — a data set captures
    /// the coerced value, the panel shows this one.
    pub raw: Value,
    pub outcome: PropertyOutcome,
}

/// A coerced value, ready for the host.
pub type Coerced = (PropValue, Option<ColorIntent>);

fn describe(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => format!("bool {b}"),
        Value::Number(n) => format!("number {n}"),
        Value::Text(t) => format!("text {:?}", t.as_str()),
        Value::Date(_) | Value::DateTime(_) => format!("date {}", v.as_display()),
        Value::Bytes(b) => format!("{} bytes", b.len()),
        Value::Error(e) => format!("error {e:?}"),
    }
}

fn check_range(n: f64, schema: &TargetSchema, unit: &str) -> Result<f64, String> {
    if let Some(r) = schema.range {
        if let Some(min) = r.min {
            if n < min {
                return Err(format!("{n}{unit} is below the minimum {min}{unit}"));
            }
        }
        if let Some(max) = r.max {
            if n > max {
                return Err(format!("{n}{unit} is above the maximum {max}{unit}"));
            }
        }
    }
    Ok(n)
}

fn numbers(text: &str, n: usize, what: &str) -> Result<Vec<f64>, String> {
    let parts: Vec<&str> = text
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .collect();
    if parts.len() != n {
        return Err(format!(
            "a {what} needs {n} comma-separated numbers, got {:?}",
            text
        ));
    }
    parts
        .iter()
        .map(|p| parse_length(p).ok_or_else(|| format!("{p:?} is not a number or a length")))
        .collect()
}

/// Coerce one expression result against a target schema row (ADR 558 §2).
/// `None` = untyped: the value is written as the expression produced it.
/// A null value is NOT coerced here — the caller runs the missing policy.
pub fn coerce(value: &Value, schema: Option<&TargetSchema>) -> Result<Coerced, String> {
    if let Value::Error(e) = value {
        return Err(format!("the expression failed ({e:?})"));
    }
    let plain = |p: PropValue| Ok((p, None));
    let Some(schema) = schema else {
        return match value {
            Value::Bool(b) => plain(PropValue::Bool(*b)),
            Value::Number(n) => plain(PropValue::Number(*n)),
            Value::Bytes(_) => Err("bytes cannot be written to a property".into()),
            other => plain(PropValue::Text(other.as_display())),
        };
    };
    let mismatch = |want: &str| Err(format!("expected {want}, got {}", describe(value)));
    match &schema.value_type {
        TargetType::Bool => match value.as_bool() {
            Ok(b) => plain(PropValue::Bool(b)),
            Err(_) => mismatch("a bool (true/false/yes/no/1/0)"),
        },
        TargetType::Number { integer, unit } => {
            let n = match value {
                Value::Text(t) if unit.as_deref() == Some("percent") && t.trim().ends_with('%') => {
                    t.trim().trim_end_matches('%').trim().parse::<f64>().ok()
                }
                Value::Bytes(_) | Value::Date(_) | Value::DateTime(_) => None,
                other => other.as_number().ok(),
            };
            let Some(n) = n.filter(|n| n.is_finite()) else {
                return mismatch("a number");
            };
            if *integer && n.fract() != 0.0 {
                return Err(format!("expected a whole number, got {n}"));
            }
            plain(PropValue::Number(check_range(n, schema, "")?))
        }
        TargetType::Length => {
            let n = match value {
                Value::Text(t) => parse_length(t),
                Value::Number(n) => Some(*n),
                _ => None,
            };
            match n {
                Some(n) => plain(PropValue::Number(check_range(n, schema, " pt")?)),
                None => mismatch("a length (a number of points, or a text like \"3mm\")"),
            }
        }
        TargetType::Color => {
            let Value::Text(t) = value else {
                return mismatch("a colour (a swatch name, #rrggbb, RGB(), CMYK())");
            };
            let lit = parse_color(t).unwrap_or_else(|| ColorLiteral::Swatch(t.trim().to_string()));
            if matches!(&lit, ColorLiteral::Swatch(n) if n.is_empty()) {
                return mismatch("a colour");
            }
            let intent = lit.intent();
            Ok((PropValue::Text(intent.name.clone()), Some(intent)))
        }
        TargetType::Enum { members } => {
            let t = value.as_display();
            if members.contains(&t) {
                plain(PropValue::Text(t))
            } else {
                Err(format!("{:?} is not one of {}", t, members.join(", ")))
            }
        }
        TargetType::Text { max_length, .. } => {
            let t = value.as_display();
            match max_length {
                Some(max) if t.chars().count() > *max => Err(format!(
                    "the text is {} characters; the target takes at most {max}",
                    t.chars().count()
                )),
                _ => plain(PropValue::Text(t)),
            }
        }
        TargetType::Ref { to } => {
            let t = value.as_display();
            if t.trim().is_empty() {
                Err(format!("expected a {to} name or id, got an empty text"))
            } else {
                plain(PropValue::Text(t.trim().to_string()))
            }
        }
        TargetType::Asset => match value {
            Value::Text(t) if !t.trim().is_empty() => plain(PropValue::Text(t.trim().to_string())),
            _ => mismatch("a URL, path or asset id"),
        },
        TargetType::Bounds => plain(PropValue::List(numbers(&value.as_display(), 4, "bounds")?)),
        TargetType::Point => plain(PropValue::List(numbers(&value.as_display(), 2, "point")?)),
        TargetType::Transform => plain(PropValue::List(numbers(
            &value.as_display(),
            6,
            "transform",
        )?)),
        TargetType::Unsupported => Err("the target's value type cannot be bound".into()),
    }
}

/// Run the missing policy (a null value, an absent record, or a lenient
/// mismatch whose reason is `why`).
fn missing(policy: PropertyMissing, schema: Option<&TargetSchema>, why: String) -> PropertyOutcome {
    match policy {
        PropertyMissing::KeepLast => PropertyOutcome::Keep { reason: why },
        PropertyMissing::Clear => match schema {
            Some(s) if !s.nullable => PropertyOutcome::Fail {
                message: format!("{why}; the Clear policy needs a nullable target"),
            },
            _ => PropertyOutcome::Write {
                value: PropValue::Null,
                color: None,
            },
        },
        PropertyMissing::Default => match schema.and_then(|s| s.default.clone()) {
            Some(value) => PropertyOutcome::Write { value, color: None },
            None => PropertyOutcome::Fail {
                message: format!("{why}; the Default policy needs a schema default"),
            },
        },
        PropertyMissing::Error => PropertyOutcome::Fail { message: why },
    }
}

/// The decision for an already-evaluated value.
pub fn decide(
    value: &Value,
    schema: Option<&TargetSchema>,
    coerce_policy: CoercePolicy,
    missing_policy: PropertyMissing,
) -> PropertyOutcome {
    if value.is_null() {
        return missing(missing_policy, schema, "the value is missing".into());
    }
    match coerce(value, schema) {
        Ok((value, color)) => PropertyOutcome::Write { value, color },
        Err(message) => match coerce_policy {
            CoercePolicy::Strict => PropertyOutcome::Fail { message },
            CoercePolicy::Lenient => missing(missing_policy, schema, message),
        },
    }
}

/// Resolve one property binding over record `row` (`usize::MAX` = absent).
#[allow(clippy::too_many_arguments)]
pub(crate) fn resolve_property(
    target: TargetRef,
    path: &str,
    expr: &str,
    schema: Option<&TargetSchema>,
    coerce_policy: CoercePolicy,
    missing_policy: PropertyMissing,
    records: &RecordSet,
    row: usize,
    params: &HashMap<String, Value>,
    today: i32,
    locale: Locale,
) -> ResolvedProperty {
    let raw = if row >= records.row_count {
        Value::Null
    } else {
        let ctx = RowCtx {
            records,
            row,
            params,
        };
        let ec = EvalCtx::new(&ctx, today).with_locale(locale);
        eval_str(expr, &ec)
    };
    let outcome = decide(&raw, schema, coerce_policy, missing_policy);
    ResolvedProperty {
        target,
        path: path.to_string(),
        raw,
        outcome,
    }
}
