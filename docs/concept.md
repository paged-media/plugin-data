# paged.data — Core Layer Technical Specification

June 2026. Concept paper. Sections describe intent; where the implementation differs, `status.md` and the ADRs in `adr/` are authoritative.

Sections not relevant outside the original planning context have been removed; numbering is unchanged.

**v0.4 changes:** `paged.data` can act as a **data provider for other
consumers** (notably the sheets plugin) — *mediated entirely by a core SDK
data-provider contract*, never by direct plugin-to-plugin coupling (§7.1).
Independence is preserved: `paged.data` publishes resolved datasets through
a neutral core registry and never knows, names, or calls any consumer; a
consumer reads providers through the SDK and never knows a specific plugin
backs them.

**v0.3 changes:** Governed-data integration is specified in engine-neutral
terms — `paged.data` consumes governed external sources (warehouse/database
tables plus optional column-metadata sidecars) through its standard source
adapters; no specific transformation tool is named or depended upon.

**v0.2 changes:** Engine decision **settled — DuckDB-WASM (MIT)**.
DataFusion (pure-Rust, Apache-2) was considered as an alternative and
declined for v1: DuckDB's connector breadth (Excel, httpfs, SQLite/Postgres/
MySQL attach) *is* most of the database-publishing product, and rebuilding
it on DataFusion is schedule-eating work for no v1 user benefit. **Apache
Arrow is clarified as substrate, not a candidate** — it is the interchange
type already woven through the stack (DuckDB results, `RecordSet`, D-2),
never a replacement for an engine. The engine stays swappable behind the
Arrow seam should DataFusion become attractive later (§6.1, D-2).

---

## 1. Purpose and scope

`paged.data` is the external-data and automation subsystem of the Paged
ecosystem: a Rust/WASM data-binding engine delivered as a **Paged plugin**
that makes Paged fully capable of **database publishing**. The goal is a
print-automation platform on top of Paged — the category occupied by
EasyCatalog (65bit) for InDesign: variable replacement, dynamic/expanding
tables, image placeholders, scriptable queries, data-driven formatting,
record flow across pages, and batch document generation.

The thesis ties directly to the governed-data conviction running through
the broader work: a publication should be a *projection of governed data*,
not a hand-assembled artifact. `paged.data` makes the data the source of
truth and the document a live, regenerable view of it.

Six properties are **constitutive** — they hold from M0 and are never
phased in:

- **Strict plugin independence.** 100% independent of any other plugin;
  only the Paged SDK (`@paged-media/plugin-api` / `plugin-sdk`) and
  published package contracts. Never imports, calls, discovers, or
  communicates with another plugin (incl. `plugin-image`, `plugin-sheet`)
  — build-time, runtime, or side-channel — even co-installed (§2.1).
- **DuckDB-WASM is the query/ingest engine** (MIT — clean to bundle, §3),
  running client-side in a worker: SQL over CSV/JSON/Parquet/Excel/remote
  sources and attached databases, with OPFS persistence (§6).
- **Governed external sources, engine-neutral** (§7). `paged.data` can bind
  to governed warehouse/database tables and optional column-metadata
  sidecars through its standard source adapters, so authors bind to
  documented, governed datasets rather than raw tables — without depending
  on or embedding any particular data-transformation tool (§3).
- **Binding-first architecture.** The core is a binding/synchronization
  engine connecting query results to document targets; data changes
  invalidate bound content and re-resolve it through committed Operations.
  Same salsa-shaped incremental model as layout and the other plugins (§8).
- **100% tested and verified operations** (§12). Every binding kind,
  source adapter, expression function, and lowering rule is registry-listed
  and tier-tested; unregistered capabilities are unreachable by
  construction.
- **Capability-gated data access with an explicit threat model** (§11).
  External data + scriptable queries is the largest attack surface of any
  Paged plugin; network/file access is capability-gated and user-consented,
  and documents carrying queries are treated with the caution due to
  embedded code.

Display follows the **content-space / lowering** model proven in
`plugin-sheet`: bound content lowers to native Paged content via
Operations; Parley typesets, Vello renders, the print/PDF/IDML pipeline
exports, and **all core frame operations (scale, rotate, skew, crop,
reposition) are honored for free** because the output is native content
(§9.6).

**Out of scope** (companion specs): the data-panel editing UX, the binding
authoring UI, the scripting end-user API surface (Boa), connector-specific
credential management UI, collaboration semantics beyond the Operation
model.

### 1.1 Non-goals

*Status note (2026-10-02): this section predates the implementation; see [ADR 555](adr/555-batch-reuses-the-engine.md) (the headless path is a plain-Rust command-line binary, `data-cli`; no napi-rs binding is built) and [ADR 015](adr/015-duckdb-wasm-vendored.md) (how the prebuilt DuckDB-WASM artifact is acquired and booted).*

- No server-side rendering or mandatory server component. Query and binding
  run client-side WASM; the same crates compile natively (napi-rs) for the
  optional **batch/headless generation** path (§10) only.
- No Emscripten, no C/C++ in the default build beyond DuckDB-WASM's own
  prebuilt module (consumed as a WASM artifact, not compiled in-tree).
- **No embedding of any source-available/ELv2/SSPL/proprietary data
  engine** (§3). Such tools are integrated, if at all, only by consuming
  their data *outputs* through the standard source adapters — never linked
  or redistributed.
- No becoming a general BI/analytics tool. DuckDB's analytical power serves
  *publishing*; dashboards, notebooks, and ad-hoc exploration are not the
  product.
- No bypassing the capability/consent model for "convenience" — network and
  filesystem reach is always explicit (§11).

---

## 2. Position in the Paged ecosystem: an independent automation plugin

`paged.data` is a **Paged plugin bundle** in its own repository
`paged-media/plugin-data`. Same isolation posture as the sibling plugins,
with the inter-plugin rule that defines the suite.

