# License

**paged.data** (part of **paged**, <https://paged.media>) is
**dual-licensed**. You may use, modify, and distribute it under the terms
of **either**:

- the **Mozilla Public License, version 2.0** (MPL-2.0) — the open-source
  option; the full text is in [`LICENSE`](./LICENSE); or
- the **Paged Media Enterprise License** (PMEL) — a commercial option
  available from **And The Next GmbH**.

`SPDX-License-Identifier: MPL-2.0 OR LicenseRef-PMEL`

Every Rust source file carries the MPL notice (MPL Exhibit A) in its
header; that notice defines the MPL's per-file scope.

## Mozilla Public License 2.0 (open source)

The standard, **unmodified** MPL-2.0 governs — see [`LICENSE`](./LICENSE),
or obtain a copy at <https://mozilla.org/MPL/2.0/>. MPL's copyleft is
**file-level**: modifications to MPL-licensed files must be made available
under the MPL, while larger works that merely link or combine remain
yours.

## Paged Media Enterprise License (commercial)

For uses where MPL terms are not suitable, And The Next GmbH offers the
PMEL. Contact <https://paged.media> for terms.

## Third-party notices

- **DuckDB-WASM** — the query/ingest engine (spec §6) is the **MIT-licensed**
  `@duckdb/duckdb-wasm` artifact, **vendored as a prebuilt artifact** (not
  compiled in-tree) under `vendor/duckdb-wasm/`. Its MIT license + attribution
  are preserved in `vendor/duckdb-wasm/SOURCE.md`. No engine code is linked
  into the MPL/PMEL crates; the boundary is the Arrow-shaped `RecordSet`
  interchange (spec §3 license boundary — data outputs only).
- **Apache Arrow** — the columnar interchange substrate (Apache-2.0), permitted
  per spec §3. No third-party source-available / ELv2 / SSPL data engine is
  embedded, linked, or redistributed (spec §3, enforced by `deny.toml`).
