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
  Disposable,
  ProviderSchema,
} from "@paged-media/plugin-api";

import {
  FIELD_PLUGIN,
  backToFront,
  dataSetPlan,
  setFieldValueMutation,
  visibilityTarget,
  type DataSetApply,
  type DataSetTargets,
  type IdmlFit,
  type LoweredBarcode,
  type PlaceholderField,
  type RuleResult,
  type RuleTarget,
  type VisibilityTargetKind,
} from "../../data-host-model/src";

import { bootEngine, ENGINE_NOT_BUILT, ingestColumnBatch, type DataEngineLike } from "./engine";
import { reviewMethods, type ReviewSession } from "./review";
import {
  DATA_PART_DIR,
  SESSION_PART,
  contentHash,
  decodeSession,
  emptyTargets,
  encodeSession,
  dataPartOf,
  loadData,
  loadFile,
  storeData,
  storeFile,
  type BinaryFormat,
  type PersistedData,
  type PersistedSession,
  type PersistedTargets,
} from "./persist";
import type { LowerStamp, LoweredTableAt } from "./lower";
import { commitRecordFlow } from "./flow-writer";
import {
  mergeRecords as writeMerge,
  readMergeTemplate,
  type MergeResult,
  type MergeTemplate,
  type RecordsPerPage,
} from "./merge";
import { documentElements, planRelower, type RelowerTarget } from "./relower";
import { bootDuckDB, DUCKDB_NOT_VENDORED, type DuckDBHandle } from "./query/duckdb";
import {
  formatOfFile,
  loadIntoDuckDB,
  quoteIdent,
  sourceNameOf,
  type ImportFormat,
  type XlsxImport,
} from "./query/import";
import { checkQuery, diagnoseDuckDBError, previewSql, type SqlDiagnostic } from "./query/sql";
import {
  IntervalScheduler,
  MANUAL,
  readPolicy,
  refusePolicy,
  type RefreshPolicy,
} from "./refresh";
import {
  commitDataSet,
  commitLoweredBarcode,
  commitLoweredImage,
  commitLoweredTable,
  commitLoweredVariable,
  commitLoweredVariables,
  commitLoweredVisibility,
  commitRule,
  failedBatchChild,
  resolveElementId,
  type LowerContext,
} from "./lower";
import {
  buildRemoteUrl,
  remoteOrigin,
  validateRemoteUrl,
  type RemoteFormat,
  type RemoteSourceState,
} from "./remote";

export type { RemoteFormat, RemoteSourceState } from "./remote";
export type { RefreshPolicy } from "./refresh";
export type { SqlDiagnostic } from "./query/sql";
export type { ImportFormat } from "./query/import";

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

/** How `subscribeChainReflow` coalesces a burst of reflow events. */
export interface ReflowOptions {
  /** The quiet period after the last relevant event before re-paginating
   *  (default 16 ms, about one frame). */
  delayMs?: number;
  /** The timer pair the debounce runs on (default: the global timers). */
  timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

/** One binding's decision from the engine's `refresh_field_values`. */
type FieldRefreshOut =
  | { outcome: "value"; binding: string; value: string | null }
  | { outcome: "kept"; binding: string; status: string }
  | { outcome: "notVariable"; binding: string }
  | { outcome: "failed"; binding: string; error?: string };

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
  /** What went wrong (or was deliberately skipped) and where, newest last.
   *  The panels render it; nothing that fails is left as a log line only. */
  diagnostics: SessionDiagnostic[];
  /** Whether the session is saved with the document (the panels say so). */
  persistence: PersistenceState;
  /** Imported local files (wave 6): which source came from which file. */
  files: ImportedFileState[];
  /** Refresh policy per source (absent = manual). */
  refresh: Record<string, RefreshPolicy>;
  /** Remote sources being polled now (interval policy, consented origin). */
  polling: string[];
}

/** One imported local file, as the Sources panel lists it. */
export interface ImportedFileState {
  source: string;
  format: ImportFormat;
  fileName: string;
  /** XLSX: the worksheet read, and every worksheet of the workbook. */
  sheet?: string;
  sheets?: string[];
}

/** What an import did. `error` is set (and reported) when it failed. */
export interface ImportResult {
  source: string;
  format: ImportFormat | null;
  sheet?: string;
  sheets?: string[];
  error?: string;
}

/** A query preview: the first rows as DuckDB renders them, or why not. */
export interface QueryPreview {
  columns: { name: string; type: string }[];
  rows: (string | null)[][];
  /** The query's full row count (the preview shows at most `limit`). */
  total: number | null;
  diagnostic: SqlDiagnostic | null;
}

/** Where the session stands against the document's `session` part:
 *  `unavailable` — this host has no container parts, nothing is saved;
 *  `empty` — nothing defined yet; `pending` — a change not yet written;
 *  `saved` — the part matches the session. */
export interface PersistenceState {
  status: "unavailable" | "empty" | "pending" | "saved";
  /** The content hash of the last written session part, or null. */
  hash: string | null;
}

/** One visible diagnostic: a failure or a deliberate skip the user should see
 *  (an import that failed, a binding that did not resolve, a field a refresh
 *  left alone because it is pinned). `binding` names the binding when there is
 *  one. */
