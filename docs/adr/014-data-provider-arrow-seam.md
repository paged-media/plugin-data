# ADR 014 — The data-provider seam: `RecordSet` = Arrow IPC, no `arrow-rs` (D-09)

**2026-06-12 (records a 2026-06-09/10 decision) · decision record · status:
ACCEPTED (records the ratified D-09 cross-plugin interchange contract; consumer
landed `editor 5df546b`).**

**Sources:** the data-provider RFC, `plugin-sdk: docs/design/data-provider.md`
(D-09 — the three-stage publish/discover/snapshot/refresh contract, §7.1
Arrow-aligned substrate, the "Why not the alternatives", the security-by-shape
notes); the consumer RFC, `plugin-sheets: docs/design/data-provider-consumer.md`
(the aligned consumer half, both repos converged); the internal gap register,
§4 (convergent joint contracts); an internal design note (engine-side
`data.provider.publish` already implemented). Section numbers (§2.1, §7.1) are
those of [`../concept.md`](../concept.md).

## The decision

**Plugins interchange tabular data through a neutral host seam where the row
payload, `RecordSet`, is Arrow-aligned — reusing (aliasing) the renderer's
existing Arrow seam rather than minting a third shape, and *without* pulling in
`arrow-rs`.** The provider plugin (`paged.data`) publishes; the consumer plugin
(`paged.sheet`) discovers and pulls a snapshot on its own schedule via
`host.dataProviders` (`discover` / `get` / `onDidChange` → `getSnapshot():
Promise<RecordSet>`, with a `revision` per snapshot). `ProviderSchema` carries
field names + Arrow-aligned types (the descriptor half); the rows are the Arrow
substrate (§7.1).

## Why this seam shape, and why no `arrow-rs`

The RFC's "Why not the alternatives" is the recorded rationale:

- **Not `host.bindings` as-is** — wrong granularity: scalar values, no schema, no
  lazy pull, no per-row revision. A 200k-row catalog is not a UI binding. (Right
  *shape* to imitate — publish/discover/observe — wrong *scope* to reuse.)
- **Not a shared `@paged-media/*` package both plugins import** — that violates
  the §2.1 isolation rule (build-time coupling) and couples release cycles. The
  whole point is a *neutral* contract owned by the host, not a library both sides
  depend on.
- **Not `paged.data` writing a sheet directly** — violates §2.1 (inter-plugin
  contact) and inverts ownership: the sheet must *pull* what it chooses, on its
  schedule. Neither plugin learns the other exists (`DataProviderInfo` never
  carries the backing plugin's identity).
- **Arrow-aligned, but no `arrow-rs`** — the wire substrate reuses the renderer's
  existing Arrow seam so the system has *one* columnar shape, not three; pulling
  `arrow-rs` into the plugins would add a heavy dependency for a shape the engine
  already speaks. The alignment is the interchange contract; `arrow-rs` is the
  implementation that was *declined*.

## Consequences

- **Security is enforced by shape, not convention (§7.1):** the consumer API has
  *no parameter* by which a consumer hands the provider a query, source, or
  origin — it reads already-resolved results. A consumer **cannot induce** a
  network/DuckDB-`httpfs` fetch `paged.data` is not consented to perform (it pulls
  cache; pulling does not authorize reach). This composes with the D-03 network-
  consent gate without weakening it.
- **Graceful absence holds (§2.1):** if `paged.data` is not installed, no provider
  in its categories exists; `discover` is simply shorter and the consumer degrades
  honestly. Neither plugin hard-depends on the other; both depend only on the SDK.
- **The engine-side `data.provider.publish` payload already exists**; the
  consumer is "a register-call away." D-09 is `planned`/
  `data.provider.register` on the roadmap but the contract is ratified by this ADR
  now that the editor loads both bundles end-to-end.
- **Cross-reference:** the consumer milestone's per-cell encoding amendment is
  the residual contract detail to close alongside the editor e2e.

## Amendment — 2026-10-02

Checked against the code at `6b96ce5`, and against the contract types in plugin-sdk at
`d90f727`. The decision stands: paged.data publishes through `host.dataProviders`, the consumer
API takes no query, source or origin, and no Arrow crate is a dependency (`Cargo.lock` contains
no `arrow` package). Three statements above do not match the code.

**1. No Arrow IPC is encoded or decoded.** The title says "`RecordSet` = Arrow IPC". The body's
word, "Arrow-aligned", is the accurate one: a record set has Arrow's shape (one array per
field, a schema with a small type vocabulary) and crosses every boundary as plain values, never
as an IPC byte buffer.

