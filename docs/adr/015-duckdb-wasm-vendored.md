# ADR 015 — DuckDB-WASM 1.29 vendored as paged.data's query engine

**2026-06-12 (records a 2026-06-08 decision) · decision record · status:
ACCEPTED (records paged.data's first-milestone query-engine choice + the
credential-redaction gate).**

**Sources:** [`../concept.md`](../concept.md) (v0.4 — the external-data / database-
publishing plugin spec); an internal design note (DuckDB-WASM 1.29 vendored,
RecordSet=Arrow seam, the credential-redaction gate, wasm budget 0.54 MiB vs 8
MiB ceiling, 9 Rust crates, first-milestone spine `d074fe3`); the data-provider
RFC, `plugin-sdk: docs/design/data-provider.md` (the §11 governed-fetch /
DuckDB-`httpfs` reach the consent gate guards); the network-consent RFC,
`plugin-sdk: docs/design/network-consent.md` (D-03 — the `httpfs` consent door).

## The decision

**paged.data uses DuckDB-WASM 1.29, vendored, as its in-bundle query engine —
with a credential-redaction gate over every diagnostic/error surface so
connection strings and secrets never leak.** DuckDB runs the plugin's SQL
(joins, aggregation, the EasyCatalog-style external-data publishing) entirely
in-wasm; its `httpfs` remote reach is governed by the D-03 network-consent gate
(default-deny, per-origin grants enforced down to CSP `connect-src`), so the
engine choice and the security posture are one decision.

## Why DuckDB-WASM, vendored, and why the redaction gate

- **A real analytical SQL engine, in-wasm, was the requirement.** The plugin's
  job is publishing/joining external datasets (the EasyCatalog category) — that is
  relational query work, not something to hand-roll. DuckDB is a mature columnar
  engine with a first-party wasm build and native Arrow interchange, which is
  exactly the substrate the D-09 data-provider seam standardized on
  ([ADR 014](014-data-provider-arrow-seam.md)) — one columnar shape end to end,
  no impedance layer.
- **Vendored, not fetched at runtime.** A query engine the plugin's correctness
  depends on cannot be a CDN dependency: vendoring pins the version (1.29), keeps
  the bundle reproducible and offline-installable, and keeps the plugin inside the
  no-network-by-default doctrine — DuckDB's *engine* is local; only its `httpfs`
  reach crosses the network, and only with consent.
- **The size is acceptable against the budget.** An internal review's "30+ MB"
  framing is the worst case; the measured paged.data wasm sits at **0.54 MiB
  against the 8 MiB plugin ceiling** — DuckDB's bulk is its own wasm artifact,
  loaded as a managed module, not folded into the plugin's contract surface.
- **Credential redaction is a gate, not a guideline.** Connection strings, file
  URLs, and secrets routinely appear in SQL/error text; the gate scrubs them from
  every diagnostic before it can reach a log, a panel, or the host. It is enforced
  in the first-milestone gate (the 53-row gate green at that milestone), not left
  to reviewer vigilance — the classic failure mode this ADR exists to prevent.

## Consequences

- **The query engine and the network posture are coupled by design.** DuckDB's
  `httpfs` is the *reason* D-03 network consent exists; a remote query is only
  reachable through a consented origin (RFC §11). The engine cannot be reasoned
  about independently of the consent gate.
- **Arrow alignment is load-bearing across two ADRs.** DuckDB's native Arrow
  output is what makes the D-09 `RecordSet` seam
  ([ADR 014](014-data-provider-arrow-seam.md)) zero-copy-shaped without
  `arrow-rs` — the engine choice and the interchange choice reinforce each
  other.
- **The redaction gate is a standing CI obligation.** Any new diagnostic surface
  in paged.data must route through it; the gate row in the first-milestone suite
  is the guard.
- **Status caveat:** the plugin-data first milestone is committed-not-pushed at
  record time; this ADR records the decision, not a release.

## Amendment — 2026-10-02

