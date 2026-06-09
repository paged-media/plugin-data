// The in-memory session: the bundle's state machine over the engine
// (`data-js`) + the query engine (DuckDB-WASM). It holds the binding recipe
// (sources / queries / binding defs), boots the engines lazily (honest about
// missing artifacts), runs the resolve → lower → mutate pipeline, and exposes a
// read-only snapshot the panels render. ZERO binding/expression semantics live
// here (CLAUDE.md hard rule) — it orchestrates the Rust engine.

import type { BundleHost } from "@paged-media/plugin-api";

import { bootEngine, ENGINE_NOT_BUILT, type DataEngineLike } from "./engine";
import { bootDuckDB, DUCKDB_NOT_VENDORED, type DuckDBHandle } from "./query/duckdb";
import { commitLoweredTable, commitLoweredVariable } from "./lower";

/** A read-only snapshot for the panels. */
export interface SessionState {
  /** Honest status of the engines (the panel renders it, never fakes it). */
  status: "idle" | "ready" | "engine-missing" | "duckdb-missing" | "error";
  message: string;
  sources: string[];
  queries: string[];
  bindings: string[];
}

/** A column → field mapping for a table binding (panel-authored). */
export interface ColumnSpec {
  header: string;
  expr: string;
}

/** The session API the panels + commands drive. */
export interface DataSourceSession {
  getState(): SessionState;
  registerCsvSource(name: string, csvText: string): Promise<void>;
  addQuery(id: string, sql: string, shape: "recordStream" | "singleRecord" | "scalar"): void;
  addVariableBinding(id: string, target: string, query: string, expr: string): void;
  addTableBinding(id: string, region: string, query: string, columns: ColumnSpec[]): void;
  /** Re-run every query through DuckDB and ingest the results (no document
   *  writes) — updates sync states. */
  refreshData(): Promise<void>;
  /** Resolve a binding and commit its lowered content to the document. */
  lowerBinding(id: string): Promise<void>;
  /** Refresh, then resolve + commit every binding. */
  lowerAll(): Promise<void>;
  /** The §11 consent gate for remote/governed sources (D-03): review the
   *  data-source manifest (origins + purpose) and obtain per-origin consent
   *  through the host before any reach. Returns the granted origins. Dormant at
   *  M0 (the manifest declares `network:false`, so the host refuses) — flips on
   *  when remote sources + `network:{origins}` land (M1; a wiring change). */
  requestNetworkConsent(origins: string[], purpose: string): Promise<string[]>;
  dispose(): void;
}

interface QueryDef {
  id: string;
  sql: string;
}

/** Create a session bound to a host. Construction is synchronous + side-effect
 *  free (the engines boot lazily on first use) so `activate` stays light. */
