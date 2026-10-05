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

//! Per-field display patterns (spec §9.1) as expression text, and the field
//! references an expression reads.
//!
//! A field's format is not a second formatting system: it is the binding's own
//! expression wrapped in one of the format functions (`NUMBER`, `CURRENCY`,
//! `PERCENT`, `DATEFMT`). [`apply_format`] writes that wrapper and
//! [`split_format`] reads it back, so a panel can show and change a field's
//! pattern without ever composing or parsing DSL text itself.

use data_core::Expr;

use crate::parser::parse;

/// A display pattern for one field.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum FormatSpec {
    /// The value as it is (no wrapper).
    #[default]
    Plain,
    /// `NUMBER(x, decimals)`.
    Number { decimals: u8 },
    /// `CURRENCY(x, decimals[, symbol])` — no symbol means the locale's.
    Currency {
        decimals: u8,
        symbol: Option<String>,
    },
    /// `PERCENT(x, decimals)`.
    Percent { decimals: u8 },
    /// `DATEFMT(x[, pattern])` — no pattern means the locale's.
    Date { pattern: Option<String> },
}

/// Wrap `inner` (an expression) in the format function `spec` names. `Plain`
/// returns `inner` unchanged. The result parses whenever `inner` does.
pub fn apply_format(inner: &str, spec: &FormatSpec) -> String {
    let inner = inner.trim();
    match spec {
        FormatSpec::Plain => inner.to_string(),
        FormatSpec::Number { decimals } => format!("NUMBER({inner}, {decimals})"),
        FormatSpec::Currency { decimals, symbol } => match symbol {
            Some(s) => format!("CURRENCY({inner}, {decimals}, {})", quote(s)),
            None => format!("CURRENCY({inner}, {decimals})"),
        },
        FormatSpec::Percent { decimals } => format!("PERCENT({inner}, {decimals})"),
        FormatSpec::Date { pattern } => match pattern {
            Some(p) => format!("DATEFMT({inner}, {})", quote(p)),
            None => format!("DATEFMT({inner})"),
        },
    }
}

/// Read a field's pattern back: when the whole expression is one format
/// function call whose options are literals, return the inner expression's
/// source and the spec; otherwise the expression itself and `Plain`. The inverse
/// of [`apply_format`] for everything it writes.
pub fn split_format(src: &str) -> (String, FormatSpec) {
    let plain = || (src.trim().to_string(), FormatSpec::Plain);
    let Ok(Expr::Call { func, args }) = parse(src) else {
        return plain();
    };
    let name = data_core::funcs::meta(func).name;
    if !matches!(name, "NUMBER" | "CURRENCY" | "PERCENT" | "DATEFMT") {
        return plain();
    }
    let Some(inner) = first_arg_source(src) else {
        return plain();
    };
    let num = |i: usize, default: u8| -> Option<u8> {
        match args.get(i) {
            None => Some(default),
            Some(Expr::Number(n)) if *n >= 0.0 && n.fract() == 0.0 && *n <= 255.0 => Some(*n as u8),
            _ => None,
        }
    };
    let text = |i: usize| -> Option<Option<String>> {
        match args.get(i) {
            None => Some(None),
            Some(Expr::Text(t)) => Some(Some(t.to_string())),
            _ => None,
        }
    };
    let spec = match name {
        "NUMBER" => num(1, 0).map(|decimals| FormatSpec::Number { decimals }),
        "PERCENT" => num(1, 0).map(|decimals| FormatSpec::Percent { decimals }),
        "CURRENCY" => num(1, 2)
            .zip(text(2))
            .map(|(decimals, symbol)| FormatSpec::Currency { decimals, symbol }),
        _ => text(1).map(|pattern| FormatSpec::Date { pattern }),
    };
    match spec {
        Some(spec) => (inner, spec),
        None => plain(),
    }
}

/// Every field an expression reads, sorted and de-duplicated. A source that
/// does not parse reads nothing.
pub fn field_refs(src: &str) -> Vec<String> {
    fn walk(e: &Expr, out: &mut Vec<String>) {
        match e {
            Expr::Field(f) => out.push(f.to_string()),
            Expr::Unary { rhs, .. } => walk(rhs, out),
            Expr::Binary { lhs, rhs, .. } => {
                walk(lhs, out);
                walk(rhs, out);
            }
            Expr::Call { args, .. } => args.iter().for_each(|a| walk(a, out)),
            Expr::Null | Expr::Bool(_) | Expr::Number(_) | Expr::Text(_) | Expr::Param(_) => {}
        }
    }
    let mut out = Vec::new();
    if let Ok(e) = parse(src) {
        walk(&e, &mut out);
    }
    out.sort();
    out.dedup();
    out
}

/// A DSL text literal for `s` (a doubled quote escapes a quote).
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// The source text of a call's first argument: from after the opening `(` to
/// the first top-level `,` or the closing `)`, honouring parentheses and quoted
/// text. `None` when the shape is not `NAME(…)`.
fn first_arg_source(src: &str) -> Option<String> {
    let open = src.find('(')?;
    let mut depth = 0usize;
    let mut quote: Option<char> = None;
    let body = &src[open + 1..];
    let mut chars = body.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if let Some(q) = quote {
            if c == q {
                if chars.peek().map(|&(_, n)| n) == Some(q) {
                    chars.next();
                } else {
                    quote = None;
                }
            }
            continue;
        }
        match c {
            '"' | '\'' => quote = Some(c),
            '(' => depth += 1,
            ')' if depth == 0 => return Some(body[..i].trim().to_string()),
            ')' => depth -= 1,
            ',' if depth == 0 => return Some(body[..i].trim().to_string()),
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_spec_round_trips_through_its_expression() {
        let specs = [
            FormatSpec::Plain,
            FormatSpec::Number { decimals: 2 },
            FormatSpec::Currency {
                decimals: 2,
                symbol: None,
            },
            FormatSpec::Currency {
                decimals: 0,
                symbol: Some("CHF".into()),
            },
            FormatSpec::Percent { decimals: 1 },
            FormatSpec::Date { pattern: None },
            FormatSpec::Date {
                pattern: Some("DD \"MM\" YYYY".into()),
            },
        ];
        for inner in ["price", "price * (1 + @vat)", "IF(a > 1, b, c)"] {
            for spec in &specs {
                let src = apply_format(inner, spec);
                assert!(parse(&src).is_ok(), "{src} does not parse");
                assert_eq!(
                    split_format(&src),
                    (inner.to_string(), spec.clone()),
                    "{src}"
                );
            }
        }
    }

    #[test]
    fn a_non_literal_option_is_not_a_pattern() {
        assert_eq!(
            split_format("NUMBER(price, @d)"),
            ("NUMBER(price, @d)".to_string(), FormatSpec::Plain)
        );
        assert_eq!(split_format("UPPER(name)").1, FormatSpec::Plain);
        assert_eq!(split_format("not valid (").1, FormatSpec::Plain);
    }

    #[test]
    fn field_refs_reads_every_field_once() {
        assert_eq!(
            field_refs("IF(stock < 5, CONCAT(name, @x), name)"),
            vec!["name".to_string(), "stock".to_string()]
        );
        assert!(field_refs("1 +").is_empty());
    }
}
