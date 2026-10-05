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

//! # data-xlsx — one worksheet of an `.xlsx` as a typed table
//!
//! DuckDB reads CSV, JSON and Parquet itself. It does not read XLSX in the
//! shipped DuckDB-WASM 1.29.0 (engine v1.1.1): the `excel` extension has no
//! wasm build for that version (extensions.duckdb.org answers 404), and the
//! `spatial` extension's GDAL reader is 22.8 MB of wasm, a quarter of the
//! whole app's budget. This crate reads the workbook with calamine (MIT,
//! ~0.4 MB of wasm) and hands DuckDB JSON records plus a column type list,
//! so DuckDB's `read_json` makes the table without guessing.
//!
//! Data Merge semantics: the FIRST ROW of the used range names the columns;
//! every later row is a record. An empty header cell is named `column_<n>`
//! (1-based), a repeated name gets `_2`, `_3`, ….
//!
//! Types are decided per column over its non-empty cells:
//! - all integers (Excel stores numbers as floats; an integral float counts)
//!   → `BIGINT`; integers and fractions → `DOUBLE`;
//! - all booleans → `BOOLEAN`;
//! - all dates (a date-formatted cell with no time of day) → `DATE`; dates and
//!   date-times → `TIMESTAMP`;
//! - anything else, or a mix → `VARCHAR`, and every cell of that column is
//!   written as text;
//! - a column with no value at all → `VARCHAR`.
//!
//! Error cells (`#N/A`, `#DIV/0!`, …) become NULL and are counted.

use std::io::Cursor;

use calamine::{Data, ExcelDateTime, ExcelDateTimeType, Reader, Xlsx};
use serde_json::{Map, Number, Value as Json};
use thiserror::Error;

/// Why a workbook could not be read.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum XlsxError {
    #[error("not a readable .xlsx workbook: {0}")]
    Open(String),
    #[error("the workbook has no worksheet named \"{0}\"")]
    NoSuchSheet(String),
    #[error("the workbook has no worksheets")]
    NoSheets,
    #[error("worksheet \"{sheet}\" could not be read: {reason}")]
    Sheet { sheet: String, reason: String },
    #[error("worksheet \"{0}\" is empty — the first row must name the columns")]
    Empty(String),
}

/// The DuckDB type a column is read as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnType {
    BigInt,
    Double,
    Boolean,
    Date,
    Timestamp,
    Varchar,
}

impl ColumnType {
    /// The DuckDB type name.
    pub fn sql(self) -> &'static str {
        match self {
            ColumnType::BigInt => "BIGINT",
            ColumnType::Double => "DOUBLE",
            ColumnType::Boolean => "BOOLEAN",
            ColumnType::Date => "DATE",
            ColumnType::Timestamp => "TIMESTAMP",
            ColumnType::Varchar => "VARCHAR",
        }
    }
}

/// One worksheet read as a table.
#[derive(Debug, Clone, PartialEq)]
pub struct SheetTable {
    /// The worksheet the table was read from.
    pub sheet: String,
    /// Column names, in sheet order, unique.
    pub columns: Vec<String>,
    /// The type of each column (same order as `columns`).
    pub types: Vec<ColumnType>,
    /// The records, one value per column (`Json::Null` for an empty cell).
    pub rows: Vec<Vec<Json>>,
    /// How many error cells (`#N/A`, …) were read as NULL.
    pub error_cells: usize,
}

/// A cell after the first pass, before its column's type is known.
#[derive(Debug, Clone, PartialEq)]
enum Cell {
    Empty,
    Int(i64),
    Float(f64),
    Bool(bool),
    Date(String),
    DateTime(String),
    Text(String),
}

/// The worksheet names of a workbook, in workbook order.
pub fn sheet_names(bytes: &[u8]) -> Result<Vec<String>, XlsxError> {
    let wb = open(bytes)?;
    Ok(wb.sheet_names())
}

