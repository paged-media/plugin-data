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

//! Whether a query DEFINES the order of its result (spec §6.1).
//!
//! Record N of a result is the Nth record as delivered when the query defines
//! that order, and the Nth by content only when it does not (see
//! [`crate::stable_order`]). DuckDB defines the order of:
//!
//! - a statement with a top-level `ORDER BY` — the sort order;
//! - a scan of ONE table through order-preserving clauses only (`SELECT`,
//!   `WHERE`, `LIMIT`, `OFFSET`, `UNION ALL`, a derived table or a CTE over
//!   such a scan) — the table's insertion order, which DuckDB keeps while
//!   `preserve_insertion_order` is on (the default; the bundle never turns it
//!   off, and `lock_configuration` keeps a query from doing so). An imported
//!   file is a table inserted in file order, so record 1 is the file's first
//!   row, as Data Merge, the Dataset preview and InDesign number it.
//!
//! It does NOT define the order of a join (`JOIN`, or several tables in one
//! `FROM`), a grouping (`GROUP BY`, `HAVING`, `DISTINCT`), a set operation
//! other than `UNION ALL`, a window with a partition or an order, `PIVOT`,
//! sampling, or a subquery outside `FROM` (DuckDB plans those as joins). Nor
//! of an empty statement (a result handed in without SQL). Those results are
//! numbered by content, so the same rows delivered in another order are the
//! same records.
//!
//! The reading is lexical and conservative: anything it does not recognise as
//! order-preserving counts as undefined, which keeps the content numbering.

/// One token of a statement, as far as order preservation cares.
#[derive(Debug, Clone, PartialEq)]
enum Tok {
    /// A keyword or bare identifier, upper-cased.
    Word(String),
    Comma,
    Open,
    Close,
    /// A literal, a quoted identifier, an operator: nothing to decide on.
    Other,
}

