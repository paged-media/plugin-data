# CLAUDE.md — paged-media/plugin-data

Orientation for Claude sessions in **paged-media/plugin-data** — the
paged.data external-data + automation subsystem, delivered as a Paged plugin
(private repo, And The Next GmbH).

## What this is

A Rust/WASM data-binding engine that makes Paged capable of **database
publishing** — the EasyCatalog category: variable replacement, dynamic tables,
image placeholders, record flow across pages, data-driven formatting, and batch
generation. The thesis: a publication is a *projection of governed data*, not a
hand-assembled artifact. Bound content is COMPILED to native Paged content via
committed Operations (the content-space / lowering model proven in
plugin-sheet), so frame ops (scale/rotate/skew/crop/reposition) are honored for
free. The **query/ingest engine is the MIT-licensed DuckDB-WASM artifact**
(vendored, not compiled in-tree), kept swappable behind the Arrow seam.

Spec (the authority): `thoughts/docs/paged/plugin-data/base-idea.md` (v0.4).
SDK gap tracker: the cross-repo RFI `thoughts/docs/paged/plugin-platform/rfi-core-sdk-gaps.md` (D-NN ids in §6; per-plugin BREAKAGE_LOG retired 2026-06-12).

Rust crates (Cargo workspace, top level per spec §4): `data-core` (frozen
types + Expr AST), `data-expr` (the binding DSL), `data-sources`, `data-query`,
`data-bind` (resolution/sync engine), `data-lower`, `data-js` (wasm-bindgen
surface), `data-conformance` (TEST-ONLY). Reserved T2: `data-automation`
(batch/headless, §10). TS packages (pnpm `packages/*`): `data-host-model`
(pure LoweredContent→Mutation translation) + `data-bundle` (manifest +
`activate(host)` + panels + DuckDB-WASM query integration). Vendored MIT engine:
`vendor/duckdb-wasm/`.

## Project State & Feature Matrix (paged-media/state)

