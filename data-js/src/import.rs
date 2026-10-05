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

//! File imports DuckDB-WASM cannot read itself (wave 6). The reading lives in
//! `data-xlsx`; this is the boundary shape the bundle receives. DuckDB reads
//! CSV, TSV, JSON and Parquet without help, so only XLSX passes through here.

use serde::Serialize;

/// One column of an imported worksheet: its name and the DuckDB type it is
/// read as.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
}

/// One worksheet, ready for DuckDB: `json` is a JSON array of records and
/// `columns` the explicit column list for `read_json(…, columns = {…})`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct XlsxImport {
    pub sheet: String,
    pub sheets: Vec<String>,
    pub columns: Vec<ImportColumn>,
    pub rows: usize,
    #[serde(rename = "errorCells")]
    pub error_cells: usize,
    pub json: String,
}

/// Read one worksheet (`None` = the first) of an `.xlsx`.
pub fn xlsx_import(bytes: &[u8], sheet: Option<&str>) -> Result<XlsxImport, String> {
    let sheets = data_xlsx::sheet_names(bytes).map_err(|e| e.to_string())?;
    let t = data_xlsx::read_sheet(bytes, sheet).map_err(|e| e.to_string())?;
    Ok(XlsxImport {
        json: t.to_json(),
        sheet: t.sheet,
        sheets,
        columns: t
            .columns
            .iter()
            .zip(&t.types)
            .map(|(n, ty)| ImportColumn {
                name: n.clone(),
                ty: ty.sql().to_string(),
            })
            .collect(),
        rows: t.rows.len(),
        error_cells: t.error_cells,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_non_workbook_is_an_error_string() {
        let err = xlsx_import(b"PK nope", None).unwrap_err();
        assert!(err.contains("not a readable .xlsx"), "{err}");
    }
}