/// Read one worksheet (`None` = the first) as a [`SheetTable`].
pub fn read_sheet(bytes: &[u8], sheet: Option<&str>) -> Result<SheetTable, XlsxError> {
    let mut wb = open(bytes)?;
    let names = wb.sheet_names();
    let name = match sheet {
        Some(s) => {
            if !names.iter().any(|n| n == s) {
                return Err(XlsxError::NoSuchSheet(s.to_string()));
            }
            s.to_string()
        }
        None => names.first().cloned().ok_or(XlsxError::NoSheets)?,
    };
    let range = wb.worksheet_range(&name).map_err(|e| XlsxError::Sheet {
        sheet: name.clone(),
        reason: e.to_string(),
    })?;

    let mut rows = range.rows();
    let header = rows.next().ok_or_else(|| XlsxError::Empty(name.clone()))?;
    let columns = column_names(header);
    if columns.is_empty() {
        return Err(XlsxError::Empty(name));
    }

    let mut error_cells = 0usize;
    let mut cells: Vec<Vec<Cell>> = Vec::new();
    for row in rows {
        let mut out = Vec::with_capacity(columns.len());
        for i in 0..columns.len() {
            let c = row.get(i).unwrap_or(&Data::Empty);
            if matches!(c, Data::Error(_)) {
                error_cells += 1;
            }
            out.push(cell_of(c));
        }
        // A wholly empty row inside the used range is not a record.
        if out.iter().all(|c| *c == Cell::Empty) {
            continue;
        }
        cells.push(out);
    }

    let types: Vec<ColumnType> = (0..columns.len())
        .map(|i| column_type(cells.iter().map(|r| &r[i])))
        .collect();
    let rows = cells
        .into_iter()
        .map(|r| {
            r.into_iter()
                .zip(&types)
                .map(|(c, t)| json_of(c, *t))
                .collect()
        })
        .collect();
    Ok(SheetTable {
        sheet: name,
        columns,
        types,
        rows,
        error_cells,
    })
}

impl SheetTable {
    /// The records as a JSON array of objects (DuckDB `read_json`,
    /// `format = 'array'`). Every object carries every column.
    pub fn to_json(&self) -> String {
        let records: Vec<Json> = self
            .rows
            .iter()
            .map(|r| {
                let mut m = Map::with_capacity(self.columns.len());
                for (name, v) in self.columns.iter().zip(r) {
                    m.insert(name.clone(), v.clone());
                }
                Json::Object(m)
            })
            .collect();
        Json::Array(records).to_string()
    }
}

fn open(bytes: &[u8]) -> Result<Xlsx<Cursor<Vec<u8>>>, XlsxError> {
    Xlsx::new(Cursor::new(bytes.to_vec())).map_err(|e| XlsxError::Open(e.to_string()))
}

/// Header row → unique, non-empty column names. Trailing empty header cells
/// past the last named one are dropped (a used range often runs wider than
/// the table's header).
fn column_names(header: &[Data]) -> Vec<String> {
    let last = header
        .iter()
        .rposition(|c| !matches!(c, Data::Empty))
        .map(|i| i + 1)
        .unwrap_or(0);
    let mut seen: Vec<String> = Vec::with_capacity(last);
    for (i, c) in header[..last].iter().enumerate() {
        let base = match cell_of(c) {
            Cell::Empty => format!("column_{}", i + 1),
            other => text_of(&other).trim().to_string(),
        };
        let base = if base.is_empty() {
            format!("column_{}", i + 1)
        } else {
            base
        };
        let mut name = base.clone();
        let mut n = 2;
        while seen.iter().any(|s| s.eq_ignore_ascii_case(&name)) {
            name = format!("{base}_{n}");
            n += 1;
        }
        seen.push(name);
    }
    seen
}