export function createSession(host: BundleHost, today: number): DataSourceSession {
  const sourceNames: string[] = [];
  const queries = new Map<string, QueryDef>();
  const bindingIds: string[] = [];

  let engine: DataEngineLike | null = null;
  let duck: DuckDBHandle | null = null;
  const state: SessionState = {
    status: "idle",
    message: "No data sources yet — import a CSV to begin.",
    sources: sourceNames,
    queries: [],
    bindings: bindingIds,
  };

  async function ensureEngine(): Promise<DataEngineLike> {
    if (engine) return engine;
    try {
      engine = await bootEngine(today);
      return engine;
    } catch (err) {
      state.status = "engine-missing";
      state.message = err instanceof Error ? err.message : ENGINE_NOT_BUILT;
      throw err;
    }
  }

  async function ensureDuck(): Promise<DuckDBHandle> {
    if (duck) return duck;
    try {
      duck = await bootDuckDB();
      return duck;
    } catch (err) {
      state.status = "duckdb-missing";
      state.message = err instanceof Error ? err.message : DUCKDB_NOT_VENDORED;
      throw err;
    }
  }

  function sync(): void {
    state.queries = Array.from(queries.keys());
  }

  return {
    getState() {
      return {
        ...state,
        sources: [...sourceNames],
        queries: Array.from(queries.keys()),
        bindings: [...bindingIds],
      };
    },

    async registerCsvSource(name, csvText) {
      try {
        const d = await ensureDuck();
        await d.registerCsv(name, csvText);
        const e = await ensureEngine();
        // NOTE: SourceKind is internally tagged — the `kind` object nests its
        // own `kind` discriminant (proven by test-integration/pipeline.e2e.mjs;
        // a flattened shape fails serde-wasm-bindgen decoding).
        e.define_source({
          id: name,
          kind: { kind: "inlineSeed", table: name },
          capability: "inline",
        });
        if (!sourceNames.includes(name)) sourceNames.push(name);
        state.status = "ready";
        state.message = `Source "${name}" registered.`;
      } catch (err) {
        host.log.warn(`registerCsvSource: ${String(err)}`);
      }
    },

    addQuery(id, sql, shape) {
      queries.set(id, { id, sql });
      void engine?.define_query({ id, sql, params: [], shape: { shape } });
      sync();
    },

    addVariableBinding(id, target, query, expr) {
      void engine?.define_binding({
        id,
        kind: "variable",
        target,
        query,
        expr,
        missing: { missing: "blank" },
      });
      if (!bindingIds.includes(id)) bindingIds.push(id);
    },

    addTableBinding(id, region, query, columns) {
      void engine?.define_binding({
        id,
        kind: "table",
        region,
        query,
        columns: columns.map((c) => ({ header: c.header, expr: c.expr, style: null })),
        options: { header_row: true, group_by: [] },
      });
      if (!bindingIds.includes(id)) bindingIds.push(id);
    },

    async refreshData() {
      try {
        const e = await ensureEngine();
        const d = await ensureDuck();
        for (const q of queries.values()) {
          const records = await d.query(q.sql);
          e.ingest_result(q.id, records);
        }
        state.status = "ready";
        state.message = "Data refreshed from sources.";
      } catch (err) {
        state.status = state.status === "idle" ? "error" : state.status;
        state.message = err instanceof Error ? err.message : String(err);
        host.log.warn(`refreshData: ${state.message}`);
      }
    },

    async lowerBinding(id) {
      try {
        const e = await ensureEngine();
        const lowered = e.resolve_lowered(id) as { kind?: string } | null;
        if (lowered?.kind === "table") {
          await commitLoweredTable(host, lowered as never);
        } else if (lowered?.kind === "variable") {
          await commitLoweredVariable(host, lowered as never);
        }
        state.status = "ready";
        state.message = `Resolved + lowered "${id}".`;
      } catch (err) {
        state.status = "error";
        state.message = err instanceof Error ? err.message : String(err);
        host.log.warn(`lowerBinding(${id}): ${state.message}`);
      }
    },

    async lowerAll() {
      await this.refreshData();
      for (const id of [...bindingIds]) {
        await this.lowerBinding(id);
      }
    },

    async requestNetworkConsent(origins, purpose) {
      // D-03: the consent gate a remote/governed source crosses before DuckDB
      // httpfs reaches an origin. No silent fetch — the host renders the
      // data-source manifest + records per-origin consent. At M0 the manifest
      // declares `network:false`, so the host's capability gate refuses (the
      // honest dormant wiring); when remote sources ship, the manifest flips to
      // `network:{origins}` and this grants.
      if (!host.supports("network.consent@1")) {
        host.log.info(
          "network consent: no host consent backend wired yet (editor follow-up: " +
            "the consent UI + a CSP connect-src derived from the grant)",
        );
      }
      try {
        const result = await host.network.requestConsent(origins, purpose);
        if (result.denied.length > 0) {
          state.message = `Network consent: ${result.granted.length} granted, ${result.denied.length} denied.`;
        }
        return [...host.network.consentedOrigins()];
      } catch (err) {
        // The capability gate refuses when `network` is undeclared (M0).
        host.log.warn(`network consent unavailable: ${String(err)}`);
        return [];
      }
    },

    dispose() {
      void duck?.close();
      engine?.free();
      engine = null;
      duck = null;
    },
  };
}
