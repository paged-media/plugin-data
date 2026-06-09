# Vendored: @duckdb/duckdb-wasm

- **Package:** `@duckdb/duckdb-wasm`
- **Version:** 1.29.0
- **License:** MIT (DuckDB Labs); the npm tarball ships no standalone license file — MIT terms (package.json `license`) apply
- **Source:** https://registry.npmjs.org/@duckdb/duckdb-wasm/-/duckdb-wasm-1.29.0.tgz
- **Acquired by:** scripts/vendor-duckdb.sh (reproducible; bump the pinned
  DUCKDB_WASM_VERSION deliberately).

This is the query/ingest engine (spec §6). It is vendored as a PREBUILT
artifact and consumed as a WASM module + JS bindings — NOT compiled in-tree,
NOT linked into the MPL/PMEL Rust crates. The boundary is the Arrow-shaped
`RecordSet` interchange (spec §3 license boundary — data outputs only). No
DuckDB engine source is part of this repo's build.