fn lex(sql: &str) -> Vec<Tok> {
    let b: Vec<char> = sql.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_whitespace() {
            i += 1;
        } else if c == '-' && b.get(i + 1) == Some(&'-') {
            while i < b.len() && b[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && b.get(i + 1) == Some(&'*') {
            i += 2;
            while i < b.len() && !(b[i] == '*' && b.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
        } else if c == '\'' || c == '"' {
            // A string literal or a quoted identifier; a doubled quote escapes.
            i += 1;
            while i < b.len() {
                if b[i] == c {
                    if b.get(i + 1) == Some(&c) {
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            i += 1;
            out.push(Tok::Other);
        } else if c == '$' {
            // A dollar-quoted string ($tag$ … $tag$) or a parameter ($1, $name).
            let mut j = i + 1;
            while j < b.len() && (b[j].is_alphanumeric() || b[j] == '_') {
                j += 1;
            }
            if b.get(j) == Some(&'$') {
                let tag: String = b[i..=j].iter().collect();
                let rest: String = b[j + 1..].iter().collect();
                i = match rest.find(&tag) {
                    Some(at) => j + 1 + rest[..at].chars().count() + tag.chars().count(),
                    None => b.len(),
                };
            } else {
                i = j;
            }
            out.push(Tok::Other);
        } else if c.is_alphabetic() || c == '_' {
            let mut j = i;
            while j < b.len() && (b[j].is_alphanumeric() || b[j] == '_') {
                j += 1;
            }
            out.push(Tok::Word(b[i..j].iter().collect::<String>().to_uppercase()));
            i = j;
        } else if c == ',' {
            out.push(Tok::Comma);
            i += 1;
        } else if c == '(' {
            out.push(Tok::Open);
            i += 1;
        } else if c == ')' {
            out.push(Tok::Close);
            i += 1;
        } else {
            out.push(Tok::Other);
            i += 1;
        }
    }
    out
}

/// Clauses that end a `FROM` list.
const FROM_ENDS: &[&str] = &[
    "WHERE",
    "GROUP",
    "HAVING",
    "ORDER",
    "LIMIT",
    "OFFSET",
    "QUALIFY",
    "WINDOW",
    "UNION",
    "INTERSECT",
    "EXCEPT",
    "USING",
    "SELECT",
    "RETURNING",
    "FETCH",
];

/// Words whose presence anywhere leaves the order undefined.
const UNORDERING: &[&str] = &[
    "JOIN",
    "GROUP",
    "HAVING",
    "DISTINCT",
    "INTERSECT",
    "EXCEPT",
    "PIVOT",
    "UNPIVOT",
    "SAMPLE",
    "TABLESAMPLE",
    "QUALIFY",
    "WINDOW",
    "RECURSIVE",
    "LATERAL",
    "POSITIONAL",
    "ASOF",
];

/// Whether `sql`'s result order is defined: a top-level `ORDER BY`, or a scan
/// of one table through order-preserving clauses (see the module docs).
pub fn result_order_is_defined(sql: &str) -> bool {
    let toks = lex(sql);
    let word = |i: usize| match toks.get(i) {
        Some(Tok::Word(w)) => Some(w.as_str()),
        _ => None,
    };
    // A statement at all: SELECT, WITH, DuckDB's FROM-first form, VALUES or
    // TABLE <name>.
    if !matches!(
        word(0),
        Some("SELECT" | "WITH" | "FROM" | "VALUES" | "TABLE")
    ) {
        return false;
    }
    // The depth of every token (the depth it sits at; `(` opens after itself).
    let mut depth = Vec::with_capacity(toks.len());
    let mut d: i32 = 0;
    for t in &toks {
        if *t == Tok::Close {
            d -= 1;
        }
        depth.push(d);
        if *t == Tok::Open {
            d += 1;
        }
    }
    if d != 0 || depth.iter().any(|&x| x < 0) {
        return false; // unbalanced: not something to reason about
    }
    // A top-level ORDER BY defines the order whatever else the query does.
    let top_level_order_by = depth
        .iter()
        .enumerate()
        .any(|(i, &at)| at == 0 && word(i) == Some("ORDER") && word(i + 1) == Some("BY"));
    if top_level_order_by {
        return true;
    }
    for i in 0..toks.len() {
        let Some(w) = word(i) else { continue };
        if UNORDERING.contains(&w) {
            return false;
        }
        // UNION ALL keeps the order of its branches; UNION de-duplicates.
        if w == "UNION" && word(i + 1) != Some("ALL") {
            return false;
        }
        // A window with a partition or an order (an empty OVER () keeps it).
        if w == "OVER"
            && !(toks.get(i + 1) == Some(&Tok::Open) && toks.get(i + 2) == Some(&Tok::Close))
        {
            return false;
        }
        // A nested SELECT is order-preserving only as a derived table
        // (`FROM (SELECT …)`) or a CTE body (`name AS (SELECT …)`).
        if w == "SELECT" && depth[i] > 0 {
            let opener = (0..i)
                .rev()
                .find(|&k| toks[k] == Tok::Open && depth[k] == depth[i] - 1);
            let before = opener.and_then(|k| k.checked_sub(1)).and_then(word);
            if !matches!(before, Some("FROM" | "AS")) {
                return false;
            }
        }
        // Several tables in one FROM list are a join.
        if w == "FROM" {
            let at = depth[i];
            for k in i + 1..toks.len() {
                if depth[k] < at {
                    break;
                }
                if depth[k] > at {
                    continue;
                }
                match &toks[k] {
                    Tok::Comma => return false,
                    Tok::Word(x) if FROM_ENDS.contains(&x.as_str()) => break,
                    _ => {}
                }
            }
        }
    }
    true
}

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__<id>`: the cockpit test-to-feature join
mod tests {
    use super::result_order_is_defined as defined;

    #[test]
    fn data_query_order_defined_by_a_scan_or_an_order_by__feat__data_query_seam() {
        for sql in [
            "SELECT * FROM catalogue",
            "select * from \"catalogue\";",
            "SELECT name, ean FROM catalogue WHERE ean <> '' LIMIT 10 OFFSET 2",
            "SELECT * EXCLUDE (sku) FROM catalogue",
            "SELECT upper(name) AS n, price * 2 FROM catalogue WHERE contains(lower(name), 'pen')",
            "SELECT * FROM (SELECT * FROM catalogue WHERE price > 5) AS cheap",
            "WITH c AS (SELECT * FROM catalogue) SELECT name FROM c",
            "SELECT name FROM a UNION ALL SELECT name FROM b",
            "SELECT name, row_number() OVER () FROM catalogue",
            "SELECT extract(year FROM d) FROM catalogue",
            "FROM catalogue",
            "SELECT * FROM catalogue -- , other\n",
            "SELECT 'GROUP BY, JOIN' AS note FROM catalogue",
            "SELECT * FROM catalogue ORDER BY price DESC",
            "SELECT cat, count(*) FROM catalogue GROUP BY cat ORDER BY cat",
            "SELECT a.x FROM a JOIN b ON a.k = b.k ORDER BY a.x",
            "VALUES (1), (2)",
        ] {
            assert!(defined(sql), "{sql}");
        }
    }

    #[test]
    fn data_query_order_undefined_for_joins_groups_and_sets__feat__data_query_seam() {
        for sql in [
            "",
            "   ",
            "-- nothing",
            "SELECT cat, count(*) FROM catalogue GROUP BY cat",
            "SELECT DISTINCT name FROM catalogue",
            "SELECT c.name FROM catalogue c JOIN prices p ON p.ean = c.ean",
            "SELECT name FROM catalogue, prices",
            "SELECT name FROM catalogue UNION SELECT name FROM archive",
            "SELECT name FROM catalogue INTERSECT SELECT name FROM archive",
            "SELECT name, rank() OVER (ORDER BY price) FROM catalogue",
            "SELECT name, sum(price) OVER (PARTITION BY cat) FROM catalogue",
            "SELECT * FROM catalogue WHERE ean IN (SELECT ean FROM stock)",
            "SELECT name, (SELECT max(price) FROM catalogue) FROM catalogue",
            "SELECT * FROM catalogue USING SAMPLE 10",
            "SELECT * FROM (SELECT cat, count(*) FROM catalogue GROUP BY cat)",
            "SELECT * FROM (catalogue",
            "PRAGMA table_info('catalogue')",
        ] {
            assert!(!defined(sql), "{sql}");
        }
    }
}
