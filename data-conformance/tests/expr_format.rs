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

//! Format-family conformance (spec §9.1). Each function gets a
//! `fn data_expr_format_<name>…` test (the prefix the registry rows point at,
//! which the coverage gate greps for).

use data_conformance::{eval0, t};

#[test]
fn data_expr_format_number() {
    assert_eq!(eval0("NUMBER(1234.56, 2)"), t("1,234.56"));
    assert_eq!(eval0("NUMBER(1000000)"), t("1,000,000"));
    assert_eq!(eval0("NUMBER(-5)"), t("-5"));
}

#[test]
fn data_expr_format_currency() {
    assert_eq!(eval0("CURRENCY(1234.56)"), t("$1,234.56"));
    assert_eq!(eval0("CURRENCY(9.5, 2, \"€\")"), t("€9.50"));
}

#[test]
fn data_expr_format_percent() {
    assert_eq!(eval0("PERCENT(0.125, 1)"), t("12.5%"));
    assert_eq!(eval0("PERCENT(1)"), t("100%"));
}

#[test]
fn data_expr_format_datefmt() {
    assert_eq!(eval0("DATEFMT(\"2026-06-08\")"), t("2026-06-08"));
    assert_eq!(
        eval0("DATEFMT(\"2026-06-08\", \"DD/MM/YYYY\")"),
        t("08/06/2026")
    );
}
