# ADR 554 — Record flow is paginated by the plugin over a host-supplied frame chain

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `6b96ce5`.
- **Scope:** `resolve_record_flow` in `data-bind`, `paginate_flow` in `data-lower`, the chain
  reader in `packages/data-bundle/src/session.ts`

## Context

A record-flow binding lets records "flow through a frame chain, one template instance per
record" (`data-core/src/binding.rs:92-93`): the catalogue case, where a query result fills a
series of threaded frames across pages.

The paginator was written before a plugin could read the host's frame chain. Its comment
says the chain read and the reflow notification were missing from the host contract, so the
function packs over a chain supplied by the caller (`data-lower/src/lib.rs:392-400`). The
bundle later gained a reader for the live chain (commit `d47cdb7`).

The plugin decides which record lands in which frame; it does not pour text into the chain
and let the host's text layout break it. The repository does not record why.

## Decision

Pagination is done by the plugin's engine, in two pure steps, over a list of frame
capacities that the caller provides.

- `resolve_record_flow` orders the records, splits them into sections by the group-by
  fields, and renders one template instance per record (one line per template field). With
  several group-by fields, parent levels become header-only sections. A leaf section may get
  a footer: a label with the record count and a SUM, AVG, MIN or MAX of one numeric field.
- An instance's height is `fields.len() × line_height_pt`. It is a model, not a measurement.
- `paginate_flow(groups, chain, opts)` packs the blocks in order into
  `FrameCapacity {frame, page, heightPt}` entries. A record is never split. When a section
  continues in the next frame its header, with its parent headers, is repeated and marked
  `continued` if the record still fits below them. A record taller than a frame is placed in
  that frame alone and over-full, so one pass always ends.
- When the chain runs out, the result has `overflow: true`; `placed` counts the records placed, out of `total`.
- In the editor the chain comes from `host.document.frameChain(storyId)` plus each frame's
  height from `elementGeometry`; a change event with `reflow` set paginates again. In batch
  runs the caller supplies the chain ([ADR 555](555-batch-reuses-the-engine.md)).

## Evidence

- `data-lower/src/lib.rs:392-400` — the rationale comment: caller-supplied chain, atomic
  records, one bounded pass
- `data-lower/src/lib.rs:497-504`, `:553-602` — `paginate_flow` and the record loop
- `data-lower/src/lib.rs:402-410`, `:458-495` — `FrameCapacity`, `FlowBlock`, `PaginatedFlow`
- `data-bind/src/lib.rs:849-869`, `:887-921`, `:958-978` — sections, nested levels, footers
- `data-core/src/binding.rs:378-389` — `Template` and its height model
- `packages/data-bundle/src/session.ts:80-110`, `:1439-1465` — `readLiveChain`,
  `paginateChain`, `subscribeChainReflow`
- `data-conformance/tests/recordflow.rs:137-196`, `data-conformance/tests/properties.rs:99-134`
  — packing, the tall record, and the order-preserving property test

## Alternatives considered

None recorded in the repository.

## Consequences

Interactive and batch pagination are the same function, so they agree by construction. The
engine cannot add frames or pages; it reports `overflow`. Heights are not measured: a record
is its field count times a line height, and a header is a fixed height (16 pt by default).

**Nothing turns a `PaginatedFlow` into document content.** `data-host-model` has no
translator for it, `paginateChain` returns the value to its caller, and the pinned checkouts
of core, editor and plugin-sdk contain no reference to the type.

**A record flow cannot be authored in the editor bundle.** The session has methods to
define variable, table, image, barcode, visibility and rule bindings, and none for a record
flow or a template; the bundle's engine interface does not declare `define_template`
(`packages/data-bundle/src/engine.ts:31-116`). `paginateChain` and `subscribeChainReflow`
are called only from tests. The Dataset panel's batch run looks for a record-flow binding
and reports that there is none; if one existed it would paginate into a single 700 pt frame
and show counts (`packages/data-bundle/src/panels/dataset-panel.tsx:133-144`). The wasm
engine is exercised with a record flow in `packages/data-bundle/test-integration/pipeline.e2e.mjs`.

The registry lists live pagination as `status: implemented`
(`registry/features/lower.yaml:99-109`); that describes the session method and its tests.

`FlowOpts.repeat_header` and `FlowOpts.continued_marker` on the binding are not read. The
paginator takes these from `FlowLayoutOpts`, and the bundle passes none, so the defaults
apply (`data-lower/src/lib.rs:448-456`).

Comments in `data-js/src/core.rs:462-464` and `:505-506` still call the host chain read blocked.

## Related

- [ADR 555](555-batch-reuses-the-engine.md) — batch runs call the same paginator
- [ADR 551](551-compiled-to-native-content.md) — the lowering path that has no record-flow arm
- [ADR 550](550-own-binding-language.md) — template fields are binding expressions
