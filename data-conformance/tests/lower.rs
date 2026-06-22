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

//! Lowering conformance (spec §9.1/§9.3): variable replacement + single-region
//! dynamic table (degraded to tab-text + rules, BREAKAGE D-02).

use data_core::{FrameRef, PlaceholderRef};
use data_lower::{lower_table, lower_variable, LowerOpts};

#[test]
fn data_lower_variable() {
    let v = lower_variable(PlaceholderRef::from("ph1"), "Widget Co.", false);
    assert_eq!(v.text, "Widget Co.");
    assert!(!v.hidden);
    // HideParagraph missing policy.
    let hidden = lower_variable(PlaceholderRef::from("ph2"), "", true);
    assert!(hidden.hidden);
}

#[test]
fn data_lower_table() {
    let headers = vec!["SKU".to_string(), "Price".to_string()];
    let rows = vec![
        vec!["A-1".to_string(), "$9.99".to_string()],
        vec!["B-22".to_string(), "$19.99".to_string()],
    ];
    let t = lower_table(FrameRef::from("r1"), &headers, &rows, &LowerOpts::default());
    // Header + 2 data rows.
    assert_eq!(t.rows.len(), 3);
    assert!(t.rows[0].header);
    // The degraded text path is tab/newline joined (D-02).
    assert_eq!(t.text, "SKU\tPrice\nA-1\t$9.99\nB-22\t$19.99");
    // Two columns + their rules exist.
    assert_eq!(t.columns.len(), 2);
    assert!(!t.rules.is_empty());
}
