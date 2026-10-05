// The query lane's SQL hygiene (wave 6): the guard every user or document
// query passes before DuckDB runs it, DuckDB error text turned into a
// diagnostic with a position, and the preview wrapper.
//
// WHY A GUARD. A document's queries are code (§11): they come back from a
// saved file and run on refresh. DuckDB-WASM can read a URL from SQL alone
// (`read_csv('https://…')`, `FROM 'https://….parquet'`), which would reach the
// network without the per-origin consent the remote-source lane asks for, and
// a statement other than SELECT could drop an imported table. Every source is
// materialised as a table at import (query/import.ts), so a query never needs
// a file or URL. The guard therefore admits exactly one SELECT that reads
// plain tables, plus the table functions that read nothing (`range`,
// `generate_series`, `unnest`). It parses with DuckDB's own parser
// (`json_serialize_sql`, built into DuckDB-WASM), so it judges the statement
// DuckDB will run, not a regex's idea of it.

import type { DuckDBHandle } from "./duckdb";
import { quoteLiteral } from "./import";

/** A query problem the panel can point at. `line`/`column` are 1-based,
 *  in the query text as the user wrote it. */
export interface SqlDiagnostic {
  /** DuckDB's error class (`Parser`, `Binder`, `Catalog`, …) or `Guard`. */
  kind: string;
  message: string;
  line?: number;
  column?: number;
}

/** Table functions that read no file and no URL. */
const PURE_TABLE_FUNCTIONS = new Set(["range", "generate_series", "unnest"]);
const PLAIN_TABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Strip trailing semicolons and whitespace. */
export function trimSql(sql: string): string {
  return sql.replace(/[\s;]+$/, "").trim();
}

/** 1-based line/column of a 0-based character offset. */
export function positionOf(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/** Walk a `json_serialize_sql` statement and name the first reach outside the
 *  imported tables, or null when there is none. */
export function findForbiddenReach(ast: unknown): string | null {
  let found: string | null = null;
  const visit = (n: unknown): void => {
    if (found !== null || n === null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const v of n) visit(v);
      return;
    }
    const node = n as Record<string, unknown>;
    if (node.type === "TABLE_FUNCTION" && node.function && typeof node.function === "object") {
      const name = String((node.function as { function_name?: unknown }).function_name ?? "");
      if (!PURE_TABLE_FUNCTIONS.has(name.toLowerCase())) {
        found = `the table function ${name}() reads files or URLs — import the data as a source and query its table`;
        return;
      }
    }
    if (node.type === "BASE_TABLE" && typeof node.table_name === "string") {
      const catalog = String(node.catalog_name ?? "");
      const schema = String(node.schema_name ?? "");
      if (!PLAIN_TABLE.test(node.table_name) || catalog !== "" || (schema !== "" && schema !== "main")) {
        const qualified = [catalog, schema, node.table_name].filter(Boolean).join(".");
        found = `"${qualified}" is not an imported source table — a query reads source tables only`;
        return;
      }
    }
    for (const v of Object.values(node)) visit(v);
  };
  visit(ast);
  return found;
}

/** Check one query with DuckDB's parser. Returns null when it may run. */
export async function guardQuery(duck: DuckDBHandle, sql: string): Promise<SqlDiagnostic | null> {
  const text = trimSql(sql);
  if (text === "") return { kind: "Guard", message: "the query is empty" };
  const rs = await duck.rows(`SELECT json_serialize_sql(${quoteLiteral(text)}) AS j`);
  const raw = rs.rows[0]?.[0] ?? "";
  let parsed: {
    error?: boolean;
    error_type?: string;
    error_message?: string;
    position?: string;
    statements?: unknown[];
  };
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return { kind: "Guard", message: "the query could not be parsed" };
  }
  if (parsed.error) {
    if (parsed.error_type === "not implemented") {
      return { kind: "Guard", message: "only a SELECT query can be a data query" };
    }
    const pos = parsed.position !== undefined ? Number(parsed.position) : NaN;
    return {
      kind: capitalise(parsed.error_type ?? "parser"),
      message: parsed.error_message ?? "the query does not parse",
      ...(Number.isFinite(pos) ? positionOf(text, pos) : {}),
    };
  }
  if ((parsed.statements ?? []).length !== 1) {
    return { kind: "Guard", message: "a data query is exactly one SELECT statement" };
  }
  const reach = findForbiddenReach(parsed.statements);
  return reach ? { kind: "Guard", message: reach } : null;
}

/** The statement a preview runs: the user's query on its own line (so
 *  DuckDB's `LINE n` maps back by one), limited. */
export function previewSql(sql: string, limit: number): string {
  return `SELECT * FROM (\n${trimSql(sql)}\n) AS paged_preview LIMIT ${Math.max(0, Math.floor(limit))}`;
}

/** DuckDB error text → a diagnostic. `lineOffset` is how many lines the
 *  executed statement put in front of the user's query (1 for previewSql). */
export function diagnoseDuckDBError(err: unknown, lineOffset = 0): SqlDiagnostic {
  const text = err instanceof Error ? err.message : String(err);
  const head = /^(?:Error:\s*)?([A-Za-z]+) Error:\s*([\s\S]*)$/.exec(text.trim());
  const kind = head ? head[1] : "Error";
  const body = head ? head[2] : text;
  const lines = body.split("\n");
  const at = lines.findIndex((l) => /^LINE \d+:/.test(l));
  const message = (at >= 0 ? lines.slice(0, at) : lines).join("\n").trim();
  if (at < 0) return { kind, message };
  const m = /^LINE (\d+): /.exec(lines[at])!;
  const caret = lines[at + 1]?.indexOf("^") ?? -1;
  const line = Number(m[1]) - lineOffset;
  return {
    kind,
    message,
    ...(line >= 1 ? { line } : {}),
    ...(caret >= m[0].length ? { column: caret - m[0].length + 1 } : {}),
  };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
