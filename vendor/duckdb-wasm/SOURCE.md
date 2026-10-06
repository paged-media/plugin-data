# Vendored: @duckdb/duckdb-wasm

- **Package:** `@duckdb/duckdb-wasm`
- **Version:** 1.29.0
- **License:** MIT (DuckDB Labs); the npm tarball ships no standalone license file — MIT terms (package.json `license`) apply
- **Source:** https://registry.npmjs.org/@duckdb/duckdb-wasm/-/duckdb-wasm-1.29.0.tgz
- **Acquired by:** scripts/vendor-duckdb.sh (reproducible; bump the pinned
  DUCKDB_WASM_VERSION deliberately).

This is the query/ingest engine (spec §6). It is vendored as a PREBUILT
artifact and consumed as a WASM module + JS bindings — NOT compiled in-tree,
NOT linked into the AGPL/PMEL Rust crates. The boundary is the Arrow-shaped
`RecordSet` interchange (spec §3 license boundary — data outputs only). No
DuckDB engine source is part of this repo's build.

## Extensions (shipped in bin/duckdb-ext/)

DuckDB's own `json` and `parquet` extensions for engine v1.1.1,
platform `wasm_eh` — the eh build has neither built in. Prebuilt
and signed by DuckDB Labs; MIT, as part of DuckDB (https://github.com/duckdb/duckdb).
They ship so DuckDB loads them same-origin: bootDuckDB sets
`custom_extension_repository` to the bundle's `bin/duckdb-ext` (and turns
autoinstall off) before the configuration lock, so nothing is fetched from
extensions.duckdb.org at run time.

| Extension | Bytes | Source | SHA-256 |
| --- | --- | --- | --- |
| `json` | 696809 | https://extensions.duckdb.org/v1.1.1/wasm_eh/json.duckdb_extension.wasm | `84958e8b52814ff0035dfcb208dbac80d99d30e582c668090879d3b814c571e4` |
| `parquet` | 2803379 | https://extensions.duckdb.org/v1.1.1/wasm_eh/parquet.duckdb_extension.wasm | `e24fb2953c6a80e32d17fa3921f90f1f05ccbfa40f382e77702c1e6af9b79479` |

