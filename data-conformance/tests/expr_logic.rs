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

//! Logic-family conformance (spec §9.1).

use data_conformance::{eval0, t};
use data_core::Value;

#[test]
fn data_expr_logic_if() {
    assert_eq!(eval0("IF(TRUE, \"a\", \"b\")"), t("a"));
    assert_eq!(eval0("IF(1 > 2, \"a\", \"b\")"), t("b"));
}

#[test]
fn data_expr_logic_and() {
    assert_eq!(eval0("AND(TRUE, 1 > 0)"), Value::Bool(true));
    assert_eq!(eval0("AND(TRUE, FALSE)"), Value::Bool(false));
}

#[test]
fn data_expr_logic_or() {
    assert_eq!(eval0("OR(FALSE, FALSE)"), Value::Bool(false));
    assert_eq!(eval0("OR(FALSE, TRUE)"), Value::Bool(true));
}

#[test]
fn data_expr_logic_not() {
    assert_eq!(eval0("NOT(FALSE)"), Value::Bool(true));
    assert_eq!(eval0("NOT(TRUE)"), Value::Bool(false));
}

#[test]
fn data_expr_logic_isblank() {
    assert_eq!(eval0("ISBLANK(NULL)"), Value::Bool(true));
    assert_eq!(eval0("ISBLANK(\"\")"), Value::Bool(true));
    assert_eq!(eval0("ISBLANK(\"x\")"), Value::Bool(false));
}

#[test]
fn data_expr_logic_iserror() {
    assert_eq!(eval0("ISERROR(1 / 0)"), Value::Bool(true));
    assert_eq!(eval0("ISERROR(1)"), Value::Bool(false));
}

#[test]
fn data_expr_logic_coalesce() {
    assert_eq!(eval0("COALESCE(NULL, NULL, \"x\")"), t("x"));
    assert_eq!(eval0("COALESCE(NULL, NULL)"), Value::Null);
}
