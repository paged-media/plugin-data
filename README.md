# paged.data

The external-data and automation subsystem of the Paged ecosystem — a
Rust/WASM data-binding engine delivered as a **Paged plugin** that makes Paged
capable of **database publishing** (the EasyCatalog category for InDesign):
variable replacement, dynamic/expanding tables, image placeholders, scriptable
queries, data-driven formatting, record flow across pages, and batch document
generation. A publication becomes a *projection of governed data*, not a
hand-assembled artifact.

Spec (the authority): [`docs/concept.md`](./docs/concept.md).

## Documentation

Everything about how the plugin is designed and built is in [`docs/`](./docs/README.md):

- [`docs/concept.md`](./docs/concept.md): the specification, with notes on what was built.
- [`docs/architecture.md`](./docs/architecture.md): crates, packages, the binding and lowering paths, host doors.
- [`docs/status.md`](./docs/status.md): what ships today and what does not.
- [`docs/adr/`](./docs/adr/README.md): the architecture decisions, one per file.
- [`docs/design/analysis-2026-10-05.md`](./docs/design/analysis-2026-10-05.md): the
  fundamentals, test, CI and performance analysis behind the current round of work.

## What is in the repository

- **Rust engine** (thirteen crates, compiled to one wasm module by `data-js`):
  the frozen type contract (`data-core`); the binding language, 42 functions
  with registry-driven dispatch (`data-expr`); source descriptors and the
  consent gate (`data-sources`); record-set shaping, ordering and hashing
  (`data-query`); the resolution and sync engine with record-identity diffing
  (`data-bind`); lowering to a pure content IR, including record flow and
  pagination (`data-lower`); barcodes (`data-barcode`); data sets and the
  variable library (`data-dataset`); batch plans (`data-automation`), the
  headless CLI (`data-cli`) and the sandboxed script surface (`data-script`);
  and the conformance suite with the coverage gate (`data-conformance`).
- **TypeScript:** `data-host-model` (pure IR → `Mutation[]`) and the published
  bundle `@paged-media/data` (`packages/data-bundle`: manifest, `activate`,
  three panels, seven commands, the DuckDB-WASM query integration).

The engine does much more than the panels reach: nothing is restored on reopen
yet, record flow never becomes document content, and the panels bind variables,
images and barcodes over `SELECT *` only. [`docs/status.md`](./docs/status.md)
has the full picture.

## Quick commands

```bash
# Rust (the engine)
cargo build --workspace
cargo nextest run --workspace --profile ci --no-fail-fast
cargo clippy --workspace --all-targets -- -D warnings
# the §12.2 gate: every implemented registry row names a test that ran and passed
cargo run -p data-conformance --bin coverage-gate -- --junit target/nextest/ci/junit.xml

# wasm artifact (100 MB app wasm budget; lands in packages/data-bundle/bin/)
bash scripts/vendor-duckdb.sh   # acquire the MIT DuckDB-WASM artifact
bash scripts/build-wasm.sh

# TS (the bundle); the plugin contract comes from npm at an exact pin
pnpm install && pnpm typecheck && pnpm test
pnpm validate:manifest   # needs a plugin-sdk checkout beside this repository

# End-to-end harness (needs the built wasm + vendored DuckDB above):
# real DuckDB-WASM CSV→Arrow→RecordSet → the real data-js wasm engine →
# resolve → lower, asserting DuckDB↔engine parity.
pnpm --filter @paged-media/data test:e2e
```

## License

Dual-licensed **MPL-2.0 OR PMEL** — see [`LICENSE.md`](./LICENSE.md).
