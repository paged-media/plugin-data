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

//! Temporal-family conformance (spec §9.1). `TODAY()` reads the injected
//! deterministic clock.

use data_conformance::{eval0, n, today};
use data_core::Value;

#[test]
fn data_expr_temporal_year() {
    assert_eq!(eval0("YEAR(\"2026-06-08\")"), n(2026.0));
}

#[test]
fn data_expr_temporal_month() {
    assert_eq!(eval0("MONTH(\"2026-06-08\")"), n(6.0));
}

#[test]
fn data_expr_temporal_day() {
    assert_eq!(eval0("DAY(\"2026-06-08\")"), n(8.0));
}

#[test]
fn data_expr_temporal_today() {
    // TODAY() is the injected clock (deterministic), and YEAR(TODAY()) reads it.
    assert_eq!(eval0("TODAY()"), Value::Date(today()));
    assert_eq!(eval0("YEAR(TODAY())"), n(2026.0));
}

#[test]
fn data_expr_temporal_weekday() {
    // 1970-01-01 was a Thursday (Excel default: Sun=1 → Thu=5).
    assert_eq!(eval0(r#"WEEKDAY("1970-01-01")"#), n(5.0));
    // 1970-01-04 was a Sunday → 1.
    assert_eq!(eval0(r#"WEEKDAY("1970-01-04")"#), n(1.0));
}
