# ADR 551 — Bound content is compiled to native document content through a pure intermediate form

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `6b96ce5`.
- **Scope:** `data-lower`, `data-barcode`, the `LoweredOutput` type in `data-js`,
  `packages/data-host-model`, `packages/data-bundle/src/lower.ts`

## Context

A binding resolves to a value: a text, a grid of cells, an image reference, a barcode, a
show/hide decision. That value has to appear on the page. The general rule for plugins is
recorded in ADR 316 (plugin-sdk): plugin content is stored as valid native document content.

The repo states the reason: bound content is compiled to native content through committed
operations, "so frame ops (scale/rotate/skew/crop/reposition) are honored for free"
(`CLAUDE.md:13-16`). `data-lower/src/lib.rs:31-33` says the same of its geometry.

## Decision

The plugin draws nothing on the page itself. The Rust engine lowers a resolved binding to a
serde value (`LoweredOutput`: `Variable`, `Table`, `Image`, `Barcode`, `Visibility`); a pure
TypeScript package (`data-host-model`) turns that value into host `Mutation`s; the bundle
sends them through `host.document.mutate`.

- Variable: an `insertField` whose `placeholder` carries `{plugin, key, value}`; later
  values are written with `setFieldValue`.
- Table: `insertTextFrame`, then `insertTable`, then one `insertText` per non-empty cell
  addressed by `{tableId, row, col}`. If `insertTable` yields no table id, the same frame
  receives tab- and newline-joined text plus one `insertLine` per grid rule.
- Image: `placeImage` on a bound rectangle, by URI.
- Visibility: `setElementProperty` on the element's own `elementVisible`.
- Rule: `applyStyle` over a story range, or `createCellStyle` once and then
  `setElementProperty` `appliedCellStyle` per fired cell.
- Barcode: EAN-13, UPC-A, Code-128 and QR are encoded in this repo (`data-barcode`), from
  the public ISO/IEC specifications, into rectangles in a unit box. `data-lower` scales them
  to the bound frame's content box and the bundle emits one closed four-anchor `insertPath`
  per dark module, all in one `batch`.
- All lowered geometry is in points, measured from the region's top-left.

## Evidence

- `data-lower/src/lib.rs:19-37` — the crate statement: pure, content-space geometry
- `data-js/src/core.rs:62-72` — `LoweredOutput`, the value that crosses the wasm boundary
- `packages/data-host-model/src/index.ts:19-21` — "data-in, mutations-out"
- `packages/data-host-model/src/lower-to-mutations.ts:111-121`,
  `packages/data-bundle/src/lower.ts:130-161` — the native table path and its fallback
- `packages/data-host-model/src/fields.ts:53-67`, `:183-189`, `:209-224` — field, image, cell style
- `data-barcode/src/lib.rs:30-37`, `data-lower/src/lib.rs:129-137`,
  `packages/data-host-model/src/barcode.ts:79-95` — encoders, scaling, one path per module
- `packages/data-bundle/manifest.json:8-14` — document read/write and `rendering: ["hitTest"]`

## Alternatives considered

Tab-aligned text with drawn rules was the first table form, while the wire had no
`insertTable`. It became the fallback when that operation arrived (commit `b6f40da`).

A raster barcode placed as an image is ruled out: `placeImage` needs a resolvable URI and
inline image bytes cannot be placed (`data-lower/src/lib.rs:134-136`). A GPL barcode library
is ruled out in `data-barcode/src/lib.rs:32-34`.

## Consequences

The lowered value carries no page coordinates; the bundle adds the page origin when it
builds mutations. Barcode modules and the fallback grid rules are separate page items at
coordinates derived from the bound frame's top-left at commit time
(`packages/data-host-model/src/barcode.ts:86-95`, `packages/data-bundle/src/lower.ts:147-154`).
The TypeScript types of the lowered value are a hand-written mirror of the Rust types
(`packages/data-host-model/src/lowered.ts:19-22`). Limits of what is built:

- Column widths are estimates from character counts (6 pt per character plus padding by
  default); the plugin has no font metrics (`data-lower/src/lib.rs:33-34`, `:68-76`).
- A table is committed in several separate `mutate` calls (frame, table, cell batch,
  metadata), and always into a new text frame at a 36 pt inset on the active page
  (`packages/data-bundle/src/lower.ts:97-141`, `packages/data-host-model/src/placement.ts:34-45`).
- An image is placed only by URI or path; an asset id or inline bytes are skipped
  (`packages/data-host-model/src/fields.ts:165-176`).
- `PaginatedFlow`, the result of record flow, has no translator (ADR 554, below).

Comments contradict the code in three places. `packages/data-bundle/src/lower.ts:19` calls
that file the only caller of `host.document.mutate`; `packages/data-bundle/src/session.ts:1359`
and `:1412` call it too. `packages/data-host-model/src/lower-to-mutations.ts:25-28` still
says the wire has no `insertTable`, and `tableToMutations` there is tested but not called by
the bundle. `data-lower/src/lib.rs:36-37` says the crate depends only on `data-core`; its
`Cargo.toml` also lists `data-barcode`.

## Related

- [ADR 316](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/316-native-content-and-baking.md) — the general rule this applies
- [ADR 310](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/310-one-write-door.md) — `document.mutate` as the single write door
- [ADR 013](https://github.com/paged-media/core/blob/main/docs/adr/013-in-frame-scenelayer.md) — in-frame scene layers, which this plugin does not use
- [ADR 552](552-binding-is-a-recipe.md), [ADR 554](554-record-flow-pagination.md) — what is stored; record flow
