# Source import fixtures

Files the wave-6 import specs read (`packages/data-bundle/test/sources-real.spec.ts`,
`data-xlsx/tests/read.rs`).

- `products.xlsx` — written with openpyxl 3.1.5: a `Products` sheet (text, decimal,
  integer, date, date-time, boolean, an empty header cell, a repeated header, a wholly
  empty row, an error cell `#DIV/0!`, a quoted UTF-8 string) and a `Prices` sheet.
- `products.parquet` — written by DuckDB v1.1.1 (DuckDB-WASM 1.29.0, the shipped engine):
  `sku VARCHAR, price DECIMAL(10,2), qty INTEGER, launched DATE`, three rows, nulls in the
  last.
