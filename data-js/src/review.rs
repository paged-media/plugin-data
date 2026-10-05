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

//! The review surfaces a panel shows before anything is written: the row diff
//! between the data a document was last written from and the data a refresh
//! delivered (spec §8), an expression check (parse errors and unknown fields),
//! a condition's firing preview, and the locale and format-pattern catalog
//! (§9.1). Read-only over the session: nothing here changes a sync state.
//!
//! The row diff is built on [`data_bind::diff`] (record identity by a declared
//! key). This module adds what a reader needs to see on top of the delta: the
//! values of added and removed rows, which columns of an updated row changed
//! and from what, and which bindings read what changed.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use data_bind::diff;
use data_core::{Binding, BindingDef, Locale, QueryId, RecordSet, Value};
use data_expr::{apply_format, field_refs, parse, split_format, FormatSpec, SimpleCtx};

/// How the row diff picks record identity, and where rules read.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowDiffOptions {
    /// Key fields per query. A query without an entry uses the first column
    /// whose values are present and unique in both results, else every column.
    #[serde(default)]
    pub keys: BTreeMap<String, Vec<String>>,
    /// The query each rule evaluates over (a rule names no query of its own).
    #[serde(default)]
    pub rule_queries: BTreeMap<String, String>,
    /// At most this many rows are listed per section (counts are always
    /// complete). Default 200.
    #[serde(default)]
    pub limit: Option<usize>,
}

/// One listed row: its index in its result, its key and its values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowView {
    pub index: usize,
    pub key: String,
    pub values: Vec<String>,
}

/// One changed cell of an updated row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CellChange {
    pub column: String,
    pub before: String,
    pub after: String,
}

/// One updated row: same key, different content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowUpdate {
    pub index: usize,
    pub key: String,
    pub changes: Vec<CellChange>,
}

/// A binding a query's change reaches, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AffectedBinding {
    pub binding: String,
    pub kind: String,
    pub reason: String,
}

/// The row diff of one query.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRowDiff {
    pub query: String,
    /// The key fields used (empty = the whole row is its identity).
    pub key: Vec<String>,
    /// No applied snapshot existed: every row counts as added.
    pub baseline: bool,
    pub columns: Vec<String>,
    pub inserted_count: usize,
    pub removed_count: usize,
    pub updated_count: usize,
    pub unchanged: usize,
    pub inserted: Vec<RowView>,
    pub removed: Vec<RowView>,
    pub updated: Vec<RowUpdate>,
    /// Columns that changed in at least one updated row.
    pub changed_columns: Vec<String>,
    pub affected: Vec<AffectedBinding>,
}

