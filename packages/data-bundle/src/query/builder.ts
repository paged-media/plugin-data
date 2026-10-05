// The query panel's builders (wave 6): filter, sort and group choices turned
// into one SELECT over a source table. The output is ordinary SQL the user
// can read and edit further in the SQL field; it passes the same guard
// (query/sql.ts) as hand-written SQL. Identifiers are always quoted and values
// always literals, so a column or value can never become SQL.

import { quoteIdent, quoteLiteral } from "./import";

export type FilterOp =
  | "="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "contains"
  | "starts with"
  | "is empty"
  | "is not empty";

export const FILTER_OPS: readonly FilterOp[] = [
  "=",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "contains",
  "starts with",
  "is empty",
  "is not empty",
];

export type AggregateFn = "count" | "sum" | "avg" | "min" | "max";
export const AGGREGATE_FNS: readonly AggregateFn[] = ["count", "sum", "avg", "min", "max"];

export interface QueryFilter {
  column: string;
  op: FilterOp;
  /** Ignored by `is empty` / `is not empty`. A value that reads as a number
   *  is compared as a number, anything else as text. */
  value?: string;
}

export interface QuerySort {
  column: string;
  dir: "asc" | "desc";
}

export interface QueryAggregate {
  fn: AggregateFn;
  /** Absent for `count` = `count(*)`. */
  column?: string;
}

export interface QuerySpec {
  source: string;
  /** Columns to select (ungrouped). Empty = every column. */
  columns?: string[];
  filters?: QueryFilter[];
  sort?: QuerySort[];
  /** Group by these columns; the result is the groups plus `aggregates`
   *  (a row count when none is given). */
  groupBy?: string[];
  aggregates?: QueryAggregate[];
  limit?: number;
}

const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** A filter value as a SQL literal: a number when it reads as one. */
export function valueLiteral(value: string): string {
  const v = value.trim();
  return NUMBER.test(v) ? v : quoteLiteral(value);
}

function condition(f: QueryFilter): string {
  const col = quoteIdent(f.column);
  const text = `CAST(${col} AS VARCHAR)`;
  const v = f.value ?? "";
  switch (f.op) {
    case "is empty":
      return `(${col} IS NULL OR ${text} = '')`;
    case "is not empty":
      return `(${col} IS NOT NULL AND ${text} <> '')`;
    case "contains":
      return `contains(lower(${text}), lower(${quoteLiteral(v)}))`;
    case "starts with":
      return `starts_with(${text}, ${quoteLiteral(v)})`;
    default:
      return `${col} ${f.op} ${valueLiteral(v)}`;
  }
}

/** The alias of an aggregate column (`count`, `sum_price`, …). */
export function aggregateAlias(a: QueryAggregate): string {
  return a.column ? `${a.fn}_${a.column}` : a.fn;
}

function aggregate(a: QueryAggregate): string {
  // sum/avg/min/max need a column; without one the aggregate is a row count.
  const fn: AggregateFn = a.column || a.fn === "count" ? a.fn : "count";
  const arg = a.column ? quoteIdent(a.column) : "*";
  return `${fn}(${arg}) AS ${quoteIdent(aggregateAlias({ fn, column: a.column }))}`;
}

/** Build the SELECT for a spec. */
export function buildSql(spec: QuerySpec): string {
  const groupBy = spec.groupBy ?? [];
  const grouped = groupBy.length > 0;
  let select: string;
  if (grouped) {
    const aggs = spec.aggregates?.length ? spec.aggregates : [{ fn: "count" as const }];
    select = [...groupBy.map(quoteIdent), ...aggs.map(aggregate)].join(", ");
  } else {
    select = spec.columns?.length ? spec.columns.map(quoteIdent).join(", ") : "*";
  }
  const parts = [`SELECT ${select}`, `FROM ${quoteIdent(spec.source)}`];
  const filters = (spec.filters ?? []).filter((f) => f.column !== "");
  if (filters.length) parts.push(`WHERE ${filters.map(condition).join(" AND ")}`);
  if (grouped) parts.push(`GROUP BY ${groupBy.map(quoteIdent).join(", ")}`);
  const sort = (spec.sort ?? []).filter((s) => s.column !== "");
  if (sort.length) {
    parts.push(
      `ORDER BY ${sort.map((s) => `${quoteIdent(s.column)} ${s.dir === "desc" ? "DESC" : "ASC"}`).join(", ")}`,
    );
  }
  if (spec.limit !== undefined && spec.limit >= 0) parts.push(`LIMIT ${Math.floor(spec.limit)}`);
  return parts.join("\n");
}
