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

//! The universal property binding's types (ADR 558): where a
//! [`Binding::Property`](crate::Binding::Property) lands ([`TargetRef`]), the
//! slice of the target's ADR 132 schema it coerces against ([`TargetSchema`]),
//! its policies, and the value it produces ([`PropValue`]).
//!
//! Plus the two pure literal parsers the expression language and the
//! coercion share: a length with a unit (`"3mm"` → pt) and a colour literal
//! (`"#ff0000"`, `"rgb(…)"`, `"cmyk(…)"`, `"swatch:Name"`).
//!
//! Values stay inside the existing [`Value`](crate::Value) model on purpose: a
//! length is a NUMBER in points, and a colour is a canonical colour-literal
//! TEXT. No new `Value` variant, so every shipped function composes with them
//! (`IF(x, MM(3), MM(5))`, `CONCAT("rgb(", …)`).

use serde::{Deserialize, Serialize};

/// Where a property binding lands (ADR 558). Durable by construction: a
/// selector over a stable key (a `Name`, an `x-paged:` label, a plugin
/// key) or `Host` — the element whose label carries the binding (ADR 559).
/// Never a raw `Self` id: InDesign renumbers every one on save.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetRef {
    /// The element carrying this binding in its label. Resolved by the host
    /// at apply time; only meaningful inside a label.
    Host,
    /// An ADR 131 selector (or a plain address), resolved at apply time to
    /// every object it matches.
    Selector(String),
}

/// What a property binding does when a value does not fit the target
/// (ADR 558 §2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CoercePolicy {
    /// A mismatch fails the binding with a diagnostic.
    #[default]
    Strict,
    /// A mismatch runs the binding's [`PropertyMissing`] policy instead.
    Lenient,
}

/// What a property binding does with a missing value (a null field, an
/// absent record — or, under [`CoercePolicy::Lenient`], a value that does
/// not fit). The text-oriented `MissingPolicy` does not fit non-text targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PropertyMissing {
    /// Write nothing: the document keeps its last value. The only policy that
    /// can never damage a designer's artwork, hence the default.
    #[default]
    KeepLast,
    /// Write null (the schema must be `nullable`).
    Clear,
    /// Write the schema's `default`.
    Default,
    /// Fail the binding.
    Error,
}

/// A target value type — ADR 132's `ValueType`, the subset a binding coerces
/// to. Serialized in the SDK's shape (`{ "kind": "length" }`), so a schema
/// row read from `host.objects.schema` deserializes as-is; kinds a binding
/// cannot produce (`list`, `map`, `struct`, `bytes`) read as
/// [`TargetType::Unsupported`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TargetType {
    Bool,
    Number {
        #[serde(default)]
        integer: bool,
        #[serde(default)]
        unit: Option<String>,
    },
    /// Points.
    Length,
    /// A swatch reference (resolved by the host; a literal colour may mint one).
    Color,
    Enum {
        members: Vec<String>,
    },
    Text {
        #[serde(default)]
        multiline: bool,
        #[serde(default, rename = "maxLength")]
        max_length: Option<usize>,
    },
    /// A reference to another object (a style, a layer, a master) by name or id.
    Ref {
        to: String,
    },
    /// A URL, a path or an asset id.
    Asset,
    /// `[top, left, bottom, right]` in points.
    Bounds,
    /// `[x, y]` in points.
    Point,
    /// `[a, b, c, d, tx, ty]`.
    Transform,
    /// Any kind this binding cannot produce.
    #[serde(other)]
    Unsupported,
}

impl TargetType {
    /// The ADR 132 kind name (diagnostics).
    pub fn name(&self) -> &'static str {
        match self {
            TargetType::Bool => "bool",
            TargetType::Number { .. } => "number",
            TargetType::Length => "length",
            TargetType::Color => "color",
            TargetType::Enum { .. } => "enum",
            TargetType::Text { .. } => "text",
            TargetType::Ref { .. } => "ref",
            TargetType::Asset => "asset",
            TargetType::Bounds => "bounds",
            TargetType::Point => "point",
            TargetType::Transform => "transform",
            TargetType::Unsupported => "unsupported",
        }
    }
}

/// A numeric range from the schema row.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct TargetRange {
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
}

