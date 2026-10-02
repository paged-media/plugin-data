# ADR 553 — Refresh is non-destructive: five sync states over content hashes

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `6b96ce5`.
- **Scope:** `data-bind`, the sync types in `data-core/src/binding.rs`, ordering and hashing
  in `data-query`

## Context

Bound content is written into the document as ordinary content
([ADR 552](552-binding-is-a-recipe.md)), so a user can edit it, and the source can change
underneath it. A refresh has to decide what happens to content that no longer matches its
source.

The crate documentation states the rule: a result change marks dependent `Linked` bindings
`Stale` but never disturbs `Pinned` or `Overridden` content, and "divergences are reported,
never silently clobbered". It also gives the purpose of diffing by record identity: minimal
row deltas, "keeping pagination stable and undo granular" (`data-bind/src/lib.rs:42-46`).
The policy is stated, not argued. The repository does not record why.

## Decision

Each binding carries a `SyncState`: a `Status` and the `ResolveStamp` of its last
resolution. A new query result may change the status of a binding only if that binding
accepts refresh; `Pinned` and `Overridden` do not.

- `Status` is `Linked` (default), `Pinned`, `Overridden`, `Stale` or `Error`.
- `ResolveStamp` is two 64-bit hashes built with FNV-1a: one over the result's content hash
  and the query's SQL and shape, one over the parameter set (independent of parameter order).
- `set_result` hashes the delivered result. If the hash differs from the previous one,
  every binding on that query whose state `accepts_refresh()` becomes `Stale`.
- `pin` sets `Pinned`. `mark_overridden` sets `Overridden` and creates the state if the
  binding was never resolved. `relink` sets `Stale`. `resolve` sets `Linked` and a new stamp.
- `sync_report` lists every binding whose status is not `Linked`, sorted by id.
- A change report fingerprints the resolved content of every binding and compares it with
  the previous snapshot: changed, unchanged, added, removed. It does not change sync state.
- `stabilize` orders rows by the given keys, or by every column, because a result without
  `ORDER BY` has no defined order. `diff` compares two results by a declared key and returns
  inserted, updated, removed and unchanged rows.

## Evidence

- `data-core/src/binding.rs:416-457`, `:499-503` — `Status`, `ResolveStamp`, `accepts_refresh`
- `data-bind/src/lib.rs:306-330` — `set_result`: only refresh-accepting bindings go `Stale`
- `data-bind/src/lib.rs:351-383` — `pin`, `mark_overridden` (with its reason), `relink`
- `data-bind/src/lib.rs:420-439` — `resolve_at` sets `Linked` and stamps
- `data-query/src/lib.rs:130-134`, `:185-188`, `:234-249`, `:274-282` — order, hash, stamp
- `data-bind/src/diff.rs:33-46`, `:69-102` — the keyed row diff and the change report
- `data-conformance/tests/bind.rs:120-159` — a pinned binding survives a changed result

## Alternatives considered

None recorded in the repository.

## Consequences

The hash functions (`content_hash`, `query_hash`, `param_hash`) are written out in
`data-query`; the stamps and the data-provider revision are their outputs. The stamps cross
to JavaScript as decimal strings, because a `u64` above `Number.MAX_SAFE_INTEGER` made the
serializer fail and the sync state arrive as `null` (`data-core/src/binding.rs:438-448`).

The protection covers one transition only. `resolve_at` does not look at the status: it
returns live content for a `Pinned` or `Overridden` binding and sets it `Linked`. The
comment there calls an explicit resolve the user action that re-links
(`data-bind/src/lib.rs:422-424`). `Status::Error` is defined and nothing assigns it.

`set_result` hashes the result as delivered, not after `stabilize`, and `content_hash` reads
the values in row order (`data-query/src/lib.rs:236-249`). The data-provider revision does
stabilize first (`data-js/src/core.rs:561-562`).

In the editor bundle the model is only partly reachable:

- `pin`, `sync_state` and `sync_report` are declared in
  `packages/data-bundle/src/engine.ts:106-110` and have no caller in the bundle. No panel
  shows a sync state or offers pin or relink. The Bindings panel shows the change report.
- `mark_overridden` is reached only through the engine's `apply_data_set`
  ([ADR 557](557-variables-and-data-sets.md)).
- The refresh loop and `lowerAll` resolve every binding without reading its status
  (`packages/data-bundle/src/session.ts:1239-1244`, `:1395-1421`). The engine's comment says
  an applied data set is protected from the next refresh (`data-js/src/core.rs:964-968`);
  that protection is the `set_result` transition only.
- `diff` is called only from tests. A table that is lowered again is inserted again as a whole ([ADR 551](551-compiled-to-native-content.md)).

Sync state is not in the saved payload; a session rebuilt from one starts every binding as
`Linked` (`data-bind/src/lib.rs:283-288`).

## Related

- [ADR 552](552-binding-is-a-recipe.md) — what is saved and what is not
- [ADR 557](557-variables-and-data-sets.md) — applying a data set marks bindings `Overridden`
- [ADR 014](014-data-provider-arrow-seam.md) — the provider revision is a content hash of the stabilized rows