Checked against the code at `6b96ce5`. The engine choice stands: DuckDB-WASM, pinned at 1.29.0
(`scripts/vendor-duckdb.sh:16`, `vendor/duckdb-wasm/SOURCE.md:4`), runs the plugin's SQL and is
never loaded from a CDN (`packages/data-bundle/src/query/duckdb.ts:70-75`). The text above no
longer matches the code in five places.

**1. Redaction is implemented for the saved payload and the source manifest.** Redaction
covers one field and is applied in two places: the saved document payload and the visible
source manifest.

- `data-sources/src/lib.rs:419-434` — `redact_credentials` strips the `user:pass@` part of the
  deprecated `dsn` field of a database source and returns every other source kind unchanged;
  `:451-459` is `redact_dsn`.
- `data-js/src/core.rs:764-780` — `payload()`, which builds the document payload, is the only
  caller of `redact_credentials`.
- `data-sources/src/lib.rs:273-284` — the source manifest shows a database target through
  `redact_dsn` when only the legacy `dsn` is present.
- Tests: `data-conformance/tests/security.rs:89-117`, `:133-157` and `:176-200` assert on the
  serialised payload; `data-sources/src/lib.rs:537-555` asserts on the manifest. The registry row
  is `data.security.credentials-absent`, "Credentials never serialized into the document payload"
  (`registry/features/security.yaml:22-32`).

These two functions, `redact_credentials` and `redact_dsn`, are the redaction code in the
repository. Secrets are kept out by the shape of a source. A source names a `credential_ref`
string that the host resolves (`data-core/src/model.rs:73-76`, `:116-120`), and a remote URL
with embedded credentials is rejected at validation (`data-sources/src/remote.rs:68-70`,
`packages/data-bundle/src/remote.ts:70-72`). That decision is recorded in
[ADR 556](556-secrets-never-enter-the-plugin.md).

This supersedes, in the decision, "with a credential-redaction gate over every diagnostic/error
surface"; the fourth reason, "the gate scrubs them from every diagnostic before it can reach a
log, a panel, or the host"; and the consequence "Any new diagnostic surface in paged.data must
route through it".

**2. DuckDB's `httpfs` is not used. The bundle fetches, after consent, and hands DuckDB the
bytes.**

- The string `httpfs` occurs once in the repository, in a test comment
  (`packages/data-bundle/src/__tests__/consent.test.ts:20`). No code installs or loads a DuckDB
  extension.
- `packages/data-bundle/src/session.ts:766-777` — `loadRemoteSource` first checks the source's
  origin against the origins the host reports as consented; an origin without consent leaves the
  source inert and nothing is fetched.
- `packages/data-bundle/src/session.ts:782` — the one `fetch()` call in the bundle's source.
- `packages/data-bundle/src/session.ts:786-794` — the response bytes are registered with DuckDB
  in the same way as an imported file (`registerCsv`, `registerFileBuffer`).
- `data-sources/src/remote.rs:21-27` — the Rust side validates the descriptor and "NEVER
  fetches".
- `packages/data-bundle/src/session.ts:1467-1490` — consent is requested through
  `host.network.requestConsent`; `packages/data-bundle/manifest.json:15-18` — the manifest
  declares `network: { origins: "consent" }`.

What the consent check guards is the bundle's own fetch. Enforcement below it is the host's:
in the editor at `28dc764` the page policy is the fixed `connect-src 'self' blob: data:`
(`editor: apps/canvas/public/_headers:49`), which is not derived from per-origin grants
(`editor: apps/canvas/src/plugin-consent.ts:36-41`). This supersedes "its `httpfs` remote reach
is governed by the D-03 network-consent gate (default-deny, per-origin grants enforced down to
CSP `connect-src`)" in the decision, "only its `httpfs` reach crosses the network" in the second
reason, and the first consequence where it names `httpfs`.

**3. "Vendored" means downloaded by a script that is run by hand, and the bundle boots the
engine in a worker it creates itself.**

