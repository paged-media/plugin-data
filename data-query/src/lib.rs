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

//! # data-query — result shaping, ordering, and content hashing (spec §6.1)
//!
//! The query/ingest engine itself is **DuckDB-WASM** (MIT, vendored), running
//! in the bundle realm; it returns **Arrow**, which the TS query layer converts
//! to a [`data_core::RecordSet`] (the Arrow-aligned interchange — the swappable
//! seam). This crate is the Rust half of that seam: it
//!
//! - [`shape`]s a raw `RecordSet` per a query's [`ResultShape`]
//!   (record-stream / single / scalar / grouped);
//! - injects a **deterministic ordering** ([`stabilize`]) so record identity is
//!   stable across refreshes — the precondition for minimal sync diffs (§8);
//! - computes content hashes ([`content_hash`], [`stamp`]) for the
//!   [`ResolveStamp`] invalidation key.
//!
//! > **M1 seam:** decoding raw Arrow-IPC *bytes* in Rust (so the wasm boundary
//! > can take IPC instead of a JSON `RecordSet`) lands with the engine wiring.
//! > The conversion currently happens in the TS DuckDB layer; this crate's
//! > contract is the `RecordSet` it produces.

use data_core::{Query, RecordSet, ResolveStamp, ResultShape, Value};

/// A result reshaped per a query's [`ResultShape`] (spec §6).
#[derive(Debug, Clone, PartialEq)]
pub enum Shaped {
    /// Many records (tables, record flow).
    RecordStream(RecordSet),
    /// Exactly one record's values (by column), or `None` if the result is
    /// empty.
    SingleRecord(Option<Vec<Value>>),
    /// A single scalar (top-left value), or `Null` if the result is empty.
    Scalar(Value),
    /// Grouped sections: each group is the key tuple + its row indices, in
    /// stable first-seen order (§9.4 sectioning).
    Grouped(Vec<Group>),
}

/// One group of a [`Shaped::Grouped`] result.
#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    /// The values of the `group by` fields for this group.
    pub key: Vec<Value>,
    /// Row indices (into the ordered record set) belonging to this group.
    pub rows: Vec<usize>,
}

/// Reshape a record set per the query's declared shape.
pub fn shape(records: &RecordSet, shape: &ResultShape) -> Shaped {
    match shape {
        ResultShape::RecordStream => Shaped::RecordStream(records.clone()),
        ResultShape::SingleRecord => {
            if records.row_count == 0 {
                Shaped::SingleRecord(None)
            } else {
                let row = (0..records.columns.len())
                    .map(|c| records.value(0, c).cloned().unwrap_or(Value::Null))
                    .collect();
                Shaped::SingleRecord(Some(row))
            }
        }
        ResultShape::Scalar => {
            let v = records.value(0, 0).cloned().unwrap_or(Value::Null);
            Shaped::Scalar(v)
        }
        ResultShape::Grouped { by } => Shaped::Grouped(group_by(records, by)),
    }
}

/// Partition rows into groups keyed by the `by` fields, in stable first-seen
/// order. Missing group fields contribute `Null` to the key.
fn group_by(records: &RecordSet, by: &[String]) -> Vec<Group> {
    let cols: Vec<Option<usize>> = by.iter().map(|n| records.schema.index_of(n)).collect();
    let mut order: Vec<Vec<Value>> = Vec::new();
    let mut groups: Vec<Group> = Vec::new();
    for row in 0..records.row_count {
        let key: Vec<Value> = cols
            .iter()
            .map(|c| match c {
                Some(c) => records.value(row, *c).cloned().unwrap_or(Value::Null),
                None => Value::Null,
            })
            .collect();
        match order.iter().position(|k| k == &key) {
            Some(i) => groups[i].rows.push(row),
            None => {
                order.push(key.clone());
                groups.push(Group {
                    key,
                    rows: vec![row],
                });
            }
        }
    }
    groups
}

// ── Deterministic ordering (spec §6.1) ──────────────────────────────────────

