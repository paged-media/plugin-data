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

use data_bind::diff;
use data_conformance::{n, record_set, t};
use data_core::{FieldType, Value};
use data_expr::{eval_str, EvalCtx, SimpleCtx};
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
}