The canonical feature inventory + live status for ALL Paged repos live in
`paged-media/state` (dashboard: https://state.paged.media). There is NO feature
matrix in this repo; do not create one. NEW CAPABILITY → registry row; EVERY NEW
TEST → feature linkage (naming convention `fn <feature_id_with_underscores>_…()`
+ the row's `tests:` pointer); STATUS CHANGE → registry, not prose. The
status-ledger row `state/registry/features/plugin-data.yaml` lives in the STATE
repo (separate PR there). The local `registry/` here is the BUILD-CONSUMED half
(see "Two-registry split" below).

## Hard rules (this repo's constitution — spec §1/§2/§3/§11)

- **ALL BINDING/EXPRESSION/SYNC/LOWERING SEMANTICS LIVE IN RUST.** Expression
  parsing + evaluation, the function library, formatting, binding resolution,
  sync-state machinery, record-identity diffing, and lowering geometry are the
  `data-*` crates compiled to ONE wasm module (`data-js`). The TS packages are
  thin glue: bundle lifecycle, panels, the DuckDB-WASM query integration, file
  input, and translating the engine's already-computed output into host
  mutations. **Never implement a binding/expression operation in TypeScript** —
  if the bundle seems to need one, the missing piece is a `data-js` API.
- **ISOLATION CONTRACT, superset (§2.1).** Zero core contact AND zero
  inter-plugin contact: the only `@paged-media/*` dependencies are `plugin-api`,
  `plugin-sdk`, and published package contracts — never `plugin-image`,
  `plugin-sheet`, or any other plugin, not at build time, runtime, or via side
  channels, even co-installed. Overlaps resolve through CORE SDK surfaces
  (image placeholders → the core asset mechanism; dynamic tables → the core
  native table contract via OUR OWN lowering code; charts → `paged.draw`),
  never a sibling plugin. The §7.1 data-provider role is a CORE SDK contract —
  `paged.data` registers a provider and never knows its consumers. TS guard:
  `scripts/check-contract-imports.mjs`; Rust guard: `deny.toml` [sources] + the
  cargo-tree CI guards. SDK gaps become RFI §6 entries /
  plugin-platform RFCs — NEVER core modifications from this project.
- **LICENSE-BOUNDARY GATE (§3 — unique to this plugin, decisive).** NO
  source-available / ELv2 / SSPL / proprietary data engine is ever embedded,
  linked, or redistributed. Such tools are integrated, if at all, ONLY by
  consuming their data *outputs* (tables + optional metadata sidecars) through
  the standard source adapters (§7) — touching zero engine code. The ONE
  bundled engine is **MIT DuckDB-WASM**, vendored as a prebuilt artifact under
  `vendor/duckdb-wasm/` (attribution in `SOURCE.md`), never compiled in-tree.
  `deny.toml` [licenses] enforces the permissive-only allow-list; any dependency
  pulling in a non-allow-listed license fails the build (the §16 license-boundary
  gate). Arrow / ADBC (Apache-2.0) is the permitted interchange substrate.
- **REGISTRY-DRIVEN DISPATCH (§12.2).** The expression function table is
  generated at build time from `registry/functions/*.yaml`
  (`data-core/build.rs` emits the name→id table; `data-expr/build.rs` emits the
  dispatch match, FnId parity). No row → no dispatch entry → **an unregistered
  function is uncallable by construction**. Same principle for source adapters,
  binding kinds, and lowering rules (registry-listed). The coverage gate
  (`cargo run -p data-conformance --bin coverage-gate`) fails below 100%
  tests-per-implemented-row.
- **PURE KERNELS.** `data-expr` functions are pure
  `fn(&[Value], &EvalCtx) -> Value` — they never see the resolution graph, the
  scheduler, or the SDK (spec §4 rule 1). `data-lower` is pure model→IR.
  `data-host-model` (TS) is pure data→Mutation[]. Every behavior change lands
  with a test.
- **CAPABILITY-GATED DATA ACCESS + THREAT MODEL (§11 — the largest surface in
  the suite).** Network and filesystem reach are capability-gated and
  user-consented; a data-source manifest shows every origin/file a document
  touches; documents carrying queries are treated as carrying code (no
  auto-fetch on open — inert until consented). Credentials are NEVER serialized
  into the document payload. M0 ships the capability/consent SKELETON +
  `data.security.*` hard gates (no resolution of remote sources pre-consent;
  round-trip test: save→inspect→assert credentials absent). `network` reach is
  declared `false` at M0 (file/inline only); it flips on at M1 WITH the consent
  UI — never silently.
- **The bundle touches host surfaces + React only.** No `@paged-media/shell` /
  `client` imports — writes via `host.document.mutate`, binding payload via
  `setPluginMetadata` (namespace `x-paged:media.paged.data`), persistence honesty
  (binding defs + source manifests in the document payload; resolved values are
  committed content — the panel says what is and isn't persisted). Panels are
  factories closing over `BundleHost`; styling = the token layer (`--pg-*`,
  `--status-*`, `--font-mono`, `--space-*`, `--radius-*`).
- **Reserved seams stay honest.** Remote/DB sources, the network-consent UI,
  record flow / pagination, data-driven rules, governed extract, batch
  generation, the data-provider contract, OPFS persistence, and worker-hosted
  DuckDB are NOT implemented at M0 — the manifest + UI + the RFI say so
  explicitly. Never fake them.
- **CLEAN-ROOM (§3).** `references/` (any reference engine, IF ever mounted) is
  read-only, analyst-only, gitignored, excluded from all artifacts; implementers
  never read it. EasyCatalog is studied as a PRODUCT (features/UX), never as
  code. **M0: references/ is NOT mounted** — implementation derives from SQL
  standards, Arrow, public docs, and golden corpora.
- **LICENSE ASYMMETRY.** Rust crates are dual MPL-2.0 OR PMEL — every `.rs`
  carries the 13-line MPL/PMEL header (copy from `data-core/src/lib.rs`). TS
  files (`packages/`, `scripts/`) carry NO header (private-side convention, like
  plugin-sheets/plugin-draw/plugin-web).
- **Interface freeze.** `data-core` types, the `Expr` AST, the `data-expr`
  calling convention (`Value`/`EvalCtx`), the `SourceAdapter` trait, the
  capability/consent model, and the registry YAML schema are FROZEN (M0 phase
  0). Changes go through the orchestrator as versioned amendments, never
  drive-by edits.

## Two-registry split

- `paged-media/state` `registry/features/plugin-data.yaml` — the STATUS ledger
  (stage `plugin.data`; planned/partial/shipped).
- `plugin-data/registry/` (here) — build-consumed metadata: `functions/*.yaml`
  (one row per expression function: family, arity, provenance, test pointers —
  drives codegen) and `features/*.yaml` (source/query/bind/lower/security/...
  rulings + test pointers). The ids mirror the state `data.*` ids so the
  registries join by id.

## Commands

```bash
# Rust (the engine)
cargo build --workspace && cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p data-conformance --bin coverage-gate    # the §12.2 gate

# Dependency guards (CI runs these; run before claiming green)
cargo tree -p data-expr --edges normal | grep -E 'data-(sources|query|bind|lower|js)' && echo LEAK
cargo tree -p data-js --target wasm32-unknown-unknown | grep -E 'data-conformance|proptest' && echo LEAK
cargo deny check

# wasm artifact (8 MiB budget; lands in packages/data-bundle/bin/)
bash scripts/vendor-duckdb.sh   # acquire the MIT DuckDB-WASM artifact (once)
bash scripts/build-wasm.sh

# TS (the bundle) — install order: editor → plugin-sdk → plugin-data
pnpm install && pnpm test && pnpm typecheck
pnpm validate:manifest

# Optional native-DuckDB differential oracle (CI container; not local)
PAGED_DATA_ORACLE=1 cargo test -p data-conformance -- --ignored
```
