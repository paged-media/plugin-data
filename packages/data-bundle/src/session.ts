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
  ElementId,
  ProviderSchema,
} from "@paged-media/plugin-api";

import {
  FIELD_PLUGIN,
  setFieldValueMutation,
  type IdmlFit,
  type LoweredBarcode,
  type PlaceholderField,
  type RuleResult,
  type RuleTarget,
} from "@paged-media/data-host-model";

import { bootEngine, ENGINE_NOT_BUILT, type DataEngineLike } from "./engine";
import { bootDuckDB, DUCKDB_NOT_VENDORED, type DuckDBHandle } from "./query/duckdb";
import {
  commitLoweredBarcode,
  commitLoweredImage,
  commitLoweredTable,
  commitLoweredVariable,
  commitRule,
} from "./lower";
import {
  buildRemoteUrl,
  remoteOrigin,
  validateRemoteUrl,
  type RemoteFormat,
  type RemoteSourceState,
} from "./remote";

export type { RemoteFormat, RemoteSourceState } from "./remote";

/** One frame in a live chain, the shape the engine paginates over
 *  (`FrameCapacity`): `frame`/`page` ids + the content-box `heightPt`. The
 *  engine deserializes camelCase (`heightPt`, verified by the e2e harness). */
interface LiveFrameCapacity {
  frame: string;
  page: string;
  heightPt: number;
}

/** Read the LIVE host frame chain for a story (D-12): the ordered frame thread
 *  (`host.document.frameChain`) + each frame's content-box height
 *  (`elementGeometry` bounds → bottom−top). Replaces the caller-supplied chain
 *  the paginator was built ahead of (like sheet S-05's `lowerPaginatedToChain`).
 *  Returns `[]` when the story has no frame (the engine reports overflow). */
async function readLiveChain(host: BundleHost, storyId: string): Promise<LiveFrameCapacity[]> {
  let links: readonly { frameId: string; next: string | null; overflow: boolean }[] = [];
  try {
    links = await host.document.frameChain(storyId);
  } catch {
    return [];
  }
  if (links.length === 0) return [];
  const ids = links.map((l) => ({ kind: "textFrame", id: l.frameId }) as ElementId);
  let geom: { id: ElementId; pageId: string; bounds: [number, number, number, number] }[] = [];
  try {
    geom = (await host.document.elementGeometry(ids)) as never;
  } catch {
    geom = [];
  }
  const byId = new Map(geom.map((g) => [(g.id as { id: string }).id, g]));
  return links.map((l) => {
    const g = byId.get(l.frameId);
    const [top, , bottom] = g?.bounds ?? [0, 0, 0, 0];
    return {
      frame: l.frameId,
      page: g?.pageId ?? "",
      heightPt: Math.max(0, bottom - top),
    };
  });
}

/** Map an explicit IDML FittingOnEmptyFrame choice back to the engine's coarse
 *  `ImgFit` (fit/fill/crop) for the binding `policy`. The engine ImgFit is only
 *  a default hint; the explicit IDML `fit` overrides at commit time. */
function engineFit(fit?: IdmlFit): "fit" | "fill" | "crop" {
  switch (fit) {
    case "FillProportionally":
      return "fill";
    case "FitContentToFrame":
    case "ContentAwareFit":
      return "crop";
    case "Proportionally":
    case "":
    case undefined:
      return "fit";
  }
}

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

/** §9 field-mapping wizard: one source column's suggested variable-binding
 *  mapping, computed by the engine (`ColumnMapping` — the data semantics stay in
 *  Rust). The wizard renders these and, on confirm, generates a variable binding
 *  from `expr`. */
export interface ColumnMapping {
  /** The source column name (verbatim). */
  column: string;
  /** A humanised header label suggestion (`unit_price` → `Unit Price`). */
  header: string;
  /** The bound expression = a bare field reference, or "" when not mappable. */
  expr: string;
  /** The column's logical type (`"text"`,`"float"`,…) — a kind hint. */
  fieldType: string;
  /** Whether the column is one-click mappable (its name is a bare DSL field
   *  identifier); false → the DSL cannot reference it bare, a manual expression
   *  is needed (the wizard never invents a quoting syntax the grammar lacks). */
  mappable: boolean;
}

/** The barcode symbologies a barcode binding can render (§9.7) — mirrors the
 *  Rust `BarcodeSymbology` wire enum. */
