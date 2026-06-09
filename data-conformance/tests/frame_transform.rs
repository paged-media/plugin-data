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

//! Frame-operation conformance (spec §9.6): the lowered IR is **content-space**
//! (offsets from the region's own top-left), so core applies frame transforms
//! (scale/rotate/skew/crop/reposition) for free. The IR must never encode
//! display geometry — asserted here on the table lowering output.

use data_core::FrameRef;
use data_lower::{lower_table, LowerOpts};

#[test]
fn data_frame_transform_content_space() {
    let headers = vec!["A".to_string(), "B".to_string()];
    let rows = vec![vec!["1".to_string(), "2".to_string()]];
    let t = lower_table(FrameRef::from("r1"), &headers, &rows, &LowerOpts::default());

    // First column starts at content-space x = 0; first row at y = 0.
    assert_eq!(t.columns[0].x_pt, 0.0);
    assert_eq!(t.rows[0].y_pt, 0.0);

    // Every rule coordinate is a non-negative content-space offset, and the
    // top-left rule originates at (0,0) — never a page/display coordinate.
    assert!(t
        .rules
        .iter()
        .all(|r| r.x1_pt >= 0.0 && r.y1_pt >= 0.0 && r.x2_pt >= 0.0 && r.y2_pt >= 0.0));
    assert!(t.rules.iter().any(|r| r.x1_pt == 0.0 && r.y1_pt == 0.0));

    // The bounds are the content box size, not a placed position.
    assert!(t.bounds.width_pt > 0.0 && t.bounds.height_pt > 0.0);
}