```
┌──────────────────────────────────────────────────────────────────┐
│ Paged (untouched)                                                 │
│  Layer 1–4 …  core: Vello · Parley · paged.draw · salsa · op log  │
│        ┌──────────────┐  ┌──────────────┐  ← NO contact with      │
│        │ plugin-image │  │ plugin-sheet │     either, either way   │
│        └──────────────┘  └──────────────┘                         │
└───────────────────────┬────────────────────────────────────────────┘
                        │ @paged-media/plugin-api / plugin-sdk
                        ▼            (the ONLY boundary)
┌──────────────────────────────────────────────────────────────────┐
│ paged.data plugin bundle (own repo, own WASM module + DuckDB-WASM)│
│  manifest (capabilities incl. network/file) · glue · panels       │
│  data-* crates (§4)                                               │
└──────────────────────────────────────────────────────────────────┘
```

### 2.1 Isolation contract (same superset as plugin-sheet)

*Status note (2026-10-02): this section predates the implementation; see [ADR 315](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/315-isolation-contract.md) in plugin-sdk (the isolation contract). In this repository the import rule is checked by `scripts/check-contract-imports.mjs` and `deny.toml`; the glue is the TypeScript package `packages/data-bundle`; the one worker is the DuckDB worker the bundle spawns ([ADR 015](adr/015-duckdb-wasm-vendored.md)); and the Boa sandbox exists only in the native `data-script` crate ([ADR 555](adr/555-batch-reuses-the-engine.md)).*

1. **Zero core contact** beyond the published SDK; CI builds against SDK
   canaries only.
2. **Zero inter-plugin contact** — no dependency, import, runtime
   discovery, messaging, or shared state with any other plugin. Overlaps
   are resolved through **core SDK surfaces**, never sibling plugins:
   - **Image placeholders** place images through the document's standard
     **asset mechanism** (core SDK) — *not* `plugin-image`. (If advanced
     processing of a placed image is ever wanted, that is the user
     separately invoking `plugin-image` on the resulting asset; `paged.data`
     neither knows nor calls it.)
   - **Dynamic tables** lower to the core **native table content model**
     (SDK) via `paged.data`'s *own* lowering code — *not* `plugin-sheet`.
     Two plugins independently targeting the same core table contract is
     correct; sharing code would not be.
   - **Charts from data** (if ever in scope) lower through `paged.draw`
     (core), never a sibling.
3. **Capability-gated everything**, including — uniquely for this plugin —
   **network** and **filesystem/import** capabilities (§11). All document
   writes are committed Operations through the SDK mutation surface.
4. **Own runtime, own memory.** Self-contained WASM + the DuckDB-WASM
   module + own worker pool. One Boa sandbox; thin glue.
5. **Gaps become RFCs, not hacks.**

**CI enforcement:** allow-list of exactly `@paged-media/plugin-api`,
`plugin-sdk`, published contracts, and the vendored DuckDB-WASM artifact;
any other `@paged-media/*` or sibling-plugin-provenance dependency fails the
build.

### 2.2 Required SDK surface (gap analysis → RFCs, due before M0)

