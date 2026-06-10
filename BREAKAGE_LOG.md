# BREAKAGE_LOG — paged.data vs. the plugin surface

Every place the published plugin surface (`@paged-media/plugin-api` v0.2 /
`plugin-sdk`) falls short of what paged.data needs. This log is BOTH the API-v1
punch list AND the live resolution of the spec's §2.2 gap table
(`thoughts/docs/paged/plugin-data/base-idea.md`) — entries drain as host/core
work lands. paged.data is the **largest SDK surface in the suite** (it adds
network + filesystem + worker + data-provider needs on top of everything
image/sheet need); several rows are the SAME RFCs the siblings file —
independence between plugins, convergence on the platform (joint-RFC summary at
the foot).

**Consolidated platform ask (the single rolled-up view + sequencing):**
`thoughts/docs/paged/plugin-data/rfi-platform-gaps.md` (the RFI). This log stays
the live per-row truth; the RFI is the entry point for the orchestrator / SDK +
core reviewers. Detailed proposals: `rfc-tagged-placeholders.md` (D-01),
`rfc-network-consent.md` (D-03).

Format: `D-NN · date · area · status`. Status vocabulary: `OPEN` / `PARTIAL`
(partially capable today) / `PARTIALLY RESOLVED` (an open gap that recently
moved) / `MOSTLY RESOLVED` / `SUPERSEDED`. Verified against the published SDK +
the `d03-network-consent` branch (plugin-api 0.2.7-canary.0) on 2026-06-10 (D-NN
ids are immutable — entries drain in place, never renumber).

---

## §2.2 row dispositions

The spec's §2.2 gap-analysis table, resolved row-by-row:

- Read document structure / styles / frames — **COVERED**
  (`capabilities.document.read: "broad"`).
