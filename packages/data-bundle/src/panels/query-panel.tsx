// The Data query panel (wave 6) — a SQL field with DuckDB's diagnostics, the
// filter / sort / group builders that write SQL into it, and a preview grid of
// the first rows. A query is saved under an id (an engine query, saved with
// the document like every definition); bindings read it by that id.
//
// Every query the panel runs or saves passes the session's guard first (one
// SELECT over imported source tables — query/sql.ts). The preview shows the
// values as DuckDB prints them; it ingests nothing and changes no binding.
//
// Built from host surfaces + React only; token-layer styling.

import { useState, type CSSProperties, type ReactElement } from "react";
import type { BundleHost } from "@paged-media/plugin-api";

import {
  AGGREGATE_FNS,
  FILTER_OPS,
  buildSql,
  type AggregateFn,
  type FilterOp,
  type QueryAggregate,
  type QueryFilter,
  type QuerySort,
} from "../query/builder";
import type { DataSourceSession, QueryPreview, SqlDiagnostic } from "../session";
import { DiagnosticsList } from "./diagnostics";
import { useSessionSnapshot } from "./use-session";

const wrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3, 12px)",
  padding: "var(--space-3, 12px)",
  fontSize: "12px",
  color: "var(--pg-fg, #ddd)",
};
const row: CSSProperties = { display: "flex", gap: "var(--space-2, 8px)", alignItems: "center", flexWrap: "wrap" };
const note: CSSProperties = { color: "var(--pg-muted-fg, #999)", fontSize: "11px", lineHeight: 1.5 };
const mono: CSSProperties = { font: "var(--font-mono, 12px ui-monospace, monospace)" };
const errorStyle: CSSProperties = {
  ...mono,
  color: "var(--status-error-fg, #f88)",
  whiteSpace: "pre-wrap",
};
const cell: CSSProperties = {
  ...mono,
  padding: "2px 6px",
  borderBottom: "1px solid var(--pg-border, #333)",
  textAlign: "left",
  whiteSpace: "nowrap",
};

/** How many rows the preview shows. */
export const PREVIEW_ROWS = 50;

/** "Binder (line 2, column 3): message". */
export function describeDiagnostic(d: SqlDiagnostic): string {
  const at =
    d.line !== undefined
      ? ` (line ${d.line}${d.column !== undefined ? `, column ${d.column}` : ""})`
      : "";
  return `${d.kind}${at}: ${d.message}`;
}

