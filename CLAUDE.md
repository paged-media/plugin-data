# CLAUDE.md — paged-media/plugin-data

Orientation for Claude sessions in **paged-media/plugin-data** — the
paged.data external-data + automation subsystem, delivered as a Paged plugin
(public; dual-licensed AGPL-3.0 OR PMEL, And The Next GmbH).

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

Spec (the authority): [`docs/concept.md`](./docs/concept.md).
SDK gap tracker: the cross-repo RFI `thoughts/docs/paged/plugin-platform/rfi-core-sdk-gaps.md` (D-NN ids in §6; per-plugin BREAKAGE_LOG retired 2026-06-12).

Rust crates (Cargo workspace, top level per spec §4): `data-core` (frozen
types + Expr AST), `data-expr` (the binding DSL), `data-sources`, `data-query`,
`data-bind` (resolution/sync engine), `data-lower`, `data-js` (wasm-bindgen
surface), `data-conformance` (TEST-ONLY), plus the §10 automation lane —
`data-automation` (batch plan/run), `data-cli` (headless native CLI), and
`data-script` (sandboxed Boa surface). TS packages (pnpm `packages/*`):
`data-host-model` (pure LoweredContent→Mutation translation) + `data-bundle`
(manifest + `activate(host)` + three panels [sources/bindings/dataset] + five
commands + DuckDB-WASM query integration). Vendored MIT engine:
`vendor/duckdb-wasm/` (fetched by `scripts/vendor-duckdb.sh`, which stages ONE
variant, eh, into `packages/data-bundle/bin/`; the runtime loads only `bin/`).

