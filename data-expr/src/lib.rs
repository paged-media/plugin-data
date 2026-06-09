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

//! # data-expr — the binding-expression DSL (spec §9.1, D-9)
//!
//! Our own minimal, publishing-focused expression language — NOT an
//! Excel-grammar formula dialect. It shares the [`data_core::Value`] /
//! format vocabulary with plugin-sheet, never its code (spec D-9). The crate
//! is three things:
//!
//! - a [`lexer`] + Pratt [`parser`] turning source text into the
//!   [`data_core::Expr`] AST;
//! - an [`eval`]uator over a [`ctx::EvalCtx`] (the current record + params +
//!   the injected eval clock);
//! - the pure function kernels in [`families`], dispatched through the
//!   **registry-generated** [`dispatch`] (FnId parity with `data-core`).
//!
//! Kernels are pure `fn(&[Value], &EvalCtx) -> Value` (spec §4 rule 1) — they
//! never see the resolution graph or the SDK. The crate depends ONLY on
//! `data-core` (CI-enforced: a leak into data-bind/sources/query/lower/js
//! fails the build).

pub mod ctx;
pub mod eval;
pub mod families;
pub mod lexer;
pub mod parser;

pub use ctx::{EvalCtx, RecordCtx, SimpleCtx};
pub use eval::eval;
pub use parser::{parse, ParseError};

mod generated {
    include!(concat!(env!("OUT_DIR"), "/dispatch.rs"));
}
pub use generated::dispatch;

/// Parse + evaluate an expression source string against a context in one call
/// (the common path). A parse error surfaces as a `#PARSE`/`#NAME` value so
/// resolution never panics on a bad binding (the value is diagnostic data).
pub fn eval_str(src: &str, ctx: &EvalCtx) -> data_core::Value {
    match parse(src) {
        Ok(expr) => eval(&expr, ctx),
        Err(ParseError::UnknownFunction(_)) => data_core::Value::Error(data_core::ValueError::Name),
        Err(_) => data_core::Value::Error(data_core::ValueError::Parse),
    }
}

#[cfg(test)]
mod smoke {
    use super::*;
    use data_core::Value;

    fn ctx() -> SimpleCtx {
        SimpleCtx::new()
            .with_field("name", Value::text("Widget"))
            .with_field("price", Value::Number(1234.5))
            .with_param("rate", Value::Number(0.2))
    }

    fn ev(src: &str) -> Value {
        let c = ctx();
        let ec = EvalCtx::new(&c, 20613); // 2026-06-08
        eval_str(src, &ec)
    }

    #[test]
    fn data_expr_smoke_pipeline() {
        // field + operators + function calls through registry dispatch.
        assert_eq!(ev("UPPER(name)"), Value::text("WIDGET"));
        assert_eq!(ev("price * 2"), Value::Number(2469.0));
        assert_eq!(ev("CURRENCY(price)"), Value::text("$1,234.50"));
        assert_eq!(
            ev("IF(price > 1000, \"big\", \"small\")"),
            Value::text("big")
        );
        assert_eq!(
            ev("CONCAT(name, \" @ \", CURRENCY(price))"),
            Value::text("Widget @ $1,234.50")
        );
        assert_eq!(ev("@rate"), Value::Number(0.2));
        assert_eq!(ev("YEAR(TODAY())"), Value::Number(2026.0));
    }

    #[test]
    fn data_expr_smoke_errors_are_values() {
        assert_eq!(ev("1 / 0"), Value::Error(data_core::ValueError::DivByZero));
        // Unknown function → #NAME (uncallable by construction).
        assert_eq!(ev("NOPE(1)"), Value::Error(data_core::ValueError::Name));
        // Missing field → Null (the resolver applies the MissingPolicy later).
        assert_eq!(ev("missing_field"), Value::Null);
    }
}