export type BarcodeSymbology = "ean13" | "upca" | "code128" | "qr";

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

/** §8 change report: one binding's entry — how its resolved content changed
 *  across a refresh (`kind` is changed/unchanged/added/removed; `before`/`after`
 *  are opaque resolved-content fingerprints, present on the side it resolved). */
export interface BindingChange {
  binding: string;
  kind: "changed" | "unchanged" | "added" | "removed";
  before?: string;
  after?: string;
}

/** §8 change report ("what changed since last sync"): the per-binding entries +
 *  rolled-up counts the panel headlines. */
export interface ChangeReport {
  entries: BindingChange[];
  changed: number;
  unchanged: number;
  added: number;
  removed: number;
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
  /** D-14: define an image binding bound to a RECTANGLE (`elementId`). `expr`
   *  yields the image reference per record (the engine classifies uri/path/
   *  assetId/bytes + applies the missing policy); `fit` is the IDML
   *  FittingOnEmptyFrame value (the engine's `ImgFit` maps to a default when
   *  omitted). `missing` governs an absent reference (skip/flag/fallback). */
  addImageBinding(
    id: string,
    target: string,
    query: string,
    expr: string,
    options?: { fit?: IdmlFit; missing?: "skip" | "flag" | "fallback" },
  ): void;
  /** §9.7: define a barcode binding bound to a frame (`target`, the rectangle the
   *  symbol fills). `symbology` is the symbology to render; `expr` resolves to the
   *  value to encode (an EAN/UPC number, or arbitrary text for Code-128/QR). The
   *  engine encodes (clean-room, in Rust) + scales the module grid to the frame's
   *  content box; lowering emits native `insertPath` filled-rect VECTOR modules.
   *  `quietZone` widens the symbology default margin; `missing` governs an empty
   *  value (skip/flag). */
  addBarcodeBinding(
    id: string,
    target: string,
    query: string,
    symbology: BarcodeSymbology,
    expr: string,
    options?: { quietZone?: number; missing?: "skip" | "flag" },
  ): void;
  /** D-13: define a data-driven formatting rule (`when → apply` a document
   *  style) over a scope, bound to a host TARGET (story range / table column).
   *  `query` names the records the `when` condition evaluates against. */
  addRuleBinding(
    id: string,
    scope: string,
    query: string,
    when: string,
    apply: { action: "characterStyle" | "paragraphStyle" | "tableStyle"; name: string },
    target: RuleTarget,
  ): void;
  /** Re-run every query through DuckDB and ingest the results (no document
   *  writes) — updates sync states. */
  refreshData(): Promise<void>;
  /** §8 change report — "what changed since last sync". Diffs every binding's
   *  CURRENT resolved content against the snapshot from the previous report and
   *  returns a per-binding changed / unchanged / added / removed summary (+
   *  counts). Call AFTER `refreshData` (so "current" reflects the fresh data).
   *  The first call reports every binding as `added` (the baseline); a caller
   *  that wants the baseline silent primes it once (see `primeChangeBaseline`).
   *  Returns an empty report honestly when the engine wasm predates the lane. */
  refreshDiff(): Promise<ChangeReport>;
  /** §8: prime the change-report baseline (one discarded `refreshDiff`) so the
   *  NEXT `refreshDiff` reports real deltas instead of the initial all-`added`
   *  baseline — call after the first lower, when the document already reflects
   *  the current data. */
  primeChangeBaseline(): Promise<void>;
  /** Resolve a binding and commit its lowered content to the document. */
  lowerBinding(id: string): Promise<void>;
  /** Refresh, then resolve + commit every binding. */
  lowerAll(): Promise<void>;
  /** §9 record-preview stepper: the count of records ingested for a query — the
   *  stepper's "of N" upper bound. Requires the query's result to be ingested
   *  first (`refreshData`); 0 before that. Returns 0 honestly when the engine
   *  wasm predates the preview lane. */
  recordCount(queryId: string): Promise<number>;
  /** §9 field-mapping wizard: the engine's column → variable-binding suggestions
   *  for a query's ingested result. Requires the query's result to be ingested
   *  first (`refreshData`); returns `[]` honestly when no result is ingested or
   *  the engine wasm predates the wizard lane. The wizard renders these and, on
   *  confirm, calls `addVariableBinding` with each suggestion's engine-computed
   *  `expr` — the bundle never decides the mapping (data semantics stay in Rust). */
  queryMappings(queryId: string): Promise<ColumnMapping[]>;
  /** §9 field-mapping wizard: generate variable bindings from the wizard's
   *  confirmed mappings in one call — for each MAPPABLE column it defines a
   *  variable binding (id `<prefix><column>`) bound to `query`, with the
   *  engine-computed `expr`. Non-mappable columns are skipped (they need a manual
   *  expression). Returns the ids it generated. A convenience over per-column
   *  `addVariableBinding`; the panel can also wire columns individually. */
  applyMappings(
    queryId: string,
    mappings: ColumnMapping[],
    options?: { idPrefix?: string; target?: string },
  ): string[];
  /** §9 record-preview stepper: "show the document resolved against record N".
   *  Resolves the binding against the chosen RECORD INDEX (per-record kinds
   *  — variable / image / barcode — evaluate over `records[record]`; a table
   *  renders in full) and commits it through the SAME lower lanes a normal lower
   *  uses, so stepping the preview shows exactly what a per-record batch run will
   *  generate for that record. Falls back to the record-0 resolve when the engine
   *  wasm predates the preview lane (honest, never faked). */
  previewRecord(bindingId: string, record: number): Promise<void>;
  /** D-01 refresh loop: re-enumerate the document's placeholder FIELDS
   *  (`host.document.placeholders()`, fresh-read addresses), resolve each
   *  `{plugin:"media.paged.data", key}` against its binding's expression, and
   *  `setFieldValue` the CHANGED values (minimal/idempotent). Sync states
   *  (Linked/Stale) update. Returns the number of fields re-resolved. */
  refreshFields(): Promise<number>;
  /** D-13: evaluate a rule binding and apply its document-style action to the
   *  fired content (per-cell on a lowered table, or over a story range).
   *  Returns the count of applied style writes. */
  applyRule(ruleId: string): Promise<number>;
  /** D-12: paginate a record-flow binding over the LIVE host frame chain
   *  (`host.document.frameChain(storyId)` + content-box capacities), re-splitting
   *  when the chain reflows. Returns the paginated flow IR (the host renders it).
   *  `storyId` is the flow region's story; the chain is read live (D-12), not
   *  caller-supplied. */
  paginateChain(bindingId: string, storyId: string): Promise<unknown>;
  /** D-12: subscribe to content-box reflow so a catalog flow re-paginates when
   *  its chain's frames resize. Returns a disposable; the callback fires with
   *  the fresh paginated flow on each relevant reflow. */
  subscribeChainReflow(
    bindingId: string,
    storyId: string,
    onRepaginate: (flow: unknown) => void,
  ): { dispose(): void };
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
  // The kind of each defined binding, so lowerBinding/refresh dispatch without
  // re-resolving (a variable field re-resolves through placeholders(), an image
  // re-places, a table re-lowers).
  const bindingKinds = new Map<
    string,
    "variable" | "table" | "image" | "rule" | "recordFlow" | "barcode"
  >();
  // D-14: the bound RECTANGLE (+ optional explicit fit) an image binding places
  // onto. Caller (the bindings panel) supplies the target frame.
  const imageTargets = new Map<string, { elementId: string; fit?: IdmlFit }>();
  // §9.7: the bound rectangle a barcode binding draws its VECTOR modules onto
  // (its page-coordinate top-left is the modules' origin). Caller-supplied.
  const barcodeTargets = new Map<string, { elementId: string }>();
  // D-01: where each variable binding's placeholder field landed
  // (`{storyId, offset}`), so a re-lower does not double-insert. The refresh
  // loop re-enumerates placeholders() fresh, so this is the placed-once guard.
  const variableFields = new Map<string, { storyId: string; offset: number }>();
  // D-13: the rule scope→query each rule binding evaluates against + its host
  // target (story range / table column). Caller-supplied.
  const ruleTargets = new Map<string, { query: string; target: RuleTarget }>();
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
      bindingKinds.set(id, "variable");
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
      bindingKinds.set(id, "table");
      if (!bindingIds.includes(id)) bindingIds.push(id);
    },

    addImageBinding(id, target, query, expr, options) {
      void engine?.define_binding({
        id,
        kind: "image",
        target,
        query,
        expr,
        // ImgPolicy: { fit, missing } — the engine's ImgFit drives the default
        // placement vocab; the explicit IDML `fit` (options.fit) overrides at
        // commit time. Map the IDML choice back to the engine ImgFit when given.
        policy: { fit: engineFit(options?.fit), missing: options?.missing ?? "skip" },
      });
      bindingKinds.set(id, "image");
      imageTargets.set(id, { elementId: target, fit: options?.fit });
      if (!bindingIds.includes(id)) bindingIds.push(id);
    },

    addBarcodeBinding(id, target, query, symbology, expr, options) {
      void engine?.define_binding({
        id,
        kind: "barcode",
        target,
        query,
        symbology,
        expr,
        options: {
          quiet_zone: options?.quietZone ?? 0,
          missing: options?.missing ?? "skip",
        },
      });
      bindingKinds.set(id, "barcode");
      barcodeTargets.set(id, { elementId: target });
      if (!bindingIds.includes(id)) bindingIds.push(id);
    },

    addRuleBinding(id, scope, query, when, apply, target) {
      void engine?.define_binding({ id, kind: "rule", scope, when, apply });
      bindingKinds.set(id, "rule");
      ruleTargets.set(id, { query, target });
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

    async refreshDiff() {
      // §8 change report: the engine fingerprints every binding's current
      // resolved content and diffs it against the previous report's snapshot. We
      // call it AFTER refreshData so "current" reflects the fresh data.
      const empty: ChangeReport = { entries: [], changed: 0, unchanged: 0, added: 0, removed: 0 };
      let e: DataEngineLike;
      try {
        e = await ensureEngine();
      } catch {
        return empty;
      }
      if (typeof e.refresh_change_report !== "function") return empty;
      try {
        const report = (e.refresh_change_report() as ChangeReport | null) ?? empty;
        state.message =
          `Change report: ${report.changed} changed, ${report.unchanged} unchanged` +
          (report.added ? `, ${report.added} added` : "") +
          (report.removed ? `, ${report.removed} removed` : "") +
          ".";
        return report;
      } catch (err) {
        host.log.warn(`refreshDiff: ${String(err)}`);
        return empty;
      }
    },

    async primeChangeBaseline() {
      // One discarded report so the NEXT refreshDiff shows real deltas, not the
      // initial all-`added` baseline.
      await this.refreshDiff();
    },

    async lowerBinding(id) {
      try {
        const e = await ensureEngine();
        // A rule is not a resolvable lowering — it applies a style decision over
        // a scope (D-13); route it through applyRule, not resolve_lowered.
        if (bindingKinds.get(id) === "rule") {
          await this.applyRule(id);
          state.status = "ready";
          state.message = `Applied rule "${id}".`;
          return;
        }
        // §9.7: a barcode is encoded + scaled to the bound frame's content box,
        // then drawn as native VECTOR modules (insertPath). It is NOT a
        // resolve_lowered kind — it needs the frame box, like record flow needs a
        // chain — so route it through lower_barcode(id, w, h).
        if (bindingKinds.get(id) === "barcode") {
          const tgt = barcodeTargets.get(id);
          let boxW = 72;
          let boxH = 72;
          if (tgt) {
            const geom = await host.document.elementGeometry([
              { kind: "rectangle", id: tgt.elementId } as ElementId,
            ]);
            const bounds = geom[0]?.bounds as [number, number, number, number] | undefined;
            if (bounds) {
              const [top, left, bottom, right] = bounds;
              boxW = Math.max(1, right - left);
              boxH = Math.max(1, bottom - top);
            }
          }
          const bc = e.lower_barcode(id, boxW, boxH) as LoweredBarcode | null;
          if (bc) await commitLoweredBarcode(host, bc, tgt?.elementId ?? null);
          state.status = "ready";
          state.message = `Resolved + lowered barcode "${id}".`;
          return;
        }
        const lowered = e.resolve_lowered(id) as { kind?: string } | null;
        if (lowered?.kind === "table") {
          await commitLoweredTable(host, lowered as never);
        } else if (lowered?.kind === "variable") {
          // D-01: place the variable as a tagged placeholder field ONCE (keyed by
          // the binding id), then re-resolve it through the placeholders() loop.
          if (!variableFields.has(id)) {
            const placed = await commitLoweredVariable(host, lowered as never, id);
            if (placed) variableFields.set(id, placed);
          } else {
            // Already placed — a re-lower just re-resolves the live field.
            await this.refreshFields();
          }
        } else if (lowered?.kind === "image") {
          // D-14: place onto the bound rectangle (caller-supplied target).
          const tgt = imageTargets.get(id);
          if (tgt) {
            await commitLoweredImage(host, lowered as never, tgt.elementId, tgt.fit);
          } else {
            host.log.info(
              `image binding "${id}" has no bound rectangle target — define it via addImageBinding`,
            );
          }
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

    async recordCount(queryId) {
      // §9 stepper bound: the engine reports how many records are ingested for
      // the query (0 before a refresh, or on an engine wasm without the lane).
      let e: DataEngineLike;
      try {
        e = await ensureEngine();
      } catch {
        return 0;
      }
      if (typeof e.query_record_count !== "function") return 0;
      try {
        return e.query_record_count(queryId);
      } catch {
        return 0;
      }
    },

    async queryMappings(queryId) {
      // §9 field-mapping wizard: the engine computes the column → binding
      // suggestions from the ingested result's schema (the data semantics stay
      // in Rust). Empty (honest) when no result is ingested or the wasm predates
      // the lane.
      let e: DataEngineLike;
      try {
        e = await ensureEngine();
      } catch {
        return [];
      }
      if (typeof e.query_mappings !== "function") return [];
      try {
        return (e.query_mappings(queryId) as ColumnMapping[] | null) ?? [];
      } catch (err) {
        host.log.warn(`queryMappings(${queryId}): ${String(err)}`);
        return [];
      }
    },

    applyMappings(queryId, mappings, options) {
      // §9 field-mapping wizard confirm: generate a variable binding per MAPPABLE
      // column from the engine-computed expr. Non-mappable columns (no bare DSL
      // reference) are skipped — they need a manual expression. The bundle does
      // not decide the expr; it only wires what the engine suggested.
      const prefix = options?.idPrefix ?? "v_";
      const target = options?.target ?? "anchor";
      const generated: string[] = [];
      for (const m of mappings) {
        if (!m.mappable || m.expr === "") continue;
        const id = `${prefix}${m.column}`;
        this.addVariableBinding(id, target, queryId, m.expr);
        generated.push(id);
      }
      return generated;
    },

    async previewRecord(bindingId, record) {
      // §9 record-preview stepper: resolve the binding against the chosen record
      // index and commit it through the normal lower lanes. A barcode needs the
      // frame box, an image its bound rectangle, a variable a placed field — the
      // same targets a normal lower uses, so the preview and the batch output are
      // the same content for that record.
      try {
        const e = await ensureEngine();
        const kind = bindingKinds.get(bindingId);

        // Barcode: re-encode for the previewed record, scaled to its frame box.
        if (kind === "barcode") {
          const tgt = barcodeTargets.get(bindingId);
          let boxW = 72;
          let boxH = 72;
          if (tgt) {
            const geom = await host.document.elementGeometry([
              { kind: "rectangle", id: tgt.elementId } as ElementId,
            ]);
            const bounds = geom[0]?.bounds as [number, number, number, number] | undefined;
            if (bounds) {
              const [top, left, bottom, right] = bounds;
              boxW = Math.max(1, right - left);
              boxH = Math.max(1, bottom - top);
            }
          }
          // The preview-aware lower (`lower_barcode_at`) falls back to the
          // record-0 `lower_barcode` when the wasm predates the lane.
          const lowerAt = (e as { lower_barcode_at?: (b: string, r: number, w: number, h: number) => unknown })
            .lower_barcode_at;
          const bc = (
            typeof lowerAt === "function"
              ? lowerAt.call(e, bindingId, record, boxW, boxH)
              : e.lower_barcode(bindingId, boxW, boxH)
          ) as LoweredBarcode | null;
          if (bc) await commitLoweredBarcode(host, bc, tgt?.elementId ?? null);
          state.status = "ready";
          state.message = `Preview: barcode "${bindingId}" against record ${record}.`;
          return;
        }

        // Variable / image / table: resolve at the chosen record (falls back to
        // the record-0 resolve when the wasm predates `resolve_lowered_at`).
        const resolveAt =
          typeof e.resolve_lowered_at === "function"
            ? (id: string) => e.resolve_lowered_at!(id, record)
            : (id: string) => e.resolve_lowered(id);
        const lowered = resolveAt(bindingId) as { kind?: string } | null;
        if (lowered?.kind === "table") {
          await commitLoweredTable(host, lowered as never);
        } else if (lowered?.kind === "variable") {
          // Re-resolve the previewed value into the placed field (place once).
          if (!variableFields.has(bindingId)) {
            const placed = await commitLoweredVariable(host, lowered as never, bindingId);
            if (placed) variableFields.set(bindingId, placed);
          } else {
            const v = lowered as { hidden?: boolean; text?: string };
            const f = variableFields.get(bindingId)!;
            const value = v.hidden ? null : (v.text ?? null);
            await host.document.mutate(setFieldValueMutation(f.storyId, f.offset, value));
          }
        } else if (lowered?.kind === "image") {
          const tgt = imageTargets.get(bindingId);
          if (tgt) {
            await commitLoweredImage(host, lowered as never, tgt.elementId, tgt.fit);
          }
        }
        state.status = "ready";
        state.message = `Preview: "${bindingId}" against record ${record}.`;
      } catch (err) {
        state.status = "error";
        state.message = err instanceof Error ? err.message : String(err);
        host.log.warn(`previewRecord(${bindingId}, ${record}): ${state.message}`);
      }
    },

    async refreshFields() {
      // D-01 refresh loop: re-enumerate OUR placeholder fields (fresh-read
      // addresses — re-enumerate before each write pass), resolve each field's
      // key (= binding id) against its binding, and setFieldValue the changed
      // values. A field whose binding no longer resolves is left untouched.
      if (!host.supports("document.placeholders@1")) return 0;
      let e: DataEngineLike;
      try {
        e = await ensureEngine();
      } catch {
        return 0;
      }
      let fields: readonly PlaceholderField[] = [];
      try {
        fields = (await host.document.placeholders()) as readonly PlaceholderField[];
      } catch {
        return 0;
      }
      let written = 0;
      for (const f of fields) {
        if (f.plugin !== FIELD_PLUGIN) continue; // our namespace only
        if (bindingKinds.get(f.key) !== "variable") continue; // a known variable binding
        // Resolve the binding live (the engine re-evaluates the expression over
        // the freshly-ingested record).
        let next: string | null = f.value;
        try {
          const lowered = e.resolve_lowered(f.key) as
            | { kind?: string; text?: string; hidden?: boolean }
            | null;
          if (lowered?.kind === "variable") {
            next = lowered.hidden ? null : (lowered.text ?? null);
          }
        } catch {
          continue; // binding gone / unresolvable → leave the field untouched
        }
        if (next === f.value) continue; // minimal: only changed → a write
        const out = await host.document.mutate(setFieldValueMutation(f.storyId, f.offset, next));
        if (out.applied) {
          written += 1;
          // Sync state: a re-resolved field tracks its source again (Linked).
          try {
            e.relink(f.key);
          } catch {
            /* relink is best-effort; the engine owns the state machine */
          }
        }
      }
      state.status = "ready";
      state.message = `Refreshed ${written} field(s) from the live data.`;
      return written;
    },

    async applyRule(ruleId) {
      const meta = ruleTargets.get(ruleId);
      if (!meta) {
        host.log.warn(`applyRule(${ruleId}): no rule target — define it via addRuleBinding`);
        return 0;
      }
      const e = await ensureEngine();
      const result = e.evaluate_rule(ruleId, meta.query) as RuleResult;
      return commitRule(host, result, meta.target);
    },

    async paginateChain(bindingId, storyId) {
      // D-12: read the LIVE host frame chain + content-box capacities, then
      // paginate the record flow over it (the engine owns the layout). The chain
      // topology is host-read (frameChain), not caller-supplied.
      const e = await ensureEngine();
      const chain = await readLiveChain(host, storyId);
      return e.lower_record_flow(bindingId, chain, undefined);
    },

    subscribeChainReflow(bindingId, storyId, onRepaginate) {
      // D-12: re-paginate when the chain's content boxes resize. A reflow event
      // carries ONLY a resize (never a transform, §8.5), so a transform-only
      // change is ignored — exactly the pagination consumer contract.
      const sub = host.document.onDidChange((ev) => {
        if (!ev.reflow) return; // resize-only; ignore pure transforms
        void (async () => {
          try {
            const e = await ensureEngine();
            const chain = await readLiveChain(host, storyId);
            onRepaginate(e.lower_record_flow(bindingId, chain, undefined));
          } catch (err) {
            host.log.warn(`subscribeChainReflow(${bindingId}): ${String(err)}`);
          }
        })();
      });
      return { dispose: () => sub.dispose() };
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
