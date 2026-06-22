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

//! Math-family conformance (spec §9.1). `f64`, bit-stable.

use data_conformance::{eval0, n};

#[test]
fn data_expr_math_abs() {
    assert_eq!(eval0("ABS(-3)"), n(3.0));
    assert_eq!(eval0("ABS(3)"), n(3.0));
}

#[test]
fn data_expr_math_round() {
    assert_eq!(eval0("ROUND(3.567, 2)"), n(3.57));
    assert_eq!(eval0("ROUND(2.5)"), n(3.0));
}

#[test]
fn data_expr_math_floor() {
    assert_eq!(eval0("FLOOR(2.9)"), n(2.0));
}

#[test]
fn data_expr_math_ceiling() {
    assert_eq!(eval0("CEILING(2.1)"), n(3.0));
}

#[test]
fn data_expr_math_min() {
    assert_eq!(eval0("MIN(3, 1, 2)"), n(1.0));
}

#[test]
fn data_expr_math_max() {
    assert_eq!(eval0("MAX(3, 1, 2)"), n(3.0));
}

#[test]
fn data_expr_math_sum() {
    assert_eq!(eval0("SUM(1, 2, 3)"), n(6.0));
    // Nulls are skipped.
    assert_eq!(eval0("SUM(1, NULL, 2)"), n(3.0));
}

#[test]
fn data_expr_math_mod() {
    assert_eq!(eval0("MOD(7, 3)"), n(1.0));
    // Sign follows the divisor (Excel): MOD(-1, 3) = 2.
    assert_eq!(eval0("MOD(-1, 3)"), n(2.0));
}

#[test]
fn data_expr_math_power() {
    assert_eq!(eval0("POWER(2, 10)"), n(1024.0));
    assert_eq!(eval0("POWER(9, 0.5)"), n(3.0));
}

#[test]
fn data_expr_math_trunc() {
    assert_eq!(eval0("TRUNC(2.789, 1)"), n(2.7));
    // Toward zero (not floor): TRUNC(-2.9) = -2.
    assert_eq!(eval0("TRUNC(-2.9)"), n(-2.0));
}

#[test]
fn data_expr_math_sign() {
    assert_eq!(eval0("SIGN(-5)"), n(-1.0));
    assert_eq!(eval0("SIGN(0)"), n(0.0));
}
