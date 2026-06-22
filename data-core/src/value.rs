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

//! The runtime [`Value`] (spec §5.1) — mirrors the sheet `CellValue` shape
//! (number / text / bool / null / error) plus typed temporal and binary (for
//! image bytes/URIs). A **shared vocabulary, not shared code** (no dependency
//! on plugin-sheet). Evaluation is CPU/`f64` bit-stable (no GPU, no tolerance);
//! the same value compares equal across resolutions, which the sync engine
//! relies on for record identity (spec §8, §12.4).

use compact_str::CompactString;
use serde::{Deserialize, Serialize};

/// A resolved value flowing through expression evaluation and binding
/// resolution. `Date` is days since the Unix epoch (1970-01-01, civil);
/// `DateTime` is milliseconds since the Unix epoch (UTC). `Bytes` carries
/// image/binary payloads (image placeholders, spec §9.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v", rename_all = "lowercase")]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    Text(CompactString),
    /// Days since 1970-01-01 (civil).
    Date(i32),
    /// Milliseconds since the Unix epoch (UTC).
    DateTime(i64),
    /// Binary payload (image bytes, encoded URI bytes).
    Bytes(Vec<u8>),
    Error(ValueError),
}

/// A typed evaluation error. Errors propagate as values (like sheet error
/// cells) — they are display/diagnostic data, never a Rust panic or a boundary
/// failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ValueError {
    /// Wrong type for the operation (e.g. text where a number was needed).
    Type,
    /// A required field/param was missing or null where a value was needed.
    Missing,
    /// A literal/format could not be parsed.
    Parse,
    /// An unregistered/unimplemented function name (`#NAME`).
    Name,
    /// A bad argument value or arity (`#VALUE`).
    Value,
    /// Division by zero.
    DivByZero,
    /// A referenced source/query value was not available.
    NotAvailable,
}

impl Value {
    /// Construct a text value from anything string-like.
    pub fn text(s: impl Into<CompactString>) -> Self {
        Value::Text(s.into())
    }

    /// True for `Null` (the absence of a value).
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    /// True for any `Error(..)`.
    pub fn is_error(&self) -> bool {
        matches!(self, Value::Error(_))
    }

    /// Coerce to a number for arithmetic. Bools coerce (`true`→1, `false`→0);
    /// numeric text parses; dates/datetimes coerce to their serial; `Null`→0.
    /// Anything else is [`ValueError::Type`].
    pub fn as_number(&self) -> Result<f64, ValueError> {
        match self {
            Value::Number(n) => Ok(*n),
            Value::Bool(b) => Ok(if *b { 1.0 } else { 0.0 }),
            Value::Null => Ok(0.0),
            Value::Date(d) => Ok(*d as f64),
            Value::DateTime(ms) => Ok(*ms as f64),
            Value::Text(t) => t.trim().parse::<f64>().map_err(|_| ValueError::Type),
            Value::Bytes(_) => Err(ValueError::Type),
            Value::Error(e) => Err(*e),
        }
    }

    /// Coerce to a boolean. Numbers are truthy iff non-zero; text `"true"`/
    /// `"false"` (case-insensitive) parse; `Null`→false.
    pub fn as_bool(&self) -> Result<bool, ValueError> {
        match self {
            Value::Bool(b) => Ok(*b),
            Value::Number(n) => Ok(*n != 0.0),
            Value::Null => Ok(false),
            Value::Text(t) => match t.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" => Ok(true),
                "false" | "0" | "no" | "" => Ok(false),
                _ => Err(ValueError::Type),
            },
            Value::Error(e) => Err(*e),
            _ => Err(ValueError::Type),
        }
    }

    /// The plain (unformatted) display string of a value. `Null` renders empty;
    /// errors render as `#NAME` etc.; numbers use a shortest-round-trip form.
    pub fn as_display(&self) -> String {
        match self {
            Value::Null => String::new(),
            Value::Bool(b) => {
                if *b {
                    "TRUE".to_string()
                } else {
                    "FALSE".to_string()
                }
            }
            Value::Number(n) => fmt_number(*n),
            Value::Text(t) => t.to_string(),
            Value::Date(d) => {
                let (y, m, day) = crate::temporal::civil_from_days(*d);
                format!("{y:04}-{m:02}-{day:02}")
            }
            Value::DateTime(ms) => {
                let days = ms.div_euclid(86_400_000) as i32;
                let (y, m, day) = crate::temporal::civil_from_days(days);
                let rem = ms.rem_euclid(86_400_000);
                let (h, mi, s) = (rem / 3_600_000, (rem / 60_000) % 60, (rem / 1000) % 60);
                format!("{y:04}-{m:02}-{day:02} {h:02}:{mi:02}:{s:02}")
            }
            Value::Bytes(b) => format!("<{} bytes>", b.len()),
            Value::Error(e) => e.code().to_string(),
        }
    }
}

impl ValueError {
    /// The short display code (sheet-style) for this error.
    pub fn code(self) -> &'static str {
        match self {
            ValueError::Type => "#TYPE",
            ValueError::Missing => "#MISSING",
            ValueError::Parse => "#PARSE",
            ValueError::Name => "#NAME",
            ValueError::Value => "#VALUE",
            ValueError::DivByZero => "#DIV/0",
            ValueError::NotAvailable => "#N/A",
        }
    }
}

impl std::fmt::Display for ValueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Value::Text(CompactString::new(s))
    }
}

impl From<f64> for Value {
    fn from(n: f64) -> Self {
        Value::Number(n)
    }
}

impl From<bool> for Value {
    fn from(b: bool) -> Self {
        Value::Bool(b)
    }
}

/// Shortest round-trip-ish display for a finite `f64`: integers print without a
/// decimal point; non-finite values render as their error code. Bit-stable
/// (no locale, no rounding heuristics) so re-resolution is idempotent.
fn fmt_number(n: f64) -> String {
    if !n.is_finite() {
        return "#NUM".to_string();
    }
    if n == n.trunc() && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        // Rust's default f64 formatting is shortest-round-trip (Ryū-equivalent).
        format!("{n}")
    }
}
