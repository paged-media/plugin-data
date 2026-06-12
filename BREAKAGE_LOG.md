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
moved) / `MOSTLY RESOLVED` / `RESOLVED` / `SUPERSEDED`. Verified against the
published SDK + the `d03-network-consent` branch (plugin-api 0.2.7-canary.0) on
2026-06-10, and re-trued 2026-06-12 against the plugin-platform RFI tracker
(`thoughts/docs/paged/plugin-platform/rfi-core-sdk-gaps.md`) after the Wave 3 IO
slice (K-2 importer/exporter + K-5 file picker), Wave 3b persistence (K-4
`host.blob`), and the Wave 2 C-2 frame-chain door (v0.38.0) closed the doors
several "OPEN" rows below describe (D-NN ids are immutable — entries drain in
place, never renumber).

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
  **LANDED** → D-12 (`host.document.frameChain()` + reflow event, Wave 2 / C-2,
  core v0.38.0; unconsumed by data's panels).
- Reflow notification carrying content-box geometry (resize vs transform,
  §9.6) — **LANDED** → D-12 (`DocumentChangeEvent.reflow`, resize-only, C-2).
- Document style read AND write (data-driven formatting) — read **COVERED**;
  style enumerate/read door still **GAP** → D-13 (text metrics half landed via
  `host.text.measureString`; M1 rules gate).
- **Network capability** (DuckDB httpfs / remote / API) with consent +
  allow-list — **PARTIAL** → D-03 (the contract + `host.network` door landed;
  M0 still declares `network:false`; editor consent UI + CSP open).
- **Filesystem/import capability** (local CSV/Excel/Parquet via OPFS) —
  **LANDED (unconsumed)** → D-04 (`host.blob` OPFS/blob store + quota, Wave 3b /
  K-4; data still imports via in-panel `<input type=file>`).
- Register importer/exporter (open a data file → start a binding) — **LANDED
  (unconsumed)** → D-06 (`ContributionSurface.importer()/exporter()`, Wave 3 IO /
  K-2).
- Worker spawn + SharedArrayBuffer (DuckDB worker + binding workers) — **GAP**
  → D-05.
- Document-scoped persistent plugin payload (binding defs, source manifests) —
  **PARTIAL** → D-08 (the metadata door exists but caps at 64 KiB).
- **Register as a data provider** (publish schema + RecordSet + refresh,
  §7.1) — **RESOLVED** → D-09 (core `host.dataProviders` door landed; engine
  publishes + bundle registers + editor injects the registry + sheets consumer
  S-15 resolved 2026-06-11).

Net-new beyond the §2.2 table: the wasm-bindgen loader path AND the multi-MB
DuckDB-WASM artifact vs. the 8 MiB budget (D-07), and the host file picker
(**LANDED, unconsumed** → D-11; `host.shell.pickFile`, Wave 3 IO / K-5).

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

- **D-04 · 2026-06-08 (door LANDED 2026-06-10) · storage / file-import ·
  RESOLVED (door); UNCONSUMED here** — the OPFS / large-blob capability LANDED:
  `host.blob` (a `BlobSurface` with quota, distinct from the KV door) shipped in
  the **Wave 3b persistence slice (K-4, plugin-sdk + editor, no wire/publish;
  2026-06-10)** — exactly the OPFS/blob store, with a quota declaration, this row
  asked for; plugin-sheet persists + restores its workbook across reloads against
  it (the joint S-08 / plugin-image I-03 row is the same door). The platform gap
  is **CLOSED**. **Residual is an adoption follow-up, not a platform gap:**
  paged.data still imports via an in-panel `<input type=file>` → DuckDB-WASM's
  in-memory FS (no persistence; reload re-imports — the panel says so); migrating
  data's source ingest onto `host.blob` (+ pickFile/importer, D-11/D-06) is the
  M1 second-consumer task. RFI tracker row: K-4 DONE (Wave 3b).

- **D-05 · 2026-06-08 · workers · OPEN (host-worker contract DEFERRED by
  decision)** — still no host worker-spawn / SharedArrayBuffer capability
  (`docs/wasm-packaging.md`: "SharedArrayBuffer / threads are OFF in v1").
  DuckDB-WASM's standard `AsyncDuckDB` API is worker-hosted; M0 boots it in the
  **bundle realm** (the bundle's own JS spawns the DuckDB worker from a bundled
  blob URL, NOT via a host worker capability — the same own-realm pattern the
  wasm-bindgen engine uses, D-07). The editor is already cross-origin isolated
  (COOP/COEP), so the platform can host it; the gap is the *contract*. **Joint
  RFC with plugin-sheet S-07 / plugin-image I-02.** *Updated 2026-06-12:* the
  joint **K-3 host-worker door is DEFERRED by decision (RFI, 2026-06-10)** — the
  SDK's no-speculative-surface rule: no bundle currently *needs* a host worker
  (sheets recalc is a sequential topo loop; data boots DuckDB in its own realm
  fine), so K-3 is built only when a bundle actually threads (engine parallel
  recalc, image's decode pool, or a worker-hosted DuckDB rewrite). Until then the
  own-realm pattern stands and this row stays OPEN-but-not-blocking.

- **D-06 · 2026-06-08 (door LANDED 2026-06-10) · importer/exporter · RESOLVED
  (door); UNCONSUMED here** — the importer/exporter registration capability
  LANDED in the **Wave 3 IO slice (K-2, plugin-sdk + editor, no wire/publish;
  2026-06-10)**: `ContributionSurface.importer()/exporter()` +
  `ImporterContribution`/`ExporterContribution` + the editor-owned File/Open +
  drag-drop flow that resolves the importer by extension/mime (e.g. `.xlsx` opens
  via paged.sheet; exporters surface in the Export Center). The platform gap a
  `.csv`/`.xlsx`/`.parquet` could not register as "open this file → start a
  binding" is **CLOSED** (joint S-06 / plugin-image I-05). **Residual is
  adoption:** paged.data still imports via an in-panel `<input type=file>`;
  registering data's own importer (with `host.document.open(bytes)` for the
  open-a-new-document case, an RFI follow-on) is the M1 task.

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

- **D-09 · 2026-06-08 (SDK door LANDED + provider registers 2026-06-10; both
  residuals landed 2026-06-11) · data-provider contract · RESOLVED** — **the core
  `host.dataProviders` registry now EXISTS** (plugin-sdk `dbcc9dc`, branch
  `d03-network-consent`): `capabilities.dataProviders:{publish,consume}` +
  `DataProvidersSurface` (register / discover / get / onDidChange) + the
  Arrow-aligned interchange types + a SHARED `createDataProviderRegistry()` the
  editor injects into every host + the per-plugin capability gate + the honest
  no-registry posture; DESIGN §4.6c; 6 tests. **paged.data registers against it**
  (`session.publishProvider → host.dataProviders.register`, commit `ed32771`):
  lazy `getSnapshot` in our realm (a consumer pull can't induce a fetch we're not
  consented to), `row_count→rowCount` boundary map, revision-bump on re-publish.
  **Both residuals have since LANDED (2026-06-11) — this row is now RESOLVED:**
  (a) the EDITOR creates the registry once + injects it into every host
  (`createDataProviderRegistry()` in `editor/apps/canvas/src/main.tsx` L881,
  commit `d66bfeb`), flipping `supports("dataProviders@1")` true; (b) the sheets
  CONSUMER side shipped — **plugin-sheets S-15 RESOLVED 2026-06-11**
  (`dataProviders.consume` + datasets panel + `sheetFromDataset`;
  discover/get/onDidChange + RecordSet→cells; 12 vitest). Both RFCs filed
  (`rfc-data-provider.md`, `rfc-data-provider-consumer.md`). **Remaining is NOT a
  platform/SDK gap:** a cross-plugin end-to-end test in the running editor
  (publish→discover→seed→revision-bump-marks-STALE) and a contract amendment
  fixing the per-cell value encoding (plain JS vs tagged `{t,v}` — both sides
  code defensively today). The original gap:
  no core data-provider registry (§7.1). paged.data should publish a
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
  `session.publishProvider(...)`: when the host registry is wired it **registers**
  (`host.dataProviders.register`); with no door it falls back to honest-deferred
  (returns the publication payload + logs the defer, never fakes a register) —
  `src/__tests__/provider.test.ts` (3 vitest, incl. "registers with
  host.dataProviders … once a registry is wired"). **The SDK gap (the core
  registry door — `host.dataProviders.register/discover/get/onDidChange` + a
  `dataProviders` capability) has LANDED**, and the editor now injects the shared
  registry into every host, so `supports("dataProviders@1")` is true in the real
  editor and paged.data registers for real. Specified in full: **RFC
  `thoughts/docs/paged/plugin-data/rfc-data-provider.md`** (shared with the sheets
  plugin's consumer side; category discovery, no consumer identity exposed to the
  provider, the §7.1 "exposes data not control" security shape). Was M1+ (T2);
  the chain is now complete across four repos (engine → bundle → editor injection
  → sheets consumer).

- **D-10 · 2026-06-08 · owned content · OPEN** — no owned-content attribute /
  edit-interception hook. Lowered bound content is plain document content; a user
  can hand-edit it with no "edit the data binding" interception (the §8 Override
  sync state is tracked in the engine, but the host cannot deliver the
  intercept). With `contribute.objectType` shipping, the "edit → re-open the
  binding" path is partially expressible; the residual is (a) the owned-content
  attribute stamped on compiled content and (b) the edit-interception delivery.
  **Joint with plugin-sheet S-09.** T2 gate.

- **D-11 · 2026-06-08 (door LANDED 2026-06-10) · shell / file input · RESOLVED
  (door); UNCONSUMED here** — the host file-picker surface LANDED:
  `ShellSurface.pickFile(options?) → Promise<readonly PickedFile[]>` shipped in
  the **Wave 3 IO slice (K-5, plugin-sdk + editor, no wire/publish; 2026-06-10)** —
  exactly the `host.shell.pickFile()` door this row named as the clean path. The
  platform gap is **CLOSED**. **Residual is adoption:** paged.data still uses an
  in-panel `<input type="file" accept=".csv,.json,.parquet,.xlsx">` (the React
  expert-leaf escape hatch); switching to `host.shell.pickFile` (or the D-06
  importer registration) is the M1 task. (Cross-reference note: D-11 here is the
  FILE-PICKER gap — not "DB-attach"; DB-attach is a base-idea decision id, not
  this log's D-11.)

- **D-12 · 2026-06-08 (door LANDED 2026-06-10) · frames / threading · RESOLVED
  (door); UNCONSUMED here** — the frame-chain read + reflow door LANDED:
  `host.document.frameChain(id) → FrameChainResult` (next + overflow state) plus
  an additive `DocumentChangeEvent.reflow` (fired on `mutationApplied`,
  **resize-only**, §8.5 — so a pure transform does NOT re-paginate, the §9.6
  distinction this row asked for) shipped in the **Wave 2 page-fidelity slice
  (C-2, core v0.38.0; 2026-06-10)**. plugin-sheet already consumes it
  (`lowerPaginatedToChain` + `subscribeChainReflow` — S-05 resolved). The SDK
  gate this row named — reading the host's actual frame-chain topology and
  receiving content-box reflow notifications — is **CLOSED** (joint S-05). *Prior
  (2026-06-09):* the Rust **record-flow + pagination engine** already landed on
  data's side (`data-bind::resolve_record_flow` → grouped atomic template
  instances; `data-lower::paginate_flow` → greedy packing with
  repeated/continued headers, tall-record convergence, order-preserving —
  property tested), paginating against a **caller-supplied** chain
  (`FrameCapacity[]`) handed to `DataSession::lower_record_flow`. **Residual is
  adoption:** wiring data's `lower_record_flow` to the live `frameChain()` reads +
  reflow subscription (so the caller-supplied chain becomes the host's real one)
  is the M1 record-flow task.

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
| D-04 | S-08 | I-03 | OPFS / large-blob + file-import capability | **LANDED** (`host.blob`, K-4 Wave 3b); data unconsumed |
| D-05 | S-07 | I-02 | worker spawn + SharedArrayBuffer (COOP/COEP) | **DEFERRED by decision** (K-3, RFI 2026-06-10 — no worker consumer yet) |
| D-06 | S-06 | I-05 | importer/exporter (document-type handler) registration | **LANDED** (`importer()/exporter()`, K-2 Wave 3 IO); data unconsumed |
| D-07 | S-10 | I-07 | wasm-bindgen loader door + the 8 MiB artifact budget | **loader ratified**; budget ceiling open |
| D-09 | S-15 (consumer) | — | core data-provider contract/registry (§7.1) | **RESOLVED** — door + provider register + editor injection (`d66bfeb`) + sheets consumer (S-15, 2026-06-11) |
| D-10 | S-09 | — | owned-content attribute + edit-interception | partial (`objectType` ships) |
| D-12 | S-05 | — | frame-chain read + content-box reflow notification | **LANDED** (`frameChain()` + reflow, C-2 v0.38.0); data unconsumed |
| D-13 | S-04 | — | document-style read+write (style-management capability) | **metrics landed**; style read open |

Three plugins, filed independently, converging on the same surface is the
signal these belong in plugin-api v1. The paged.data-specific rows that remain
open are D-01 (tagged placeholders) and D-08 (payload budget); D-03 (network
consent) is partially resolved (contract landed, editor UI + CSP + legal
remain); D-11 (file picker) RESOLVED platform-side (K-5, unconsumed here). D-01
and D-03 are the two that most define this plugin's contract with the platform.

**Adoption follow-up (the second debt P9 names):** several rows above are
RESOLVED platform-side but UNCONSUMED here — paged.data still ingests via an
in-panel `<input type=file>` into DuckDB's in-memory FS rather than the landed
`host.shell.pickFile` (D-11/K-5) + `host.blob` (D-04/K-4) + importer
registration (D-06/K-2), and binds against a caller-supplied chain rather than
the live `frameChain()` (D-12/C-2). Migrating data's ingest + record-flow onto
those doors is the M1 task and the second-consumer proof for the Wave 3 doors.