/// Return a stable row permutation ordering the record set by the named keys
/// (or, when `keys` is empty, by every column left-to-right). DuckDB result
/// iteration is unordered without `ORDER BY`; this stabilizes it so record
/// identity is stable across refreshes (the sync-diff precondition, §8).
pub fn order_rows(records: &RecordSet, keys: &[String]) -> Vec<usize> {
    let key_cols: Vec<usize> = if keys.is_empty() {
        (0..records.columns.len()).collect()
    } else {
        keys.iter()
            .filter_map(|n| records.schema.index_of(n))
            .collect()
    };
    let mut idx: Vec<usize> = (0..records.row_count).collect();
    let ncols = records.columns.len();
    idx.sort_by(|&a, &b| {
        // Key columns first.
        for &c in &key_cols {
            let va = records.value(a, c).map(value_key).unwrap_or_default();
            let vb = records.value(b, c).map(value_key).unwrap_or_default();
            match va.cmp(&vb) {
                std::cmp::Ordering::Equal => continue,
                other => return other,
            }
        }
        // Tiebreak on FULL row content (not the original index) so the order is
        // permutation-invariant: rows with identical content are equal, others
        // order by their content — stable identity across refreshes (§8).
        for c in 0..ncols {
            let va = records.value(a, c).map(value_key).unwrap_or_default();
            let vb = records.value(b, c).map(value_key).unwrap_or_default();
            match va.cmp(&vb) {
                std::cmp::Ordering::Equal => continue,
                other => return other,
            }
        }
        std::cmp::Ordering::Equal
    });
    idx
}

/// Apply a row permutation, returning a new record set with rows reordered.
pub fn apply_order(records: &RecordSet, order: &[usize]) -> RecordSet {
    let columns: Vec<Vec<Value>> = records
        .columns
        .iter()
        .map(|col| order.iter().map(|&r| col[r].clone()).collect())
        .collect();
    RecordSet {
        schema: records.schema.clone(),
        columns,
        row_count: order.len(),
    }
}

/// Stabilize a record set by the named keys (`order_rows` + `apply_order`).
pub fn stabilize(records: &RecordSet, keys: &[String]) -> RecordSet {
    let order = order_rows(records, keys);
    apply_order(records, &order)
}

// ── Content hashing (spec §8 ResolveStamp) ──────────────────────────────────

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn fnv_bytes(h: &mut u64, bytes: &[u8]) {
    for &b in bytes {
        *h ^= b as u64;
        *h = h.wrapping_mul(FNV_PRIME);
    }
}

fn hash_value(h: &mut u64, v: &Value) {
    // Tag byte per variant keeps `1` (number) distinct from `"1"` (text).
    match v {
        Value::Null => fnv_bytes(h, &[0]),
        Value::Bool(b) => fnv_bytes(h, &[1, *b as u8]),
        Value::Number(n) => {
            fnv_bytes(h, &[2]);
            fnv_bytes(h, &n.to_bits().to_le_bytes());
        }
        Value::Text(t) => {
            fnv_bytes(h, &[3]);
            fnv_bytes(h, t.as_bytes());
        }
        Value::Date(d) => {
            fnv_bytes(h, &[4]);
            fnv_bytes(h, &d.to_le_bytes());
        }
        Value::DateTime(ms) => {
            fnv_bytes(h, &[5]);
            fnv_bytes(h, &ms.to_le_bytes());
        }
        Value::Bytes(b) => {
            fnv_bytes(h, &[6]);
            fnv_bytes(h, b);
        }
        Value::Error(e) => {
            fnv_bytes(h, &[7]);
            fnv_bytes(h, e.code().as_bytes());
        }
    }
}

/// A stable content hash of a record set (schema + every value). Bit-stable —
/// the basis for [`ResolveStamp`] invalidation (§8).
pub fn content_hash(records: &RecordSet) -> u64 {
    let mut h = FNV_OFFSET;
    for f in &records.schema.fields {
        fnv_bytes(&mut h, f.name.as_bytes());
        fnv_bytes(&mut h, &[0xff]);
    }
    fnv_bytes(&mut h, &records.row_count.to_le_bytes());
    for col in &records.columns {
        for v in col {
            hash_value(&mut h, v);
        }
    }
    h
}

/// Hash a query's SQL + shape (the query half of the resolve stamp).
pub fn query_hash(query: &Query) -> u64 {
    let mut h = FNV_OFFSET;
    fnv_bytes(&mut h, query.sql.as_bytes());
    fnv_bytes(&mut h, format!("{:?}", query.shape).as_bytes());
    h
}

/// Hash a bound parameter set (`(name, value)` pairs, order-independent).
pub fn param_hash(params: &[(String, Value)]) -> u64 {
    // XOR per-pair so the combined hash is order-independent.
    let mut combined = 0u64;
    for (name, value) in params {
        let mut h = FNV_OFFSET;
        fnv_bytes(&mut h, name.as_bytes());
        hash_value(&mut h, value);
        combined ^= h;
    }
    combined
}

