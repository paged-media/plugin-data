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

//! Expression-engine conformance (spec §9.1, §12.2): the parser, the
//! evaluator, registry-driven dispatch, and bit-stable idempotence.

use data_conformance::{eval0, eval1, n, t};
use data_core::{Value, ValueError};
use data_expr::{parse, ParseError, SimpleCtx};

#[test]
fn data_expr_parse_precedence_and_grouping() {
    assert_eq!(eval0("1 + 2 * 3"), n(7.0));
    assert_eq!(eval0("(1 + 2) * 3"), n(9.0));
    assert_eq!(eval0("-2 + 3"), n(1.0));
    assert_eq!(eval0("\"a\" & \"b\" & \"c\""), t("abc"));
    // A malformed expression is a parse error (surfaced as a value).
    assert!(matches!(parse("1 +"), Err(ParseError::UnexpectedEnd)));
}

#[test]
fn data_expr_eval_fields_params_errors() {
    let ctx = SimpleCtx::new()
        .with_field("price", Value::Number(10.0))
        .with_param("rate", Value::Number(2.0));
    assert_eq!(eval1("price * @rate", &ctx), n(20.0));
    // A missing field resolves to Null (the resolver applies the missing policy).
    assert_eq!(eval1("missing", &ctx), Value::Null);
    // Errors propagate as values.
    assert_eq!(eval0("1 / 0"), Value::Error(ValueError::DivByZero));
}

#[test]
fn data_expr_dispatch_registry_gated() {
    // Registered names resolve to an FnId; unregistered names do not exist.
    assert!(data_core::funcs::lookup_func("SUM").is_some());
    assert!(data_core::funcs::lookup_func("CURRENCY").is_some());
    assert!(data_core::funcs::lookup_func("NOTAFUNCTION").is_none());
    assert!(data_core::funcs::func_count() >= 30);
    // An unregistered function is a parse error → #NAME (uncallable by
    // construction).
    assert!(matches!(
        parse("NOTAFUNCTION(1)"),
        Err(ParseError::UnknownFunction(_))
    ));
    assert_eq!(eval0("NOTAFUNCTION(1)"), Value::Error(ValueError::Name));
}

#[test]
fn data_expr_idempotent_bit_stable() {
    let ctx = SimpleCtx::new().with_field("price", Value::Number(1234.5));
    let a = eval1("CURRENCY(price) & \" (\" & PERCENT(0.2) & \")\"", &ctx);
    let b = eval1("CURRENCY(price) & \" (\" & PERCENT(0.2) & \")\"", &ctx);
    assert_eq!(a, b);
    assert_eq!(a, t("$1,234.50 (20%)"));
}
