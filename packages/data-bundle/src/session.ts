// The in-memory session: the bundle's state machine over the engine
// (`data-js`) + the query engine (DuckDB-WASM). It holds the binding recipe
// (sources / queries / binding defs), boots the engines lazily (honest about
// missing artifacts), runs the resolve → lower → mutate pipeline, and exposes a
// read-only snapshot the panels render. ZERO binding/expression semantics live
// here (CLAUDE.md hard rule) — it orchestrates the Rust engine.

import type {
  BundleHost,
  DataProviderHandle,
  DataProviderRegistration,
  ProviderSchema,
} from "@paged-media/plugin-api";

import { bootEngine, ENGINE_NOT_BUILT, type DataEngineLike } from "./engine";
import { bootDuckDB, DUCKDB_NOT_VENDORED, type DuckDBHandle } from "./query/duckdb";
import { commitLoweredImage, commitLoweredTable, commitLoweredVariable } from "./lower";
import {
  buildRemoteUrl,
  remoteOrigin,
  validateRemoteUrl,
  type RemoteFormat,
  type RemoteSourceState,
} from "./remote";

export type { RemoteFormat, RemoteSourceState } from "./remote";

/** A read-only snapshot for the panels. */
export interface SessionState {
  /** Honest status of the engines (the panel renders it, never fakes it). */
  status: "idle" | "ready" | "engine-missing" | "duckdb-missing" | "error";
  message: string;
  sources: string[];
  queries: string[];
  bindings: string[];
  /** Remote sources (M1, D-03) — each INERT until its origin is consented. */
  remote: RemoteSourceState[];
}

/** A column → field mapping for a table binding (panel-authored). */
export interface ColumnSpec {
  header: string;
  expr: string;
}

/** How a §10 batch run partitions a dataset into generation units: one document
 *  per record, per group, or one paginated catalog. */
export type BatchMode =
  | { mode: "perRecord"; key?: string }
  | { mode: "perGroup"; by: string[] }
  | { mode: "oneCatalog" };

/** A §10 batch plan: the deterministic sequence of generation units (which
 *  records feed which output document). The executor lowers each unit through
 *  the normal pipeline — nothing renders at plan time. */
export interface BatchPlan {
  mode: "perRecord" | "perGroup" | "oneCatalog";
  units: { label: string; recordIndices: number[] }[];
  totalRecords: number;
}

/** A frame's content-box capacity in a chain (the host frame-chain read is D-12;
 *  caller-supplied until then). The engine deserializes camelCase — `heightPt`,
 *  not `height_pt` (verified by the e2e harness). */
export interface FrameCapacity {
  frame: string;
  page: string;
  heightPt: number;
}

/** One executed §10 batch unit: a label + the paginated flow IR for that
 *  document (the same IR the live lower produces). */
export interface BatchRun {
  label: string;
  flow: unknown;
}

/** A governed dataset's column-metadata sidecar (§7): the JSON the bundle reads
 *  from a `GovernedExtract.metadata_sidecar` location and hands to the engine. */
export interface DatasetMetadata {
  dataset?: string;
  columns: {
    name: string;
    label?: string;
    description?: string;
    /** Arrow-aligned type label (`"text"`,`"float"`,`"int"`,…) — checked vs the live type. */
    dataType?: string;
    provenance?: string;
  }[];
}

/** The §7 governed catalog the engine builds — the live schema enriched with the
 *  sidecar (documented columns) plus governance-drift diagnostics. */
export interface GovernedCatalog {
  columns: {
    name: string;
    label: string;
    dataType: string;
    description?: string;
    provenance?: string;
    documented: boolean;
  }[];
  diagnostics: unknown[];
}

/** The §7.1 data-provider publication payload the engine produces — a schema +
 *  the stabilized rows + an opaque content revision (etag) — ready to register
 *  with the core data-provider registry once that contract lands (D-09). */
export interface DataProviderPublication {
  id: string;
  category: string;
  /** Content etag; changes iff the published rows change (permutation-invariant). */
  revision: string;
  /** The Arrow-seam schema: each field is `{ name, ty, nullable }` (the same
   *  shape the engine ingests — `ty`, not `type`; verified by the e2e harness). */
  schema: { fields: { name: string; ty: string; nullable: boolean }[] };
  rowCount: number;
  /** The stabilized RecordSet (Arrow-shaped) — the snapshot a consumer pulls. */
  records: unknown;
}

