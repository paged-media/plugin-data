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

//! Text-family conformance (spec §9.1).

use data_conformance::{eval0, n, t};

#[test]
fn data_expr_text_concat() {
    assert_eq!(eval0("CONCAT(\"a\", \"b\", \"c\")"), t("abc"));
    assert_eq!(eval0("CONCAT(\"qty=\", 5)"), t("qty=5"));
}

#[test]
fn data_expr_text_upper() {
    assert_eq!(eval0("UPPER(\"aBc\")"), t("ABC"));
}

#[test]
fn data_expr_text_lower() {
    assert_eq!(eval0("LOWER(\"aBc\")"), t("abc"));
}

#[test]
fn data_expr_text_trim() {
    assert_eq!(eval0("TRIM(\"  x  \")"), t("x"));
}

#[test]
fn data_expr_text_len() {
    assert_eq!(eval0("LEN(\"hello\")"), n(5.0));
    // Character count, not byte count.
    assert_eq!(eval0("LEN(\"héllo\")"), n(5.0));
}

#[test]
fn data_expr_text_left() {
    assert_eq!(eval0("LEFT(\"hello\", 2)"), t("he"));
}

#[test]
fn data_expr_text_right() {
    assert_eq!(eval0("RIGHT(\"hello\", 2)"), t("lo"));
}

#[test]
fn data_expr_text_substitute() {
    assert_eq!(eval0("SUBSTITUTE(\"a-b-c\", \"-\", \"+\")"), t("a+b+c"));
    // Empty find is a no-op (no degenerate insert-between-chars).
    assert_eq!(eval0("SUBSTITUTE(\"abc\", \"\", \"x\")"), t("abc"));
}

#[test]
fn data_expr_text_mid() {
    assert_eq!(eval0(r#"MID("hello", 2, 3)"#), t("ell"));
    // A start past the end yields empty.
    assert_eq!(eval0(r#"MID("hi", 9, 3)"#), t(""));
}

#[test]
fn data_expr_text_proper() {
    assert_eq!(eval0(r#"PROPER("hello WORLD")"#), t("Hello World"));
    assert_eq!(eval0(r#"PROPER("o'brien-smith")"#), t("O'Brien-Smith"));
}