*Status note (2026-10-02): this section predates the implementation; most rows of this table are now host doors the plugin uses. See [ADR 552](adr/552-binding-is-a-recipe.md) (placeholder fields and per-element plugin metadata), [ADR 551](adr/551-compiled-to-native-content.md) (table, image and style content written through host mutations), [ADR 554](adr/554-record-flow-pagination.md) (the frame-chain read), [ADR 556](adr/556-secrets-never-enter-the-plugin.md) (network consent), [ADR 014](adr/014-data-provider-arrow-seam.md) (the data-provider registry) and, in the editor, [ADR 024](https://github.com/paged-media/editor/blob/main/docs/adr/024-context-sensitivity-is-a-core-concept.md) (double-click entry into the edit context the plugin contributes). The designs behind the network, credential and data-provider rows are in `plugin-sdk: docs/design/`. The plugin uses no OPFS storage, registers no importer, and spawns its DuckDB worker itself ([ADR 015](adr/015-duckdb-wasm-vendored.md)).*

| Need | Likely status | If missing |
|---|---|---|
| Read document structure, styles, frames, and **placeholder/tag markup in text** | read covered; *inline placeholder markup model* to verify | **RFC: tagged-placeholder content model** (named insertion points in text runs that survive editing) — the most consequential row (§9.1) |
| Commit Operations producing text, table, rule, and **placed-asset** content in owned regions | mutation surface covered; table + asset placement to verify | RFC: native table content model (shared with plugin-sheet); asset-placement op |
| Owned-content / lock semantics + edit-interception for bound content | to verify | RFC: owned-content attribute + "edit the data binding" interception |
| Frame-chain topology + overflow notification (record flow / pagination) | text threading exists; plugin visibility to verify | RFC: frame-chain read + overflow notification (shared with plugin-sheet) |
| Reflow notification carrying **content-box geometry**, not display geometry (resize vs transform, §9.6) | to verify | RFC clause (shared with the plugin-sheet concept §8.5, `plugin-sheets: docs/concept.md`) |
| Document style read **and write** (data-driven formatting via document styles) | read covered; write to verify | RFC: style-management capability (shared with plugin-sheet) |
| **Network capability** (DuckDB httpfs / remote sources / API adapters) with user consent + allow-list | new | **RFC: network capability with per-origin consent and a visible data-source manifest** (§11) |
| **Filesystem/import capability** (local CSV/Excel/Parquet/DB files via OPFS) | shared with image/sheet OPFS RFC | RFC: storage + file-import capability |
| Register importer/exporter (open a data file → start a binding) | shared RFC | RFC: importer registration |
| Worker spawn + SharedArrayBuffer (DuckDB worker + binding workers) | shared RFC | RFC: worker capability with COOP/COEP |
| Document-scoped persistent plugin payload (binding definitions, source manifests) | to verify | RFC: plugin document-data capability with size budget |
| **Register as a data provider** (publish schema + `RecordSet` + refresh, consumed by others through the SDK — §7.1) | new | **RFC: core data-provider contract/registry** (shared with the sheets plugin's consumer side); category/capability discovery, no consumer identity exposed to the provider |

Several rows are shared RFCs with the sibling plugins — convergence on the
platform, independence between plugins.

The viewer-grade subset (`data-core` + `data-query` + `data-bind` in
read/resolve-only form) presents already-bound documents without authoring
or live external fetch — mirroring `EditorSession extends ViewerSession`.

---

## 3. Legal and methodological ground rules — **decisive**

| Dependency | Finding | Ruling |
|---|---|---|
| **DuckDB / DuckDB-WASM** | MIT licensed. | **Bundle freely.** Vendored as a prebuilt WASM artifact + JS bindings; attribution preserved. |
| **Source-available / ELv2 / SSPL / proprietary data engines** (any third-party transformation or query engine of this class) | Not OSI-open. | **Never embed, link, or redistribute such an engine.** Integrate, if at all, only by consuming its data *outputs* (tables + optional metadata sidecars) through the standard source adapters (§7) — touching *zero* engine code. |
| **Arrow / ADBC** | Apache-2. | Permitted; the natural interchange type system for DuckDB results and any warehouse extracts. |
| Source-level clean-room | Largely **not applicable**: SQL is a standard; binding semantics are our own design; EasyCatalog is a *conceptual* reference only. | If any reference engine is ever mounted under `references/`, the analyst/implementer protocol from the `plugin-image` concept §3.1 (`plugin-image: docs/concept.md`) applies verbatim. EasyCatalog is studied as a product (features/UX), never as code. |
| **License** | See `LICENSE.md`. | — |

The strategic read: binding to governed datasets is valuable and on-thesis
(governed data feeding governed publications), but the value is in the
**data and its metadata**, not in any engine binary. Consuming governed
outputs through the standard adapters captures the value and sidesteps the
licensing question entirely.

---

## 4. Crate architecture

*Status note (2026-10-02): this section predates the implementation; see `architecture.md` (there is no `manifest/`, `glue/` or `references/` directory: the bundle and its manifest are `packages/data-bundle`, with the translation to host mutations in `packages/data-host-model`; the crates `data-barcode`, `data-dataset`, `data-script` and `data-cli` were added), [ADR 015](adr/015-duckdb-wasm-vendored.md) (the DuckDB-WASM integration is TypeScript in `packages/data-bundle/src/query/`; `data-query` shapes, orders and hashes results), [ADR 551](adr/551-compiled-to-native-content.md) (`data-lower` produces plain data and does not touch the SDK) and [ADR 555](adr/555-batch-reuses-the-engine.md) (`data-automation` plans batches; the headless binary is `data-cli`; there is no napi-rs binding).*

Repository `paged-media/plugin-data`:

```
plugin-data/
├── manifest/            # plugin manifest, capability declarations (incl. network/file), panel schemas
├── glue/                # Boa-side glue: lifecycle, panels, Operation submission, scripting host
├── references/          # READ-ONLY if ever mounted — analyst-only; excluded from artifacts
├── vendor/duckdb-wasm/  # vendored MIT DuckDB-WASM artifact + bindings (not compiled in-tree)
├── data-core/           # types: DataSource, Query, RecordSet, Field, Binding, Placeholder, SyncState
├── data-query/          # DuckDB-WASM integration: worker mgmt, SQL exec, params, result→Arrow→RecordSet
├── data-sources/        # source adapters: file (CSV/JSON/Parquet/Excel), remote (httpfs/API), DB attach, governed-extract
├── data-expr/           # binding expression language: lexer/parser/eval (formatting, conditionals, derivations)
├── data-bind/           # binding + synchronization engine (salsa-shaped): resolve, invalidate, pin/override, stale
├── data-lower/          # placeholder lowering: variables, images, dynamic tables, record flow/pagination, rules
├── data-automation/     # batch/headless generation: native (napi-rs) + scripted "build" operations
├── data-conformance/    # TEST-ONLY: oracle/fixture harness, corpora, coverage gate — never shipped
└── data-js/             # wasm-bindgen surface consumed by glue/ and the viewer bundle
```

**Dependency rules (CI-enforced):**

1. `data-expr` and `data-sources` depend only on `data-core` (+ DuckDB
   bindings in `data-sources`). Expression functions are pure
   `fn(&[Value], &EvalCtx) -> Value`, like sheet functions.
2. `data-lower` is the only crate touching the SDK mutation surface;
   `data-sources` is the only crate touching network/file capabilities.
3. SDK rule + inter-plugin rule (§2.1) apply to every crate.
4. `data-conformance` is dev-dependency-only; `cargo tree` proves no test
   code reaches the wasm release build.

---

## 5. Core concepts and types (`data-core`)

### 5.1 The object model

*Status note (2026-10-02): this section predates the implementation; see [ADR 014](adr/014-data-provider-arrow-seam.md) (a `RecordSet` is a schema plus columns of tagged values, not an Arrow batch), [ADR 550](adr/550-own-binding-language.md) (a binding stores its expression as source text), [ADR 551](adr/551-compiled-to-native-content.md) and [ADR 557](adr/557-variables-and-data-sets.md) (the `Barcode` and `Visibility` binding kinds were added), [ADR 552](adr/552-binding-is-a-recipe.md) (what is stored in the document) and [ADR 555](adr/555-batch-reuses-the-engine.md) (the headless path named in the record below is the `data-cli` binary; no napi-rs binding is built).*

```rust
pub struct DataSource {            // a connection + its scope
    id: SourceId,
    kind: SourceKind,              // File | Remote | DbAttach | GovernedExtract | InlineSeed
    capability: CapabilityRef,     // which granted capability authorizes it (§11)
    refresh: RefreshPolicy,        // Manual | OnOpen | Interval(..) | Never(snapshot)
}

pub struct Query {                 // a named, parameterized SQL query over sources
    id: QueryId,
    sql: String,                   // DuckDB SQL; references sources as tables/views
    params: Vec<ParamDecl>,        // typed, bound at resolve time
    shape: ResultShape,            // record-stream | single-record | scalar | grouped
}

pub struct RecordSet {             // materialized result (Arrow-backed)
    schema: Schema,                // field names + types
    records: ArrowBatch,           // columnar; rows addressed by index
}

pub enum Binding {                 // the heart of the plugin
    Variable  { target: PlaceholderRef, expr: Expr },              // §9.1
    Image     { target: PlaceholderRef, expr: Expr, policy: ImgPolicy }, // §9.2
    Table     { region: FrameRef, query: QueryId, columns: Vec<ColumnBind>, options: TableOpts }, // §9.3
    RecordFlow{ chain: FrameChainRef, query: QueryId, template: TemplateRef, options: FlowOpts },  // §9.4
    Rule      { scope: ScopeRef, when: Expr, apply: StyleAction },  // §9.5
}

pub struct SyncState {             // per binding/target
    status: Status,                // Linked | Pinned | Overridden | Stale | Error
    last_resolved: ResolveStamp,   // source+query content hash + params
}
```

- `Value` mirrors the sheet `CellValue` shape (number/text/bool/null/error)
  plus typed temporal and binary (for image bytes/URIs) — a shared
  vocabulary, not shared code.
- Binding *definitions* and source *manifests* are the plugin's
  document-scoped payload (SDK document-data capability, §2.2); resolved
  *values* are committed content. The document carries the recipe and the
  result, exactly as `plugin-sheet` carries sheet model + lowered content.

> **`RefreshPolicy` — shape vs. scheduler (record, 2026-06-13).** The
> `RefreshPolicy { Manual | OnOpen | Interval{secs} | Never }` field exists on
> every `DataSource` and **round-trips** with the recipe (serde; added fields
> default, so pre-policy payloads still decode). It is a stored *policy shape*,
> **not** a live scheduler. The honest interactive-vs-automation split is
> encoded in `RefreshPolicy::honored_interactively()`: the interactive editor
> acts on `Manual` (explicit user refresh), `OnOpen` (re-resolve **once** on
> open, behind the §11 consent gate — never a silent auto-fetch), and `Never`
> (a frozen snapshot); it does **not** run a wall-clock timer in a document (§11
> — a document carries data, not a daemon). `Interval` is deliberately the one
> policy the editor does not drive itself: an interval re-resolve belongs to the
> **batch/automation lane** (`data-automation`, the napi/headless track that
> owns the clock), which reads `interval_secs()`. The live interval scheduler is
> a recorded follow-up; no background-timer code lives in the document realm.
> Registry: `data.source.refresh-policy` (round-trip test
> `data_source_refresh_policy_roundtrip`).

### 5.2 Placeholders

*Status note (2026-10-02): this section predates the implementation; see [ADR 552](adr/552-binding-is-a-recipe.md) (a text placeholder is a host placeholder field tagged with the plugin id and the binding id; a table frame the plugin creates carries plugin metadata).*

A **placeholder** is a named, edit-surviving insertion point in document
content (a tagged text run, an empty frame marked image-target, a frame
marked table/flow region). Placeholders are the binding's anchor; they
depend on the SDK tagged-placeholder model (§2.2, top RFC). Resolution
replaces/fills the placeholder's *content* while preserving the *anchor*,
so re-resolution is idempotent and round-trip-safe.

---

## 6. Query and ingest engine (`data-query`, `data-sources`)

*Status note (2026-10-02): this section predates the implementation; see [ADR 015](adr/015-duckdb-wasm-vendored.md) as amended (DuckDB-WASM is booted by TypeScript in `packages/data-bundle/src/query/duckdb.ts`, in a worker the bundle spawns; `data-query` only shapes, orders and hashes results; nothing is persisted to OPFS), [ADR 014](adr/014-data-provider-arrow-seam.md) as amended (a result is converted to a `RecordSet` in TypeScript and crosses into the engine as a JSON-shaped value, not as Arrow IPC) and [ADR 556](adr/556-secrets-never-enter-the-plugin.md) (a remote source is fetched by the bundle after consent and handed to DuckDB as bytes; `httpfs` is not used).*

### 6.1 DuckDB-WASM

**Engine decision: settled (DuckDB-WASM, MIT).** DataFusion was weighed as
a pure-Rust, Apache-2 alternative and declined for v1 (connector breadth is
the product; reimplementing it buys nothing for users now). The engine is
kept **swappable behind the Arrow seam**: `data-query` exposes results as
Arrow → `RecordSet`, so a future DataFusion (or hybrid) engine is an
internal substitution, not an architectural change. Arrow is substrate, not
an engine candidate.

- Runs in a dedicated worker; results returned as Arrow, mapped to
  `RecordSet`. OPFS-backed for persisted databases and cached extracts.
- **Scriptable queries = SQL**, parameterized and typed. DuckDB's reach is
  the feature: query CSV/JSON/Parquet/Excel directly; `ATTACH` SQLite/
  Postgres/MySQL; join across heterogeneous sources in one statement;
  window functions, CTEs, aggregation for grouped catalog sections.
- Extension policy (D-3): a curated, security-reviewed set — `httpfs`
  (remote, capability-gated), `excel`, `json`, `parquet`, DB scanners as
  needed — not "all extensions." Bundle-size budget tracked (DuckDB-WASM is
  multi-MB; lazy-load extensions; D-4).
- Determinism: queries with `ORDER BY` are deterministic; unordered result
  iteration is stabilized by an injected deterministic ordering before
  binding (record identity must be stable across refreshes for sync — §8).

### 6.2 Source adapters

| Kind | Mechanism | Capability |
|---|---|---|
| File (CSV/TSV/JSON/Parquet/Excel) | DuckDB readers over OPFS-imported bytes | file-import |
| Remote (HTTP(S) file, REST/JSON API) | DuckDB `httpfs` / fetch adapter → temp table | network (per-origin consent) |
| DB attach (SQLite/Postgres/MySQL) | DuckDB scanners; client-side reachable DBs | network + credential handling |
| **Governed extract** (§7) | read governed warehouse/database tables via the file/DB/remote adapter; optional column-metadata sidecar (names, descriptions, types) | file or network |
| Inline seed | data embedded in the document (small lookup tables) | none (travels with the doc) |

Each adapter declares its capability; a source cannot be created without
the granting capability present and consented.

---

## 7. Governed-data integration — engine-neutral (`data-sources`)

The on-thesis enterprise feature, built **without depending on any
particular data-transformation tool**:

- The user produces governed datasets in their own environment, by whatever
  means they choose. `paged.data` consumes the **outputs**: the
  materialized tables (read via the file/DB/remote adapters) plus an
  optional **column-metadata sidecar** (a JSON description of field names,
  types, descriptions, and provenance) when one is available.
- Effect: a **governed catalog** experience — the author binds to
  documented datasets (e.g. `fct_products`, `dim_pricing`) with
  human-readable column metadata, not raw anonymous tables. Governed,
  documented data flowing into a governed publication — the
  governed-data conviction expressed in the publishing layer.
- Zero license entanglement: tables are data; the metadata sidecar is data.
  No third-party engine is linked or shipped (§3).
- Scope (D-5): v1 reads governed tables and an optional metadata sidecar
  from a user-provided location (file/URL/DB); orchestrating the upstream
  transformation, triggering runs, or talking to a live semantic layer is
  explicitly out — that is the user's data platform, not Paged's job.

### 7.1 Acting as a data provider for other consumers (SDK-mediated)

*Status note (2026-10-02): this section predates the implementation; see [ADR 014](adr/014-data-provider-arrow-seam.md) (the data-provider contract exists as a host door, and the plugin registers its publications through it) and `plugin-sdk: docs/design/data-provider.md` (the design of that door).*

`paged.data` can serve its resolved datasets to **other consumers in the
Paged ecosystem** — most importantly the **sheets plugin**, so a sheet can
be sourced from a governed query rather than from a static import. This is
done **without any inter-plugin contact**, through a core-mediated
**data-provider contract**:

- `paged.data` **registers a named data provider** with the core SDK
  data-provider registry, exposing a schema + the resolved `RecordSet`
  (Arrow-shaped, the same interchange substrate used internally) plus
  refresh/subscribe semantics. It declares the provider; it does **not**
  know who consumes it.
- A consumer (e.g. the sheets plugin) **discovers providers by
  category/capability through the SDK** and reads their output, never
  learning that `paged.data` specifically backs a provider. No import, no
  runtime discovery by plugin identity, no message-passing between the two
  plugins — they rendezvous only at the neutral core contract.
- **Graceful absence:** if `paged.data` is not installed, no such provider
  exists; the consumer degrades (its provider list is simply shorter).
  Neither plugin hard-depends on the other; the independence rule (§2.1) is
  fully intact — both depend only on the SDK.
- **Sync flows through the contract:** when a `paged.data` source refreshes
  and a bound query re-resolves, the provider emits a refresh notification;
  consumers re-pull through the SDK on their own schedule. `paged.data`'s
  capability/consent model (§11) still governs the underlying fetch — a
  consumer cannot induce network access `paged.data` is not authorized to
  perform.
- **Security note:** the provider contract exposes *data*, not the ability
  to define new queries or sources in `paged.data`. A consumer reads
  published results; it cannot drive `paged.data`'s network/file reach.

This makes a powerful composition possible — a spreadsheet computing over a
governed, live query result and then lowering to print — while keeping the
plugins strictly decoupled. The data-provider contract is a new SDK RFC
(§2.2) and is shared with the sheets plugin's consumer side.

> **The record transport is Arrow-aligned-by-shape today, not arrow-rs IPC
> (record, 2026-06-13; [ADR 014](adr/014-data-provider-arrow-seam.md)).** What the seam ACTUALLY uses today: DuckDB-WASM
> returns Arrow; the TS query layer materialises it (`packages/data-bundle/src/query/recordset.ts`,
> `arrowToRecordSet`) into the columnar `RecordSetJson` — `schema.fields[]`
> (name + an **Arrow-aligned** `FieldType`: bool/int/float/text/date/datetime/
> bytes/null) + `columns[c][r]` tagged `Value`s + `row_count` — which serde-decodes
> directly into `data-core::RecordSet` (a Rust struct: `Schema` + `Vec<Vec<Value>>`
> + `row_count`). The `ProviderPublication` (`data-js::core`) already carries the
> `Schema` **descriptor** half alongside the stabilized `RecordSet` and a content-
> etag `revision`. So the transport is **columnar + typed + Arrow-shaped**, but it
> is JSON-over-the-wasm-boundary, **not** an `arrow-rs` IPC byte buffer — and that
> is the *correct* state per **ADR-014**: "Arrow-aligned rows reuse the renderer
> seam; not a shared arrow-rs package", and `arrow-rs` is the implementation that
> was explicitly **declined** (a heavy dep for a shape the system already speaks).
> No additive descriptor is missing — the `Schema` already IS the Arrow-aligned
> descriptor on both the `RecordSet` and the `ProviderPublication`. A genuine
> `arrow-rs` IPC encode (zero-copy columnar bytes instead of JSON materialisation)
> is a **deferred v3 perf item**: it is an architecture move
> (pulling the dep ADR-014 declines, re-tiering the wasm boundary), to be taken
> only if profiling shows the JSON materialisation is a real bottleneck on
> 100k+-row publications. Until then the seam is shape-compatible and honest.

---

## 8. Binding and synchronization engine (`data-bind`) — salsa-shaped

*Status note (2026-10-02): this section predates the implementation; see [ADR 553](adr/553-non-destructive-refresh.md) (the five sync states, the content-hash stamps and the keyed row diff as built).*

The incremental core, same intellectual architecture as layout, Engine B
(`plugin-image`), and recalc (`plugin-sheet`):

- **Resolution graph:** sources → queries → bindings → targets. Each node
  caches its result keyed by upstream content hashes + params
  (`ResolveStamp`).
- **Invalidation:** a source refresh or query/param/expression edit marks
  dependent bindings stale; resolution recomputes only the affected cut and
  commits Operations to update bound content.
- **Record identity & stable diffing:** record flow and dynamic tables
  diff old vs new result by a declared key (or stabilized ordering), so a
  refresh updates/inserts/removes rows minimally rather than regenerating
  the whole region — keeping pagination stable and undo granular.
- **Sync states & overrides:**
  - `Linked` — tracks the source live.
  - `Pinned` — frozen to a snapshot (EasyCatalog "pinning"); ignores
    refreshes until unpinned.
  - `Overridden` — a manual edit replaced the resolved value; flagged,
    preserved, and reported in a sync panel (never silently clobbered).
  - `Stale` / `Error` — source changed but not re-resolved / resolution
    failed (with diagnostic).
- **Conflict policy (D-6):** default is *non-destructive* — refresh never
  overwrites `Overridden`/`Pinned` without explicit user action; a sync
  report lists divergences for review. This is the print-publishing
  expectation (you do not want a data refresh silently rewriting an
  approved page).
- Mutation maps to Operations/Gestures: editing a query or expression
  previews via Gestures (bounded re-resolution); confirming commits
  Operations; undo is the inverse, O(affected targets).

---

## 9. Placeholder lowering (`data-lower`) — content-space, frame-ops-honored

*Status note (2026-10-02): this section predates the implementation; see [ADR 551](adr/551-compiled-to-native-content.md) (how each binding kind is written as native content: `data-lower` produces plain data, `packages/data-host-model` turns it into host mutations, and the bundle sends them; a barcode kind was added) and [ADR 550](adr/550-own-binding-language.md) (the expression language).*

All output is **native Paged content** committed via Operations; the
content-space principle and frame-operation handling are inherited from
the `plugin-sheet` concept §8.5 (`plugin-sheets: docs/concept.md`; see §9.6).

### 9.1 Variable replacement

Tagged placeholders in text runs resolve to formatted field values via a
binding expression (`data-expr`). The anchor survives; only content
updates. Expressions handle formatting (number/date/currency via a
format-code engine shared in spirit with the `plugin-sheet` concept §9 — own code),
conditionals, concatenation, and derivations. Missing/null policy is
explicit per binding (blank, placeholder text, hide paragraph).

> **Localization breadth — NOT data-table-driven; enum-match, frozen
> (record + follow-up, 2026-06-13).** `paged.data` has its OWN locale-driven
> display formatter (separate from sheets): the `NUMBER`/`CURRENCY`/`PERCENT`/
> `DATEFMT` kernels (`data-expr::families::format`) thread a session `Locale`
> through `EvalCtx`. But the locale data is **not** a registry/YAML table — it
> is a hardcoded Rust `match` on the `Locale` enum in `data-core::model` (4
> methods: `decimal_sep` / `group_sep` / `currency` / `date_pattern`), today
> `En` + `De` (the §9.1 v1 minimum, mirroring plugin-sheet's D-8). Adding a
> locale therefore means a NEW `Locale` variant + 4 match arms — and `Locale`
> is a `data-core` **frozen** type that also serde-serialises into the document
> payload (`data-script`). So broadening locales is a **versioned interface
> amendment**, not a drive-by row.
> Deferred to a dedicated follow-up (the clean shape would migrate the
> per-variant `match` to a registry-driven locale table FIRST — making locales
> additive rows like the function table — THEN add fr/es/it/etc.; that
> table-ification is itself the follow-up's first step). Recorded, not faked:
> registry `data.i18n.locale` still reads en/de only. Entry point:
> `data-core/src/model.rs::Locale`.

### 9.2 Image placeholders

A field yields an image reference (URI, path, asset id, or bytes); the
binding places it through the **core asset mechanism** (SDK) into the
target frame, honoring fit/fill/crop options. Policies for missing assets
(fallback image, skip, flag), resolution of relative paths against a
source-declared base, and async fetch (capability-gated for remote) are
registry-tested. Never routes through `plugin-image`.

### 9.3 Dynamic / expanding tables

A query result lowers to **native table content**: one row per record (or
grouped sections with headers/subtotals), column bindings mapping fields →
columns with per-column expressions and styles. Expands/contracts with the
data; threads and paginates via §9.4. Independent of `plugin-sheet` — same
core table contract, own lowering code.

### 9.4 Record flow and pagination — the catalog engine

*Status note (2026-10-02): this section predates the implementation; see [ADR 554](adr/554-record-flow-pagination.md) (the plugin paginates in one bounded pass over a frame chain read from the host or supplied by the caller; a record is never split).*

The defining print-automation feature: a **record flow** binds a query to a
**frame chain + a template** (a designed layout for one record — the
"catalog cell"). Records flow through the chain, one template instance per
record, paginating across pages exactly like threaded text/sheet frames:

- Template instancing: each record renders the template with its fields
  bound (variables + images + sub-tables).
- Grouping & sectioning: group by field(s), section headers/footers,
  keep-together, "continued" markers.
- Pagination is the bounded fixed-point settle loop (lower → reflow →
  overflow notification → re-split → settle), conformance-tested for
  convergence including pathological records (a record taller than a page).
- This is how "generate a 200-page product catalog from the database"
  becomes a *live, regenerable* document rather than a batch artifact —
  though batch is also supported (§10).

### 9.5 Data-driven formatting rules

Conditional rules (`when: Expr → apply: StyleAction`) drive styling through
**document styles** (the `plugin-sheet` concept §8.3 principle, reused as a
principle): e.g. negative margins in a warning character style, low-stock
rows in an emphasis table style. Rules apply at resolution time; styling is
always document-style references, never a parallel styling system, never
direct color literals where a swatch exists.

### 9.6 Frame operations

The content-space principle (verbatim from the `plugin-sheet` concept §8.5): bound
content is native content, so **scale/rotate/skew/crop/reposition apply for
free** via core's render path. Record-flow templates in transformed frames
render transformed; content-box resize re-paginates, pure transforms do
not. Registry rows `data.frame.transform.*` assert this on the output.

---

## 10. Print automation / batch generation (`data-automation`)

*Status note (2026-10-02): this section predates the implementation; see [ADR 555](adr/555-batch-reuses-the-engine.md) (a batch run reuses the interactive engine; the headless path is the plain-Rust binary `paged-data-batch` in `data-cli`, which takes query results already materialised by the caller; no napi-rs binding is built; the scripting surface is the native-only `data-script` crate, in which a script is handed no host functions and returns a build specification).*

The EasyCatalog "build" capability, two execution modes from one crate:

- **Interactive/live:** the document is bound and regenerates as data
  changes — the default.
- **Batch/headless:** generate many outputs from data — one document per
  record (e.g. per-store flyers), per group (per-category catalogs), or one
  large paginated catalog — driven by a parameter set. Runs natively
  (napi-rs) for server/CI batch, or in-app for smaller runs. Outputs are
  ordinary Paged documents/exports; nothing bypasses the normal render/
  export pipeline.
- **Scripting:** query definitions, expressions, and build parameters are
  authored as data; a constrained scripting surface (Boa, capability-gated)
  exposes the binding/build API for "scriptable queries" and templated runs
  — not arbitrary code execution against the host.
- Scope (D-7): v1 batch = parameterized multi-document/multi-section
  generation from a single template document; pipelines/scheduling/webhooks
  are out (that is the user's automation platform calling the napi-rs
  binding).

---

## 11. Security and threat model — the largest surface in the suite

*Status note (2026-10-02): this section predates the implementation; see [ADR 556](adr/556-secrets-never-enter-the-plugin.md) (a source names its credential by reference, and credentials are redacted from the payload the engine emits; a remote source is fetched by the bundle only after per-origin consent) and [ADR 015](adr/015-duckdb-wasm-vendored.md) as amended (DuckDB's `httpfs` is not used). The designs of the consent and credential doors are `plugin-sdk: docs/design/network-consent.md` and `plugin-sdk: docs/design/credential-store.md`.*

External data + scriptable queries make this plugin categorically
higher-risk than its siblings. The model is explicit:

- **Capabilities are consented, visible, and minimal.** Network and file
  access require granted capabilities; a **data-source manifest** in the UI
  shows every origin/file a document will touch. No silent fetch, ever.
- **Documents carrying queries are treated as carrying code.** Opening a
  document with bindings does **not** auto-execute remote fetches: external
  sources are inert until the user reviews the source manifest and consents
  (per-origin, rememberable). A shared/untrusted document cannot silently
  exfiltrate via `httpfs` or call out to an attacker origin on open —
  resolution against networked sources is gated behind explicit consent.
- **SQL is data over declared sources, not host code.** DuckDB executes in
  its worker sandbox; file/DB reach is bounded to capability-granted
  sources; the curated extension set (D-3) excludes anything that broadens
  filesystem/host reach beyond the model.
- **Credentials** for DB attach are handled through a credential mechanism
  (never embedded in the document payload; never serialized into the
  saved file) — D-8 fixes the storage approach (SDK secret store vs
  session-only).
- **Data-protection posture:** client-side fetch means data may leave the
  user's machine to third-party origins they authorized; the consent UI
  must make that legible.
- Conformance: `data.security.*` rows assert no network/file access without
  the granting capability, no resolution of remote sources pre-consent, and
  no credential leakage into the document payload (round-trip test:
  save→inspect→assert absent).

---

## 12. Conformance, testing, verification invariant

### 12.1 Identical environment to Paged core

*Status note (2026-10-02): this section predates the implementation; this repository's tests run under `cargo nextest` and vitest, and it has no Playwright suite; see `architecture.md`.*

Adopted verbatim (as in the sibling specs): Playwright sole browser-side
runner (Chrome-only); `@feat`/`#[feature_test]`; `paged-results.json`
reported to the project's internal feature registry and its
dashboard; `conformance.public.json` → `<ConformanceMatrix>` on
`docs.paged.media`; fingerprinted bug pipeline; canonical `CLAUDE.md`
extended with this spec's invariants (incl. §3 dependency-license boundary, §11 threat
model); plans in the internal notes repo at `status: planned`; one-way registry →
Projects.

### 12.2 The 100% verification invariant

*Status note (2026-10-02): this section predates the implementation; see [ADR 317](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/317-registry-driven-dispatch.md) in plugin-sdk (dispatch is generated from the registry for expression functions only; the other registry rows are checked by the coverage gate, which requires a test on disk for every row marked implemented).*

1. **Registry-driven dispatch** for source adapters, expression functions,
   binding kinds, and lowering rules — no row, no dispatch entry,
   unreachable by construction.
2. **Coverage gate:** tests for every claimed tier per row; below 100%
   fails the build.
3. **Tier-regression gate:** forward-only via green runs; regressions
   auto-file fingerprinted issues and block release.

### 12.3 Registry integration

*Status note (2026-10-02): this section predates the implementation; the registry is in this repository, under `registry/functions/` and `registry/features/`.*

`registry/features/data.*.yaml` — namespaces: `data.source.*`,
`data.query.*`, `data.expr.*`, `data.bind.*` (resolution/sync/identity),
`data.lower.*` (variable/image/table/recordflow/rule),
`data.frame.transform.*`, `data.security.*`, `data.automation.*`,
`data.governed.*`, `data.provider.*` (SDK data-provider registration/
refresh/discovery, §7.1), `data.plugin.*`. Taxonomies:
bindings `defined → resolves → renders → syncs → round-trips`;
sources `connects → queries → typed → refresh-stable`;
security per §11.

Sample row:

```yaml
# registry/features/data.lower.yaml
id: data.lower.recordflow.grouped
title: Grouped record flow with section headers + pagination
status: planned
provenance:
  - "design: an internal design note"
  - "EasyCatalog studied as product reference (no code)"
tests:
  rust: ["data-conformance/tests/recordflow.rs::grouped"]
  playwright: ["@feat:data.lower.recordflow.grouped"]
  corpus: ["data-corpus/catalog/grouped/*"]
```

### 12.4 Oracles and harnesses (`data-conformance`, test-only)

*Status note (2026-10-02): this section predates the implementation; the native-DuckDB oracle is an unimplemented skeleton in `data-conformance/tests/oracle.rs`; see `status.md`.*

- **DuckDB itself** is the query oracle: expected result sets are computed
  by DuckDB native and diffed against DuckDB-WASM (parity across the two
  builds is its own `data.query.*` tier).
- **Fixture corpora:** source files + queries + expected `RecordSet`s;
  binding fixtures + expected lowered content; catalog corpora for record
  flow/pagination convergence.
- **Property tests:** resolution-order independence; sync diffing
  (random source mutations → minimal correct row deltas, never full
  regeneration); idempotent re-resolution (resolve twice → identical
  content); round-trip (binding defs + overrides survive save/load;
  credentials absent).
- **Security tests:** §11 assertions as hard gates.
- Determinism: expression eval and binding resolution are CPU/`f64`
  bit-stable (sheet rules); no GPU, no tolerance machinery.

### 12.5 Performance gates (CI-enforced)

| Benchmark | Target |
|---|---|
| Query 1M-row CSV → grouped `RecordSet` (DuckDB-WASM, worker) | < 1.5 s cold |
| Resolve + lower a 200-page record-flow catalog | < 5 s; incremental refresh < 300 ms for a 100-record delta |
| Variable re-resolution, 5k placeholders, 1-source refresh | < 200 ms |
| Sync diff, 50k-record set, 1% changed | minimal row deltas; < 250 ms |
| Round-trip a bound document (defs + overrides) | lossless; credentials absent |
| DuckDB-WASM + plugin bundle initial load | budgeted; extensions lazy-loaded (D-4) |

---

## 13. Feature inventory and tiering

*Status note (2026-10-02): this section predates the implementation; see `status.md` (what is shipped and what is not).*

| Tier | Content | Schedule |
|---|---|---|
| **T0 — spine** | object model; DuckDB-WASM query engine + file/inline sources; expression core (formatting/conditionals); binding/resolution engine + sync states; variable replacement + image placeholders; single-region dynamic table; round-trip of binding defs; capability/consent skeleton | M0 |
| **T1 — the automation product** | record flow + template instancing + grouping + pagination across chains; full expression/format engine; data-driven formatting rules; remote + DB-attach sources (network capability + consent UI); override/pin/stale sync panel semantics; document-style integration | M1 |
| **T2 — governed + batch** | **governed-extract source** (governed tables + optional metadata sidecar, §7); batch/headless generation (§10); scripted queries/builds (Boa); richer source adapters; credential mechanism (D-8) | M2 |
| **T3 — depth** | incremental sync optimization, large-catalog performance, localization of formats, advanced grouping/cross-tab presentation (presentation only — not pivot semantics) | M3+ |
| **T∞ — never** | embedding any third-party data engine; general BI/dashboards; server-mandatory operation; arbitrary host code execution via scripting | excluded by design/§3 |

---

## 14. Open decisions

*Status note (2026-10-02): this section predates the implementation; what was decided and built is recorded in [ADR 015](adr/015-duckdb-wasm-vendored.md) (D-2, D-3, D-4), [ADR 553](adr/553-non-destructive-refresh.md) (D-6), [ADR 555](adr/555-batch-reuses-the-engine.md) (D-7), [ADR 556](adr/556-secrets-never-enter-the-plugin.md) (D-8) and [ADR 550](adr/550-own-binding-language.md) (D-9).*

| ID | Decision | Default leaning | Resolve by |
|---|---|---|---|
| D-1 | Governed-data integration depth | **outputs only (§3, §7)** — ruled; no third-party engine ever embedded | settled |
| D-2 | DataFusion as an alternative/embedded engine substrate | not for v1; Arrow yes (interchange), DataFusion no | M1 |
| D-3 | DuckDB extension allow-list (security-reviewed set) | httpfs (gated), excel, json, parquet, SQLite/Postgres scanners; nothing broadening host reach | M0 |
| D-4 | DuckDB-WASM bundle-size strategy (eager vs lazy extension load; which build) | lazy-load extensions; minimal core build; measure | M0 |
| D-5 | Governed-extract integration scope (read outputs vs orchestrate upstream) | read-only governed tables + optional metadata sidecar from a user-provided location; never orchestrate upstream transformation | M2 |
| D-6 | Sync conflict policy (refresh vs overrides/pins) | non-destructive default; sync report for divergences | M1 |
| D-7 | Batch generation scope | parameterized multi-doc/section from one template; no scheduling/webhooks | M2 |
| D-8 | Credential storage for DB sources | SDK secret store if available else session-only; never in document payload | M2 (RFC at M0) |
| D-9 | Binding expression language: own DSL vs reuse a sheet-style formula dialect | own minimal DSL (publishing-focused) sharing the `Value`/format vocabulary; not Excel-grammar | M0 |

---

## 15. Milestones

*Status note (2026-10-02): this section predates the implementation; see `status.md` (what is shipped and what is not). The DuckDB oracle harness named under M0 is an unimplemented skeleton (`data-conformance/tests/oracle.rs`), and the headless generation named under M2 is the `data-cli` binary ([ADR 555](adr/555-batch-reuses-the-engine.md)).*

**M0 — Spine + safe data + first bindings.**
Phase 0 (serial): **A-0 audit** (SDK surface for tagged placeholders, table
content, asset placement, network/file/storage capabilities, document-data
payload — resolve §2.2 to covered/RFC; rule D-3/D-4/D-9); freeze `data-core` types, expression signature,
binding kinds, source-adapter trait, capability/consent model. Then:
DuckDB-WASM query engine + file/inline sources; expression core; binding/
resolution/sync engine; variable + image placeholders; single-region
dynamic table; capability skeleton + security gates; round-trip; DuckDB
oracle harness + coverage gate. *Exit:* T0
green at claimed tiers; security tests green; plugin loads via SDK with
zero core changes; coverage 100%.

**M1 — The automation product.**
Record flow + templates + grouping + pagination; full expression/format
engine; data-driven rules; remote + DB sources with network-capability
consent UI; override/pin/stale sync panel; document-style integration.
*Exit:* perf gates green; a real catalog demo — a multi-hundred-page
product catalog generated live from a database, paginated, document-styled,
images placed — produced end-to-end.

**M2 — Governed + batch.**
governed-extract source (§7); batch/headless generation (§10); scripted
queries/builds; credential mechanism; richer adapters. *Exit:* governed-
model→catalog path demonstrated; batch generation of per-segment documents.

**M3 — Depth.**
Incremental-sync and large-catalog performance; format localization;
advanced presentation grouping.