/// Diff every query's current result against its applied snapshot.
pub fn row_diffs(
    applied: &HashMap<QueryId, RecordSet>,
    current: &[(QueryId, &RecordSet)],
    bindings: &[BindingDef],
    templates: &HashMap<String, Vec<String>>,
    opts: &RowDiffOptions,
) -> Vec<QueryRowDiff> {
    let limit = opts.limit.unwrap_or(200);
    let empty = RecordSet::empty(data_core::Schema::default());
    let mut out = Vec::with_capacity(current.len());
    for (qid, new) in current {
        let old = applied.get(qid);
        let baseline = old.is_none();
        let old = old.unwrap_or(&empty);
        let key = match opts.keys.get(qid.as_str()) {
            Some(k) => k.clone(),
            None => default_key(old, new),
        };
        let delta = diff(old, new, &key);
        let columns: Vec<String> = new.schema.fields.iter().map(|f| f.name.clone()).collect();

        let new_keys = key_index(new, &key);
        let old_keys = key_index(old, &key);
        let old_by_key: HashMap<&str, usize> = old_keys
            .iter()
            .enumerate()
            .map(|(i, k)| (k.as_str(), i))
            .collect();
        let new_key_set: HashSet<&str> = new_keys.iter().map(String::as_str).collect();

        let inserted = delta
            .inserted
            .iter()
            .take(limit)
            .map(|&i| row_view(new, i, &key))
            .collect();
        let removed_rows: Vec<usize> = (0..old.row_count)
            .filter(|&i| !new_key_set.contains(old_keys[i].as_str()))
            .collect();
        let removed = removed_rows
            .iter()
            .take(limit)
            .map(|&i| row_view(old, i, &key))
            .collect();

        let mut changed: BTreeSet<String> = BTreeSet::new();
        let mut updated = Vec::new();
        for &i in &delta.updated {
            let Some(&o) = old_by_key.get(new_keys[i].as_str()) else {
                continue;
            };
            let changes: Vec<CellChange> = columns
                .iter()
                .enumerate()
                .filter_map(|(c, name)| {
                    let before = old
                        .schema
                        .index_of(name)
                        .and_then(|oc| old.value(o, oc))
                        .map(Value::as_display)
                        .unwrap_or_default();
                    let after = new.value(i, c).map(Value::as_display).unwrap_or_default();
                    (before != after).then(|| CellChange {
                        column: name.clone(),
                        before,
                        after,
                    })
                })
                .collect();
            changed.extend(changes.iter().map(|c| c.column.clone()));
            if updated.len() < limit {
                updated.push(RowUpdate {
                    index: i,
                    key: display_key(new, i, &key),
                    changes,
                });
            }
        }

        let rows_moved = !delta.inserted.is_empty() || !removed_rows.is_empty();
        let affected = affected_bindings(qid, bindings, templates, opts, &changed, rows_moved);
        out.push(QueryRowDiff {
            query: qid.to_string(),
            key,
            baseline,
            columns,
            inserted_count: delta.inserted.len(),
            removed_count: removed_rows.len(),
            updated_count: delta.updated.len(),
            unchanged: delta.unchanged,
            inserted,
            removed,
            updated,
            changed_columns: changed.into_iter().collect(),
            affected,
        });
    }
    out.sort_by(|a, b| a.query.cmp(&b.query));
    out
}

/// The first column whose values are present and unique in both results;
/// none (the whole row) when no column qualifies.
fn default_key(old: &RecordSet, new: &RecordSet) -> Vec<String> {
    let unique = |rs: &RecordSet, name: &str| -> bool {
        let Some(c) = rs.schema.index_of(name) else {
            return rs.row_count == 0;
        };
        let mut seen = HashSet::with_capacity(rs.row_count);
        (0..rs.row_count).all(|r| match rs.value(r, c) {
            None | Some(Value::Null) => false,
            Some(v) => seen.insert(cell_key(v)),
        })
    };
    new.schema
        .fields
        .iter()
        .map(|f| f.name.as_str())
        .find(|n| unique(new, n) && unique(old, n))
        .map(|n| vec![n.to_string()])
        .unwrap_or_default()
}

/// A typed identity for one cell (`1` the number and `"1"` the text differ).
fn cell_key(v: &Value) -> String {
    format!("{v:?}")
}

