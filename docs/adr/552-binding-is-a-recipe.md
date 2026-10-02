# ADR 552 — A binding is a recipe stored in the document; resolved values are committed content

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `6b96ce5`.
- **Scope:** `DocumentPayload` in `data-js/src/core.rs`, the binding types in `data-core`,
  the envelope and placeholder helpers in `packages/data-host-model`, `packages/data-bundle`

## Context

A data-bound document holds two kinds of state: the definition of what is bound to what
(sources, queries, expressions) and the values those definitions currently produce. The
repo's rules name both and assign them differently: "binding defs + source manifests in the
document payload; resolved values are committed content — the panel says what is and isn't
persisted" (`CLAUDE.md:136-137`). The repository does not record why.

`data-core/src/binding.rs:35-36` adds that expressions are carried as source strings, "so
the binding is the document's serializable *recipe*" (see [ADR 550](550-own-binding-language.md)).

## Decision

Persistence is split in two.

- **The recipe** is one serde type, `DocumentPayload`: `sources`, `queries`, `templates`,
  `bindings` and `variables`. Every field is `#[serde(default)]`, so a payload written before
  a field existed still loads. `DataSession::payload()` emits it with credentials redacted
  ([ADR 556](556-secrets-never-enter-the-plugin.md)); `DataSession::from_payload()` rebuilds
  a session from it.
- **Resolved values** are not plugin data. They are ordinary document content written
  through host mutations ([ADR 551](551-compiled-to-native-content.md)).
- **The link from content back to a binding** uses host mechanisms. A text variable is a
  placeholder field tagged `{plugin: "media.paged.data", key: <binding id>}`; the refresh
  loop enumerates `host.document.placeholders()` and writes only changed values. A table
  frame the plugin creates carries a versioned envelope `{v, data}` under the metadata key
  `x-paged:media.paged.data`, written with `setPluginMetadata`; a barcode batch stamps the
  same kind of envelope on its `$created` element. The text frame minted for a new variable
  field carries none (`packages/data-bundle/src/lower.ts:253-264`).
- **Imported rows are never stored.** They live in the query engine's memory.

## Evidence

- `data-js/src/core.rs:196-221` — `DocumentPayload` and its fields
- `data-js/src/core.rs:777-817` — `payload()` with redaction, and `from_payload()`
- `data-conformance/tests/roundtrip.rs:96-122` — save, load, save again: lossless, no secrets
- `packages/data-host-model/src/binding.ts:25-43` — the key and the `{v, data}` envelope
- `packages/data-host-model/src/fields.ts:41`, `:53-67` — the tagged placeholder field
- `packages/data-bundle/src/session.ts:1376-1426` — the refresh loop over `placeholders()`
- `packages/data-bundle/src/lower.ts:103`, `:541-545` — the two envelopes the bundle writes
- `packages/data-bundle/src/panels/sources-panel.tsx:202-205` — "Imported data stays in memory only"

## Alternatives considered

One envelope holding every recipe of a document is tested and rejected on size: the host
caps a metadata value at 64 KiB (`core: crates/paged-mutate/src/apply/layer.rs:498`), and 400
recipes in one value exceed it (`packages/data-host-model/src/__tests__/payload-budget.test.ts:117-124`).

## Consequences

The payload is a file format, and the recipe half of a batch job file
([ADR 555](555-batch-reuses-the-engine.md)). Captured data sets are the only part of it that
grows with the record count (`data-js/src/core.rs:213-218`); the session measures the
variable set and warns above 80 % of 64 KiB (`packages/data-bundle/src/session.ts:977-987`).

**Restoring a session on reopen is not built.** The bundle does not complete the recipe half.

- `payload()` is declared in the bundle's engine interface
  (`packages/data-bundle/src/engine.ts:113`) and never called by the bundle.
- The wasm class `DataEngine` exposes no `from_payload` (`data-js/src/lib.rs:74-442`).
  `from_payload` is called by `data-cli` and by the conformance tests only.
- The envelopes the bundle writes are stubs: `{kind: "table", region}` on a table frame and
  `{kind: "barcode", target, symbology}` on a barcode. They hold no expression, query or
  source. Image and visibility bindings write no envelope.
- `parseEnvelope` has no caller outside tests. The only reader of the metadata is the
  edit-context claim, which checks that it is present
  (`packages/data-bundle/src/activate.ts:169-180`).

The placeholder fields, tables, images and tagged frames are document content and stay with
the document; sources, queries and binding definitions exist only in the session. After a
reopen the refresh loop skips a field whose key is not a binding defined in the new session
(`packages/data-bundle/src/session.ts:1396-1397`), and data has to be imported again.

The comment in `packages/data-host-model/src/__tests__/payload-budget.test.ts:24-28`
describes recipes stamped on their carrier elements and a manifest on the document. No code
writes either; the test measures objects built in the test file.

## Related

- [ADR 550](550-own-binding-language.md) — expressions in the recipe are source text
- [ADR 551](551-compiled-to-native-content.md) — how resolved values become content
- [ADR 553](553-non-destructive-refresh.md) — sync state, which is not in the payload
- [ADR 311](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/311-plugin-state-under-own-id.md) — plugin metadata lives under the plugin's own id
- [ADR 024](https://github.com/paged-media/editor/blob/main/docs/adr/024-context-sensitivity-is-a-core-concept.md) — the edit context that claims frames by this metadata