fn cell_of(c: &Data) -> Cell {
    match c {
        Data::Empty | Data::Error(_) => Cell::Empty,
        Data::Int(i) => Cell::Int(*i),
        Data::Float(f) => {
            if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15 {
                Cell::Int(*f as i64)
            } else {
                Cell::Float(*f)
            }
        }
        Data::Bool(b) => Cell::Bool(*b),
        Data::String(s) => {
            if s.is_empty() {
                Cell::Empty
            } else {
                Cell::Text(s.clone())
            }
        }
        Data::DateTime(d) if d.is_datetime() => {
            let (y, mo, da, h, mi, s, ms) = date_time_parts(d);
            if h == 0 && mi == 0 && s == 0 && ms == 0 {
                Cell::Date(format!("{y:04}-{mo:02}-{da:02}"))
            } else if ms == 0 {
                Cell::DateTime(format!("{y:04}-{mo:02}-{da:02} {h:02}:{mi:02}:{s:02}"))
            } else {
                Cell::DateTime(format!(
                    "{y:04}-{mo:02}-{da:02} {h:02}:{mi:02}:{s:02}.{ms:03}"
                ))
            }
        }
        // A duration-formatted number: keep the number of days as written.
        Data::DateTime(d) => Cell::Float(d.as_f64()),
        Data::DateTimeIso(s) => {
            if s.len() == 10 {
                Cell::Date(s.clone())
            } else {
                Cell::DateTime(s.replacen('T', " ", 1))
            }
        }
        Data::DurationIso(s) => Cell::Text(s.clone()),
    }
}

/// A date-time serial as `(year, month, day, hour, minute, second, milli)`,
/// rounded to the nearest millisecond. calamine 0.31's own
/// `to_ymd_hms_milli` truncates the seconds but rounds the milliseconds, so
/// 18:45:15 stored as 0.78142361111… came back as 18:45:14 + 1000 ms; here
/// the time of day is rounded as a whole and a round-up past midnight moves
/// to the next day. calamine still does the calendar (both epochs).
fn date_time_parts(d: &ExcelDateTime) -> (u16, u8, u8, u8, u8, u8, u16) {
    let v = d.as_f64();
    // The epoch is private to calamine: the 1900 reading of the same serial
    // differs from the 1904 one by 1 462 days, so comparing names it.
    let is_1904 = ExcelDateTime::new(v, ExcelDateTimeType::DateTime, false).to_ymd_hms_milli()
        != d.to_ymd_hms_milli();
    let mut day = v.floor();
    let mut ms = ((v - day) * 86_400_000.0).round() as u64;
    if ms >= 86_400_000 {
        ms -= 86_400_000;
        day += 1.0;
    }
    let (y, mo, da, ..) =
        ExcelDateTime::new(day, ExcelDateTimeType::DateTime, is_1904).to_ymd_hms_milli();
    (
        y,
        mo,
        da,
        (ms / 3_600_000) as u8,
        (ms / 60_000 % 60) as u8,
        (ms / 1000 % 60) as u8,
        (ms % 1000) as u16,
    )
}

fn column_type<'a>(cells: impl Iterator<Item = &'a Cell>) -> ColumnType {
    let mut t: Option<ColumnType> = None;
    for c in cells {
        let ct = match c {
            Cell::Empty => continue,
            Cell::Int(_) => ColumnType::BigInt,
            Cell::Float(_) => ColumnType::Double,
            Cell::Bool(_) => ColumnType::Boolean,
            Cell::Date(_) => ColumnType::Date,
            Cell::DateTime(_) => ColumnType::Timestamp,
            Cell::Text(_) => return ColumnType::Varchar,
        };
        t = Some(match (t, ct) {
            (None, x) => x,
            (Some(a), b) if a == b => a,
            (Some(ColumnType::BigInt), ColumnType::Double)
            | (Some(ColumnType::Double), ColumnType::BigInt) => ColumnType::Double,
            (Some(ColumnType::Date), ColumnType::Timestamp)
            | (Some(ColumnType::Timestamp), ColumnType::Date) => ColumnType::Timestamp,
            _ => return ColumnType::Varchar,
        });
    }
    t.unwrap_or(ColumnType::Varchar)
}