- `data-core/src/model.rs:350-359` — `RecordSet { schema, columns: Vec<Vec<Value>>, row_count }`,
  "Stored **columnar** (Arrow's shape)". `data-core/src/model.rs:261-273` — `FieldType`, the eight
  logical field types.
- `packages/data-bundle/src/query/recordset.ts:113-124` — `arrowToRecordSet` converts the Arrow
  table that DuckDB-WASM returns into that shape, in TypeScript. Each cell becomes a tagged
  `{t, v}` value (`:27-33`, `:94-109`); the field type is classified from the string form of the
  Arrow type (`:76-85`).
- `data-js/src/lib.rs:115-119` — the wasm export `ingest_result` takes a `JsValue` and decodes it
  with `serde_wasm_bindgen` (`:448-454`). `publish_provider` (`:308-319`) returns the publication
  the same way.
- `packages/data-bundle/src/session.ts:1514-1525` — the provider's `getSnapshot` returns
  `{ schema, columns, rowCount }`, mapping the engine's `row_count` to the contract's `rowCount`.
- `plugin-sdk: packages/plugin-api/src/host.ts:1385-1392` — the contract type is
  `ProviderRecordSet { schema, columns: unknown[][], rowCount }`, "The columnar row payload a
  provider serves (Arrow-aligned)"; `:1373-1378` — a field's type is the string `ty`. The contract
  has no byte-buffer type. `plugin-sdk: packages/plugin-sdk/src/host-impl.ts:523-528` — the
  registry hands the consumer the object that `getSnapshot` returned.
- `registry/features/provider.yaml:16` — "transport is Arrow-aligned-by-SHAPE, not arrow-rs IPC
  (ADR-014)" and "JSON over the wasm boundary, not an arrow-rs byte buffer".
- `registry/features/query.yaml:29-32` — the row `data.query.arrow-ipc`, "Raw Arrow-IPC decode in
  Rust (so the boundary takes IPC, not JSON)", has `status: planned`.
- `packages/data-bundle/package.json:31` — `apache-arrow`, the JavaScript Arrow library, is a
  development dependency of the bundle and of nothing else in the repository.

This supersedes "= Arrow IPC" in the title and qualifies "the rows are the Arrow substrate" in
the decision. Three places in the repository still describe a Rust-side IPC decode as the next step:
`data-query/src/lib.rs:33-36`, `README.md:27-29` and `deny.toml:10-11`; the last one expects
`arrow-rs` to arrive with it, which this ADR declines.

**2. The seam that is reused is paged.data's own record set.** "The renderer's existing Arrow
seam" (decision, and the fourth reason) is the `RecordSet` that the data engine already ingests
from its query layer: the publication carries "Arrow-shaped, the same interchange used
internally" (`data-js/src/core.rs:177-179`). The core render engine has no Arrow type and no
Arrow dependency (`core: Cargo.lock` contains no `arrow` package; core at `9f933f1`).

**3. Registration is implemented.**

- `registry/features/provider.yaml:21-24` — `data.provider.register` has `status: implemented`.
- `packages/data-bundle/src/session.ts:1502-1528` — `publishProvider` registers with
  `host.dataProviders` when the host reports `dataProviders@1`; a second publish of the same
  provider only updates its revision. Without a registry it logs and registers nothing
  (`:1529-1536`).
- `packages/data-bundle/src/panels/dataset-panel.tsx:155` — the Dataset panel calls it.
- `packages/data-bundle/manifest.json:34-38` — the manifest declares
  `dataProviders.publish: ["dataset"]`.

This supersedes, in Consequences, "D-09 is `planned`/`data.provider.register` on the roadmap".
Three comments still describe the registry door as not yet available and are stale:
`data-js/src/core.rs:157-160`, `data-js/src/lib.rs:290-293` and
`packages/data-bundle/src/session.ts:498-501`.
