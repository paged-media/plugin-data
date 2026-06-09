# paged.data

The external-data and automation subsystem of the Paged ecosystem — a
Rust/WASM data-binding engine delivered as a **Paged plugin** that makes Paged
capable of **database publishing** (the EasyCatalog category for InDesign):
variable replacement, dynamic/expanding tables, image placeholders, scriptable
queries, data-driven formatting, record flow across pages, and batch document
generation. A publication becomes a *projection of governed data*, not a
hand-assembled artifact.

Spec (the authority): `thoughts/docs/paged/plugin-data/base-idea.md` (v0.4).
SDK gap punch list: [`BREAKAGE_LOG.md`](./BREAKAGE_LOG.md) (the §2.2 resolution).

## Status — M0 / T0 spine

The first milestone: the spine + safe data + first bindings (spec §13 T0, §15
M0). Implemented:

- **`data-core`** — frozen type contract: `Value`, `DataSource`, `Query`,
  `RecordSet`, `Binding`, `Placeholder`, `SyncState`, the `Expr` AST.
- **`data-expr`** — the binding-expression DSL (own minimal DSL, spec D-9):
  lexer + Pratt parser + evaluator + pure function kernels (format / logic /
  text / math / temporal), registry-driven dispatch.
- **`data-sources`** — `SourceAdapter` trait + source models (inline seed +
  file at M0), capability tagging.
- **`data-query`** — `RecordSet` shaping (record-stream / single / scalar /
  grouped), deterministic ordering, content hashing. (Arrow-IPC decode in Rust
  is the M1 seam; the M0 path converts DuckDB's Arrow result → `RecordSet` in
  the TS query layer.)
- **`data-bind`** — the salsa-shaped resolution/synchronization engine:
  resolution graph, `ResolveStamp` invalidation, sync states
  (Linked / Pinned / Overridden / Stale / Error), record-identity diffing,
  non-destructive conflict policy.
- **`data-lower`** — placeholder lowering to a pure `LoweredContent` IR:
  variable replacement + single-region dynamic table.
- **`data-js`** — the wasm-bindgen surface (`DataSession` + `DataEngine`).
- **`data-conformance`** — the coverage gate + property/security tests.
- **TS** — `data-host-model` (pure IR → `Mutation[]`) + `data-bundle` (manifest,
  `activate`, panels, DuckDB-WASM query integration).

Record flow / pagination, remote + DB sources & the network-consent UI,
data-driven rules, governed extract, batch generation, and the SDK
data-provider contract are **M1+** (spec §13 T1–T3) — tracked as `planned`
registry rows + `BREAKAGE_LOG.md` futures.

## Quick commands

```bash
# Rust (the engine)
cargo build --workspace && cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p data-conformance --bin coverage-gate    # the §12.2 gate

# wasm artifact (8 MiB budget; lands in packages/data-bundle/bin/)
bash scripts/vendor-duckdb.sh   # acquire the MIT DuckDB-WASM artifact
bash scripts/build-wasm.sh

# TS (the bundle) — install order: editor → plugin-sdk → plugin-data
pnpm install && pnpm test && pnpm typecheck
pnpm validate:manifest

# End-to-end harness (gated; needs the built wasm + vendored DuckDB above):
# real DuckDB-WASM CSV→Arrow→RecordSet → the real data-js wasm engine →
# resolve → lower, asserting DuckDB↔engine parity.
pnpm --filter @paged-media/data-bundle test:e2e
```

## License

Dual-licensed **MPL-2.0 OR PMEL** — see [`LICENSE.md`](./LICENSE.md).