export interface SessionDiagnostic {
  level: "error" | "warn" | "info";
  source:
    | "import"
    | "refresh"
    | "preview"
    | "binding"
    | "variables"
    | "persist"
    | "restore"
    | "flow"
    | "query";
  message: string;
  binding?: string;
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
 *  with the host data-provider registry (`host.dataProviders`, D-09). */
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

/** §9.9: one declared variable, as the palette shows it. `bound` is false for a
 *  variable an imported library declares but nothing in this document binds —
 *  the palette shows it greyed rather than pretending it will apply. */
export interface VariableSummary {
  name: string;
  trait: "textcontent" | "filereference" | "visibility" | "graphdata";
  bound: boolean;
}

/** §9.9: what a variable-library import brought in, and what will NOT apply. */
export interface ImportReport {
  setName: string;
  variables: number;
  dataSets: number;
  /** Bindable variables with no binding defined here — skipped on apply. */
  unbound: string[];
  /** `graphdata` variables — carried and re-exported, never applied (RFI D-15). */
  graphOnly: string[];
}

/** A record flow resolved for preview: the records it would place, as lines. */
export interface RecordFlowPreview {
  total: number;
  /** One entry per block: a group header, a record (its field lines joined),
   *  or a group footer. */
  blocks: { kind: "header" | "record" | "footer"; text: string }[];
}

/** What `mergeRecords` takes (see `merge.ts`). */
export interface SessionMergeOptions {
  query: string;
  recordsPerPage?: RecordsPerPage;
  removeBlankLines?: boolean;
  /** `keep` (default): the template page stays, the output goes on new pages
   *  after it. `consume`: the template page holds the first output page. */
  template?: "consume" | "keep";
  /** The template page (default: the active page). */
  pageId?: string;
  /** Image placeholders: rectangle id → field (`photo` or `@photo`). */
  imageFields?: Record<string, string>;
  /** Where relative image references resolve. */
  imageBase?: string;
  /** Labels the output so a re-merge replaces it (default `merge-<query>`). */
  mergeId?: string;
}

/** The session API the panels + commands drive. */
export interface DataSourceSession extends ReviewSession {
  getState(): SessionState;
  /** Drop every diagnostic (the panel's "clear" action). */
  clearDiagnostics(): void;
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
  /** Import a local file as a source table: CSV, TSV, JSON (array or
   *  newline-delimited), Parquet, XLSX (one worksheet, `sheet` absent = the
   *  first). The source is named after the file unless `name` is given. The
   *  file is saved with the document like a CSV. Never throws: a failure is
   *  in the result and in `diagnostics`. */
  importFile(
    fileName: string,
    bytes: Uint8Array,
    options?: { name?: string; sheet?: string },
  ): Promise<ImportResult>;
  /** Read another worksheet of an imported workbook into the same source. */
  selectSheet(source: string, sheet: string): Promise<ImportResult>;
  /** The columns of a source table (name and DuckDB type), for the query
   *  builders. Empty when the source is unknown or DuckDB is unavailable. */
  describeSource(source: string): Promise<{ name: string; type: string }[]>;
  /** Run a query for a preview of its first `limit` rows (default 50), as
   *  DuckDB renders the values. Guarded like every query (query/sql.ts);
   *  nothing is ingested and no binding changes. */
  previewQuery(sql: string, limit?: number): Promise<QueryPreview>;
  /** Define or replace a query after the guard admits it; returns the
   *  diagnostic and defines nothing when it does not. Saved with the
   *  session. */
  saveQuery(
    id: string,
    sql: string,
    shape?: "recordStream" | "singleRecord" | "scalar",
  ): Promise<SqlDiagnostic | null>;
  /** The defined queries and their SQL, in definition order. */
  listQueries(): { id: string; sql: string }[];
  /** Set a source's refresh policy (src/refresh.ts says what each does).
   *  Returns why it was refused, or null. */
  setRefreshPolicy(source: string, policy: RefreshPolicy): string | null;
  getRefreshPolicy(source: string): RefreshPolicy;
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
  /** §9.8: define a VISIBILITY binding — the Illustrator "visibility variable".
   *  `target` is the bound element's raw Self id; `expr` resolves to the
   *  shown/hidden decision per record. `invert` flips it (bind `discontinued`,
   *  hide when true); `missing` governs a null value — `hide` (default), `show`,
   *  or `leave` (write nothing at all, the non-destructive arm).
   *
   *  `kind` pins the element's `ElementId` kind when the caller knows it (the
   *  panel binds from the selection); absent, it is resolved from the live scene
   *  tree at commit time. */
  addVisibilityBinding(
    id: string,
    target: string,
    query: string,
    expr: string,
    options?: {
      invert?: boolean;
      missing?: "hide" | "show" | "leave";
      kind?: VisibilityTargetKind;
    },
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
  // ── §9.9 variables + data sets (the Illustrator palette) ─────────────────

  /** The declared variables — one per bindable binding, plus anything an
   *  imported library brought in. Empty when the engine wasm predates the lane
   *  (honest degrade, never a fabricated palette). */
  variables(): Promise<VariableSummary[]>;
  /** Capture the current resolved values as a named data set (§9.9 — "capture
   *  current data set"), resolved against `record` (the preview index; 0 by
   *  default). Capturing over an existing name replaces it. */
  captureDataSet(name: string, record?: number): Promise<string[]>;
  /** Capture ONE data set per record of a query — the whole palette straight
   *  from the data, which is the point of doing this here rather than in a
   *  drawing plugin. `nameColumn` titles each set from a result column.
   *  Returns the captured names in record order. */
  captureEveryRecord(
    queryId: string,
    options?: { prefix?: string; nameColumn?: string },
  ): Promise<string[]>;
  /** The named data sets, in palette order. */
  listDataSets(): Promise<string[]>;
  /** Delete a data set by name; `true` when one was removed. */
  deleteDataSet(name: string): Promise<boolean>;
  /** Apply a named data set to the document (§9.9 — "switch data set"). ONE
   *  undoable batch regardless of how many variables move; returns the count
   *  written plus the per-variable reasons for everything skipped, which the
   *  caller must SHOW (a data set that half-applies in silence is the failure
   *  this return shape exists to prevent). */
  applyDataSet(name: string): Promise<{ applied: number; skipped: Record<string, string> }>;
  /** Export the variable set as an Illustrator-compatible variable library
   *  (XML). See `data-dataset/src/xml.rs` for the two declared deviations. */
  exportVariableLibrary(): Promise<string>;
  /** Import a variable library (XML), replacing the current variable set.
   *  Returns what came in and what will NOT apply. Import never writes to the
   *  document — applying a set is a separate, explicit action. */
  importVariableLibrary(xml: string): Promise<ImportReport>;
  /** The serialized byte size of the variable half of the document payload —
   *  the D-08 64 KiB budget check before a bulk capture. */
  dataSetPayloadBytes(): Promise<number>;

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
   *  `setFieldValue` the CHANGED values (minimal/idempotent), back to front
   *  per story so no write moves an address still to be used. A field whose
   *  binding is Pinned or Overridden is left alone and not resolved (ADR 553);
   *  every skip and failure lands in `diagnostics`. Returns the number of
   *  fields written. */
  refreshFields(): Promise<number>;
  /** D-13: evaluate a rule binding and apply its document-style action to the
   *  fired content (per-cell on a lowered table, or over a story range).
   *  Returns the count of applied style writes. */
  applyRule(ruleId: string): Promise<number>;
  /** The defined bindings + their kinds — panel-facing read of session
   *  state (the dataset panel's batch RUN needs the record-flow binding). */
  listBindings(): { id: string; kind: string }[];
  /** D-12: paginate a record-flow binding over the LIVE host frame chain
   *  (`host.document.frameChain(storyId)` + content-box capacities), re-splitting
   *  when the chain reflows. Returns the paginated flow IR (the host renders it).
   *  `storyId` is the flow region's story; the chain is read live (D-12), not
   *  caller-supplied. */
  paginateChain(bindingId: string, storyId: string): Promise<unknown>;
  /** D-12: subscribe to content-box reflow so a catalog flow re-paginates when
   *  its chain's frames resize. Returns a disposable; the callback fires with
   *  the fresh paginated flow once per BURST of relevant reflows (a drag-resize
   *  streams one per step; only the settled chain is paginated). `options`
   *  sets the quiet period and injects the timers (tests). */
  subscribeChainReflow(
    bindingId: string,
    storyId: string,
    onRepaginate: (flow: unknown) => void,
    options?: ReflowOptions,
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
   *  consumes it. Returns the engine-side publication payload, and registers it
   *  with the host's shared data-provider registry (`host.dataProviders`, D-09)
   *  when the host injects one (`supports("dataProviders@1")`); a re-publish
   *  bumps the existing registration's revision. On a host without the
   *  registry nothing is registered and nothing is faked — check
   *  `isProviderRegistered`. Requires the query's result to be ingested first
   *  (`refreshData`). */
  publishProvider(
    queryId: string,
    providerId: string,
    category: string,
  ): Promise<DataProviderPublication>;
  /** Whether `publishProvider` registered `providerId` with the host registry
   *  (false on a host that injects none — the payload exists, nobody can read
   *  it yet). */
  isProviderRegistered(providerId: string): boolean;
  /** §7 governed catalog: enrich a query's resolved schema with a column-metadata
   *  sidecar (the bundle reads the sidecar JSON from the source's
   *  `metadata_sidecar` location) → documented columns + governance-drift
   *  diagnostics. Requires the query's result to be ingested first
   *  (`refreshData`). The byte-read of the governed table + sidecar from a
   *  file/URL/DB location is the broader `data.governed.extract` path (M2). */
  governedCatalog(queryId: string, metadata: DatasetMetadata): Promise<GovernedCatalog>;
  /** §9.1: set the session formatting locale (a tag from the engine's locale
   *  table — `locales()` lists them) for the display kernels
   *  (NUMBER/CURRENCY/PERCENT/DATEFMT). Applies immediately if the engine is up,
   *  else on its next boot; a tag the engine lacks is reported, and the locale
   *  stays as it was. Re-lower bindings to see the change in the document. */
  setLocale(next: string): void;
  getLocale(): string;
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
  /** §9.4: define a RECORD-FLOW binding — the catalog flow. Each record of
   *  `query` renders through a template of `fields` (one line per field: a
   *  static `label` plus an expression); `groupBy` adds a section header per
   *  group. `chain` names the story the flow threads through (resolved live
   *  when it is paginated). Defines the template `<id>.template` alongside. */
  defineRecordFlow(
    id: string,
    query: string,
    fields: { label?: string; expr: string }[],
    options?: { groupBy?: string[]; lineHeightPt?: number; chain?: string },
  ): void;
  /** Resolve a record-flow binding and list what it would place, record by
   *  record, as text lines (no document write — writing the flow into frames
   *  is a separate step). Needs the query's data (`refreshData`). Returns null
   *  and reports a diagnostic when it cannot resolve. */
  previewRecordFlow(id: string): Promise<RecordFlowPreview | null>;
  /** Wave 5 — InDesign-style Data Merge of a query's records into the
   *  document through a record template read off a page (`merge.ts`). A
   *  second merge with the same id replaces the first run's output. */
  mergeRecords(options: SessionMergeOptions): Promise<MergeResult>;
  /** Pin a binding (a refresh leaves its content alone) or link it again.
   *  Saved with the session. */
  setPinned(id: string, pinned: boolean): void;
  /** Listen for session changes (a restore finishing, a diagnostic, a save). */
  onDidChange(listener: () => void): Disposable;
  /** Restore the document's saved session part (activate calls this once).
   *  Never throws: what cannot be restored lands in `diagnostics`. */
  restore(): Promise<void>;
  /** A different document is open (File ▸ Open / New): drop everything this
   *  session held for the previous one — nothing of it may be written into
   *  the new document — and restore the new document's own session part. */
  documentOpened(): Promise<void>;
  /** Resolves once the document's saved session (if any) has been restored. */
  whenRestored(): Promise<void>;
  /** Write any pending session change to the document now (the debounced
   *  write, and the will-save hook, call this). */
  flushPersist(): Promise<void>;
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
    "variable" | "table" | "image" | "rule" | "recordFlow" | "barcode" | "visibility"
  >();
  // §9.8: the bound element a visibility binding shows/hides. `kind` is the
  // caller's (the panel binds from the selection, which carries it); absent, it
  // is resolved from the live scene tree at commit time.
  const visibilityTargets = new Map<
    string,
    { elementId: string; kind?: VisibilityTargetKind }
  >();
  // D-14: the bound RECTANGLE (+ optional explicit fit) an image binding places
  // onto. Caller (the bindings panel) supplies the target frame.
  const imageTargets = new Map<string, { elementId: string; fit?: IdmlFit }>();
  // §9.7: the bound rectangle a barcode binding draws its VECTOR modules onto
  // (its page-coordinate top-left is the modules' origin). Caller-supplied.
  const barcodeTargets = new Map<string, { elementId: string }>();
  // D-01: the variable bindings whose placeholder field this session placed,
  // so a re-lower or a preview step does not insert a second one. A set, not a
  // map of offsets, on purpose: a field's offset is valid only until the next
  // edit (core normalises it to the run start, and anything inserted in front
  // moves it), so every write re-reads placeholders() for the address.
  const placedVariables = new Set<string>();
  // D-13: the rule scope→query each rule binding evaluates against + its host
  // target (story range / table column). Caller-supplied.
  const ruleTargets = new Map<string, { query: string; target: RuleTarget }>();
  // D-09: live provider registrations, keyed by provider id, so a re-publish
  // bumps the existing registration's revision instead of double-registering.
  const providerHandles = new Map<string, DataProviderHandle>();
  // §9.1 localization — the session formatting locale (applied on engine boot,
  // and immediately if the engine is already up). Default en.
  let locale = "en";

  // M1 remote sources (D-03): descriptor-only until consented + loaded.
  const remoteSources = new Map<string, RemoteSourceState>();

  // ── persistence (the `session` container part, persist.ts) ───────────────
  // The imported CSV text per source: the bytes the session saves, so a reopen
  // can register the source in DuckDB again.
  const importedCsv = new Map<string, string>();
  // Restored sources not yet in DuckDB: registered on DuckDB's first boot, so
  // opening a document never boots DuckDB by itself.
  const pendingCsv = new Map<string, string>();
  // Where table / record-flow bindings were last lowered (checked on restore).
  const loweredInto = new Map<string, ElementId>();
  // Update in place (Wave 5): where each table binding's table is, and every
  // module each barcode binding drew last, so a re-lower or a preview step
  // replaces them instead of adding a duplicate.
  const tableAt = new Map<string, LoweredTableAt>();
  const barcodeMinted = new Map<string, ElementId[]>();
  // The template each merge read last: a consumed template is gone from its
  // page, and a re-merge reuses it.
  const mergeTemplates = new Map<string, MergeTemplate>();
  // Definitions made before the engine booted, replayed (in order) on boot.
  const pendingDefs: { binding?: string; run: (e: DataEngineLike) => void }[] = [];
  // A saved engine recipe to load as the engine boots (set by restore).
  let bootPayload: unknown = null;
  // Data parts this session wrote or read (a large CSV is written once).
  const knownDataParts = new Set<string>();
  const persistence: PersistenceState = { status: "empty", hash: null };
  let lastWritten: string | null = null;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let persistChain: Promise<void> = Promise.resolve();
  let partsMissingReported = false;
  let restorePromise: Promise<void> | null = null;
  // Bumped when another document opens: a write queued for the previous
  // document checks it and is dropped instead of landing in the new one.
  let docEpoch = 0;
  const listeners = new Set<() => void>();
  const PERSIST_DEBOUNCE_MS = 250;

  let engine: DataEngineLike | null = null;
  let duck: DuckDBHandle | null = null;
  const diagnostics: SessionDiagnostic[] = [];
  const state: SessionState = {
    status: "idle",
    message: "No data sources yet — import a CSV to begin.",
    sources: sourceNames,
    queries: [],
    bindings: bindingIds,
    remote: [],
    diagnostics,
    persistence,
    files: [],
    refresh: {},
    polling: [],
  };

  // ── wave 6: local files beyond CSV, refresh policies, the query guard ────
  /** An imported JSON / Parquet / XLSX file: the bytes the session saves. */
  interface ImportedFile {
    format: BinaryFormat;
    fileName: string;
    bytes: Uint8Array;
    sheet?: string;
    sheets?: string[];
  }
  const importedFiles = new Map<string, ImportedFile>();
  // Restored files not yet in DuckDB (registered on DuckDB's first boot).
  const pendingFiles = new Map<string, ImportedFile>();
  // The file a CSV / TSV source came from (display only).
  const csvFileNames = new Map<string, { format: "csv" | "tsv"; fileName: string }>();
  const refreshPolicies = new Map<string, RefreshPolicy>();
  const poller = new IntervalScheduler((name) => pollRemote(name));

  function emit(): void {
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        // a listener's failure is its own
      }
    }
  }