/// Each row's key: the key columns' typed identities (every column when the
/// key is empty), joined by U+001F.
fn key_index(rs: &RecordSet, key: &[String]) -> Vec<String> {
    let cols: Vec<Option<usize>> = if key.is_empty() {
        (0..rs.columns.len()).map(Some).collect()
    } else {
        key.iter().map(|k| rs.schema.index_of(k)).collect()
    };
    (0..rs.row_count)
        .map(|r| {
            cols.iter()
                .map(|c| {
                    c.and_then(|c| rs.value(r, c))
                        .map(cell_key)
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>()
                .join("\u{1f}")
        })
        .collect()
}

fn row_view(rs: &RecordSet, i: usize, key: &[String]) -> RowView {
    RowView {
        index: i,
        key: display_key(rs, i, key),
        values: (0..rs.columns.len())
            .map(|c| rs.value(i, c).map(Value::as_display).unwrap_or_default())
            .collect(),
    }
}

/// A row's key as a reader sees it: the key fields' values, or the record
/// number when the whole row is the key.
fn display_key(rs: &RecordSet, i: usize, key: &[String]) -> String {
    if key.is_empty() {
        return format!("#{}", i + 1);
    }
    key.iter()
        .map(|k| {
            rs.schema
                .index_of(k)
                .and_then(|c| rs.value(i, c))
                .map(Value::as_display)
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

/// The binding kind as the panels name it.
pub fn kind_name(b: &Binding) -> &'static str {
    match b {
        Binding::Variable { .. } => "variable",
        Binding::Table { .. } => "table",
        Binding::RecordFlow { .. } => "recordFlow",
        Binding::Image { .. } => "image",
        Binding::Barcode { .. } => "barcode",
        Binding::Visibility { .. } => "visibility",
        Binding::Rule { .. } => "rule",
    }
}

/// Every field a binding's expressions read (a record flow reads its
/// template's fields, which the caller supplies by template id).
fn binding_reads(b: &Binding, templates: &HashMap<String, Vec<String>>) -> Vec<String> {
    let mut reads = match b {
        Binding::Variable { expr, .. }
        | Binding::Image { expr, .. }
        | Binding::Barcode { expr, .. }
        | Binding::Visibility { expr, .. } => field_refs(expr),
        Binding::Rule { when, .. } => field_refs(when),
        Binding::Table { columns, .. } => {
            columns.iter().flat_map(|c| field_refs(&c.expr)).collect()
        }
        Binding::RecordFlow {
            template, options, ..
        } => {
            let mut r = templates
                .get(template.as_str())
                .cloned()
                .unwrap_or_default();
            r.extend(options.group_by.iter().cloned());
            r
        }
    };
    reads.sort();
    reads.dedup();
    reads
}

/// Which bindings on `query` read what changed. A whole-result binding (table,
/// record flow, rule) is reached by any added or removed row; a per-record
/// binding resolves one record, which an added or removed row can move, so
/// both are reported with the reason. A binding whose expressions read no
/// field (an empty table column, say) is reached by any change.
fn affected_bindings(
    query: &QueryId,
    bindings: &[BindingDef],
    templates: &HashMap<String, Vec<String>>,
    opts: &RowDiffOptions,
    changed: &BTreeSet<String>,
    rows_moved: bool,
) -> Vec<AffectedBinding> {
    let mut out = Vec::new();
    for def in bindings {
        let on_query = match &def.binding {
            Binding::Rule { .. } => opts
                .rule_queries
                .get(def.id.as_str())
                .is_some_and(|q| q == query.as_str()),
            b => b.query() == Some(query),
        };
        if !on_query {
            continue;
        }
        let reads = binding_reads(&def.binding, templates);
        let hit: Vec<&String> = reads.iter().filter(|r| changed.contains(*r)).collect();
        let reason = if !hit.is_empty() {
            format!(
                "reads {} which changed",
                hit.iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        } else if rows_moved {
            match &def.binding {
                Binding::Table { .. } | Binding::RecordFlow { .. } | Binding::Rule { .. } => {
                    "rows were added or removed".to_string()
                }
                _ => "rows were added or removed, which can move the record it shows".to_string(),
            }
        } else if reads.is_empty() && !changed.is_empty() {
            "reads the whole record, which changed".to_string()
        } else {
            continue;
        };
        out.push(AffectedBinding {
            binding: def.id.to_string(),
            kind: kind_name(&def.binding).to_string(),
            reason,
        });
    }
    out
}

/// An expression check: parses, which fields it reads, and which of them the
/// query's result does not have.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExprCheck {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub fields: Vec<String>,
    pub unknown_fields: Vec<String>,
}

/// Check an expression, against a result's schema when one is given.
pub fn check_expression(src: &str, schema_of: Option<&RecordSet>) -> ExprCheck {
    if src.trim().is_empty() {
        return ExprCheck {
            ok: false,
            error: Some("the expression is empty".to_string()),
            fields: vec![],
            unknown_fields: vec![],
        };
    }
    match parse(src) {
        Err(e) => ExprCheck {
            ok: false,
            error: Some(e.to_string()),
            fields: vec![],
            unknown_fields: vec![],
        },
        Ok(_) => {
            let fields = field_refs(src);
            let unknown_fields = match schema_of {
                Some(rs) => fields
                    .iter()
                    .filter(|f| rs.schema.index_of(f).is_none())
                    .cloned()
                    .collect(),
                None => vec![],
            };
            ExprCheck {
                ok: unknown_fields.is_empty(),
                error: (!unknown_fields.is_empty())
                    .then(|| format!("no such field: {}", unknown_fields.join(", "))),
                fields,
                unknown_fields,
            }
        }
    }
}

/// A field's display pattern across the boundary (mirrors [`FormatSpec`]).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FormatPattern {
    #[default]
    Plain,
    Number {
        decimals: u8,
    },
    Currency {
        decimals: u8,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        symbol: Option<String>,
    },
    Percent {
        decimals: u8,
    },
    Date {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pattern: Option<String>,
    },
}

impl From<FormatPattern> for FormatSpec {
    fn from(p: FormatPattern) -> Self {
        match p {
            FormatPattern::Plain => FormatSpec::Plain,
            FormatPattern::Number { decimals } => FormatSpec::Number { decimals },
            FormatPattern::Currency { decimals, symbol } => {
                FormatSpec::Currency { decimals, symbol }
            }
            FormatPattern::Percent { decimals } => FormatSpec::Percent { decimals },
            FormatPattern::Date { pattern } => FormatSpec::Date { pattern },
        }
    }
}

impl From<FormatSpec> for FormatPattern {
    fn from(s: FormatSpec) -> Self {
        match s {
            FormatSpec::Plain => FormatPattern::Plain,
            FormatSpec::Number { decimals } => FormatPattern::Number { decimals },
            FormatSpec::Currency { decimals, symbol } => {
                FormatPattern::Currency { decimals, symbol }
            }
            FormatSpec::Percent { decimals } => FormatPattern::Percent { decimals },
            FormatSpec::Date { pattern } => FormatPattern::Date { pattern },
        }
    }
}

/// An expression split into its inner expression and display pattern.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SplitPattern {
    pub inner: String,
    pub pattern: FormatPattern,
}

/// Wrap an expression in a display pattern.
pub fn format_expression(inner: &str, pattern: FormatPattern) -> String {
    apply_format(inner, &pattern.into())
}

/// Read an expression's display pattern back.
pub fn split_expression(src: &str) -> SplitPattern {
    let (inner, spec) = split_format(src);
    SplitPattern {
        inner,
        pattern: spec.into(),
    }
}

/// One locale for a picker, with samples formatted by the real kernels.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleInfo {
    pub tag: String,
    pub name: String,
    pub number: String,
    pub currency: String,
    pub date: String,
}

/// Every locale the kernels know, each with a number, currency and date
/// sample (1234567.891 and 2026-10-05).
pub fn locale_catalog() -> Vec<LocaleInfo> {
    let ctx = SimpleCtx::new()
        .with_field("n", Value::Number(1_234_567.891))
        .with_field("d", Value::Date(20_731));
    Locale::all()
        .map(|l| {
            let ec = data_expr::EvalCtx::new(&ctx, 0).with_locale(l);
            let ev = |src: &str| data_expr::eval_str(src, &ec).as_display();
            LocaleInfo {
                tag: l.tag().to_string(),
                name: l.def().name.to_string(),
                number: ev("NUMBER(n, 2)"),
                currency: ev("CURRENCY(n)"),
                date: ev("DATEFMT(d)"),
            }
        })
        .collect()
}