- `scripts/vendor-duckdb.sh:22-36` — the script downloads the `@duckdb/duckdb-wasm` tarball from
  the npm registry and copies its `dist/` to `vendor/duckdb-wasm/dist/`.
- `.gitignore:18-25` — that directory is not committed. The tracked files under `vendor/` are
  `vendor/duckdb-wasm/SOURCE.md` and a `.gitkeep`.
- `packages/data-bundle/src/query/duckdb.ts:44`, `:64` — the bundle imports DuckDB's JavaScript
  API dynamically from that directory. `@duckdb/duckdb-wasm` is not a dependency in any
  `package.json`.
- `packages/data-bundle/src/query/duckdb.ts:76-99` — the bundle builds same-origin URLs for the
  three builds (`mvp`, `eh`, `coi`), lets `selectBundle` choose one, creates the worker with
  `new Worker(bundle.mainWorker)` and instantiates the module in it.
- `packages/data-bundle/src/query/duckdb.ts:65-68`,
  `packages/data-bundle/src/session.ts:683-693` — when the directory is absent the boot throws
  `DUCKDB_NOT_VENDORED` and the session reports the status `duckdb-missing`.
- `packages/data-bundle/manifest.json:27-32` — the manifest declares `bin/duckdb-engine.wasm` with
  `purpose: "engine"` and `maxBytes: 50331648`. `scripts/vendor-duckdb.sh:74-83` stages a copy of
  the `eh` build at that path. The module instantiated at run time is the one chosen from
  `vendor/duckdb-wasm/dist/`, not the staged copy
  (`packages/data-bundle/src/query/duckdb.ts:29-35`).

The host does not load the DuckDB module and does not spawn its worker. The manifest declares
no `workers` capability (`packages/data-bundle/manifest.json:7-39`), and the comment at
`packages/data-bundle/src/query/duckdb.ts:21-22` gives the reason as "no host worker capability
yet". plugin-sdk now has a `workers` capability and a `host.workers` door
(`plugin-sdk: packages/plugin-api/src/manifest.ts:161-180`, plugin-sdk at `d90f727`;
[ADR 318](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/318-host-spawned-workers.md));
this bundle does not use it. This supersedes "loaded as a managed module" in the third reason.

**4. The published npm package does not contain DuckDB.**

- `.github/workflows/publish.yml:41-42`, `:52`, `:63-65` — the publish job runs
  `scripts/build-wasm.sh` and `pnpm -r build`, then packs and publishes `packages/data-bundle`.
  No workflow under `.github/workflows/` runs `scripts/vendor-duckdb.sh`.
- `packages/data-bundle/package.json:36-40` — the package ships `dist`, `bin` and
  `manifest.json`. `bin/duckdb-engine.wasm` is created only by `scripts/vendor-duckdb.sh:74-78`
  and is ignored by git (`.gitignore:14`), so the artifact the manifest declares
  (`packages/data-bundle/manifest.json:29`) is not in the package. `vendor/` lies outside the
  package directory.
- The tarball of `@paged-media/data@0.1.0-canary.9` on the npm registry, read on 2026-10-02,
  contains `bin/data_js_bg.wasm` and no DuckDB file.
- `editor: apps/canvas/vite.config.ts:53-67`, `:404-437` — the editor's development server
  serves the DuckDB files from `vendor/duckdb-wasm/dist` in a plugin-data checkout beside it
  (editor at `28dc764`).

An application that installs the package from npm therefore has no query engine until it
supplies those files itself. This supersedes "keeps the bundle reproducible and
offline-installable" in the second reason.

**5. DuckDB's Arrow result is converted, not passed through.**
`packages/data-bundle/src/query/recordset.ts:113-124` turns the Arrow table into the engine's
record set one cell at a time, in TypeScript, and that record set is what crosses into the wasm
engine and to other plugins. See the amendment to
[ADR 014](014-data-provider-arrow-seam.md). This supersedes "one columnar shape end to end, no
impedance layer" in the first reason and "zero-copy-shaped" in the second consequence.