/** The session API the panels + commands drive. */
export interface DataSourceSession {
  getState(): SessionState;
  registerCsvSource(name: string, csvText: string): Promise<void>;
  /** Define a remote source (M1, §6.2/D-03): records the `{url, format,
   *  params}` descriptor only — NOTHING fetches and no engine boots. The
   *  source is INERT until its origin is consented AND the user loads it.
   *  `credentialRef` is a host-credential-store reference string (D-11);
   *  secret material is rejected (an embedded `user:pass@` URL fails).
   *  Returns an error message, or `null` on success. */
  addRemoteSource(
    name: string,
    url: string,
    format: RemoteFormat,
    options?: { params?: Record<string, string>; credentialRef?: string },
  ): string | null;
  /** Request per-origin consent for one remote source through the host
   *  (D-03). Returns true when its origin is granted afterwards. */
  requestConsentForRemote(name: string): Promise<boolean>;
  /** Load a remote source (edit-time fetch, M1): the consent gate runs FIRST
   *  — an unconsented origin returns inert without touching the network. On
   *  grant: fetch the bytes, hand them to the DuckDB query lane exactly like
   *  an imported file, define the source on the engine, and record the
   *  engine-computed content-hash invalidation key. */
  loadRemoteSource(name: string): Promise<void>;
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
   *  through the host before any reach. Returns the granted origins. LIVE at
   *  M1: the manifest declares `network:{origins:"consent"}` — every reach is
   *  runtime-consented, none pre-allowed. */
  requestNetworkConsent(origins: string[], purpose: string): Promise<string[]>;
  /** §7.1 data-provider: publish a query's resolved result as a named,
   *  discoverable dataset for OTHER consumers (the sheets plugin sourcing a
   *  sheet from a governed query) — declaring the provider, never knowing who
   *  consumes it. Returns the engine-side publication payload. REGISTRATION with
   *  the core registry is the D-09 gate (no `host.dataProviders` door yet); this
   *  returns the payload ready for that `register(...)` call and does NOT fake a
   *  registration (reserved seams stay honest). Requires the query's result to be
   *  ingested first (`refreshData`). */
  publishProvider(
    queryId: string,
    providerId: string,
    category: string,
  ): Promise<DataProviderPublication>;
  /** §7 governed catalog: enrich a query's resolved schema with a column-metadata
   *  sidecar (the bundle reads the sidecar JSON from the source's
   *  `metadata_sidecar` location) → documented columns + governance-drift
   *  diagnostics. Requires the query's result to be ingested first
   *  (`refreshData`). The byte-read of the governed table + sidecar from a
   *  file/URL/DB location is the broader `data.governed.extract` path (M2). */
  governedCatalog(queryId: string, metadata: DatasetMetadata): Promise<GovernedCatalog>;
  /** §9.1: set the formatting locale (`"en"` | `"de"`) for the display kernels
   *  (NUMBER/CURRENCY/PERCENT/DATEFMT). Applies immediately if the engine is up,
   *  else on its next boot. Re-lower bindings to see the change in the document. */
  setLocale(next: "en" | "de"): void;
  getLocale(): "en" | "de";
  /** §10 batch plan: partition a query's resolved result into generation units
   *  (per-record / per-group / one-catalog). Returns the plan; executing it
   *  (resolve → lower → paginate → export each unit) reuses the normal pipeline.
   *  Native server/CI execution is the napi-rs binding (M2); this is the in-app
   *  plan. Requires the query's result to be ingested first (`refreshData`). */
  planBatch(queryId: string, mode: BatchMode): Promise<BatchPlan>;
  /** §10 batch RUN: execute a plan over a record-flow binding — resolve, partition
   *  by `mode`, and paginate each unit. Returns one `BatchRun` per output
   *  document. `chain` is caller-supplied until the host frame-chain read (D-12).
   *  Native server/CI execution is the napi-rs binding (`data.automation.native`,
   *  M2); this is the in-app executor. */
  runRecordFlowBatch(
    bindingId: string,
    mode: BatchMode,
    chain: FrameCapacity[],
  ): Promise<BatchRun[]>;
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
  // D-09: live provider registrations, keyed by provider id, so a re-publish
  // bumps the existing registration's revision instead of double-registering.
  const providerHandles = new Map<string, DataProviderHandle>();
  // §9.1 localization — the session formatting locale (applied on engine boot,
  // and immediately if the engine is already up). Default en.
  let locale: "en" | "de" = "en";

