# ADR 556 — Secrets never enter the plugin

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `6b96ce5`.
- **Scope:** `data-sources`, the source types in `data-core/src/model.rs`,
  `DataSession::payload` in `data-js`, the remote lane in `packages/data-bundle`

## Context

This plugin reaches outside the document: files, HTTP endpoints, databases. The repo's rules
state the position. Network and file access are gated by capability and by user consent;
"documents carrying queries are treated as carrying code (no auto-fetch on open — inert
until consented)"; credentials are never serialized into the document payload
(`CLAUDE.md:123-128`).

For databases the code adds: "The plugin NEVER holds the secret." The plugin knows the
engine, a non-secret target and a reference; the host is to resolve the reference and
build the connection on its side (`data-sources/src/lib.rs:343-351`).

## Decision

A source is described without secret material, the crates compiled into the wasm module do
no network or file I/O, and the bundle's one `fetch` call, which loads a remote source,
happens after the host has recorded consent for that origin.

- A remote source is `{url, format, params, credential_ref}`. A URL with `user:pass@` is
  rejected by `validate_remote` in Rust and by `validateRemoteUrl` in the bundle.
- A database source is `{db, target, credential_ref}`. `attach_plan` produces what a host
  needs to attach it; it carries the reference, never a secret. The older `dsn` field is
  kept so old payloads decode.
- `authorize` refuses a source whose capability is not granted or whose origin is not
  consented. `build_manifest` lists every file and origin the sources touch.
- On save, `payload()` passes each source through `redact_credentials`, which strips
  `user:pass@` from a legacy `dsn`.
- In the bundle a remote source is a descriptor until it is loaded. `loadRemoteSource`
  checks `host.network.consentedOrigins()` first; on a consented origin it calls `fetch`
  once, then hands the bytes to the query engine like an imported file. That is the only
  `fetch` call in the bundle's source. The engine computes a content key from the bytes it is given.
- The manifest declares `network: {origins: "consent"}`: no origin is allowed in advance.

## Evidence

- `data-core/src/model.rs:71-126` — the `Remote` and `DbAttach` shapes; `dsn` deprecated
- `data-sources/src/remote.rs:33-47`, `:68-89` — it "NEVER fetches"; userinfo is rejected
- `data-sources/src/lib.rs:114-140`, `:164-181` — `authorize` and `build_manifest`
- `data-sources/src/lib.rs:368-414`, `:425-459` — `AttachPlan`, `redact_credentials`
- `data-js/src/core.rs:777-794` — `payload()` redacts every source
- `packages/data-bundle/src/session.ts:766-828`, `:1467-1490` — gate, `fetch`, consent request
- `packages/data-bundle/manifest.json:15-18` — the network capability and its purpose text
- `data-conformance/tests/security.rs:63-200` — six tests of the gate and of the saved payload

## Alternatives considered

A connection string inside the source (`dsn`) was the first database shape. Commit `4081f7e`
replaced it with the credential reference and kept the field for old payloads.

Letting the query engine fetch remote files itself is what ADR 015 describes. The code does
not do that: nothing loads DuckDB's `httpfs` extension, and the bundle registers the bytes
it fetched with the query engine.

## Consequences

A consumer of the data provider cannot cause a fetch: its snapshot is rebuilt from results
already ingested (`packages/data-bundle/src/session.ts:1493-1498`). Redaction is applied in
two places: `payload()` (`data-js/src/core.rs:778-794`) and the database target shown in the
source manifest (`data-sources/src/lib.rs:287-298`). `redact_credentials` changes `DbAttach` sources only.

Authenticated sources are designed and not usable:

- Nothing resolves a `credential_ref`. The host contract has a `secrets` surface
  (`plugin-sdk: packages/plugin-api/src/host.ts:1660`); this plugin's manifest does not
  declare that capability and no code calls it.
- `attach_plan` is called only from tests. The bundle's session can add CSV and remote
  sources; it has no method to add a database source.
- The bundle's `fetch` sends no credential. A remote source's `credentialRef` is stored and
  passed into the descriptor only.
- Postgres and MySQL are not reachable from a browser at all
  (`data-core/src/model.rs:104-109`).

`authorize_report` evaluates each source against `GrantedCapabilities::m0_default()`: file
import granted, network not granted (`data-js/src/core.rs:756-759`). In the bundle, `loadRemoteSource`
tests `host.network.consentedOrigins()` before its `fetch` (`packages/data-bundle/src/session.ts:769-777`).
`CLAUDE.md:47-51`, `data-sources/src/lib.rs:82-84` and `data-core/src/model.rs:63-64` still
describe the network as declared off.

## Related

- [ADR 015](015-duckdb-wasm-vendored.md) — the query engine; amended on `httpfs` and on redaction
- [ADR 552](552-binding-is-a-recipe.md) — the payload that is redacted
- [ADR 014](014-data-provider-arrow-seam.md) — the provider snapshot
- [ADR 315](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/315-isolation-contract.md) — a gap becomes a host door, not a private channel
