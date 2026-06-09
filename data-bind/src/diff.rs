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

//! Record-identity stable diffing (spec §8). A refresh diffs the old vs new
//! result by a **declared key** so it updates/inserts/removes rows minimally
//! rather than regenerating the whole region — keeping pagination stable and
//! undo granular. With an empty key the whole row is its own identity (only
//! insert/remove are possible — no in-place update).

use std::collections::HashMap;

use data_core::{RecordSet, Value};

/// The minimal row deltas between two results (spec §8).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RowDelta {
    /// Indices into `new` whose key did not exist in `old`.
    pub inserted: Vec<usize>,
    /// Keys present in `old` but not in `new`.
    pub removed: Vec<String>,
    /// Indices into `new` whose key existed but whose row content changed.
    pub updated: Vec<usize>,
    /// Count of rows whose key existed and content was identical.
    pub unchanged: usize,
}

/// Diff two results by a declared key (the key field names). An empty key uses
/// every column as the identity.
pub fn diff(old: &RecordSet, new: &RecordSet, key_fields: &[String]) -> RowDelta {
    let old_keys = key_cols(old, key_fields);
    let new_keys = key_cols(new, key_fields);

    // old: key → (content, present-in-new?)
    let mut old_map: HashMap<String, String> = HashMap::with_capacity(old.row_count);
    for row in 0..old.row_count {
        old_map.insert(row_key(old, row, &old_keys), row_content(old, row));
    }

    let mut delta = RowDelta::default();
    let mut seen: HashMap<String, ()> = HashMap::with_capacity(new.row_count);
    for row in 0..new.row_count {
        let key = row_key(new, row, &new_keys);
        seen.insert(key.clone(), ());
        match old_map.get(&key) {
            None => delta.inserted.push(row),
            Some(old_content) => {
                if *old_content == row_content(new, row) {
                    delta.unchanged += 1;
                } else {
                    delta.updated.push(row);
                }
            }
        }
    }
    for key in old_map.keys() {
        if !seen.contains_key(key) {
            delta.removed.push(key.clone());
        }
    }
    delta.removed.sort();
    delta
}

/// Resolve key field names to column indices (or every column for an empty
/// key).
fn key_cols(records: &RecordSet, key_fields: &[String]) -> Vec<usize> {
    if key_fields.is_empty() {
        (0..records.columns.len()).collect()
    } else {
        key_fields
            .iter()
            .filter_map(|n| records.schema.index_of(n))
            .collect()
    }
}

/// A stable string identity for the key columns of a row.
fn row_key(records: &RecordSet, row: usize, key_cols: &[usize]) -> String {
    let mut s = String::new();
    for &c in key_cols {
        s.push_str(&cell_repr(records.value(row, c)));
        s.push('\u{1f}'); // unit separator
    }
    s
}

/// A stable string identity for the full content of a row.
fn row_content(records: &RecordSet, row: usize) -> String {
    let mut s = String::new();
    for c in 0..records.columns.len() {
        s.push_str(&cell_repr(records.value(row, c)));
        s.push('\u{1f}');
    }
    s
}

/// A type-tagged display of a cell (so `1` ≠ `"1"`).
fn cell_repr(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "0:".to_string(),
        Some(Value::Bool(b)) => format!("1:{b}"),
        Some(Value::Number(n)) => format!("2:{}", n.to_bits()),
        Some(Value::Text(t)) => format!("3:{t}"),
        Some(Value::Date(d)) => format!("4:{d}"),
        Some(Value::DateTime(ms)) => format!("5:{ms}"),
        Some(Value::Bytes(b)) => format!("6:{}", b.len()),
        Some(Value::Error(e)) => format!("7:{}", e.code()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use data_core::{FieldType, Schema};

    fn rs(rows: &[(&str, f64)]) -> RecordSet {
        let schema = Schema::from_fields([
            ("id".to_string(), FieldType::Text),
            ("qty".to_string(), FieldType::Float),
        ]);
        let ids = rows.iter().map(|(id, _)| Value::text(*id)).collect();
        let qtys = rows.iter().map(|(_, q)| Value::Number(*q)).collect();
        RecordSet::new(schema, vec![ids, qtys]).unwrap()
    }

    #[test]
    fn data_bind_diff_minimal_deltas() {
        let old = rs(&[("a", 1.0), ("b", 2.0), ("c", 3.0)]);
        // b updated (2→9), c removed, d inserted, a unchanged.
        let new = rs(&[("a", 1.0), ("b", 9.0), ("d", 4.0)]);
        let key = vec!["id".to_string()];
        let delta = diff(&old, &new, &key);
        assert_eq!(delta.unchanged, 1); // a
        assert_eq!(delta.updated, vec![1]); // b at new index 1
        assert_eq!(delta.inserted, vec![2]); // d at new index 2
        assert_eq!(delta.removed, vec!["3:c\u{1f}".to_string()]);
    }

    #[test]
    fn data_bind_diff_identical_is_all_unchanged() {
        let r = rs(&[("a", 1.0), ("b", 2.0)]);
        let delta = diff(&r, &r, &["id".to_string()]);
        assert_eq!(delta.unchanged, 2);
        assert!(delta.inserted.is_empty() && delta.updated.is_empty() && delta.removed.is_empty());
    }
}
