// Local file import into DuckDB (wave 6): which formats there are, how each
// becomes a DuckDB table, and the SQL quoting that keeps a file name from
// becoming SQL. Transport only — no binding or expression semantics here.
//
// How each format becomes the table `<source>`:
//   csv / tsv  DuckDB's CSV sniffer (`insertCSVFromPath`, the path CSV always
//              took — the same types as before).
//   json       the bytes registered as a virtual file, then
//              `CREATE TABLE … AS SELECT * FROM read_json_auto(file)`.
//              An array of objects and newline-delimited JSON both read.
//   parquet    the bytes registered, then `read_parquet(file)`.
//   xlsx       DuckDB-WASM 1.29.0 has no offline XLSX reader, so the data
//              engine (data-xlsx, calamine) reads the worksheet and decides
//              one type per column; DuckDB reads its JSON records with that
//              column list (`read_json(…, columns = {…})`), guessing nothing.
//
// Every source is materialised as a table, so a query names it the same way
// whatever it was imported from (`SELECT * FROM products`).

import type { DuckDBHandle } from "./duckdb";

/** The formats a local file can be imported as. */
export type ImportFormat = "csv" | "tsv" | "json" | "parquet" | "xlsx";

/** File extension → format. `.ndjson` / `.jsonl` are JSON (DuckDB detects
 *  the newline-delimited layout itself). */
export const IMPORT_EXTENSIONS: Readonly<Record<string, ImportFormat>> = {
  ".csv": "csv",
  ".tsv": "tsv",
  ".json": "json",
  ".ndjson": "json",
  ".jsonl": "json",
  ".parquet": "parquet",
  ".xlsx": "xlsx",
};

/** The `accept` list for a file picker. */
export const IMPORT_ACCEPT: readonly string[] = Object.keys(IMPORT_EXTENSIONS);

/** The format of a file by its extension, or null when it is not importable. */
export function formatOfFile(fileName: string): ImportFormat | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return null;
  return IMPORT_EXTENSIONS[fileName.slice(dot).toLowerCase()] ?? null;
}

/** A source name from a file name: the stem, with anything but letters,
 *  digits and `_` replaced, never starting with a digit. */
export function sourceNameOf(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const clean = base.replace(/[^a-zA-Z0-9_]/g, "_") || "data";
  return /^[0-9]/.test(clean) ? `_${clean}` : clean;
}

/** A SQL identifier, double-quoted. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** A SQL string literal, single-quoted. */
export function quoteLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** One worksheet as the data engine reads it (`DataEngine.xlsx_import`). */
export interface XlsxImport {
  sheet: string;
  sheets: string[];
  columns: { name: string; type: string }[];
  rows: number;
  errorCells: number;
  json: string;
}

/** What an import loaded. */
export interface LoadOutcome {
  /** The worksheet read (xlsx only). */
  sheet?: string;
  /** Every worksheet of the workbook (xlsx only). */
  sheets?: string[];
  /** Error cells read as NULL (xlsx only). */
  errorCells?: number;
}

/** The virtual file name a source's bytes are registered under. */
export function virtualFileName(source: string, format: ImportFormat): string {
  return `paged_src_${source}.${format === "xlsx" ? "xlsx.json" : format}`;
}

/** Load one imported file into DuckDB as the table `source`. `readXlsx` is
 *  the data engine's worksheet reader (only called for xlsx). Throws DuckDB's
 *  own error text when the file does not read. */
export async function loadIntoDuckDB(
  duck: DuckDBHandle,
  source: string,
  format: ImportFormat,
  bytes: Uint8Array,
  readXlsx: (bytes: Uint8Array, sheet?: string) => XlsxImport,
  sheet?: string,
): Promise<LoadOutcome> {
  const table = quoteIdent(source);
  switch (format) {
    case "csv":
    case "tsv":
      await duck.exec(`DROP TABLE IF EXISTS ${table}`);
      await duck.registerCsv(source, new TextDecoder().decode(bytes));
      return {};
    case "json":
    case "parquet": {
      const file = virtualFileName(source, format);
      await duck.dropFile(file);
      await duck.registerFileBuffer(file, bytes);
      const reader = format === "json" ? "read_json_auto" : "read_parquet";
      await duck.exec(
        `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM ${reader}(${quoteLiteral(file)})`,
      );
      return {};
    }
    case "xlsx": {
      const x = readXlsx(bytes, sheet);
      if (x.rows === 0) {
        const cols = x.columns.map((c) => `${quoteIdent(c.name)} ${c.type}`).join(", ");
        await duck.exec(`CREATE OR REPLACE TABLE ${table} (${cols})`);
      } else {
        const file = virtualFileName(source, format);
        await duck.dropFile(file);
        await duck.registerFileBuffer(file, new TextEncoder().encode(x.json));
        const columns = x.columns
          .map((c) => `${quoteLiteral(c.name)}: ${quoteLiteral(c.type)}`)
          .join(", ");
        await duck.exec(
          `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_json(${quoteLiteral(file)}, ` +
            `format = 'array', columns = {${columns}})`,
        );
      }
      return { sheet: x.sheet, sheets: x.sheets, errorCells: x.errorCells };
    }
  }
}