/// The slice of an ADR 132 `PropertySchema` row a binding coerces against.
/// The host reads the row through `host.objects.schema` when the binding is
/// defined and again at apply time; the engine stores it in the recipe so a
/// headless resolve (batch, CLI, preview) coerces the same way.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TargetSchema {
    #[serde(rename = "type")]
    pub value_type: TargetType,
    #[serde(default)]
    pub nullable: bool,
    #[serde(default)]
    pub range: Option<TargetRange>,
    #[serde(default)]
    pub default: Option<PropValue>,
}

/// A value a property binding writes — the JSON the host hands to
/// `host.objects`. Untagged: `null`, `true`, `12.5`, `"Body"`, `[0,0,10,10]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PropValue {
    Null,
    Bool(bool),
    Number(f64),
    Text(String),
    List(Vec<f64>),
}

/// The decision for one property binding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum PropertyOutcome {
    /// Write `value` (a colour additionally carries the swatch the host
    /// resolves or mints).
    Write {
        value: PropValue,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<ColorIntent>,
    },
    /// Write nothing (`KeepLast`): the document keeps its value.
    Keep { reason: String },
    /// The binding failed (strict coercion, or the `Error` missing policy).
    Fail { message: String },
}

/// A colour the host resolves to a swatch reference (ADR 558 §2: a swatch
/// name or ref, `#rrggbb`, `RGB()` / `CMYK()`). `spec` is set for a literal
/// colour: the host reuses a swatch of that name or that value, and mints one
/// named the way InDesign names an unnamed colour (`R=255 G=0 B=0`,
/// `C=0 M=100 Y=100 K=0`) when there is none.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColorIntent {
    /// The swatch name (or `Color/…` self id) to look up.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<ColorSpec>,
}

/// A literal colour's process definition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColorSpec {
    /// `"RGB"` (0–255 channels) or `"CMYK"` (0–100 percent channels).
    pub space: String,
    pub value: Vec<f64>,
}

/// A parsed colour literal.
#[derive(Debug, Clone, PartialEq)]
pub enum ColorLiteral {
    Rgb([f64; 3]),
    Cmyk([f64; 4]),
    /// A swatch by name or self id (`swatch:Red`, or a bare name).
    Swatch(String),
}

impl ColorLiteral {
    /// The canonical text form the expression language carries
    /// (`rgb(255,0,0)`, `cmyk(0,100,100,0)`, `swatch:Red`).
    pub fn canonical(&self) -> String {
        match self {
            ColorLiteral::Rgb([r, g, b]) => format!("rgb({},{},{})", num(*r), num(*g), num(*b)),
            ColorLiteral::Cmyk([c, m, y, k]) => {
                format!("cmyk({},{},{},{})", num(*c), num(*m), num(*y), num(*k))
            }
            ColorLiteral::Swatch(name) => format!("swatch:{name}"),
        }
    }

    /// The host-side intent: a swatch to find, or a process colour to find or
    /// mint under InDesign's unnamed-colour name.
    pub fn intent(&self) -> ColorIntent {
        match self {
            ColorLiteral::Swatch(name) => ColorIntent {
                name: name.clone(),
                spec: None,
            },
            ColorLiteral::Rgb([r, g, b]) => ColorIntent {
                name: format!("R={} G={} B={}", num(*r), num(*g), num(*b)),
                spec: Some(ColorSpec {
                    space: "RGB".into(),
                    value: vec![*r, *g, *b],
                }),
            },
            ColorLiteral::Cmyk([c, m, y, k]) => ColorIntent {
                name: format!("C={} M={} Y={} K={}", num(*c), num(*m), num(*y), num(*k)),
                spec: Some(ColorSpec {
                    space: "CMYK".into(),
                    value: vec![*c, *m, *y, *k],
                }),
            },
        }
    }
}

/// `12` not `12.0`; up to 4 decimals, trailing zeros trimmed.
fn num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        let s = format!("{n:.4}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// Points per unit for the units the expression language and coercion accept.
pub fn points_per(unit: &str) -> Option<f64> {
    Some(match unit.to_ascii_lowercase().as_str() {
        "pt" => 1.0,
        "mm" => 72.0 / 25.4,
        "cm" => 72.0 / 2.54,
        "in" | "\"" => 72.0,
        "pc" | "p" => 12.0,
        // CSS pixels at 96 dpi; `PX(n, dpi)` takes another resolution.
        "px" => 72.0 / 96.0,
        _ => return None,
    })
}

/// Parse a length with an optional unit (`"3mm"`, `"2 in"`, `"12"`, `"-1.5cm"`)
/// to points. A bare number is points. `None` when it is not a length.
pub fn parse_length(text: &str) -> Option<f64> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    let split = t
        .char_indices()
        .find(|(_, c)| c.is_ascii_alphabetic() || *c == '"')
        .map_or(t.len(), |(i, _)| i);
    let (n, unit) = t.split_at(split);
    let value: f64 = n.trim().replace(',', ".").parse().ok()?;
    if !value.is_finite() {
        return None;
    }
    let unit = unit.trim();
    if unit.is_empty() {
        return Some(value);
    }
    points_per(unit).map(|f| value * f)
}