  const partsAvailable = () => host.supports("storage.parts@1");

  /** A definition or decision changed: write the session part soon. */
  function markDirty(): void {
    if (!partsAvailable()) {
      persistence.status = "unavailable";
      if (!partsMissingReported) {
        partsMissingReported = true;
        report({
          level: "info",
          source: "persist",
          message:
            "this host has no document container parts — sources, queries and bindings are not saved with the document",
        });
      }
      emit();
      return;
    }
    persistence.status = "pending";
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void flushPersistInternal();
    }, PERSIST_DEBOUNCE_MS);
    emit();
  }

  /** Run a definition on the engine now, or on its boot if it is not up yet.
   *  A definition the engine refuses is reported against the binding. */
  function defineOnEngine(run: (e: DataEngineLike) => void, binding?: string): void {
    if (!engine) {
      pendingDefs.push({ binding, run });
      return;
    }
    try {
      run(engine);
    } catch (err) {
      report({
        level: "error",
        source: "binding",
        binding,
        message: `the engine refused the definition: ${errText(err)}`,
      });
    }
  }

  /** Document changes seen so far (every applied mutate, undo and redo).
   *  A field address read at one count is valid only at that count. */
  let docChanges = 0;
  /** The preview's last field read, reusable while nothing but its own write
   *  changed the document (see `previewRecord`). */
  let previewFields: {
    binding: string;
    changes: number;
    doc: number;
    fields: PlaceholderField[];
  } | null = null;

  /** Set while `lowerAll` runs: what its lowerings share (the active page). */
  let lowerCtx: LowerContext | undefined;

  /** What a re-lower of `target` must clear (relower.ts): one tree read (and
   *  a pages read for a flow or a merge). A host without the tree read clears only what this
   *  session remembers minting. */
  async function relowerPlan(target: RelowerTarget, minted?: readonly ElementId[]) {
    let elements: ReturnType<typeof documentElements> = [];
    let pages: string[] = [];
    try {
      elements = documentElements((await host.document.tree()) as never);
      // Only a flow or a merge adds pages that a re-lower may remove.
      if (target.kind === "merge" || target.kind === "recordFlow") {
        pages = (await host.document.collection<{ selfId: string }>("pages")).map((p) => p.selfId);
      }
    } catch {
      // no tree read: fall back to the remembered ids below
      elements = (minted ?? []).map((element) => ({ element, page: -1, data: null }));
    }
    return planRelower(elements, target, { pages: pages as never, minted });
  }

  /** The page a lowering starts on: the active page, else the first. */
  async function startPage(): Promise<string | null> {
    const meta = await host.document.meta();
    if (meta.activePage) return meta.activePage as string;
    const pages = await host.document.collection<{ selfId: string }>("pages");
    return pages[0]?.selfId ?? null;
  }

  /** The recipe `buildPersisted` serialised last (reused by `stampFor`). */
  let lastPayload: unknown;

  /** The session as the part stores it, or null when there is nothing to
   *  save (the engine never booted, so nothing was defined). */
  async function buildPersisted(): Promise<PersistedSession | null> {
    if (!engine) return null;
    const payload = engine.payload();
    lastPayload = payload;
    const sync: PersistedSession["sync"] = [];
    try {
      const report = (engine.sync_report() as { binding: string; status: string }[] | null) ?? [];
      for (const e of report) {
        if (e.status === "pinned" || e.status === "overridden") {
          sync.push({ binding: e.binding, status: e.status });
        }
      }
    } catch {
      // no sync report: nothing pinned to save
    }
    const targets: PersistedTargets = emptyTargets();
    for (const [id, t] of imageTargets) targets.image[id] = { ...t };
    for (const [id, t] of barcodeTargets) targets.barcode[id] = { ...t };
    for (const [id, t] of visibilityTargets) targets.visibility[id] = { ...t };
    for (const [id, t] of ruleTargets) targets.rule[id] = { ...t };
    for (const [id, el] of loweredInto) targets.lowered[id] = el;
    const data: PersistedData[] = [];
    for (const [source, text] of importedCsv) {
      data.push(
        await storeData(
          source,
          text,
          (path, bytes) => host.parts.write(path, bytes),
          knownDataParts,
        ),
      );
    }
    for (const [source, f] of importedFiles) {
      data.push(
        await storeFile(
          source,
          f.format,
          f.fileName,
          f.bytes,
          f.sheet,
          (path, bytes) => host.parts.write(path, bytes),
          knownDataParts,
        ),
      );
    }
    return {
      v: 1,
      engine: payload,
      locale,
      sync,
      targets,
      data,
      remote: Array.from(remoteSources.values(), (r) => ({
        name: r.name,
        url: r.url,
        format: r.format,
        params: { ...r.params },
        ...(r.credentialRef ? { credentialRef: r.credentialRef } : {}),
      })),
      refresh: Object.fromEntries(refreshPolicies),
    };
  }

  /** Write the session part if it changed since the last write. Serialised:
   *  one write at a time, in order. */
  function flushPersistInternal(): Promise<void> {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    const epoch = docEpoch;
    persistChain = persistChain.then(async () => {
      if (!partsAvailable() || epoch !== docEpoch) return;
      try {
        const built = await buildPersisted();
        if (!built || epoch !== docEpoch) return;
        const bytes = encodeSession(built);
        const text = new TextDecoder().decode(bytes);
        if (text !== lastWritten) {
          await host.parts.write(SESSION_PART, bytes);
          lastWritten = text;
          persistence.hash = await contentHash(bytes);
        }
        persistence.status = "saved";
      } catch (err) {
        report({
          level: "error",
          source: "persist",
          message: `the data session could not be saved with the document: ${errText(err)}`,
        });
      }
      emit();
    });
    return persistChain;
  }

  /** Drop `data/*.csv` parts the current session no longer names. The session
   *  is not on the undo stack, so no undo step can name one again. */
  async function collectDataParts(): Promise<void> {
    if (!host.supports("storage.parts@2")) return;
    try {
      const built = await buildPersisted();
      if (!built) return;
      const named = new Set(
        built.data.flatMap((d) => {
          const part = dataPartOf(d);
          return part ? [part] : [];
        }),
      );
      for (const rel of await host.parts.list(DATA_PART_DIR)) {
        const path = rel.startsWith(DATA_PART_DIR) ? rel : `${DATA_PART_DIR}${rel}`;
        if (!named.has(path)) {
          await host.parts.delete(path);
          knownDataParts.delete(path);
        }
      }
    } catch (err) {
      report({
        level: "warn",
        source: "persist",
        message: `unused data parts were kept: ${errText(err)}`,
      });
    }
  }

  /** The label a lowering stamps on the content it creates: the binding, the
   *  hash of that binding's definition (its def + its query), and the hash of
   *  the session part it was lowered under (written first, so the hash names a
   *  part that exists). Undo removes the content and its label together. */
  async function stampFor(binding: string): Promise<LowerStamp> {
    lastPayload = undefined;
    await flushPersistInternal();
    // The flush just serialised the recipe; hash the definition from that
    // copy instead of asking the engine for a second one.
    return { binding, def: await definitionHash(binding, lastPayload), session: persistence.hash };
  }

  /** The content hash of one binding's definition and the query it reads, or
   *  null when the engine does not know it. */
  async function definitionHash(binding: string, recipe?: unknown): Promise<string | null> {
    if (!engine) return null;
    const p = (recipe ?? engine.payload()) as {
      bindings?: { id: string; query?: string }[];
      queries?: { id: string }[];
    } | null;
    const def = p?.bindings?.find((b) => b.id === binding);
    if (!def) return null;
    const query = p?.queries?.find((q) => q.id === def.query) ?? null;
    return contentHash(new TextEncoder().encode(JSON.stringify({ def, query })));
  }

  /** Re-read which variable bindings have a field in the document (after a
   *  restore, and after undo/redo, which can add or remove one). */
  async function reconcilePlaced(): Promise<PlaceholderField[] | null> {
    if (!host.supports("document.placeholders@1")) return null;
    let fields: PlaceholderField[];
    try {
      fields = ((await host.document.placeholders()) as readonly PlaceholderField[]).filter(
        (p) => p.plugin === FIELD_PLUGIN,
      );
    } catch {
      return null;
    }
    placedVariables.clear();
    for (const f of fields) if (bindingKinds.get(f.key) === "variable") placedVariables.add(f.key);
    return fields;
  }

  /** Record a diagnostic (bounded: the newest 50 stay) and log it. */
  const DIAGNOSTICS_KEPT = 50;
  function report(d: SessionDiagnostic): void {
    diagnostics.push(d);
    if (diagnostics.length > DIAGNOSTICS_KEPT) {
      diagnostics.splice(0, diagnostics.length - DIAGNOSTICS_KEPT);
    }
    const line = `${d.source}${d.binding ? `(${d.binding})` : ""}: ${d.message}`;
    if (d.level === "info") host.log.info(line);
    else host.log.warn(line);
    emit();
  }

  const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

  /** Our placeholder fields with key `key` (or all of ours), freshly read.
   *  `null` when the read failed — reported against `source`. */
  async function readOwnFields(
    source: SessionDiagnostic["source"],
    key?: string,
  ): Promise<PlaceholderField[] | null> {
    try {
      const all = (await host.document.placeholders()) as readonly PlaceholderField[];
      return all.filter((p) => p.plugin === FIELD_PLUGIN && (key === undefined || p.key === key));
    } catch (err) {
      report({
        level: "error",
        source,
        binding: key,
        message: `could not read the document's fields: ${errText(err)}`,
      });
      return null;
    }
  }

  /** Write `value` into every given field, back to front per story, off the
   *  addresses just read, as ONE mutate — one rebuild and one undo step for
   *  the whole refresh (core applies such a batch atomically). Returns the
   *  number of writes the host applied.
   *
   *  A rejected batch is rolled back whole, and core names the child that
   *  failed ("Mutation::Batch child N"). That write is reported against its
   *  binding and the batch is sent again without it, so one bad field does not
   *  hold back the others (the addresses stay valid: nothing landed). A
   *  rejection that names no child is reported against every write in it. */
  async function writeFields(
    source: SessionDiagnostic["source"],
    writes: readonly { storyId: string; offset: number; key: string; value: string | null }[],
  ): Promise<number> {
    let pending = backToFront(writes);
    const rejected = (w: (typeof pending)[number], err: unknown) =>
      report({
        level: "error",
        source,
        binding: w.key,
        message: `the host rejected the field write at ${w.storyId}:${w.offset} (${errText(err)})`,
      });
    while (pending.length > 0) {
      const ops = pending.map((w) => setFieldValueMutation(w.storyId, w.offset, w.value));
      const out = await host.document.mutate(
        ops.length === 1 ? ops[0]! : { op: "batch", args: { ops } },
      );
      if (out.applied) return pending.length;
      const child = ops.length === 1 ? 0 : failedBatchChild(out.error);
      if (child === null || child >= pending.length) {
        for (const w of pending) rejected(w, out.error);
        return 0;
      }
      rejected(pending[child]!, out.error);
      pending = pending.filter((_, i) => i !== child);
    }
    return 0;
  }

  /** The engine's sync status for a binding (`"linked"`, `"pinned"`, …), or
   *  null when it has none yet. */
  function syncStatus(e: DataEngineLike, id: string): string | null {
    try {
      const st = e.sync_state(id) as { status?: unknown } | null;
      return st && typeof st.status === "string" ? st.status : null;
    } catch {
      return null;
    }
  }

  /** The host's currently-consented origins; [] when the door is unavailable
   *  (network undeclared) — which keeps every remote source inert. */
  function consentedOriginsSafe(): readonly string[] {
    try {
      return host.network.consentedOrigins();
    } catch {
      return [];
    }
  }

  /** §9.9: resolve WHERE each applicable data-set row lands in the live
   *  document. The engine decided the VALUES; only the host knows the addresses:
   *
   *  - text → the placeholder field's `{storyId, offset}`, read FRESH from
   *    `placeholders()` (the host normalises to the run start, and an edit above
   *    the field moves it — a cached offset would write into the wrong run);
   *  - image → the bound rectangle's Self id (from the binding definition);
   *  - visibility → the bound element's typed `ElementId` (the caller's kind, or
   *    resolved from the scene tree).
   *
   *  An address that cannot be resolved is simply ABSENT from the result, which
   *  makes `dataSetPlan` skip that row with a reason. Never invented. */
  async function resolveDataSetTargets(
    applies: readonly DataSetApply[],
  ): Promise<DataSetTargets> {
    const fields: Record<string, { storyId: string; offset: number }> = {};
    const frames: Record<string, string> = {};
    const elements: Record<string, ElementId> = {};

    // Elements without a known kind resolve from ONE scene-tree read.
    const ctx: LowerContext = {};
    const wantsField = applies.some((a) => a.applicable && a.kind === "text");
    if (wantsField && host.supports("document.placeholders@1")) {
      try {
        const placed = (await host.document.placeholders()) as PlaceholderField[];
        for (const p of placed) {
          if (p.plugin !== FIELD_PLUGIN) continue;
          // First occurrence wins: a variable placed twice in a document is a
          // real authoring case, and the refresh loop (refreshFields) updates
          // EVERY copy — this apply path drives the first, then refreshFields
          // brings the rest in line on the next resolve.
          if (!(p.key in fields)) fields[p.key] = { storyId: p.storyId, offset: p.offset };
        }
      } catch (err) {
        host.log.warn(`data set: placeholders() read failed — ${String(err)}`);
      }
    }

    for (const a of applies) {
      if (!a.applicable) continue;
      if (a.kind === "image") {
        const t = imageTargets.get(a.variable);
        if (t) frames[a.variable] = t.elementId;
      } else if (a.kind === "visibility") {
        const t = visibilityTargets.get(a.variable);
        if (!t) continue;
        const el = t.kind
          ? visibilityTarget(t.kind, t.elementId)
          : await resolveElementId(host, t.elementId, ctx);
        if (el) elements[a.variable] = el;
      }
    }
    return { fields, frames, elements };
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
      const e = await bootEngine(today);
      try {
        e.set_locale(locale); // apply the chosen locale to the fresh engine
      } catch (err) {
        report({
          level: "error",
          source: "restore",
          message: `the saved locale "${locale}" is not known to this engine (${errText(err)}); using en`,
        });
        locale = "en";
      }
      engine = e;
      if (bootPayload !== null) {
        const saved = bootPayload;
        bootPayload = null;
        if (typeof e.load_payload === "function") {
          e.load_payload(saved);
        } else {
          report({
            level: "error",
            source: "restore",
            message:
              "the engine wasm predates load_payload — the saved session cannot be loaded (rebuild scripts/build-wasm.sh)",
          });
        }
      }
      for (const d of pendingDefs.splice(0)) defineOnEngine(d.run, d.binding);
      return e;
    } catch (err) {
      state.status = "engine-missing";
      state.message = err instanceof Error ? err.message : ENGINE_NOT_BUILT;
      throw err;
    }
  }

  async function ensureDuck(): Promise<DuckDBHandle> {
    if (duck) return duck;
    try {
      const d = await bootDuckDB();
      duck = d;
      for (const [name, text] of [...pendingCsv]) {
        try {
          await d.registerCsv(name, text);
          pendingCsv.delete(name);
        } catch (err) {
          report({
            level: "error",
            source: "restore",
            message: `the saved source "${name}" could not be loaded into the query engine: ${errText(err)}`,
          });
        }
      }
      for (const [name, f] of [...pendingFiles]) {
        try {
          const e = f.format === "xlsx" ? await ensureEngine() : null;
          await loadIntoDuckDB(d, name, f.format, f.bytes, xlsxReader(e), f.sheet);
          pendingFiles.delete(name);
        } catch (err) {
          report({
            level: "error",
            source: "restore",
            message: `the saved file "${f.fileName}" (source "${name}") could not be loaded into the query engine: ${errText(err)}`,
          });
        }
      }
      return d;
    } catch (err) {
      state.status = "duckdb-missing";
      state.message = err instanceof Error ? err.message : DUCKDB_NOT_VENDORED;
      throw err;
    }
  }

  function sync(): void {
    state.queries = Array.from(queries.keys());
  }

  /** The data engine's worksheet reader (xlsx imports). */
  function xlsxReader(e: DataEngineLike | null): (bytes: Uint8Array, sheet?: string) => XlsxImport {
    return (bytes, sheet) => {
      if (!e || typeof e.xlsx_import !== "function") {
        throw new Error(
          "the engine wasm predates the XLSX reader — rebuild scripts/build-wasm.sh",
        );
      }
      return e.xlsx_import(bytes, sheet) as XlsxImport;
    };
  }

  /** Is this source a remote one, a local one, or unknown? */
  function sourceKind(name: string): "remote" | "file" | null {
    if (remoteSources.has(name)) return "remote";
    return sourceNames.includes(name) ? "file" : null;
  }

  /** Make the running poll timers match the policies: a remote source with
   *  an interval policy whose origin is consented, nothing else. */
  function syncPolling(): void {
    const consented = consentedOriginsSafe();
    const wanted = new Map<string, number>();
    for (const [name, p] of refreshPolicies) {
      const r = remoteSources.get(name);
      if (p.policy === "interval" && r && consented.includes(r.origin)) wanted.set(name, p.secs);
    }
    poller.sync(wanted);
    state.polling = [...wanted.keys()];
  }

  /** One poll of a remote source: fetch again, and re-run the queries when
   *  the content changed. The session part is not rewritten (nothing in it
   *  changed). Stops polling a source whose consent is gone. */
  async function pollRemote(name: string): Promise<void> {
    const r = remoteSources.get(name);
    if (!r) return;
    if (!consentedOriginsSafe().includes(r.origin)) {
      syncPolling();
      return;
    }
    const before = r.contentKey;
    await fetchRemote(name, false);
    if (r.status === "loaded" && r.contentKey !== before && before !== null) {
      await self.refreshData();
      state.message = `Remote source "${name}" changed — data refreshed.`;
    }
    emit();
  }

  /** On open, act on `onOpen` policies: a consented remote source is fetched
   *  again; when any source asks for it, the queries re-run (this boots
   *  DuckDB — the user chose it for this document). Never throws. */
  async function applyOnOpen(): Promise<void> {
    const onOpen = [...refreshPolicies].filter(([, p]) => p.policy === "onOpen").map(([n]) => n);
    if (onOpen.length === 0) return;
    const consented = consentedOriginsSafe();
    for (const name of onOpen) {
      const r = remoteSources.get(name);
      if (r && consented.includes(r.origin)) await fetchRemote(name, false);
    }
    await self.refreshData();
  }

  /** The fetch behind Load and every poll (the consent gate first). */
  async function fetchRemote(name: string, persist: boolean): Promise<void> {
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

      // Hand the bytes to the query lane exactly like an imported file: the
      // source becomes a table named after it, whatever its format.
      const d = await ensureDuck();
      const e = await ensureEngine();
      await loadIntoDuckDB(d, name, r.format, bytes, xlsxReader(e));

      // Define the descriptor on the engine + record the content-hash
      // invalidation key (computed in Rust; the engine never fetches).
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
        refresh: refreshPolicies.get(name) ?? MANUAL,
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
      if (persist) markDirty();
    } catch (err) {
      r.status = "error";
      r.message = err instanceof Error ? err.message : String(err);
      // A fetch the page's network policy refuses rejects with a bare
      // TypeError: say which wall it may be (editor ADR 218 — a deployment
      // lists the data origins its connect-src admits).
      if (err instanceof TypeError) {
        r.message += ` — the editor's network policy may not admit ${r.origin}; consent alone does not open it`;
      }
      report({
        level: "error",
        source: "import",
        message: `remote source "${name}" did not load: ${r.message}`,
      });
    }
  }

  /** Restore the document's `session` part: the engine recipe, the locale and
   *  the sync decisions, the host-side targets, the imported data (registered
   *  in DuckDB on its first boot) and remote descriptors (inert). Then reconcile
   *  with the document: which variable fields are placed, and whether each
   *  recorded table is still there and still labelled with its binding. */
  async function restoreInternal(): Promise<void> {
    if (!partsAvailable()) return;
    let bytes: Uint8Array | null;
    try {
      bytes = await host.parts.read(SESSION_PART);
    } catch (err) {
      report({
        level: "error",
        source: "restore",
        message: `the saved data session could not be read: ${errText(err)}`,
      });
      return;
    }
    if (!bytes) return;
    const saved = decodeSession(bytes);
    if ("error" in saved) {
      report({ level: "error", source: "restore", message: saved.error });
      return;
    }

    // The engine: boot it with the saved recipe, then the user's decisions.
    locale = saved.locale;
    bootPayload = saved.engine;
    let e: DataEngineLike;
    try {
      e = await ensureEngine();
    } catch (err) {
      report({ level: "error", source: "restore", message: `engine unavailable: ${errText(err)}` });
      return;
    }
    for (const d of saved.sync) {
      try {
        if (d.status === "pinned") e.pin(d.binding);
        else e.mark_overridden(d.binding);
      } catch {
        // a decision for a binding the recipe no longer has
      }
    }

    // The session's own view of the recipe, derived from what the engine holds.
    const recipe = (e.payload() ?? {}) as {
      queries?: { id: string; sql: string }[];
      bindings?: { id: string; kind: string }[];
    };
    for (const q of recipe.queries ?? []) queries.set(q.id, { id: q.id, sql: q.sql });
    for (const b of recipe.bindings ?? []) {
      bindingKinds.set(b.id, b.kind as never);
      if (!bindingIds.includes(b.id)) bindingIds.push(b.id);
    }
    for (const [id, t] of Object.entries(saved.targets.image)) imageTargets.set(id, t);
    for (const [id, t] of Object.entries(saved.targets.barcode)) barcodeTargets.set(id, t);
    for (const [id, t] of Object.entries(saved.targets.visibility)) visibilityTargets.set(id, t);
    for (const [id, t] of Object.entries(saved.targets.rule)) ruleTargets.set(id, t);
    for (const [id, el] of Object.entries(saved.targets.lowered)) loweredInto.set(id, el);

    // Imported data: back into DuckDB when it first boots.
    for (const d of saved.data) {
      if (d.format !== "csv") {
        const fileBytes = await loadFile(d, (path) => host.parts.read(path));
        if (fileBytes === null) {
          report({
            level: "error",
            source: "restore",
            message: `the file "${d.fileName}" of source "${d.source}" is missing from the document — import it again`,
          });
          continue;
        }
        const part = dataPartOf(d);
        if (part) knownDataParts.add(part);
        const f: ImportedFile = {
          format: d.format,
          fileName: d.fileName,
          bytes: fileBytes,
          ...(d.sheet !== undefined ? { sheet: d.sheet } : {}),
        };
        importedFiles.set(d.source, f);
        pendingFiles.set(d.source, f);
        if (!sourceNames.includes(d.source)) sourceNames.push(d.source);
        continue;
      }
      const text = await loadData(d, (path) => host.parts.read(path));
      if (text === null) {
        report({
          level: "error",
          source: "restore",
          message: `the data of source "${d.source}" is missing from the document — import it again`,
        });
        continue;
      }
      if ("ref" in d) knownDataParts.add(`${DATA_PART_DIR}${d.ref.hash}.csv`);
      importedCsv.set(d.source, text);
      pendingCsv.set(d.source, text);
      if (!sourceNames.includes(d.source)) sourceNames.push(d.source);
    }

    for (const [name, p] of Object.entries(saved.refresh ?? {})) {
      const policy = readPolicy(p);
      if (policy.policy !== "manual") refreshPolicies.set(name, policy);
    }

    // Remote descriptors come back INERT: nothing fetches on open (§11).
    for (const r of saved.remote) {
      const origin = remoteOrigin(r.url);
      if (!origin) continue;
      remoteSources.set(r.name, {
        name: r.name,
        url: r.url,
        origin,
        format: r.format,
        params: { ...r.params },
        credentialRef: r.credentialRef,
        consent: "required",
        status: "inert",
        message: "Inert — saved with the document; load it to fetch (origin consent first).",
        contentKey: null,
      });
    }

    // Reconcile with the document.
    const fields = await reconcilePlaced();
    if (fields) {
      for (const f of fields) {
        if (bindingKinds.get(f.key) === undefined) {
          report({
            level: "warn",
            source: "restore",
            binding: f.key,
            message: "a data field in the document names a binding the saved session does not have",
          });
        }
      }
    }
    for (const [id, el] of [...loweredInto]) {
      type Label = { data?: { binding?: string; def?: string | null } };
      let label: Label | null = null;
      try {
        label = (await host.document.getMetadata(el)) as Label | null;
      } catch {
        label = null;
      }
      if (!label || !label.data || label.data.binding !== id) {
        loweredInto.delete(id);
        report({
          level: "info",
          source: "restore",
          binding: id,
          message:
            "the content this binding was lowered into is gone or no longer labelled with it — Lower places it again",
        });
        continue;
      }
      const now = await definitionHash(id);
      if (label.data.def && now && label.data.def !== now) {
        report({
          level: "info",
          source: "restore",
          binding: id,
          message: "the document shows this binding as it was defined earlier — Lower updates it",
        });
      }
    }

    lastWritten = new TextDecoder().decode(bytes);
    persistence.hash = await contentHash(bytes);
    persistence.status = "saved";
    state.status = "ready";
    state.message = `Restored ${bindingIds.length} binding(s) over ${sourceNames.length} source(s) from the document.`;
    emit();
    // Refresh policies: interval polling for consented remote sources, and
    // what the document asked to happen on open.
    syncPolling();
    await applyOnOpen();
    emit();
  }

  // Save hook + undo/redo follow-up, held for dispose.
  const hostSubs: Disposable[] = [];
  if (typeof host.document?.onWillSave === "function") {
    hostSubs.push(
      host.document.onWillSave(async () => {
        await flushPersistInternal();
        await collectDataParts();
      }),
    );
  }
  if (typeof host.document?.onDidChange === "function") {
    hostSubs.push(
      host.document.onDidChange((ev) => {
        docChanges += 1;
        // Undo/redo can take a placed field away or bring it back; a stale
        // "placed" would make Lower skip placing it again.
        if (ev.kind === "undoApplied" || ev.kind === "redoApplied") void reconcilePlaced();
      }),
    );
  }

  /** Re-resolve one variable binding and write its placed field(s) — the
   *  single-binding half of `refreshFields`, for accept-source, a changed
   *  locale and a changed display pattern. The caller decided the write is
   *  wanted (it does not read the sync state). */
  async function writeVariable(id: string): Promise<number | null> {
    const e = await ensureEngine();
    const fields = await readOwnFields("refresh", id);
    if (fields === null) return null;
    let value: string | null;
    try {
      const lowered = e.resolve_lowered(id) as { kind?: string; text?: string; hidden?: boolean } | null;
      if (lowered?.kind !== "variable") return 0;
      value = lowered.hidden ? null : (lowered.text ?? null);
    } catch (err) {
      report({ level: "warn", source: "refresh", binding: id, message: `did not resolve: ${errText(err)}` });
      return null;
    }
    const writes = fields
      .filter((f) => f.value !== value)
      .map((f) => ({ storyId: f.storyId, offset: f.offset, key: id, value }));
    return writeFields("refresh", writes);
  }

  const self: DataSourceSession = {
    ...reviewMethods({
      host,
      ensureEngine,
      listBindings: () => self.listBindings(),
      ruleTargets,
      setPinned: (id, pinned) => self.setPinned(id, pinned),
      lowerBinding: (id) => self.lowerBinding(id),
      writeVariable,
      markDirty,
      report,
      emit,
    }),

    getState() {
      return {
        ...state,
        sources: [...sourceNames],
        queries: Array.from(queries.keys()),
        bindings: [...bindingIds],
        remote: remoteSnapshot(),
        diagnostics: diagnostics.map((d) => ({ ...d })),
        persistence: { ...persistence },
        files: [
          ...Array.from(csvFileNames, ([source, f]) => ({ source, ...f })),
          ...Array.from(importedFiles, ([source, f]) => ({
            source,
            format: f.format,
            fileName: f.fileName,
            ...(f.sheet !== undefined ? { sheet: f.sheet } : {}),
            ...(f.sheets !== undefined ? { sheets: [...f.sheets] } : {}),
          })),
        ],
        refresh: Object.fromEntries(refreshPolicies),
        polling: [...state.polling],
      };
    },

    clearDiagnostics() {
      diagnostics.length = 0;
      emit();
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
        importedCsv.set(name, csvText);
        pendingCsv.delete(name);
        state.status = "ready";
        state.message = `Source "${name}" registered.`;
        markDirty();
      } catch (err) {
        // Keep the more specific engine-missing / duckdb-missing status the
        // boot helpers set; anything else is an import error.
        if (state.status !== "engine-missing" && state.status !== "duckdb-missing") {
          state.status = "error";
        }
        state.message = `Import of "${name}" failed: ${errText(err)}`;
        report({ level: "error", source: "import", message: state.message });
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
      markDirty();
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
      await fetchRemote(name, true);
      syncPolling();
      emit();
    },

    addQuery(id, sql, shape) {
      queries.set(id, { id, sql });
      defineOnEngine((e) => e.define_query({ id, sql, params: [], shape: { shape } }));
      sync();
      markDirty();
    },

    async importFile(fileName, bytes, options) {
      const format = formatOfFile(fileName);
      const name = options?.name ?? sourceNameOf(fileName);
      if (!format) {
        const error = `"${fileName}" is not a file the data plugin imports (CSV, TSV, JSON, Parquet or XLSX)`;
        report({ level: "error", source: "import", message: error });
        return { source: name, format: null, error };
      }
      if (format === "csv" || format === "tsv") {
        const text = new TextDecoder().decode(bytes);
        const before = diagnostics.length;
        await this.registerCsvSource(name, text);
        if (importedCsv.get(name) !== text) {
          const error = diagnostics.slice(before).find((d) => d.source === "import")?.message ??
            `Import of "${name}" failed`;
          return { source: name, format, error };
        }
        importedFiles.delete(name);
        pendingFiles.delete(name);
        csvFileNames.set(name, { format, fileName });
        emit();
        return { source: name, format };
      }
      try {
        const d = await ensureDuck();
        const e = await ensureEngine();
        const out = await loadIntoDuckDB(d, name, format, bytes, xlsxReader(e), options?.sheet);
        e.define_source({
          id: name,
          kind: { kind: "file", format: format === "xlsx" ? "excel" : format, name: fileName },
          capability: "file-import",
          refresh: refreshPolicies.get(name) ?? MANUAL,
        });
        importedFiles.set(name, {
          format,
          fileName,
          bytes,
          ...(out.sheet !== undefined ? { sheet: out.sheet } : {}),
          ...(out.sheets !== undefined ? { sheets: out.sheets } : {}),
        });
        pendingFiles.delete(name);
        importedCsv.delete(name);
        pendingCsv.delete(name);
        csvFileNames.delete(name);
        if (!sourceNames.includes(name)) sourceNames.push(name);
        state.status = "ready";
        state.message =
          `Source "${name}" imported from ${fileName}` +
          (out.sheet !== undefined ? ` (worksheet "${out.sheet}")` : "") +
          ".";
        if (out.errorCells) {
          report({
            level: "warn",
            source: "import",
            message: `${out.errorCells} error cell(s) in ${fileName} were read as empty`,
          });
        }
        markDirty();
        return {
          source: name,
          format,
          ...(out.sheet !== undefined ? { sheet: out.sheet } : {}),
          ...(out.sheets !== undefined ? { sheets: out.sheets } : {}),
        };
      } catch (err) {
        if (state.status !== "engine-missing" && state.status !== "duckdb-missing") {
          state.status = "error";
        }
        const error = `Import of "${fileName}" failed: ${errText(err)}`;
        state.message = error;
        report({ level: "error", source: "import", message: error });
        return { source: name, format, error };
      }
    },

    async selectSheet(source, sheet) {
      const f = importedFiles.get(source);
      if (!f || f.format !== "xlsx") {
        const error = `"${source}" is not an imported workbook`;
        report({ level: "error", source: "import", message: error });
        return { source, format: f?.format ?? null, error };
      }
      return this.importFile(f.fileName, f.bytes, { name: source, sheet });
    },

    async describeSource(source) {
      if (!sourceNames.includes(source)) return [];
      try {
        const d = await ensureDuck();
        const desc = await d.rows(`DESCRIBE ${quoteIdent(source)}`);
        return desc.rows.map((r) => ({ name: r[0] ?? "", type: r[1] ?? "" }));
      } catch (err) {
        report({
          level: "warn",
          source: "query",
          message: `the columns of "${source}" could not be read: ${errText(err)}`,
        });
        return [];
      }
    },

    async previewQuery(sql, limit = 50) {
      const empty = { columns: [], rows: [], total: null };
      let d: DuckDBHandle;
      try {
        d = await ensureDuck();
      } catch (err) {
        return { ...empty, diagnostic: { kind: "Engine", message: errText(err) } };
      }
      const refused = checkQuery(sql);
      if (refused) return { ...empty, diagnostic: refused };
      try {
        const limited = previewSql(sql, limit);
        const desc = await d.rows(`DESCRIBE ${limited}`);
        const columns = desc.rows.map((r) => ({ name: r[0] ?? "", type: r[1] ?? "" }));
        // DuckDB renders every value (dates, decimals with their scale, …)
        // the way it would print them.
        const shown = await d.rows(`SELECT COLUMNS(*)::VARCHAR FROM (${limited})`);
        const count = await d.rows(`SELECT count(*) FROM (\n${sql.replace(/[\s;]+$/, "")}\n)`);
        const total = Number(count.rows[0]?.[0] ?? NaN);
        return {
          columns,
          rows: shown.rows,
          total: Number.isFinite(total) ? total : null,
          diagnostic: null,
        };
      } catch (err) {
        return { ...empty, diagnostic: diagnoseDuckDBError(err, 1) };
      }
    },

    async saveQuery(id, sql, shape = "recordStream") {
      let d: DuckDBHandle;
      try {
        d = await ensureDuck();
      } catch (err) {
        return { kind: "Engine", message: errText(err) };
      }
      const refused = checkQuery(sql);
      if (refused) return refused;
      try {
        await d.rows(`DESCRIBE ${previewSql(sql, 0)}`);
      } catch (err) {
        return diagnoseDuckDBError(err, 1);
      }
      this.addQuery(id, sql.replace(/[\s;]+$/, "").trim(), shape);
      return null;
    },

    listQueries() {
      return Array.from(queries.values(), (q) => ({ id: q.id, sql: q.sql }));
    },

    setRefreshPolicy(source, policy) {
      const kind = sourceKind(source);
      if (!kind) return `no source named "${source}"`;
      const refused = refusePolicy(kind, policy);
      if (refused) return refused;
      if (policy.policy === "manual") refreshPolicies.delete(source);
      else refreshPolicies.set(source, policy);
      // Mirror it into the engine's source definition (the recipe model).
      if (engine) {
        try {
          const p = engine.payload() as { sources?: { id: string }[] } | null;
          const def = p?.sources?.find((x) => x.id === source);
          if (def) engine.define_source({ ...def, refresh: policy });
        } catch {
          // the session map is what acts on the policy
        }
      }
      syncPolling();
      markDirty();
      return null;
    },

    getRefreshPolicy(source) {
      return refreshPolicies.get(source) ?? MANUAL;
    },

    addVariableBinding(id, target, query, expr) {
      if (expr.trim() === "") {
        report({
          level: "warn",
          source: "binding",
          binding: id,
          message: "the binding has an empty expression — it resolves to nothing; bind a field",
        });
      }
      defineOnEngine(
        (e) =>
          e.define_binding({
            id,
            kind: "variable",
            target,
            query,
            expr,
            missing: { missing: "blank" },
          }),
        id,
      );
      bindingKinds.set(id, "variable");
      if (!bindingIds.includes(id)) bindingIds.push(id);
      markDirty();
    },

    addTableBinding(id, region, query, columns) {
      defineOnEngine(
        (e) =>
          e.define_binding({
            id,
            kind: "table",
            region,
            query,
            columns: columns.map((c) => ({ header: c.header, expr: c.expr, style: null })),
            options: { header_row: true, group_by: [] },
          }),
        id,
      );
      bindingKinds.set(id, "table");
      if (!bindingIds.includes(id)) bindingIds.push(id);
      markDirty();
    },

    addImageBinding(id, target, query, expr, options) {
      defineOnEngine(
        (e) =>
          e.define_binding({
            id,
            kind: "image",
            target,
            query,
            expr,
            // ImgPolicy: { fit, missing } — the engine's ImgFit drives the default
            // placement vocab; the explicit IDML `fit` (options.fit) overrides at
            // commit time. Map the IDML choice back to the engine ImgFit when given.
            policy: { fit: engineFit(options?.fit), missing: options?.missing ?? "skip" },
          }),
        id,
      );
      bindingKinds.set(id, "image");
      imageTargets.set(id, { elementId: target, fit: options?.fit });
      if (!bindingIds.includes(id)) bindingIds.push(id);
      markDirty();
    },

    addBarcodeBinding(id, target, query, symbology, expr, options) {
      defineOnEngine(
        (e) =>
          e.define_binding({
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
          }),
        id,
      );
      bindingKinds.set(id, "barcode");
      barcodeTargets.set(id, { elementId: target });
      if (!bindingIds.includes(id)) bindingIds.push(id);
      markDirty();
    },

    addVisibilityBinding(id, target, query, expr, options) {
      defineOnEngine(
        (e) =>
          e.define_binding({
            id,
            kind: "visibility",
            target,
            query,
            expr,
            options: { invert: options?.invert ?? false, missing: options?.missing ?? "hide" },
          }),
        id,
      );
      bindingKinds.set(id, "visibility");
      visibilityTargets.set(id, { elementId: target, kind: options?.kind });
      if (!bindingIds.includes(id)) bindingIds.push(id);
      markDirty();
    },

    addRuleBinding(id, scope, query, when, apply, target) {
      defineOnEngine((e) => e.define_binding({ id, kind: "rule", scope, when, apply }), id);
      bindingKinds.set(id, "rule");
      ruleTargets.set(id, { query, target });
      if (!bindingIds.includes(id)) bindingIds.push(id);
      markDirty();
    },

    // ── §9.9 variables + data sets ──────────────────────────────────────────

    async variables() {
      let e: DataEngineLike;
      try {
        e = await ensureEngine();
      } catch (err) {
        report({ level: "error", source: "variables", message: `engine unavailable: ${errText(err)}` });
        return [];
      }
      if (typeof e.variables !== "function") {
        report({
          level: "info",
          source: "variables",
          message: "the engine wasm predates the variables lane — rebuild it (scripts/build-wasm.sh)",
        });
        return [];
      }
      try {
        const set = e.variables() as { variables?: VariableSummary[] } | null;
        const decls = (set?.variables ?? []) as { name: string; trait: string }[];
        return decls.map((d) => ({
          name: d.name,
          trait: d.trait as VariableSummary["trait"],
          bound: bindingIds.includes(d.name),
        }));
      } catch (err) {
        report({ level: "error", source: "variables", message: errText(err) });
        return [];
      }
    },

    async captureDataSet(name, record = 0) {
      try {
        const e = await ensureEngine();
        if (typeof e.capture_data_set !== "function") {
          state.message =
            "The engine wasm predates the variables lane — rebuild it (scripts/build-wasm.sh).";
          return [];
        }
        e.capture_data_set(name, record);
        markDirty();
        const names = await this.listDataSets();
        state.status = "ready";
        state.message = `Captured data set "${name}" (record ${record + 1}).`;
        return names;
      } catch (err) {
        state.status = "error";
        state.message = err instanceof Error ? err.message : String(err);
        host.log.warn(`captureDataSet(${name}): ${state.message}`);
        return [];
      }
    },

    async captureEveryRecord(queryId, options) {
      try {
        const e = await ensureEngine();
        if (typeof e.capture_every_record !== "function") {
          state.message =
            "The engine wasm predates the variables lane — rebuild it (scripts/build-wasm.sh).";
          return [];
        }
        const names =
          (e.capture_every_record(
            queryId,
            options?.prefix ?? "Data Set",
            options?.nameColumn,
          ) as string[] | null) ?? [];
        markDirty();
        // D-08: captured data sets are the only payload half that grows with the
        // record count. Say so BEFORE the document cannot be saved, not after.
        const bytes = await this.dataSetPayloadBytes();
        const CAP = 64 * 1024;
        state.status = "ready";
        state.message =
          `Captured ${names.length} data set(s) from "${queryId}".` +
          (bytes > CAP * 0.8
            ? ` WARNING: the variable payload is ${bytes} bytes of the ${CAP}-byte ` +
              "document-metadata cap (D-08) — delete data sets or capture fewer records."
            : "");
        return names;
      } catch (err) {
        state.status = "error";
        state.message = err instanceof Error ? err.message : String(err);
        host.log.warn(`captureEveryRecord(${queryId}): ${state.message}`);
        return [];
      }
    },

    async listDataSets() {
      try {
        const e = await ensureEngine();
        if (typeof e.list_data_sets !== "function") return [];
        return (e.list_data_sets() as string[] | null) ?? [];
      } catch {
        return [];
      }
    },

    async deleteDataSet(name) {
      try {
        const e = await ensureEngine();
        if (typeof e.delete_data_set !== "function") return false;
        const removed = e.delete_data_set(name);
        if (removed) markDirty();
        return removed;
      } catch {
        return false;
      }
    },

    async applyDataSet(name) {
      const none = { applied: 0, skipped: {} as Record<string, string> };
      let e: DataEngineLike;
      try {
        e = await ensureEngine();
      } catch (err) {
        state.status = "error";
        state.message = err instanceof Error ? err.message : String(err);
        return none;
      }
      if (typeof e.apply_data_set !== "function") {
        state.message =
          "The engine wasm predates the variables lane — rebuild it (scripts/build-wasm.sh).";
        return none;
      }
      try {
        const applies = (e.apply_data_set(name) as DataSetApply[] | null) ?? [];
        // The engine decided WHAT; the host knows WHERE. Resolve each applicable
        // row's address from the live document, then commit the lot as ONE batch.
        const targets = await resolveDataSetTargets(applies);
        const plan = dataSetPlan(applies, targets);
        const result = await commitDataSet(host, plan);
        state.status = "ready";
        const skippedCount = Object.keys(result.skipped).length;
        state.message =
          `Applied data set "${name}": ${result.applied} variable(s) in one undo step` +
          (skippedCount > 0 ? `, ${skippedCount} skipped.` : ".");
        return result;
      } catch (err) {
        state.status = "error";
        state.message = err instanceof Error ? err.message : String(err);
        host.log.warn(`applyDataSet(${name}): ${state.message}`);
        return none;
      }
    },

    async exportVariableLibrary() {
      try {
        const e = await ensureEngine();
        if (typeof e.export_variable_library !== "function") return "";
        return e.export_variable_library();
      } catch (err) {
        host.log.warn(`exportVariableLibrary: ${String(err)}`);
        return "";
      }
    },

    async importVariableLibrary(xml) {
      const empty: ImportReport = {
        setName: "",
        variables: 0,
        dataSets: 0,
        unbound: [],
        graphOnly: [],
      };
      let e: DataEngineLike;
      try {
        e = await ensureEngine();
      } catch (err) {
        state.status = "error";
        state.message = err instanceof Error ? err.message : String(err);
        return empty;
      }
      if (typeof e.import_variable_library !== "function") {
        state.message =
          "The engine wasm predates the variables lane — rebuild it (scripts/build-wasm.sh).";
        return empty;
      }
      try {
        const report = (e.import_variable_library(xml) as ImportReport | null) ?? empty;
        markDirty();
        state.status = "ready";
        state.message =
          `Imported "${report.setName}": ${report.variables} variable(s), ` +
          `${report.dataSets} data set(s).` +
          (report.unbound.length > 0
            ? ` Not bound in this document (will be skipped): ${report.unbound.join(", ")}.`
            : "") +
          (report.graphOnly.length > 0
            ? ` Graph-data variables are carried but never applied: ${report.graphOnly.join(", ")}.`
            : "");
        return report;
      } catch (err) {
        state.status = "error";
        state.message = err instanceof Error ? err.message : String(err);
        host.log.warn(`importVariableLibrary: ${state.message}`);
        return empty;
      }
    },

    async dataSetPayloadBytes() {
      try {
        const e = await ensureEngine();
        if (typeof e.data_set_payload_bytes !== "function") return 0;
        return e.data_set_payload_bytes();
      } catch {
        return 0;
      }
    },

    async refreshData() {
      try {
        const e = await ensureEngine();
        const d = await ensureDuck();
        for (const q of queries.values()) {
          // A document's queries are code (§11): only a SELECT over the
          // source tables runs (query/sql.ts).
          const refused = checkQuery(q.sql);
          if (refused) {
            report({
              level: "error",
              source: "query",
              message: `query "${q.id}" was not run: ${refused.message}`,
            });
            continue;
          }
          try {
            // Typed column buffers (one copy per column); a re-delivery of the
            // same data is recognised by the engine and decodes nothing.
            if (typeof d.queryColumns === "function") {
              ingestColumnBatch(e, q.id, await d.queryColumns(q.sql));
            } else {
              e.ingest_result(q.id, await d.query(q.sql));
            }
          } catch (err) {
            const diag = diagnoseDuckDBError(err);
            report({
              level: "error",
              source: "query",
              message: `query "${q.id}" failed — ${diag.kind}: ${diag.message}`,
            });
            continue;
          }
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
        if (bindingKinds.get(id) === "recordFlow") {
          // Wave 5: the paginated flow becomes frames, one per page from the
          // active page on; a re-lower replaces the previous frames and the
          // pages it added (relower.ts) in the same first batch.
          const page = await startPage();
          if (!page) {
            report({ level: "error", source: "flow", binding: id, message: "no page to lower the record flow onto" });
            return;
          }
          const plan = await relowerPlan({ kind: "recordFlow", binding: id });
          const res = await commitRecordFlow(host, e, id, page as never, plan.remove);
          for (const d of res.diagnostics) report({ level: res.ok ? "warn" : "error", source: "flow", binding: id, message: d });
          if (res.ok && res.frames[0]) {
            loweredInto.set(id, res.frames[0]);
            markDirty();
          }
          state.status = res.ok ? "ready" : "error";
          state.message = `Record flow "${id}": ${res.frames.length} frame(s) on ${res.pages.length} page(s).`;
          return;
        }
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
          if (bc) {
            const plan = await relowerPlan({ kind: "barcode", binding: id }, barcodeMinted.get(id));
            await commitLoweredBarcode(host, bc, tgt?.elementId ?? null, await stampFor(id), {
              clear: plan.remove,
              onMinted: (ids) => barcodeMinted.set(id, ids),
            });
          }
          state.status = "ready";
          state.message = `Resolved + lowered barcode "${id}".`;
          return;
        }
        const lowered = e.resolve_lowered(id) as { kind?: string } | null;
        if (lowered?.kind === "table") {
          const plan = await relowerPlan({ kind: "table", binding: id });
          const known = tableAt.get(id);
          const inPlace =
            known && plan.reuse && plan.reuse.id === known.frame.id ? known : undefined;
          // A labelled frame whose table we cannot address goes, too.
          const clear = [...plan.remove];
          if (plan.reuse && !inPlace) clear.push({ op: "deleteFrame", args: { frameId: plan.reuse.id as string } });
          const frameId = await commitLoweredTable(host, lowered as never, await stampFor(id), lowerCtx, {
            inPlace,
            clear,
            onTable: (at) => tableAt.set(id, at),
          });
          if (frameId) {
            loweredInto.set(id, { kind: "textFrame", id: frameId } as ElementId);
            markDirty();
          }
        } else if (lowered?.kind === "variable") {
          // D-01: place the variable as a tagged placeholder field ONCE (keyed by
          // the binding id), then re-resolve it through the placeholders() loop.
          if (!placedVariables.has(id)) {
            if (lowerCtx?.variables) {
              // lowerAll: planned now, placed with the others in ONE batch.
              lowerCtx.variables.push({ variable: lowered as never, key: id });
            } else {
              const placed = await commitLoweredVariable(host, lowered as never, id, null, lowerCtx);
              if (placed) placedVariables.add(id);
            }
          } else if (lowerCtx) {
            // Already placed: the command re-resolves the live fields once.
            lowerCtx.refreshFields = true;
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
        } else if (lowered?.kind === "visibility") {
          // §9.8: show/hide the bound element via its own elementVisible property.
          const tgt = visibilityTargets.get(id);
          const el = tgt?.kind ? visibilityTarget(tgt.kind, tgt.elementId) : null;
          await commitLoweredVisibility(host, lowered as never, el, lowerCtx);
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
      // One command: its lowerings share one read of the active page.
      // Variables are planned first and placed together: one batch, one undo
      // step for the whole command (budget W5).
      const ctx: LowerContext = { variables: [] };
      lowerCtx = ctx;
      try {
        for (const id of [...bindingIds]) {
          await this.lowerBinding(id);
        }
        const placed = await commitLoweredVariables(host, ctx.variables!, ctx);
        for (const key of placed.keys()) placedVariables.add(key);
      } finally {
        lowerCtx = undefined;
      }
      if (ctx.refreshFields) await this.refreshFields();
      // The document is now written from these results: the row diff's "before".
      await this.markApplied();
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
        // Rules and record flows have no per-record value to step through.
        if (kind === "rule" || kind === "recordFlow") return;

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
          if (bc) {
            // Update in place: the previous step's symbol goes in the same batch.
            const plan = await relowerPlan({ kind: "barcode", binding: bindingId }, barcodeMinted.get(bindingId));
            await commitLoweredBarcode(host, bc, tgt?.elementId ?? null, await stampFor(bindingId), {
              clear: plan.remove,
              onMinted: (ids) => barcodeMinted.set(bindingId, ids),
            });
          }
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
        // A table renders its whole result whatever the record index, so a
        // preview step has nothing new to show — and committing it again would
        // insert a second table frame per step. Leave it to Lower.
        if (kind === "table") {
          state.status = "ready";
          state.message = `Preview: table "${bindingId}" shows every record — nothing to step.`;
          return;
        }
        const lowered = resolveAt(bindingId) as { kind?: string } | null;
        if (lowered?.kind === "variable") {
          const v = lowered as { hidden?: boolean; text?: string };
          const value = v.hidden ? null : (v.text ?? null);
          // An offset is valid only until the next edit, so a cached one writes
          // into whatever now sits there (measured: another plugin's field,
          // test/field-offsets-real-core). The addresses are re-read unless
          // the ONLY change since the last read is this preview's own write:
          // the document-change count moved by exactly that one mutate, and
          // each story holds one copy of the field, so the write moved no
          // address the next step uses.
          const reuse =
            previewFields?.binding === bindingId &&
            previewFields.changes === docChanges &&
            previewFields.doc === docEpoch;
          const fields = reuse ? previewFields!.fields : await readOwnFields("preview", bindingId);
          previewFields = null;
          if (fields === null) return;
          if (fields.length > 0) {
            const stale = fields.filter((f) => f.value !== value);
            const before = docChanges;
            const written = await writeFields(
              "preview",
              stale.map((f) => ({ storyId: f.storyId, offset: f.offset, key: bindingId, value })),
            );
            const oneCopyPerStory = new Set(fields.map((f) => f.storyId)).size === fields.length;
            const onlyOurWrite = stale.length === 0 || (written === stale.length && docChanges === before + 1);
            if (oneCopyPerStory && onlyOurWrite) {
              previewFields = {
                binding: bindingId,
                changes: docChanges,
                doc: docEpoch,
                fields: fields.map((f) => ({ ...f, value })),
              };
            }
          } else if (!placedVariables.has(bindingId)) {
            // Not in the document yet: place it once (the normal lower lane).
            const placed = await commitLoweredVariable(host, lowered as never, bindingId);
            if (placed) placedVariables.add(bindingId);
          } else {
            // Placed earlier and since removed from the document. Placing it
            // again on every step would mint a frame per step; say so instead.
            report({
              level: "warn",
              source: "preview",
              binding: bindingId,
              message: "the field is no longer in the document — Lower places it again",
            });
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
      // D-01 refresh loop: ONE fresh placeholders() read, resolve each of our
      // fields against its binding, then write the changed values BACK TO
      // FRONT per story (see backToFront: core addresses a field by its run
      // start, and a write shifts every later field in the story). Pinned and
      // Overridden bindings are skipped before they are resolved, because a
      // resolve re-links (ADR 553).
      if (!host.supports("document.placeholders@1")) {
        report({
          level: "warn",
          source: "refresh",
          message: "the host predates the placeholder field model (document.placeholders@1)",
        });
        return 0;
      }
      let e: DataEngineLike;
      try {
        e = await ensureEngine();
      } catch (err) {
        report({ level: "error", source: "refresh", message: `engine unavailable: ${errText(err)}` });
        return 0;
      }
      const fields = await readOwnFields("refresh");
      if (fields === null) return 0;

      const writes: { storyId: string; offset: number; key: string; value: string | null }[] = [];
      // Resolve each binding once, however many copies of its field exist —
      // all of them in ONE engine call when the wasm has it.
      const resolved = new Map<string, { value: string | null } | "kept" | "failed" | "same">();
      const ours = fields.filter((f) => bindingKinds.get(f.key) === "variable");
      if (typeof e.refresh_field_values === "function" && ours.length > 0) {
        let decided: FieldRefreshOut[] = [];
        try {
          decided = (e.refresh_field_values([...new Set(ours.map((f) => f.key))]) as FieldRefreshOut[] | null) ?? [];
        } catch (err) {
          report({ level: "error", source: "refresh", message: `the engine could not resolve the fields: ${errText(err)}` });
          return 0;
        }
        for (const d of decided) {
          if (d.outcome === "value") resolved.set(d.binding, { value: d.value ?? null });
          else if (d.outcome === "kept") resolved.set(d.binding, "kept");
          else if (d.outcome === "notVariable") resolved.set(d.binding, "same");
          else {
            report({
              level: "warn",
              source: "refresh",
              binding: d.binding,
              message: `did not resolve — the field keeps its value: ${d.error ?? "unknown error"}`,
            });
            resolved.set(d.binding, "failed");
          }
        }
      }
      for (const f of ours) {
        let r = resolved.get(f.key);
        if (r === undefined) {
          const status = syncStatus(e, f.key);
          if (status === "pinned" || status === "overridden") {
            r = "kept";
          } else {
            try {
              const lowered = e.resolve_lowered(f.key) as
                | { kind?: string; text?: string; hidden?: boolean }
                | null;
              r =
                lowered?.kind === "variable"
                  ? { value: lowered.hidden ? null : (lowered.text ?? null) }
                  : { value: f.value };
            } catch (err) {
              report({
                level: "warn",
                source: "refresh",
                binding: f.key,
                message: `did not resolve — the field keeps its value: ${errText(err)}`,
              });
              r = "failed";
            }
          }
          resolved.set(f.key, r);
        }
        if (r === "kept" || r === "failed" || r === "same") continue;
        if (r.value === f.value) continue; // minimal: only changed → a write
        writes.push({ storyId: f.storyId, offset: f.offset, key: f.key, value: r.value });
      }

      const written = await writeFields("refresh", writes);
      await this.markApplied();
      const kept = [...resolved.values()].filter((r) => r === "kept").length;
      state.status = "ready";
      state.message =
        `Refreshed ${written} field(s) from the live data.` +
        (kept > 0 ? ` Left ${kept} pinned/overridden binding(s) unchanged.` : "");
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

    subscribeChainReflow(bindingId, storyId, onRepaginate, options) {
      // D-12: re-paginate when the chain's content boxes resize. A reflow event
      // carries ONLY a resize (never a transform, §8.5), so a transform-only
      // change is ignored — exactly the pagination consumer contract.
      //
      // Coalesced: a drag-resize streams one event per step, and each
      // re-pagination is a full resolve + sort of the flow, of which only the
      // last result is ever shown. So the events of a burst only (re)arm a
      // trailing timer; the chain is read and paginated once it is quiet. An
      // event that arrives while a pagination runs schedules one more after it.
      //
      // Only THIS chain: an event for a frame that is not in the chain read
      // last time is ignored. Any other document change may have relinked the
      // chain, so it forgets the frame set and the next resize counts.
      const delayMs = options?.delayMs ?? 16;
      const timers = options?.timers ?? {
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
      };
      let chainFrames: Set<string> | null = null;
      let timer: unknown = null;
      let running = false;
      let again = false;
      let disposed = false;
      const run = async () => {
        running = true;
        try {
          const e = await ensureEngine();
          const chain = await readLiveChain(host, storyId);
          chainFrames = new Set(chain.map((c) => c.frame));
          if (!disposed) onRepaginate(e.lower_record_flow(bindingId, chain, undefined));
        } catch (err) {
          host.log.warn(`subscribeChainReflow(${bindingId}): ${String(err)}`);
        } finally {
          running = false;
          if (again && !disposed) {
            again = false;
            schedule();
          }
        }
      };
      const schedule = () => {
        if (running) {
          again = true;
          return;
        }
        if (timer !== null) timers.clearTimeout(timer);
        timer = timers.setTimeout(() => {
          timer = null;
          void run();
        }, delayMs);
      };
      const sub = host.document.onDidChange((ev) => {
        if (!ev.reflow) {
          chainFrames = null; // the chain may have changed; re-learn it
          return;
        }
        if (chainFrames && !chainFrames.has(ev.reflow.frameId)) return; // another chain
        schedule();
      });
      return {
        dispose: () => {
          disposed = true;
          if (timer !== null) timers.clearTimeout(timer);
          timer = null;
          sub.dispose();
        },
      };
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

      // D-09: the registry door exists in the contract; a host that injects it
      // answers `supports("dataProviders@1")`.
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
            "ready, but this host injects no host.dataProviders registry — nothing " +
            "registered, never faked.",
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
      if (engine) {
        try {
          engine.set_locale(next);
        } catch (err) {
          report({ level: "error", source: "binding", message: `unknown locale "${next}": ${errText(err)}` });
          return;
        }
      }
      locale = next;
      markDirty();
    },

    getLocale() {
      return locale;
    },

    isProviderRegistered(providerId) {
      return providerHandles.has(providerId);
    },

    listBindings() {
      return bindingIds.map((id) => ({ id, kind: bindingKinds.get(id) ?? "?" }));
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

    defineRecordFlow(id, query, fields, options) {
      const template = `${id}.template`;
      if (fields.length === 0 || fields.every((f) => f.expr.trim() === "")) {
        report({
          level: "warn",
          source: "binding",
          binding: id,
          message: "the record flow has no field — each record would render empty; add a field",
        });
      }
      defineOnEngine(
        (e) =>
          e.define_template({
            id: template,
            fields: fields.map((f) => ({ label: f.label ?? "", expr: f.expr })),
            lineHeightPt: options?.lineHeightPt ?? 12,
          }),
        id,
      );
      defineOnEngine(
        (e) =>
          e.define_binding({
            id,
            kind: "recordFlow",
            chain: options?.chain ?? "chain",
            query,
            template,
            options: {
              groupBy: options?.groupBy ?? [],
              repeatHeader: true,
              continuedMarker: true,
            },
          }),
        id,
      );
      bindingKinds.set(id, "recordFlow");
      if (!bindingIds.includes(id)) bindingIds.push(id);
      markDirty();
    },

    async mergeRecords(options) {
      const fail = (message: string): MergeResult => {
        report({ level: "error", source: "flow", message: `merge: ${message}` });
        state.status = "error";
        state.message = `Merge failed: ${message}`;
        emit();
        return { ok: false, plan: null, pages: [], records: [], overset: [], mutateCalls: 0, diagnostics: [message] };
      };
      let e: DataEngineLike;
      try {
        e = await ensureEngine();
      } catch (err) {
        return fail(`engine unavailable: ${errText(err)}`);
      }
      if (!e.plan_merge || !e.merge_words || !e.merge_overset) {
        return fail("this engine build has no merge lane — rebuild the data-js wasm");
      }
      if (!queries.has(options.query)) return fail(`no query "${options.query}"`);
      // The merge reads the query's result as delivered: run it if it has none.
      if ((e.query_record_count?.(options.query) ?? 0) === 0) {
        await this.refreshData();
        if (state.status === "error" && (e.query_record_count?.(options.query) ?? 0) === 0) {
          return fail(`the query did not run: ${state.message}`);
        }
      }

      const mergeId = options.mergeId ?? `merge-${options.query}`;
      const mode = options.template ?? "keep";
      const pageId = options.pageId ?? (await startPage());
      if (!pageId) return fail("no template page");
      // A consumed template is gone from its page; a re-merge reuses the one
      // read last time.
      let template = mode === "consume" ? (mergeTemplates.get(mergeId) ?? null) : null;
      const templatePresent = template === null;
      if (!template) {
        const read = await readMergeTemplate(host, { pageId: pageId as never, imageFields: options.imageFields });
        if (!read.template) return fail(read.diagnostics.join("; ") || "no template on the page");
        template = read.template;
      }
      // Replace the previous run of this merge in the first batch.
      const plan = await relowerPlan({ kind: "merge", merge: mergeId });
      const engineForMerge = e as Required<Pick<DataEngineLike, "plan_merge" | "merge_words" | "merge_overset">>;
      const result = await writeMerge(host, engineForMerge, template, {
        query: options.query,
        recordsPerPage: options.recordsPerPage ?? { mode: "single" },
        removeBlankLines: options.removeBlankLines ?? false,
        template: mode,
        imageBase: options.imageBase,
        mergeId,
        clear: plan.remove,
        templatePresent,
      });
      if (result.ok) mergeTemplates.set(mergeId, template);
      for (const d of result.diagnostics) {
        report({ level: result.ok ? "warn" : "error", source: "flow", message: d });
      }
      state.status = result.ok ? "ready" : "error";
      state.message = result.ok
        ? `Merged ${result.records.length} record(s) onto ${result.pages.length} page(s)` +
          (result.overset.length ? `, ${result.overset.length} overset.` : ".")
        : "Merge failed.";
      emit();
      return result;
    },

    async previewRecordFlow(id) {
      if (bindingKinds.get(id) !== "recordFlow") {
        report({
          level: "error",
          source: "flow",
          binding: id,
          message: "not a record-flow binding",
        });
        return null;
      }
      let e: DataEngineLike;
      try {
        e = await ensureEngine();
      } catch (err) {
        report({
          level: "error",
          source: "flow",
          binding: id,
          message: `engine unavailable: ${errText(err)}`,
        });
        return null;
      }
      try {
        // One unbounded virtual frame: every record lands in it, in order —
        // the list a merge would place, before any page geometry applies.
        const flow = e.lower_record_flow(
          id,
          [{ frame: "preview", page: "preview", heightPt: Number.MAX_SAFE_INTEGER }],
          undefined,
        ) as {
          total: number;
          frames: { blocks: { block: string; text?: string; cells?: string[] }[] }[];
        };
        const blocks: RecordFlowPreview["blocks"] = [];
        for (const f of flow.frames) {
          for (const b of f.blocks) {
            if (b.block === "groupHeader") blocks.push({ kind: "header", text: b.text ?? "" });
            else if (b.block === "record")
              blocks.push({ kind: "record", text: (b.cells ?? []).join(" · ") });
            else if (b.block === "groupFooter")
              blocks.push({ kind: "footer", text: (b.cells ?? []).join(" · ") });
          }
        }
        state.status = "ready";
        state.message = `Record flow "${id}": ${flow.total} record(s).`;
        emit();
        return { total: flow.total, blocks };
      } catch (err) {
        report({
          level: "error",
          source: "flow",
          binding: id,
          message: `did not resolve — refresh the data first? (${errText(err)})`,
        });
        return null;
      }
    },

    setPinned(id, pinned) {
      defineOnEngine((e) => (pinned ? e.pin(id) : e.relink(id)), id);
      markDirty();
    },

    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },

    restore() {
      if (!restorePromise) restorePromise = restoreInternal();
      return restorePromise;
    },

    async documentOpened() {
      docEpoch += 1;
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = null;
      await restorePromise?.catch(() => {});
      for (const h of providerHandles.values()) h.dispose();
      providerHandles.clear();
      sourceNames.length = 0;
      bindingIds.length = 0;
      diagnostics.length = 0;
      queries.clear();
      bindingKinds.clear();
      visibilityTargets.clear();
      imageTargets.clear();
      barcodeTargets.clear();
      placedVariables.clear();
      ruleTargets.clear();
      remoteSources.clear();
      importedCsv.clear();
      pendingCsv.clear();
      importedFiles.clear();
      pendingFiles.clear();
      csvFileNames.clear();
      refreshPolicies.clear();
      poller.stopAll();
      state.polling = [];
      loweredInto.clear();
      pendingDefs.length = 0;
      knownDataParts.clear();
      bootPayload = null;
      lastWritten = null;
      persistence.status = "empty";
      persistence.hash = null;
      partsMissingReported = false;
      engine?.free();
      engine = null;
      const oldDuck = duck;
      duck = null;
      void oldDuck?.close();
      state.status = "idle";
      state.message = "No data sources yet — import a CSV to begin.";
      emit();
      restorePromise = restoreInternal();
      await restorePromise;
    },

    async whenRestored() {
      await restorePromise;
    },

    flushPersist() {
        return flushPersistInternal();
      },

      dispose() {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = null;
        for (const d of hostSubs.splice(0)) d.dispose();
        poller.stopAll();
        listeners.clear();
        for (const h of providerHandles.values()) h.dispose();
        providerHandles.clear();
        void duck?.close();
        engine?.free();
        engine = null;
        duck = null;
      },
    };
  return self;
}