export function makeQueryPanel(_host: BundleHost, session: DataSourceSession): () => ReactElement {
  return function QueryPanel(): ReactElement {
    const [snapshot, refresh] = useSessionSnapshot(session);
    const [queryId, setQueryId] = useState("q");
    const [sql, setSql] = useState("");
    const [source, setSource] = useState("");
    const [columns, setColumns] = useState<{ name: string; type: string }[]>([]);
    const [filters, setFilters] = useState<QueryFilter[]>([]);
    const [sort, setSort] = useState<QuerySort[]>([]);
    const [groupBy, setGroupBy] = useState<string[]>([]);
    const [aggregates, setAggregates] = useState<QueryAggregate[]>([]);
    const [preview, setPreview] = useState<QueryPreview | null>(null);
    const [diagnostic, setDiagnostic] = useState<SqlDiagnostic | null>(null);
    const [saved, setSaved] = useState<string | null>(null);

    const chosen = source || snapshot.sources[0] || "";
    const names = columns.map((c) => c.name);
    const first = names[0] ?? "";

    async function onPickSource(name: string): Promise<void> {
      setSource(name);
      setFilters([]);
      setSort([]);
      setGroupBy([]);
      setAggregates([]);
      setColumns(await session.describeSource(name));
      refresh();
    }

    function onBuild(): void {
      if (!chosen) return;
      setSql(buildSql({ source: chosen, filters, sort, groupBy, aggregates }));
      setSaved(null);
    }

    async function onPreview(): Promise<void> {
      const p = await session.previewQuery(sql, PREVIEW_ROWS);
      setPreview(p);
      setDiagnostic(p.diagnostic);
      refresh();
    }

    async function onSave(): Promise<void> {
      const id = queryId.trim();
      if (!id) {
        setDiagnostic({ kind: "Guard", message: "name the query first" });
        return;
      }
      const d = await session.saveQuery(id, sql);
      setDiagnostic(d);
      setSaved(d === null ? id : null);
      refresh();
    }

    function onLoad(id: string): void {
      const q = session.listQueries().find((x) => x.id === id);
      if (!q) return;
      setQueryId(q.id);
      setSql(q.sql);
      setSaved(null);
      setDiagnostic(null);
    }

    const setAt = <T,>(list: T[], i: number, patch: Partial<T>): T[] =>
      list.map((x, j) => (j === i ? { ...x, ...patch } : x));

    return (
      <div style={wrap}>
        <div style={row}>
          <label>
            Source{" "}
            <select
              data-data-query-source
              value={chosen}
              onChange={(e) => void onPickSource(e.target.value)}
            >
              {snapshot.sources.length === 0 ? <option value="">no sources</option> : null}
              {snapshot.sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <button type="button" data-data-query-columns onClick={() => void onPickSource(chosen)}>
            Read columns
          </button>
          {columns.length > 0 ? (
            <span style={note}>
              {columns.length} column(s): {columns.map((c) => `${c.name} ${c.type}`).join(", ")}
            </span>
          ) : null}
        </div>

        {/* ── builders: they write SQL into the field below ─────────────── */}
        <fieldset data-data-query-builders style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <legend>Filter, sort, group</legend>
          {filters.map((f, i) => (
            <div key={`f${i}`} style={row} data-data-query-filter={i}>
              <select value={f.column} onChange={(e) => setFilters(setAt(filters, i, { column: e.target.value }))}>
                {names.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <select value={f.op} onChange={(e) => setFilters(setAt(filters, i, { op: e.target.value as FilterOp }))}>
                {FILTER_OPS.map((op) => (
                  <option key={op} value={op}>{op}</option>
                ))}
              </select>
              {f.op === "is empty" || f.op === "is not empty" ? null : (
                <input
                  value={f.value ?? ""}
                  placeholder="value"
                  onChange={(e) => setFilters(setAt(filters, i, { value: e.target.value }))}
                />
              )}
              <button type="button" onClick={() => setFilters(filters.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          {sort.map((s, i) => (
            <div key={`s${i}`} style={row} data-data-query-sort={i}>
              Sort by
              <select value={s.column} onChange={(e) => setSort(setAt(sort, i, { column: e.target.value }))}>
                {names.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <select value={s.dir} onChange={(e) => setSort(setAt(sort, i, { dir: e.target.value as "asc" | "desc" }))}>
                <option value="asc">ascending</option>
                <option value="desc">descending</option>
              </select>
              <button type="button" onClick={() => setSort(sort.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          {groupBy.length > 0 ? (
            <div style={row} data-data-query-group>
              Group by <span style={mono}>{groupBy.join(", ")}</span>
              {aggregates.map((a, i) => (
                <span key={`a${i}`} style={row}>
                  <select value={a.fn} onChange={(e) => setAggregates(setAt(aggregates, i, { fn: e.target.value as AggregateFn }))}>
                    {AGGREGATE_FNS.map((fn) => (
                      <option key={fn} value={fn}>{fn}</option>
                    ))}
                  </select>
                  <select
                    value={a.column ?? ""}
                    onChange={(e) => setAggregates(setAt(aggregates, i, { column: e.target.value || undefined }))}
                  >
                    <option value="">(rows)</option>
                    {names.map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </span>
              ))}
              <button type="button" onClick={() => setAggregates([...aggregates, { fn: "sum", column: first }])}>
                Add total
              </button>
              <button type="button" onClick={() => { setGroupBy([]); setAggregates([]); }}>
                Ungroup
              </button>
            </div>
          ) : null}
          <div style={row}>
            <button type="button" data-data-query-add-filter disabled={!first} onClick={() => setFilters([...filters, { column: first, op: "=", value: "" }])}>
              Add filter
            </button>
            <button type="button" data-data-query-add-sort disabled={!first} onClick={() => setSort([...sort, { column: first, dir: "asc" }])}>
              Add sort
            </button>
            <select
              data-data-query-group-by
              value=""
              disabled={!first}
              onChange={(e) => e.target.value && !groupBy.includes(e.target.value) && setGroupBy([...groupBy, e.target.value])}
            >
              <option value="">Group by…</option>
              {names.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <button type="button" data-data-query-build disabled={!chosen} onClick={onBuild}>
              Write SQL
            </button>
          </div>
          {!first ? <span style={note}>Read the source&apos;s columns to build a query.</span> : null}
        </fieldset>

        {/* ── the SQL field ──────────────────────────────────────────────── */}
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          SQL
          <textarea
            data-data-query-sql
            rows={6}
            spellCheck={false}
            style={{ ...mono, width: "100%", boxSizing: "border-box" }}
            value={sql}
            placeholder={chosen ? `SELECT * FROM ${chosen}` : "SELECT * FROM <source>"}
            onChange={(e) => {
              setSql(e.target.value);
              setSaved(null);
            }}
          />
        </label>
        <div style={row}>
          <button type="button" data-data-query-preview disabled={!sql.trim()} onClick={() => void onPreview()}>
            Preview
          </button>
          <label>
            Query id{" "}
            <input data-data-query-id style={mono} size={10} value={queryId} onChange={(e) => setQueryId(e.target.value)} />
          </label>
          <button type="button" data-data-query-save disabled={!sql.trim()} onClick={() => void onSave()}>
            Save query
          </button>
          {saved ? <span style={note} data-data-query-saved>Saved as {saved}.</span> : null}
        </div>
        {diagnostic ? (
          <div role="alert" data-data-query-diagnostic={diagnostic.kind} style={errorStyle}>
            {describeDiagnostic(diagnostic)}
          </div>
        ) : null}

        {/* ── preview grid ───────────────────────────────────────────────── */}
        {preview && !preview.diagnostic ? (
          <div data-data-query-grid style={{ overflow: "auto", maxHeight: 280 }}>
            <span style={note}>
              {preview.rows.length} of {preview.total ?? "?"} row(s)
            </span>
            <table style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {preview.columns.map((c) => (
                    <th key={c.name} style={cell} title={c.type}>
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j} style={{ ...cell, ...(v === null ? note : {}) }}>
                        {v === null ? "NULL" : v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {/* ── saved queries ──────────────────────────────────────────────── */}
        <div>
          <strong>Queries</strong>
          {snapshot.queries.length === 0 ? (
            <p style={note}>No saved queries. Bindings read a query by its id.</p>
          ) : (
            <ul>
              {snapshot.queries.map((id) => (
                <li key={id}>
                  <button type="button" data-data-query-load={id} onClick={() => onLoad(id)} style={mono}>
                    {id}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DiagnosticsList
          diagnostics={snapshot.diagnostics}
          sources={["query"]}
          onClear={() => {
            session.clearDiagnostics();
            refresh();
          }}
        />
      </div>
    );
  };
}
