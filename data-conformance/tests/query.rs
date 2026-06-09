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

//! Query-shaping conformance (spec §6.1): result shapes, deterministic
//! ordering, and content hashing for the resolve stamp.

use data_conformance::{n, record_set, t};
use data_core::{FieldType, ResultShape, Value};
use data_query::{apply_order, content_hash, order_rows, shape, Shaped};

fn rs() -> data_core::RecordSet {
    record_set(
        &[("cat", FieldType::Text), ("n", FieldType::Float)],
        vec![vec![t("b"), t("a"), t("a")], vec![n(2.0), n(3.0), n(1.0)]],
    )
}

#[test]
fn data_query_shape_record_stream_single_scalar_grouped() {
    let r = rs();
    assert!(matches!(
        shape(&r, &ResultShape::RecordStream),
        Shaped::RecordStream(_)
    ));
    assert_eq!(shape(&r, &ResultShape::Scalar), Shaped::Scalar(t("b")));
    match shape(&r, &ResultShape::SingleRecord) {
        Shaped::SingleRecord(Some(row)) => assert_eq!(row, vec![t("b"), n(2.0)]),
        other => panic!("expected single, got {other:?}"),
    }
    match shape(
        &r,
        &ResultShape::Grouped {
            by: vec!["cat".into()],
        },
    ) {
        Shaped::Grouped(groups) => assert_eq!(groups.len(), 2),
        other => panic!("expected grouped, got {other:?}"),
    }
}

#[test]
fn data_query_order_deterministic() {
    let r = rs();
    let order = order_rows(&r, &["n".to_string()]);
    assert_eq!(order, vec![2, 0, 1]); // n = 1,2,3
    let ordered = apply_order(&r, &order);
    assert_eq!(ordered.value(0, 1), Some(&n(1.0)));
    // Stable across calls.
    assert_eq!(order_rows(&r, &["n".to_string()]), order);
}

#[test]
fn data_query_content_hash_stamp() {
    let r1 = rs();
    let mut r2 = rs();
    assert_eq!(content_hash(&r1), content_hash(&r2));
    r2.columns[1][0] = Value::Number(99.0);
    assert_ne!(content_hash(&r1), content_hash(&r2));
}