  // M1 remote sources (D-03): descriptor-only until consented + loaded.
  const remoteSources = new Map<string, RemoteSourceState>();

  let engine: DataEngineLike | null = null;
  let duck: DuckDBHandle | null = null;
  const state: SessionState = {
    status: "idle",
    message: "No data sources yet — import a CSV to begin.",
    sources: sourceNames,
    queries: [],
    bindings: bindingIds,
    remote: [],
  };

  /** The host's currently-consented origins; [] when the door is unavailable
   *  (network undeclared) — which keeps every remote source inert. */
  function consentedOriginsSafe(): readonly string[] {
    try {
      return host.network.consentedOrigins();
    } catch {
      return [];
    }
  }

  /** Recompute each remote source's consent posture from the live grant. */
  function remoteSnapshot(): RemoteSourceState[] {
    const consented = consentedOriginsSafe();
    return Array.from(remoteSources.values(), (r) => ({
      ...r,
      consent: consented.includes(r.origin) ? ("granted" as const) : ("required" as const),
    }));
  }

  async function ensureEngine(): Promise<DataEngineLike> {
    if (engine) return engine;
    try {
      engine = await bootEngine(today);
      engine.set_locale(locale); // apply the chosen locale to the fresh engine
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
        remote: remoteSnapshot(),
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

    addRemoteSource(name, url, format, options) {
      // Descriptor-only (INERT): no fetch, no engine boot — a document/panel
      // defining a remote source touches nothing (§11: no silent fetch).
      const invalid = validateRemoteUrl(url);
      if (invalid) {
        host.log.warn(`addRemoteSource(${name}): ${invalid}`);
        return invalid;
      }
      const origin = remoteOrigin(url);
      if (!origin) return `not a valid URL: ${url}`;
      remoteSources.set(name, {
        name,
        url,
        origin,
        format,
        params: { ...(options?.params ?? {}) },
        credentialRef: options?.credentialRef,
        consent: "required",
        status: "inert",
        message: "Inert — origin consent required before any fetch (D-03).",
        contentKey: null,
      });
      return null;
    },

    async requestConsentForRemote(name) {
      const r = remoteSources.get(name);
      if (!r) return false;
      const granted = await this.requestNetworkConsent(
        [r.origin],
        `Fetch the remote data source "${name}" (${r.format}) from ${r.origin}.`,
      );
      return granted.includes(r.origin);
    },

    async loadRemoteSource(name) {
      const r = remoteSources.get(name);
      if (!r) return;
      // THE GATE COMES FIRST: an unconsented origin never reaches the network
      // (no fetch, no engine boot) — the source stays inert (§11/D-03).
      if (!consentedOriginsSafe().includes(r.origin)) {
        r.consent = "required";
        r.status = "inert";
        r.message = `Origin ${r.origin} not consented — request consent first (no fetch performed).`;
        state.message = r.message;
        return;
      }
      r.consent = "granted";
      try {
        // Edit-time fetch (the ONLY fetch in the bundle): the editor's CSP
        // connect-src derived from the grant backstops this gate.
        const response = await fetch(buildRemoteUrl(r.url, r.params));
        if (!response.ok) {
          throw new Error(`fetch failed: HTTP ${response.status}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());

        // Hand the bytes to the query lane exactly like an imported file.
        const d = await ensureDuck();
        if (r.format === "csv" || r.format === "tsv") {
          await d.registerCsv(name, new TextDecoder().decode(bytes));
        } else {
          await d.registerFileBuffer(`${name}.${r.format}`, bytes);
        }

        // Define the descriptor on the engine + record the content-hash
        // invalidation key (computed in Rust; the engine never fetches).
        const e = await ensureEngine();
        e.define_source({
          id: name,
          kind: {
            kind: "remote",
            url: r.url,
            format: r.format,
            params: r.params,
            credential_ref: r.credentialRef ?? null,
          },
          capability: "network",
        });
        r.contentKey =
          typeof e.remote_invalidation_key === "function"
            ? e.remote_invalidation_key(name, bytes)
            : null;

        if (!sourceNames.includes(name)) sourceNames.push(name);
        r.status = "loaded";
        r.message =
          r.contentKey === null
            ? "Loaded (engine wasm predates the invalidation key — rebuild scripts/build-wasm.sh)."
            : `Loaded — content key ${r.contentKey}.`;
        state.status = "ready";
        state.message = `Remote source "${name}" loaded.`;
      } catch (err) {
        r.status = "error";
        r.message = err instanceof Error ? err.message : String(err);
        host.log.warn(`loadRemoteSource(${name}): ${r.message}`);
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
        } else if (lowered?.kind === "image") {
          await commitLoweredImage(host, lowered as never);
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
      // D-03: the consent gate a remote/governed source crosses before the
      // fetch lane reaches an origin. No silent fetch — the host renders the
      // data-source manifest + records per-origin consent. M1: the manifest
      // declares `network:{origins:"consent"}` (every reach runtime-consented,
      // none pre-allowed); the editor derives CSP connect-src from the grant.
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

    async publishProvider(queryId, providerId, category) {
      // §7.1/D-09: the engine produces the publication (schema + stabilized rows
      // + revision etag); we register it with the core data-provider registry so
      // OTHER consumers (the sheets plugin) can discover + read it — never
      // knowing paged.data backs it. The snapshot getter re-resolves lazily, in
      // OUR realm, so a consumer pull cannot induce a fetch we are not consented
      // to (§7.1 security shape; composes with D-03).
      const e = await ensureEngine();
      const pub = e.publish_provider(queryId, providerId, category) as DataProviderPublication;

      const registry = host.dataProviders;
      const wired = Boolean(registry) && host.supports("dataProviders@1");
      if (registry && wired) {
        const existing = providerHandles.get(providerId);
        if (existing) {
          existing.update(pub.revision); // a re-publish only bumps the revision
        } else {
          const registration: DataProviderRegistration = {
            id: pub.id,
            category: pub.category,
            schema: pub.schema as ProviderSchema,
            revision: pub.revision,
            getSnapshot: () => {
              // Re-resolve the current snapshot on demand. The engine RecordSet
              // is snake-cased (`row_count`); map it to the contract's camelCase
              // `rowCount` at the boundary.
              const fresh = e.publish_provider(queryId, providerId, category) as DataProviderPublication;
              const rec = fresh.records as {
                schema: ProviderSchema;
                columns: unknown[][];
                row_count: number;
              };
              return { schema: rec.schema, columns: rec.columns, rowCount: rec.row_count };
            },
          };
          providerHandles.set(providerId, registry.register(registration));
        }
      } else {
        host.log.info(
          `data provider "${pub.id}" (category "${pub.category}", rev ${pub.revision}) ` +
            "ready, but no shared host.dataProviders registry is wired yet (D-09: the door " +
            "exists; the editor injects createDataProviderRegistry). Registration deferred " +
            "until then — never faked.",
        );
      }
      return pub;
    },

    async governedCatalog(queryId, metadata) {
      // §7: the engine enriches the query's resolved schema with the sidecar.
      // The sidecar JSON is data (read by the bundle from metadata_sidecar) — no
      // third-party engine is linked (§3 license boundary).
      const e = await ensureEngine();
      return e.governed_catalog(queryId, metadata) as GovernedCatalog;
    },

    setLocale(next) {
      locale = next;
      if (engine) engine.set_locale(next);
    },

    getLocale() {
      return locale;
    },

    async planBatch(queryId, mode) {
      // §10: the engine partitions the query's resolved result into generation
      // units. Executing the plan reuses the normal resolve/lower/paginate path.
      const e = await ensureEngine();
      return e.plan_batch(queryId, mode) as BatchPlan;
    },

    async runRecordFlowBatch(bindingId, mode, chain) {
      // §10: resolve the flow, partition by mode, paginate each unit — the same
      // data-lower path the live document uses, so headless == interactive.
      const e = await ensureEngine();
      return e.run_record_flow_batch(bindingId, mode, chain, undefined) as BatchRun[];
    },

    dispose() {
      for (const h of providerHandles.values()) h.dispose();
      providerHandles.clear();
      void duck?.close();
      engine?.free();
      engine = null;
      duck = null;
    },
  };
}