fn json_of(c: Cell, t: ColumnType) -> Json {
    match (c, t) {
        (Cell::Empty, _) => Json::Null,
        (Cell::Int(i), ColumnType::BigInt) => Json::Number(i.into()),
        (Cell::Int(i), ColumnType::Double) => Number::from_f64(i as f64)
            .map(Json::Number)
            .unwrap_or(Json::Null),
        (Cell::Float(f), ColumnType::Double) => {
            Number::from_f64(f).map(Json::Number).unwrap_or(Json::Null)
        }
        (Cell::Bool(b), ColumnType::Boolean) => Json::Bool(b),
        (Cell::Date(d), ColumnType::Date) => Json::String(d),
        (Cell::Date(d), ColumnType::Timestamp) => Json::String(format!("{d} 00:00:00")),
        (Cell::DateTime(d), ColumnType::Timestamp) => Json::String(d),
        (other, _) => Json::String(text_of(&other)),
    }
}

/// A cell as text (a VARCHAR column, or a header).
fn text_of(c: &Cell) -> String {
    match c {
        Cell::Empty => String::new(),
        Cell::Int(i) => i.to_string(),
        Cell::Float(f) => f.to_string(),
        Cell::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        Cell::Date(s) | Cell::DateTime(s) | Cell::Text(s) => s.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integral_floats_are_integers_and_a_mix_widens() {
        let ints = [Cell::Int(1), Cell::Empty, Cell::Int(3)];
        assert_eq!(column_type(ints.iter()), ColumnType::BigInt);
        let mixed = [Cell::Int(1), Cell::Float(2.5)];
        assert_eq!(column_type(mixed.iter()), ColumnType::Double);
        let dates = [
            Cell::Date("2026-01-01".into()),
            Cell::DateTime("2026-01-01 10:00:00".into()),
        ];
        assert_eq!(column_type(dates.iter()), ColumnType::Timestamp);
        let text = [Cell::Int(1), Cell::Text("x".into())];
        assert_eq!(column_type(text.iter()), ColumnType::Varchar);
        let nothing = [Cell::Empty];
        assert_eq!(column_type(nothing.iter()), ColumnType::Varchar);
        assert_eq!(cell_of(&Data::Float(4.0)), Cell::Int(4));
    }

    #[test]
    fn header_names_are_unique_and_never_empty() {
        let header = [
            Data::String("sku".into()),
            Data::Empty,
            Data::String("SKU".into()),
            Data::String(" price ".into()),
            Data::Empty,
        ];
        assert_eq!(
            column_names(&header),
            vec!["sku", "column_2", "SKU_2", "price"]
        );
    }

    #[test]
    fn a_varchar_column_writes_numbers_as_text() {
        assert_eq!(
            json_of(Cell::Int(7), ColumnType::Varchar),
            Json::String("7".into())
        );
        assert_eq!(
            json_of(Cell::Bool(true), ColumnType::Varchar),
            Json::String("TRUE".into())
        );
        assert_eq!(
            json_of(Cell::Date("2026-10-05".into()), ColumnType::Timestamp),
            Json::String("2026-10-05 00:00:00".into())
        );
    }

    #[test]
    fn times_round_to_the_millisecond_and_carry_past_midnight() {
        let at =
            |v: f64| date_time_parts(&ExcelDateTime::new(v, ExcelDateTimeType::DateTime, false));
        // 2026-03-01 18:45:15 as openpyxl writes it (just under :15).
        assert_eq!(at(46082.781423611109), (2026, 3, 1, 18, 45, 15, 0));
        assert_eq!(at(46037.0 + 0.4 / 86_400.0), (2026, 1, 15, 0, 0, 0, 400));
        // 23:59:59.9999 rounds to the next midnight.
        assert_eq!(at(46037.999_999_999), (2026, 1, 16, 0, 0, 0, 0));
        // The 1904 epoch is kept.
        let d1904 = ExcelDateTime::new(0.5, ExcelDateTimeType::DateTime, true);
        assert_eq!(date_time_parts(&d1904), (1904, 1, 1, 12, 0, 0, 0));
    }

    #[test]
    fn garbage_is_an_open_error() {
        assert!(matches!(
            read_sheet(b"not a zip", None),
            Err(XlsxError::Open(_))
        ));
    }
}