/// Build a [`ResolveStamp`] from a source-content hash + the query + the bound
/// params (§8). Equal stamps ⇒ no re-resolution needed.
pub fn stamp(source_content_hash: u64, query: &Query, params: &[(String, Value)]) -> ResolveStamp {
    let mut sq = FNV_OFFSET;
    fnv_bytes(&mut sq, &source_content_hash.to_le_bytes());
    fnv_bytes(&mut sq, &query_hash(query).to_le_bytes());
    ResolveStamp {
        source_query_hash: sq,
        param_hash: param_hash(params),
    }
}

/// A total, type-aware sort key for a value (used by `order_rows`/`group_by`).
/// Orders by type tag, then by content; numbers by bits-preserving order.
fn value_key(v: &Value) -> (u8, Vec<u8>) {
    match v {
        Value::Null => (0, Vec::new()),
        Value::Bool(b) => (1, vec![*b as u8]),
        Value::Number(n) => (2, order_f64(*n).to_be_bytes().to_vec()),
        Value::Date(d) => (3, (*d as i64).to_be_bytes().to_vec()),
        Value::DateTime(ms) => (3, ms.to_be_bytes().to_vec()),
        Value::Text(t) => (4, t.as_bytes().to_vec()),
        Value::Bytes(b) => (5, b.clone()),
        Value::Error(e) => (6, e.code().as_bytes().to_vec()),
    }
}

/// Map an `f64` to a `u64` whose unsigned order matches numeric order
/// (IEEE-754 total order trick) so byte comparison sorts numbers correctly.
fn order_f64(n: f64) -> u64 {
    let bits = n.to_bits();
    if bits & (1 << 63) != 0 {
        !bits
    } else {
        bits | (1 << 63)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use data_core::{FieldType, Schema};

    fn rs() -> RecordSet {
        let schema = Schema::from_fields([
            ("cat".to_string(), FieldType::Text),
            ("n".to_string(), FieldType::Float),
        ]);
        RecordSet::new(
            schema,
            vec![
                vec![Value::text("b"), Value::text("a"), Value::text("a")],
                vec![Value::Number(2.0), Value::Number(3.0), Value::Number(1.0)],
            ],
        )
        .unwrap()
    }

    #[test]
    fn data_query_order_is_deterministic() {
        let r = rs();
        // Order by "n": rows become n=1,2,3 → original indices 2,0,1.
        let order = order_rows(&r, &["n".to_string()]);
        assert_eq!(order, vec![2, 0, 1]);
        let ordered = apply_order(&r, &order);
        assert_eq!(ordered.value(0, 1), Some(&Value::Number(1.0)));
        assert_eq!(ordered.value(2, 1), Some(&Value::Number(3.0)));
        // Stable across calls.
        assert_eq!(order_rows(&r, &["n".to_string()]), order);
    }

    #[test]
    fn data_query_shape_scalar_and_single() {
        let r = rs();
        assert_eq!(
            shape(&r, &ResultShape::Scalar),
            Shaped::Scalar(Value::text("b"))
        );
        match shape(&r, &ResultShape::SingleRecord) {
            Shaped::SingleRecord(Some(row)) => {
                assert_eq!(row, vec![Value::text("b"), Value::Number(2.0)]);
            }
            other => panic!("expected single record, got {other:?}"),
        }
    }

    #[test]
    fn data_query_group_by_stable() {
        let r = stabilize(&rs(), &["cat".to_string()]);
        match shape(
            &r,
            &ResultShape::Grouped {
                by: vec!["cat".to_string()],
            },
        ) {
            Shaped::Grouped(groups) => {
                assert_eq!(groups.len(), 2);
                assert_eq!(groups[0].key, vec![Value::text("a")]);
                assert_eq!(groups[0].rows.len(), 2);
            }
            other => panic!("expected grouped, got {other:?}"),
        }
    }

    #[test]
    fn data_query_content_hash_detects_change() {
        let r1 = rs();
        let mut r2 = rs();
        assert_eq!(content_hash(&r1), content_hash(&r2));
        r2.columns[1][0] = Value::Number(99.0);
        assert_ne!(content_hash(&r1), content_hash(&r2));
    }

    #[test]
    fn data_query_param_hash_order_independent() {
        let a = vec![
            ("x".to_string(), Value::Number(1.0)),
            ("y".to_string(), Value::text("q")),
        ];
        let b = vec![
            ("y".to_string(), Value::text("q")),
            ("x".to_string(), Value::Number(1.0)),
        ];
        assert_eq!(param_hash(&a), param_hash(&b));
    }
}