- **Tagged placeholder / inline-placeholder markup in text** (named insertion
  points in text runs that survive editing) — **GAP** → D-01 (the most
  consequential row; the binding's anchor model, spec §5.2/§9.1).
- Commit Operations producing text / table / rule / **placed-asset** content in
  owned regions — text **COVERED** (`host.document.mutate`); native table content
  model **LANDED** → D-02 (`insertTable` op); placed-asset **GAP** → D-14
  (no asset-placement op).
- Owned-content / lock semantics + edit-interception for bound content —
  **GAP** → D-10.
- Frame-chain topology + overflow notification (record flow / pagination) —
  **GAP** → D-12 (M1 record-flow gate).
- Reflow notification carrying content-box geometry (resize vs transform,
  §9.6) — **GAP** → D-12.
- Document style read AND write (data-driven formatting) — read **COVERED**;
  style enumerate/read door still **GAP** → D-13 (text metrics half landed via
  `host.text.measureString`; M1 rules gate).
- **Network capability** (DuckDB httpfs / remote / API) with consent +
  allow-list — **PARTIAL** → D-03 (the contract + `host.network` door landed;
  M0 still declares `network:false`; editor consent UI + CSP open).
- **Filesystem/import capability** (local CSV/Excel/Parquet via OPFS) —
  **GAP** → D-04.
- Register importer/exporter (open a data file → start a binding) — **GAP** →
  D-06.
- Worker spawn + SharedArrayBuffer (DuckDB worker + binding workers) — **GAP**
  → D-05.
- Document-scoped persistent plugin payload (binding defs, source manifests) —
  **PARTIAL** → D-08 (the metadata door exists but caps at 64 KiB).
- **Register as a data provider** (publish schema + RecordSet + refresh,
  §7.1) — **PARTIAL** → D-09 (plugin side built + tested + RFC filed; the core
  `host.dataProviders` registry door is the residual SDK gap).

Net-new beyond the §2.2 table: the wasm-bindgen loader path AND the multi-MB
DuckDB-WASM artifact vs. the 8 MiB budget (D-07), and the host file picker
(D-11).

---

## Entries

- **D-01 · 2026-06-08 · content model · OPEN** — no tagged-placeholder /
  inline-placeholder content model. A binding's anchor is a named,
  edit-surviving insertion point in document content (a tagged text run, an
  empty frame marked image-target, a frame marked table/flow region; spec §5.2).
  The published `DocumentSurface` reads structure + geometry and `mutate` writes
  content, but there is no contract for **named insertion points in text runs
  that survive editing** and round-trip. M0 anchors bindings to whole frames /
  elements by id (coarse) and stamps the binding envelope via `setPluginMetadata`
  (`x-paged:media.paged.data`); fine-grained in-text placeholders await this
  RFC. **The most consequential row (§2.2 top).** Resolution: a
  tagged-placeholder content model RFC. T1 gate. *RFC FILED 2026-06-09:*
  `thoughts/docs/paged/plugin-data/rfc-tagged-placeholders.md` — proposes
  extending the existing `insertField`/`FieldKind` mechanism to plugin-namespaced
  fields (inline, edit-surviving, IDML-round-tripping) + a
  `DocumentSurface.placeholders()` read door + a `setFieldValue` update mutation.
  Status: draft for plugin-platform review.

- **D-02 · 2026-06-08 · engine ops · MOSTLY RESOLVED (2026-06-09)** — the
  **`insertTable` op LANDED** (the platform's table-content rework, on the
  plugin-sdk `d03-network-consent` branch): `insertTable { storyId, rows, cols,
  headerRows?, columnWidths? }` + `insertText` with a `cell: { tableId, row,
  col }` qualifier. plugin-data now lowers a dynamic table to a **NATIVE table**:
  `data-host-model` derives the `insertTable` spec + the per-cell `insertText`
  ops (pure + unit-tested — `tableInsertSpec`/`tableInsertMutation`/
  `tableCellInserts`), and `lower.ts` commits frame → story → `insertTable`
  (read its created id) → fill cells. The §2.2 tab-text + drawn-rules path is
  RETAINED as the fallback for an older host. **Residual:** the platform's
  `ElementId`/table-address shape is still settling, so `lower.ts` extracts the
  table id defensively (`tableIdOf` handles `string | { table_id }`) until it
  stabilizes. The original gap below is otherwise closed.

- **D-02b · 2026-06-08 · asset placement · SUPERSEDED by D-14 (2026-06-09)** —
  the original "covered (verify)" claim was WRONG. Verified: there is **no
  asset-placement Mutation** in the wire, and `AssetSurface` is `getFontFace`
  (font bytes) READ only — the `AssetKind` `"images"` is reserved and **rejected
  by manifest validation today** (the door has no `getImage`/place). So placing
  an image into a frame is NOT covered; that gap is **D-14**.

- **D-03 · 2026-06-08 · network capability · PARTIALLY RESOLVED (2026-06-09)** —
  the **contract + host adapter LANDED** in plugin-sdk (branch
  `d03-network-consent`): `capabilities.network` now accepts a structured
  `{ origins, purpose }` declaration (the OUTER allow-list bound) alongside the
  legacy boolean; the `host.network` door (`requestConsent` + `consentedOrigins`)
  is implemented in `host-impl.ts` (allow-list check + remembered-grant store +
  default-deny), validated by `plugin-cli`, recorded in DESIGN.md §4.6b, and
  covered by 6+5 vitest. plugin-sdk/api bumped to 0.2.7-canary. plugin-data
  **consumes it**: `session.requestNetworkConsent` gates remote/governed sources
  (dormant at M0 — `network:false` — so the host refuses; tested). **Residual
  (editor follow-up):** the consent-prompt UI + the CSP `connect-src` derived
  from the granted origins (a `ConsentBackend` the editor injects), AND
  plugin-data flips `network:{origins}` + ships a remote/httpfs source adapter
  at M1. This closes the original gap (the bare `capabilities.network` boolean
  with no consent model, no visible data-source manifest, and no allow-list door)
  at the platform layer — satisfying the §11 threat model (documents carrying
  queries do NOT auto-fetch on open; external origins are inert until the user
  reviews the source manifest and consents, per-origin + rememberable). **What
  remains:** the editor UI + CSP, and the M1 remote adapter. Full RFC:
  `thoughts/docs/paged/plugin-data/rfc-network-consent.md` (CSP-`connect-src`-
  enforced per-grant reach so DuckDB `httpfs` works unchanged; the 3b
  host-proxied fetch was rejected) — still open for **legal** review (the §11
  data-protection / GDPR posture).

- **D-04 · 2026-06-08 · storage / file-import · OPEN** — no OPFS / large-blob /
  file-import capability. `host.storage` is a localStorage-backed JSON KV
  (get/set/delete/keys) — unfit for multi-MB source files or DuckDB's OPFS
  persistence. M0 file import is in-panel `<input type=file>` → bytes handed to
  DuckDB-WASM's in-memory FS (no persistence; reload re-imports — the panel says
  so). **Joint RFC with plugin-sheet S-08 / plugin-image I-03.** Resolution:
  storage + file-import capability with a quota declaration + an OPFS/blob store
  distinct from the KV door.