/// Parse a colour literal. Accepts `#rgb`, `#rrggbb`, `rgb(r,g,b)` (0–255),
/// `cmyk(c,m,y,k)` (0–100) and `swatch:<name>`. Anything else is `None` — the
/// coercion then reads the text as a swatch NAME.
pub fn parse_color(text: &str) -> Option<ColorLiteral> {
    let t = text.trim();
    if let Some(hex) = t.strip_prefix('#') {
        let expand = |s: &str| -> Option<[f64; 3]> {
            let chars: Vec<char> = s.chars().collect();
            let full: String = match chars.len() {
                3 => chars.iter().flat_map(|c| [*c, *c]).collect(),
                6 => s.to_string(),
                _ => return None,
            };
            let v = u32::from_str_radix(&full, 16).ok()?;
            Some([
                ((v >> 16) & 0xff) as f64,
                ((v >> 8) & 0xff) as f64,
                (v & 0xff) as f64,
            ])
        };
        return expand(hex).map(ColorLiteral::Rgb);
    }
    let lower = t.to_ascii_lowercase();
    if let Some(name) = t.strip_prefix("swatch:") {
        let name = name.trim();
        return (!name.is_empty()).then(|| ColorLiteral::Swatch(name.to_string()));
    }
    let channels = |prefix: &str, n: usize, max: f64| -> Option<Vec<f64>> {
        let inner = lower.strip_prefix(prefix)?.trim().strip_prefix('(')?;
        let inner = inner.strip_suffix(')')?;
        let parts: Vec<f64> = inner
            .split(',')
            .map(|p| p.trim().trim_end_matches('%').parse::<f64>())
            .collect::<Result<_, _>>()
            .ok()?;
        (parts.len() == n
            && parts
                .iter()
                .all(|v| v.is_finite() && *v >= 0.0 && *v <= max))
        .then_some(parts)
    };
    if let Some(v) = channels("rgb", 3, 255.0) {
        return Some(ColorLiteral::Rgb([v[0], v[1], v[2]]));
    }
    if let Some(v) = channels("cmyk", 4, 100.0) {
        return Some(ColorLiteral::Cmyk([v[0], v[1], v[2], v[3]]));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_parse_with_units() {
        assert_eq!(parse_length("72"), Some(72.0));
        assert_eq!(parse_length("1in"), Some(72.0));
        assert!((parse_length("25.4 mm").unwrap() - 72.0).abs() < 1e-9);
        assert!((parse_length("2,54cm").unwrap() - 72.0).abs() < 1e-9);
        assert_eq!(parse_length("1furlong"), None);
        assert_eq!(parse_length(""), None);
    }

    #[test]
    fn colours_parse_and_name_like_indesign() {
        assert_eq!(
            parse_color("#f00"),
            Some(ColorLiteral::Rgb([255.0, 0.0, 0.0]))
        );
        let c = parse_color("cmyk(0, 100, 100, 0)").unwrap();
        assert_eq!(c.canonical(), "cmyk(0,100,100,0)");
        assert_eq!(c.intent().name, "C=0 M=100 Y=100 K=0");
        assert_eq!(parse_color("rgb(300,0,0)"), None);
        assert_eq!(
            parse_color("swatch:Red"),
            Some(ColorLiteral::Swatch("Red".into()))
        );
        assert_eq!(parse_color("Red"), None);
    }

    #[test]
    fn schema_rows_from_the_sdk_deserialize() {
        let row: TargetSchema = serde_json::from_str(
            r#"{"type":{"kind":"enum","members":["a","b"]},"nullable":true,"default":"a"}"#,
        )
        .unwrap();
        assert_eq!(
            row.value_type,
            TargetType::Enum {
                members: vec!["a".into(), "b".into()]
            }
        );
        assert_eq!(row.default, Some(PropValue::Text("a".into())));
        let other: TargetSchema =
            serde_json::from_str(r#"{"type":{"kind":"struct","fields":{}}}"#).unwrap();
        assert_eq!(other.value_type, TargetType::Unsupported);
    }
}
