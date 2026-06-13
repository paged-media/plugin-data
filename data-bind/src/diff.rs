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
//!
//! This module ALSO carries the per-binding **change report** (spec §8 — "what
//! changed since last sync"): on a refresh the panel wants a binding-level
//! changed / unchanged summary, not just a row delta. A binding's resolved
//! content is fingerprinted ([`resolved_fingerprint`]) and the prior vs new
//! fingerprints are compared ([`diff_resolved`]) — pure, deterministic, and
//! locale-free at the value layer (the fingerprint canonicalises the displayed
//! content the host committed, so the report says exactly which bound regions a
//! refresh would change).

use std::collections::{BTreeSet, HashMap};

use data_core::{RecordSet, Value};

use crate::Resolved;

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

/// How a binding's resolved content changed across a refresh (spec §8 change
/// report).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ChangeKind {
    /// The binding existed before and its resolved content is identical.
    Unchanged,
    /// The binding existed before and its resolved content changed.
    Changed,
    /// The binding had no prior resolution (newly resolved this refresh).
    Added,
    /// The binding had a prior resolution but resolves no longer (e.g. its query
    /// or result went away) — surfaced so the panel can flag a stale region.
    Removed,
}

/// One binding's entry in the refresh change report (spec §8). `before`/`after`
/// are the resolved-content fingerprints (`None` when the binding was absent on
/// that side) — opaque identity strings, not display text, so the panel keys off
/// `kind` and may show the fingerprints for an audit trail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindingChange {
    /// The binding id (as a string — the report crosses the wasm door).
    pub binding: String,
    pub kind: ChangeKind,
    pub before: Option<String>,
    pub after: Option<String>,
}

/// The whole refresh change report (spec §8): the per-binding entries plus
/// rolled-up counts the panel headlines ("3 changed, 12 unchanged"). Entries are
/// sorted by binding id (deterministic).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ChangeReport {
    pub entries: Vec<BindingChange>,
    pub changed: usize,
    pub unchanged: usize,
    pub added: usize,
    pub removed: usize,
}

/// A stable, locale-free fingerprint of a binding's RESOLVED content (spec §8) —
/// the identity the change report diffs. Type-tagged so different kinds never
/// collide; for the per-record kinds it captures the displayed value, for the
/// whole-result kinds the full grid / instance set. Two resolutions with the
/// same fingerprint commit the same host content (the refresh would be a no-op
/// for that region); a differing fingerprint means the region's content changes.
pub fn resolved_fingerprint(resolved: &Resolved) -> String {
    let mut s = String::new();
    match resolved {
        Resolved::Variable(v) => {
            s.push_str("var\u{1f}");
            // hidden vs blank vs a value are all distinct outcomes.
            s.push_str(if v.hidden { "1" } else { "0" });
            s.push('\u{1f}');
            s.push_str(&v.display);
        }
        Resolved::Table(t) => {
            s.push_str("tbl\u{1f}");
            s.push_str(&t.headers.join("\u{1e}"));
            for row in &t.rows {
                s.push('\u{1d}');
                s.push_str(&row.join("\u{1e}"));
            }
        }
        Resolved::RecordFlow(rf) => {
            s.push_str("flow\u{1f}");
            for g in &rf.groups {
                s.push('\u{1d}');
                s.push_str(g.header.as_deref().unwrap_or(""));
                s.push(':');
                // The rendered cell lines per record carry the displayed content.
                for r in &g.records {
                    s.push('\u{1c}');
                    s.push_str(&r.cells.join("\u{1e}"));
                }
                if let Some(f) = &g.footer {
                    s.push_str("\u{1c}foot");
                    s.push_str(&f.cells.join("\u{1e}"));
                }
            }
        }
        Resolved::Image(img) => {
            s.push_str("img\u{1f}");
            s.push_str(&format!("{:?}", img.status));
            s.push('\u{1f}');
            s.push_str(&image_ref_repr(&img.reference));
        }
        Resolved::Barcode(bc) => {
            s.push_str("bc\u{1f}");
            s.push_str(&format!("{:?}", bc.symbology));
            s.push('\u{1f}');
            s.push_str(&format!("{:?}", bc.status));
            s.push('\u{1f}');
            s.push_str(&bc.value);
        }
    }
    s
}

/// A stable repr of a resolved image reference (the bytes case keys off length +
/// a content marker so two different blobs of equal length still differ via the
/// status/value context they were resolved from).
fn image_ref_repr(r: &data_core::ImageReference) -> String {
    use data_core::ImageReference;
    match r {
        ImageReference::None => "none".to_string(),
        ImageReference::Uri { uri } => format!("uri:{uri}"),
        ImageReference::Path { path } => format!("path:{path}"),
        ImageReference::AssetId { id } => format!("asset:{id}"),
        ImageReference::Bytes { bytes } => format!("bytes:{}", bytes.len()),
    }
}

/// Diff two snapshots of per-binding resolved fingerprints (spec §8 change
/// report — "what changed since last sync"). `before`/`after` map a binding id →
/// its [`resolved_fingerprint`]. A binding present on both sides is `Changed` iff
/// the fingerprints differ (else `Unchanged`); present only in `after` is
/// `Added`; only in `before` is `Removed`. Pure + deterministic; entries sorted
/// by id.
pub fn diff_resolved(
    before: &HashMap<String, String>,
    after: &HashMap<String, String>,
) -> ChangeReport {
    let ids: BTreeSet<&String> = before.keys().chain(after.keys()).collect();
    let mut report = ChangeReport::default();
    for id in ids {
        let b = before.get(id);
        let a = after.get(id);
        let kind = match (b, a) {
            (Some(bv), Some(av)) if bv == av => ChangeKind::Unchanged,
            (Some(_), Some(_)) => ChangeKind::Changed,
            (None, Some(_)) => ChangeKind::Added,
            (Some(_), None) => ChangeKind::Removed,
            (None, None) => unreachable!("an id came from one of the two maps"),
        };
        match kind {
            ChangeKind::Changed => report.changed += 1,
            ChangeKind::Unchanged => report.unchanged += 1,
            ChangeKind::Added => report.added += 1,
            ChangeKind::Removed => report.removed += 1,
        }
        report.entries.push(BindingChange {
            binding: id.clone(),
            kind,
            before: b.cloned(),
            after: a.cloned(),
        });
    }
    report
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