- **D-05 · 2026-06-08 · workers · OPEN** — no worker-spawn / SharedArrayBuffer
  capability (`docs/wasm-packaging.md`: "SharedArrayBuffer / threads are OFF in
  v1"). DuckDB-WASM's standard `AsyncDuckDB` API is worker-hosted; M0 boots it in
  the **bundle realm** (the bundle's own JS spawns the DuckDB worker from a
  bundled blob URL, NOT via a host worker capability — the same own-realm pattern
  the wasm-bindgen engine uses, D-07). The editor is already cross-origin
  isolated (COOP/COEP), so the platform can host it; the gap is the *contract*.
  **Joint RFC with plugin-sheet S-07 / plugin-image I-02.**

- **D-06 · 2026-06-08 · importer/exporter · OPEN** — no importer/exporter
  registration capability: `ContributionSurface` offers
  tool/panel/schemaPanel/command/keybinding/overlay/editContext/objectType but
  no `importer()`/`exporter()` — so a `.csv`/`.xlsx`/`.parquet` cannot register
  as "open this file → start a binding". M0 imports via an in-panel
  `<input type=file>`. **Joint RFC with plugin-sheet S-06 / plugin-image I-05.**

- **D-07 · 2026-06-08 · wasm packaging + budget · PARTIALLY RESOLVED
  (2026-06-09)** — TWO sub-gaps. **(a) RATIFIED:** `docs/wasm-packaging.md` now
  documents "Two loaders, ratified" — the wasm-bindgen-glue path in the bundle
  realm is **the v1 contract** (there is no host-side wasm-bindgen glue; the
  bundle owns it), so loading `data-js` this way is blessed, not a workaround.
  Below is the original framing.
  (a) `loadBundleWasm` instantiates a RAW module (host-owned
  memory, caller-passed imports, no glue); a wasm-bindgen artifact (`data-js`)
  needs its `__wbindgen_*` imports + generated JS glue, so M0 declares the
  `data-js` artifact under `capabilities.wasm[]` (governance + the 8 MiB
  plugin-cli gate) but loads it via the wasm-bindgen `--target web` glue in the
  bundle realm (the canvas-wasm pattern — joint plugin-sheet S-10 / plugin-image
  I-07). (b) **NEW: the DuckDB-WASM artifact is multi-MB** — it EXCEEDS the
  `capabilities.wasm[].maxBytes` ceiling (8 MiB) AND cannot load via
  `loadBundleWasm`; it is therefore NOT manifest-declarable and loads via its own
  glue in the bundle realm. Resolution: sub-gap (a) is **closed** (the loader
  path is ratified, above); the OPEN residual is sub-gap (b) — a
  **budget-ceiling RFC** for large vendored engines (8 MiB is the hard
  per-artifact cap; the multi-MB DuckDB-WASM needs a declared, governed,
  higher-ceiling artifact class).

- **D-08 · 2026-06-08 · document-data payload · PARTIAL** — binding definitions
  + source manifests persist via `setPluginMetadata` (namespace
  `x-paged:media.paged.data`) and round-trip the document, but that door caps at
  **64 KiB per element** — fine for a binding envelope, too small for a large
  source manifest or an inline-seed table of any size. M0 keeps the per-element
  payload small + honest. Resolution: a plugin document-data capability with a
  declared size budget. GAP (verify the cap).

- **D-09 · 2026-06-08 (RFC filed + provider side built 2026-06-10) ·
  data-provider contract · PARTIALLY RESOLVED (plugin-data side done; SDK door
  OPEN)** — no core data-provider registry (§7.1). paged.data should publish a
  resolved dataset (schema + `RecordSet` + refresh/subscribe) to OTHER consumers
  (notably the sheets plugin) THROUGH a neutral core contract — registering a
  provider without knowing its consumers, no inter-plugin contact. **The
  engine/plugin side is now built + tested:**
  `DataSession::publish_provider(query, id, category) -> ProviderPublication`
  (`data-js/src/core.rs`) returns `{ id, category, revision, schema, rowCount,
  records }` — the records **stabilized** to a permutation-invariant order and
  `revision` an etag over that stabilized content (so a meaningless reorder does
  NOT trigger a spurious consumer refresh); conformance
  `data-conformance/tests/provider.rs` (3 tests), registry `data.provider.publish`
  (implemented, coverage-gated). The bundle exposes it through
  `session.publishProvider(...)` with **honest-deferred registration** (no
  `host.dataProviders` door → it returns the publication payload and logs the
  defer, never fakes a register), `src/__tests__/provider.test.ts` (3 vitest).
  **Residual (the SDK gap):** the core registry door —
  `host.dataProviders.register/discover/get/onDidChange` + a `dataProviders`
  capability. Specified in full: **RFC
  `thoughts/docs/paged/plugin-data/rfc-data-provider.md`** (shared with the
  sheets plugin's consumer side; category discovery, no consumer identity exposed
  to the provider, the §7.1 "exposes data not control" security shape). When the
  door lands, paged.data is a one-line `register(...)` away — a wiring change,
  like D-02/D-03. M1+ (T2) gate.

- **D-10 · 2026-06-08 · owned content · OPEN** — no owned-content attribute /
  edit-interception hook. Lowered bound content is plain document content; a user
  can hand-edit it with no "edit the data binding" interception (the §8 Override
  sync state is tracked in the engine, but the host cannot deliver the
  intercept). With `contribute.objectType` shipping, the "edit → re-open the
  binding" path is partially expressible; the residual is (a) the owned-content
  attribute stamped on compiled content and (b) the edit-interception delivery.
  **Joint with plugin-sheet S-09.** T2 gate.

- **D-11 · 2026-06-08 · shell / file input · OPEN** — no host file-picker
  surface (`ShellSurface` = openPanel/closePanel only). M0 uses an in-panel
  `<input type="file" accept=".csv,.json,.parquet,.xlsx">` (the React
  expert-leaf escape hatch). Clean path: a `host.shell.pickFile()` door or the
  D-06 importer registration.

- **D-12 · 2026-06-08 · frames / threading · OPEN** — no frame-chain
  topology read for owned frames and no reflow/overflow subscription. Record flow
  / pagination (the spec §9.4 killer feature) binds a query to a frame chain +
  template and paginates across pages; it needs chain reads, overflow
  notification, and the content-box-resize-vs-transform distinction (§9.6 — a
  pure transform must NOT re-paginate). `DocumentChangeEvent` carries only
  `{kind, pageIds}` today. **Joint with plugin-sheet S-05.** *Updated
  2026-06-09:* the Rust **record-flow + pagination engine landed**
  (`data-bind::resolve_record_flow` → grouped atomic template instances;
  `data-lower::paginate_flow` → greedy packing with repeated/continued headers,
  tall-record convergence, order-preserving — property tested). It paginates
  against a **caller-supplied** chain (`FrameCapacity[]`) handed to
  `DataSession::lower_record_flow`, exactly as plugin-sheet's paginator runs
  ahead of S-05. The SDK gate — reading the host's actual frame-chain topology
  and receiving content-box reflow notifications — is unchanged.

- **D-13 · 2026-06-08 · styles · PARTIALLY RESOLVED (2026-06-09)** — data-driven formatting rules
  (§9.5: `when: Expr → apply: StyleAction`) style through DOCUMENT styles, never
  a parallel styling system. Style CREATE mutations exist; there is no style
  ENUMERATION / read door, so "apply the warning character style to negative
  margins" cannot resolve a style by name without the read half. **Joint with
  plugin-sheet S-04.** M1 rules gate. *Updated 2026-06-09:* the platform's
  `host.text.measureString` door landed (on the plugin-sdk branch) — that
  supplies the text METRICS the lowerer wants for column auto-fit (the S-13
  half); the style READ door is still the open half here. *Updated 2026-06-10:*
  the rule **evaluation** engine landed (`data.bind.rule` — `evaluate_rule`
  decides which records fire which `StyleAction`, the data-driven half); what
  this gap still blocks is the **application** of a fired style — resolving a
  style by name (the READ door) and `applyStyle` with a cell qualifier for
  per-row table rules (`applyStyle` has no `cell:` today).

- **D-14 · 2026-06-09 · asset placement · OPEN** — image placeholders (§9.2)
  place a resolved reference (uri / path / asset id / bytes) into the target
  frame through the core ASSET mechanism, but there is **no image/asset-placement
  Mutation** in the wire (no `insertImage`/`placeImage`/`setFrameContent`; the
  `assets` surface is font-bytes READ only). The engine resolves + classifies the
  reference and lowers the placement IR (`data.bind.image` / `data.lower.image`
  green), but `commitLoweredImage` cannot place it — it records the binding +
  defers honestly (never faked, never via `plugin-image`, §2.1). Resolution: an
  asset-placement op (`placeImage { frameId, reference, fit }`) — possibly joint
  with plugin-image's resource-provider row (I-06). T1 gate.

---

## Convergent joint RFCs (with plugin-image + plugin-sheet)

Rows here that are the SAME platform RFCs the siblings filed independently — the
platform should design each once, for all three plugins:

| paged.data | paged.sheet | paged.image | Joint RFC | Status |
|---|---|---|---|---|
| D-02 | S-03 | — | native table content model | **LANDED** (`insertTable`) |
| D-04 | S-08 | I-03 | OPFS / large-blob + file-import capability | open |
| D-05 | S-07 | I-02 | worker spawn + SharedArrayBuffer (COOP/COEP) | open |
| D-06 | S-06 | I-05 | importer/exporter (document-type handler) registration | open |
| D-07 | S-10 | I-07 | wasm-bindgen loader door + the 8 MiB artifact budget | **loader ratified**; budget ceiling open |
| D-09 | (consumer side) | — | core data-provider contract/registry (§7.1) | **RFC filed + provider side built**; SDK registry door open |
| D-10 | S-09 | — | owned-content attribute + edit-interception | partial (`objectType` ships) |
| D-12 | S-05 | — | frame-chain read + content-box reflow notification | open |
| D-13 | S-04 | — | document-style read+write (style-management capability) | **metrics landed**; style read open |

Three plugins, filed independently, converging on the same surface is the
signal these belong in plugin-api v1. The paged.data-specific rows (D-01 tagged
placeholders, D-03 network consent, D-08 payload budget, D-11 file picker) are
paged.data's own to carry — D-01 and D-03 are the two that most define this
plugin's contract with the platform.
