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

//! Property tests (spec §12.4): idempotent re-resolution, resolution-order
//! independence (deterministic ordering is permutation-invariant), and the
//! self-diff identity.

use data_barcode::{encode, BarcodeError, Symbology};
use data_bind::diff;
use data_conformance::{n, record_set, t};
use data_core::{FieldType, Value};
use data_expr::{eval_str, EvalCtx, SimpleCtx};
use data_lower::{paginate_flow, FlowBlock, FlowGroup, FlowLayoutOpts, FlowRecord, FrameCapacity};
use data_query::stabilize;
use proptest::prelude::*;

proptest! {
    /// Re-evaluating the same expression against the same context is identical
    /// (CPU/`f64` bit-stable — spec §12.4).
    #[test]
    fn data_prop_idempotent_eval(price in -1e9f64..1e9f64, dec in 0u32..6u32) {
        let ctx = SimpleCtx::new().with_field("price", Value::Number(price));
        let ec = EvalCtx::new(&ctx, 0);
        let src = format!("NUMBER(price, {dec})");
        let a = eval_str(&src, &ec);
        let b = eval_str(&src, &ec);
        prop_assert_eq!(a, b);
    }

    /// Deterministic ordering is **permutation-invariant**: stabilizing a result
    /// gives the same record set regardless of the engine's row delivery order —
    /// the precondition for stable record identity across refreshes (§8).
    #[test]
    fn data_prop_order_independent(mut rows in prop::collection::vec((".{0,4}", any::<i32>()), 0..12)) {
        let make = |rows: &[(String, i32)]| {
            record_set(
                &[("k", FieldType::Text), ("v", FieldType::Float)],
                vec![
                    rows.iter().map(|(s, _)| t(s)).collect(),
                    rows.iter().map(|(_, v)| n(*v as f64)).collect(),
                ],
            )
        };
        let original = stabilize(&make(&rows), &["k".to_string()]);
        // Reverse the delivery order; stabilization must erase the difference.
        rows.reverse();
        let reversed = stabilize(&make(&rows), &["k".to_string()]);
        prop_assert_eq!(original, reversed);
    }

    /// Diffing a result against itself yields zero deltas (all unchanged) — the
    /// minimal-diff identity (§8).
    #[test]
    fn data_prop_self_diff_is_empty(vals in prop::collection::vec(any::<i32>(), 0..16)) {
        let r = record_set(
            &[("id", FieldType::Float)],
            vec![vals.iter().map(|v| n(*v as f64)).collect()],
        );
        let delta = diff(&r, &r, &["id".to_string()]);
        prop_assert!(delta.inserted.is_empty());
        prop_assert!(delta.updated.is_empty());
        prop_assert!(delta.removed.is_empty());
        prop_assert_eq!(delta.unchanged, r.row_count);
    }

    /// Pagination always converges and preserves record order (§9.4): for ANY
    /// record heights + frame chain, the pass terminates, placement accounts
    /// exactly (overflow iff some record didn't fit), and the placed records
    /// appear in input order.
    #[test]
    fn data_prop_recordflow_places_in_order(
        heights in prop::collection::vec(1u32..40, 0..20),
        caps in prop::collection::vec(20u32..60, 0..8),
    ) {
        let records: Vec<FlowRecord> = heights
            .iter()
            .enumerate()
            .map(|(i, h)| FlowRecord { cells: vec![format!("r{i}")], height_pt: *h as f64 })
            .collect();
        let groups = vec![FlowGroup { header: None, level: 0, records: records.clone(), footer: None }];
        let chain: Vec<FrameCapacity> = caps
            .iter()
            .enumerate()
            .map(|(i, c)| FrameCapacity { frame: format!("f{i}"), page: "p".into(), height_pt: *c as f64 })
            .collect();

        let flow = paginate_flow(&groups, &chain, &FlowLayoutOpts::default());

        prop_assert_eq!(flow.total, records.len());
        prop_assert!(flow.placed <= flow.total);
        prop_assert_eq!(flow.overflow, flow.placed < flow.total);

        // The placed records, flattened across frames in order, are exactly the
        // first `placed` inputs — order preserved, none duplicated or lost.
        let placed_cells: Vec<String> = flow
            .frames
            .iter()
            .flat_map(|f| f.blocks.iter().filter_map(|b| match b {
                FlowBlock::Record { cells, .. } => Some(cells[0].clone()),
                _ => None,
            }))
            .collect();
        let expected: Vec<String> = records.iter().take(flow.placed).map(|r| r.cells[0].clone()).collect();
        prop_assert_eq!(placed_cells, expected);
    }

    /// EAN-13 (§9.7): encoding 12 data digits computes the check, and re-encoding
    /// the resulting 13-digit canonical text accepts it (the supplied check
    /// verifies) and yields the SAME bars — the checksum round-trips.
    #[test]
    fn data_prop_barcode_ean13_checksum_round_trips(
        digits in prop::collection::vec(0u8..10, 12),
    ) {
        let s: String = digits.iter().map(|d| (b'0' + d) as char).collect();
        let g12 = encode(Symbology::Ean13, &s).unwrap();
        prop_assert_eq!(g12.text.len(), 13);
        // Re-encode the 13-digit canonical form: the embedded check must verify
        // and produce identical bars (no re-checksum drift).
        let g13 = encode(Symbology::Ean13, &g12.text).unwrap();
        prop_assert_eq!(&g12.rects, &g13.rects);
    }

    /// Code-128 (§9.7): encoding ANY non-empty Latin-1-printable string never
    /// panics, always yields a non-empty 1D symbol, and is deterministic.
    #[test]
    fn data_prop_barcode_code128_total_on_printable(s in "[ -~]{1,32}") {
        let a = encode(Symbology::Code128, &s).unwrap();
        prop_assert_eq!(a.modules_y, 1);
        prop_assert!(a.rect_count() > 0);
        prop_assert_eq!(a.text, s.clone());
        // Determinism.
        let b = encode(Symbology::Code128, &s).unwrap();
        prop_assert_eq!(a.rects, b.rects);
    }

    /// QR (§9.7): byte-mode encoding is total + deterministic for any payload
    /// that fits the v1–v10 ceiling, and a square matrix; an over-capacity
    /// payload is a typed `TooLong`, never a panic.
    #[test]
    fn data_prop_barcode_qr_total_and_deterministic(s in "[ -~]{1,120}") {
        match encode(Symbology::Qr, &s) {
            Ok(a) => {
                prop_assert_eq!(a.modules_x, a.modules_y);
                prop_assert!(a.rect_count() > 0);
                let b = encode(Symbology::Qr, &s).unwrap();
                prop_assert_eq!(a.rects, b.rects);
            }
            Err(BarcodeError::TooLong { .. }) => { /* capacity ceiling — acceptable */ }
            Err(e) => prop_assert!(false, "unexpected QR error: {e}"),
        }
    }
}