**State (the live ledger is the Cockpit feature registry and `docs/status.md`,
not this prose; the 2026-10-05 analysis is `docs/design/analysis-2026-10-05.md`).**
The ENGINE is far ahead of what a user can reach from the panels:
- The binding-expression DSL is SHIPPED — its own publishing grammar (not
  Excel's), ~42 functions across format/logic/text/math/temporal, registry-
  driven FnId-parity dispatch (no row → no dispatch → uncallable).
- The binding + sync engine is SHIPPED (resolution graph + Linked/Pinned/
  Overridden/Stale/Error states + record-identity diff); record flow /
  pagination (multi-level nested grouping, per-group SUM/AVG/MIN/MAX footers,
  parent path on spill) landed in the lowering lane.
- Print automation is SHIPPED end-to-end (per-record / per-group / one-catalog
  batch plan + RUN executor + the data-cli + the data-script Boa surface).
- The D-09 data-provider contract is SHIPPED (register a provider, publish a
  RecordSet to other consumers; never knows its consumers, §7.1). The
  governed-catalog KERNEL is built (schema + column-metadata sidecar), but
  nothing reads a sidecar from a source location yet (PARTIAL).
- REACHABILITY GAPS (2026-10-05, see the analysis): nothing survives reopen
  (sources, queries, bindings and data sets are session-only); the panels
  define variable, image and barcode bindings only, over `SELECT *`; table,
  rule and visibility bindings are session-only; record flow has no define
  method and no writer, so it never becomes document content; local import is
  CSV/TSV only. Remote sources declare `network: { origins: "consent" }` and
  fetch only consented origins, but the editor's CSP `connect-src 'self'`
  still blocks them in the browser (RFI D-03). Still not built: DB-attach
  execution, OPFS persistence, worker-hosted DuckDB, merge to a document.

## Project State & Feature Matrix (cockpit)

The feature inventory, test linkage and live status for ALL Paged repos are derived by
[Cockpit](https://github.com/drietsch/cockpit) from `~/paged/cockpit/` (`cockpit.toml` with
`root = ".."`; features in `cockpit/docs/features/<chapter>/<id>.md`). There is NO feature
matrix in this repo; do not create one.

Rules for every code change in this repo:

1. NEW CAPABILITY → feature file. If your change adds or completes a feature, add or update
   `cockpit/docs/features/<chapter>/<id>.md` (separate commit in `paged/cockpit`, referenced
   from this one). Feature ids are immutable; rename with `superseded_by`.
2. EVERY NEW TEST → feature link. Playwright: `{ tag: ['@feat:<id>'] }`. Rust: a test name
   ending in `__feat__<id_with_underscores>` or containing `[<id>]`. Otherwise an entry in
   `cockpit/test-map.yaml`.
3. STATUS CHANGE → `claims:` in the feature file, never prose. "X is now shipped/partial" is a
   claim edit; whether it *works* is computed from evidence and cannot be written.
4. BEFORE claiming a feature done: `cockpit feature <id> --json` (or its page in
   `cockpit serve`) — done means the linked tests are green and were produced after the
   latest implementation commit.
5. `cockpit validate --strict` is the gate (references resolve, required evidence present and
   fresh). `cockpit pull` fetches the newest CI artifacts; `cockpit status` is the summary.
6. FOUND A BUG while working? If a test exposes it, let it fail and push — the failure shows
   up as attention on its feature. Never commit `.cockpit/`.

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
  (`cargo run -p data-conformance --bin coverage-gate`) fails when an
  `implemented` row names no test that exists on disk; with
  `-- --junit target/nextest/ci/junit.xml` (as CI runs it, after nextest) it
  also fails when a named test did not run (ignored, filtered) or failed.
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
  into the document payload. The capability/consent gate +
  `data.security.*` hard gates (no resolution of remote sources pre-consent;
  round-trip test: save→inspect→assert credentials absent). `network` reach is
  declared `origins: "consent"`: a remote source is fetched only for an origin
  the host reports as consented — never silently.
- **The bundle touches host surfaces + React only.** No `@paged-media/shell` /
  `client` imports — writes via `host.document.mutate`, binding payload via
  `setPluginMetadata` (namespace `x-paged:media.paged.data`), persistence honesty
  (binding defs + source manifests in the document payload; resolved values are
  committed content — the panel says what is and isn't persisted). Panels are
  factories closing over `BundleHost`; styling = the token layer (`--pg-*`,
  `--status-*`, `--font-mono`, `--space-*`, `--radius-*`).
- **Reserved seams stay honest.** What the engine can do but a user cannot
  reach (record flow into the document, merge to a document, persistence,
  DB-attach execution, worker-hosted DuckDB, OPFS) is said so in the manifest,
  the UI, `docs/status.md` and the RFI. Never fake it, and never leave a
  "not yet" message standing after the door exists.
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

- `~/paged/cockpit/docs/features/data/<id>.md` (Cockpit, chapter `data`) — the STATUS
  ledger (component `plugin.data`; `claims:` planned/partial/shipped, health from evidence).
- `plugin-data/registry/` (here) — build-consumed metadata: `functions/*.yaml`
  (one row per expression function: family, arity, provenance, test pointers —
  drives codegen) and `features/*.yaml` (source/query/bind/lower/security/...
  rulings + test pointers). The ids mirror the Cockpit `data.*` ids so the
  registries join by id.

## Commands

```bash
# Rust (the engine). CARGO_INCREMENTAL=0 keeps target/ small.
cargo build --workspace
cargo nextest run --workspace --profile ci --no-fail-fast   # writes target/nextest/ci/junit.xml
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p data-conformance --bin coverage-gate -- --junit target/nextest/ci/junit.xml   # the §12.2 gate

# Dependency guards (CI runs these; run before claiming green)
cargo tree -p data-expr --edges normal | grep -E 'data-(sources|query|bind|lower|js)' && echo LEAK
cargo tree -p data-js --target wasm32-unknown-unknown | grep -E 'data-conformance|proptest' && echo LEAK
cargo deny check

# wasm artifact (100 MB app wasm budget; lands in packages/data-bundle/bin/).
# Rebuild after ANY Rust change: test/wasm-fresh.spec.ts fails on a wasm built
# from other sources (scripts/source-hash.mjs, stamped as bin/SOURCE_HASH).
bash scripts/vendor-duckdb.sh   # the MIT DuckDB-WASM artifact; stages bin/duckdb-engine.wasm
bash scripts/build-wasm.sh

# TS (the bundle). The contract comes from npm at an exact pin
# (test/sdk-pin.spec.ts); CI runs with REQUIRE_REAL_ENGINE=1 REQUIRE_REAL_DUCKDB=1.
pnpm install && pnpm typecheck && pnpm test
pnpm validate:manifest

# Publishing (publish.yml, after green CI): a version already on npm must be
# bumped when its inputs changed, and the tarball must carry DuckDB.
node scripts/package-hash.mjs --check
bash scripts/pubcheck.sh <packed.tgz>

# Optional native-DuckDB differential oracle (CI container; not local)
PAGED_DATA_ORACLE=1 cargo test -p data-conformance -- --ignored
```
