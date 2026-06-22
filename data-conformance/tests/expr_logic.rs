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

#[test]
fn data_expr_logic_switch() {
    // Matches the second case → "y".
    assert_eq!(eval0(r#"SWITCH("b", "a", "x", "b", "y", "z")"#), t("y"));
    // No match → the odd trailing default.
    assert_eq!(eval0(r#"SWITCH("q", "a", "x", "z")"#), t("z"));
}

#[test]
fn data_expr_logic_iferror() {
    // A division error → the fallback; a clean value passes through.
    assert_eq!(eval0(r#"IFERROR(MOD(1, 0), "n/a")"#), t("n/a"));
    assert_eq!(eval0(r#"IFERROR("ok", "n/a")"#), t("ok"));
}
