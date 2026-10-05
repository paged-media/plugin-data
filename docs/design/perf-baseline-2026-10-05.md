# Performance baseline, 2026-10-05

**Measured, not read.** This record replaces the "read from code" performance table of
[`analysis-2026-10-05.md`](analysis-2026-10-05.md) §7 with counts. Every count below comes
from a test that runs on every CI build and is pinned as a budget. The exception is the 1M-row
DuckDB lane, which is opt-in. The wall-clock figures beside the counts are trended only.

## How it is measured

Two harnesses, one per side of the wasm boundary.

**The engine (Rust).** `data-query` has a `perf-counters` feature (`data-query/src/perf.rs`)
that counts:

- resolves;
- `stabilize` sorts;
- sort-key allocations, one fresh `Vec<u8>` per `value_key`;
- fingerprints;
- rows visited by `diff`;
- cells ingested;
- content hashes;
- group-key comparisons.

`data-bind` forwards the feature.

When the feature is off, every count is an empty `#[inline(always)]` function. The counters
are thread-local, so a native test reads only its own work.

The workloads live in `data-conformance/src/perf_workloads.rs`. Two harnesses run them:

- `data-conformance/tests/perf_counts.rs` pins the counts as budgets.
- `data-conformance/benches/engine.rs` runs the criterion benches (trended).

The input data is a deterministic shuffle, because sorted or reversed input lets the sort
finish in n−1 comparisons.

**The bundle (TypeScript), in `packages/data-bundle/test/perf/`.**

- **The host.** The real core engine (`@paged-media/canvas-wasm` 0.67.0 through plugin-sdk's
  headless host), scoped to this bundle's own manifest. It is wrapped in `countingHost`, which
  is plugin-draw's Proxy, trimmed. The proxy counts:
  - door calls;
  - `mutate` calls and the ops inside each batch;
  - fields and tree nodes read back.
- **Undo steps.** These are counted by walking the history back to a marker. This is the
  plugin-draw probe.
- **The data engine.** The real `data-js` wasm, booted fresh per scenario and wrapped in a
  counting Proxy. The proxy counts:
  - wasm calls by method;
  - cells and JSON bytes into `ingest_result`;
  - JSON bytes of the IR that comes back;
  - the engine's own `perfCounters()`.
- **DuckDB.** Real DuckDB-WASM over the shipped `bin/duckdb-engine.wasm`, driven through the
  bundle's own `duckdbHandle`.
- **The session.** The bundle's own `createSession`. Only `bootEngine` and `bootDuckDB` are
  pointed at the counted instances. Nothing in `src/` changed.

To re-measure, run `PERF_SHOW=1 pnpm vitest run test/perf`. It prints:

- every scenario's full door log;
- the wasm calls and engine counters;
- a table at the end of each file.

Natively it is `PERF_SHOW=1 cargo nextest run -p data-conformance -E 'binary(perf_counts)'
--no-capture`.

### The counters ship in the wasm

`data-js` enables `perf-counters` by default, so the budgets and the editor measure the same
artifact. The `perfCounters()` and `resetPerfCounters()` exports are global to the wasm
instance.

| Build | Counters off | Counters on |
|---|---|---|
| `data_js_bg.wasm` (after `wasm-opt -Oz`) | 725,819 B | 726,223 B (+404 B, 0.06 %) |
| 10k-row table resolve in wasm (Node, mean of 30; one-off comparison of two builds) | 30.7 ms | 30.5–31.1 ms |
| criterion, native, table 10k / catalog 7k / diff 5k | 26.6 / 15.0 / 4.5 ms | 27.8 / 15.3 / 4.7 ms (+2–5 %) |

In wasm the cost is inside the noise. Natively it is 2–5 %, so the library crates keep the
feature off by default and only the boundary crate turns it on.

The first version counted group-key comparisons one at a time, and that cost 33 % on the
group-plan bench. They are now added once per row.

## The counts

### Bundle commands (pinned in `perf-budgets-commands.spec.ts`, `perf-budgets-boot.spec.ts`)

| Scenario | Host calls | Reads | Mutates (ops) | Undo steps | Wasm calls | Cells in | Resolves | Sorts | Sort keys | Trend: ms · bytes in / out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| W1 import a 500-row CSV | 0 | 0 | 0 | — | 2 | 0 | 0 | 0 | 0 | 36 ms (DuckDB load) |
| W1 lower it as one table | 8 | 3 | 4 (1,506) | 4 | 2 | 1,500 | 1 | 1 | 9,840 | 88 ms · 41 KB / 81 KB |
| W2 refresh 100 fields, one story | 102 | 1 | 100 (100) | 89, history exhausted | 200 | 0 | 100 | 0 | 0 | 16 ms · 0 / 7 KB |
| W3 preview-step 20 records | 40 | 20 | 20 (20) | 20 | 20 | 0 | 20 | 0 | 0 | 2 ms |
| W4 one QR barcode | 6 | 4 | 1 (670) | 1 | 1 | 0 | 1 | 0 | 0 | 11 ms · 0 / 23 KB |
| W5 `lowerAll`, 20 variable bindings | 240 | 120 | 40 (40) | 40 | 21 | 150 | 20 | 0 | 0 | 10 ms |
| W6 200 reflow events on a record flow | 400 | 400 | 0 | — | 200 | 0 | 200 | 200 | 665,600 | 262 ms · 0 / 2.17 MB |
| W7 cold boot (activate) | 21 | 0 | 0 | — | 0 | 0 | 0 | 0 | 0 | engine boot 9 ms, DuckDB boot 408 ms |

Notes:

- **W2 runs out of undo history.** It writes 100 separate undo steps. The engine's history is
  bounded, and after a 200-step setup only 89 can be walked back. The user cannot undo past
  the refresh.
- **W5 starts from a fresh table.** `lowerAll` first re-queries DuckDB, which is one query
  and a 150-cell re-ingest. Then it places each variable in a fresh frame. Each placement
  costs 2 mutates, 2 undo steps and 6 reads (`meta`, `collection` ×2, `elementGeometry`,
  `hitTest`, `selection.get`), plus 2 `supports` calls.
- **W6 re-paginates every event.** It re-reads the chain (`frameChain` + `elementGeometry`)
  and re-paginates the whole 200-record flow on every event: a full resolve and a full
  stabilize sort. That is 3,328 sort keys and 10.8 KB of IR per event, and only the last of
  the 200 results is ever shown.
- **W7 boots nothing.** `activate` registers 3 panels, 7 commands, 7 menu entries and 1 edit
  context, and boots no wasm. The first command pays both boots.

### Engine workloads (pinned in `data-conformance/tests/perf_counts.rs`)

| Workload | Resolves | Sorts | Sort keys | Fingerprints | Other | Criterion (trended) |
|---|---:|---:|---:|---:|---|---:|
| Table resolve, 10k rows × 3 columns | 1 | 1 | 288,478 | 0 | — | 27.8 ms |
| Record-flow catalog lower, 7k records | 1 | 1 | 185,110 | 0 | — | 15.3 ms |
| 50 bindings × `refresh_change_report` after a 1-cell change (1k rows; 10 tables, 40 variables) | 50 | 10 | 210,560 | 50 | 4,000 cells ingested, 1 content hash, 0 diff rows | 24.6 ms |
| Row diff, 5k rows, 100-row delta | 0 | 0 | 0 | 0 | 10,000 diff rows | 4.7 ms |
| Per-group batch plan, 2k rows in 100 groups | 0 | 1 | 48,166 | 0 | 100,900 group-key compares | 3.2 ms |

### DuckDB, 1M rows (trended, `PERF_DUCKDB_1M=1 pnpm vitest run test/perf/duckdb-1m.trend.spec.ts`)

The CSV is 36.2 MB: 1,000,000 rows × 4 columns (`sku, name, price, cat`, with 100 categories).
Two runs, Node 22, Apple silicon:

| Step | ms |
|---|---:|
| Ingest: register the text and `insertCSVFromPath` | 326, 326 |
| Grouped query (`GROUP BY cat`) to a 100-row RecordSet | 42, 42 |
| **CSV to grouped RecordSet, the cited gate** | **369, 367** |
| `SELECT *` materialised through `recordset.ts` (4M `{t, v}` cells) | 642, 683 |
| `ingest_result` of those 4M cells (serde decode) | 1,449, 1,462 |

The "1M-row CSV → grouped RecordSet < 1.5 s" figure that the records cited now has a
measurement: 0.37 s. It is trended, not gated.

A refresh that brings a 1M-row result into the engine costs about 2.1 s at the boundary
today. About 70 % of that is the serde decode of per-cell objects.

## What the counts found

1. **A refresh can already be one undo step, with no protocol change.** On core 0.67, a
   `batch` of `setFieldValue` ops written back to front applies atomically as one undo step.
   The `PROBE` case in `perf-budgets-commands.spec.ts` shows it. A planned protocol change for
   "setFieldValue inside a batch" is therefore not needed for the refresh. This is
   plugin-only work.
2. **The undo history is bounded.** A 100-field refresh (W2) puts the state before the
   refresh out of reach.
3. **Cost scales with how often the user acts, not with how much the data changed.**
   - W6: 200 resize events cost 200 full re-paginations.
   - The change report: a 1-cell change costs 50 resolves and 10 full sorts.
   - W5: every `lowerAll` re-runs the query and re-ingests the result.
4. **`stabilize` is the engine's hot spot.** Every resolve of a table or record flow sorts
   from scratch. Every comparison builds two `Vec<u8>` keys per column it reaches: 28.8 keys
   per row at 10k rows, 92 per record across the reflow stream.
5. **The neutral harness host hid the binding metadata.** plugin-sdk's neutral headless host
   rejects this bundle's `x-paged:media.paged.data` metadata writes as foreign. The barcode
   batch and the table's `setPluginMetadata` were refused, and a refused write counts as free.
   The budgets therefore run on a host scoped to the data manifest (`openDataHost`), which is
   the host the bundle gets in the editor.
6. **`resolveElementId` is never reached.** No workload walks the scene tree: the panel
   supplies the kind for visibility bindings, and the other lanes take element ids directly.
   The tree walk costs only for a visibility binding defined without a kind.

## Ranked for the optimisation round

Ranked by counts saved per user action. All rows are plugin-only unless marked.

| # | Change | Budget it lowers (from → expected) | Side |
|---:|---|---|---|
| 1 | `refreshFields` (and the data-set apply path) writes **one** back-to-front `setFieldValue` batch | W2: mutates 100 → 1, undo 89 (exhausted) → 1; the preview step stays 1 per step | TS |
| 2 | Debounce and coalesce the reflow subscription; re-paginate once per burst | W6: lower_record_flow 200 → 1 per burst, reads 400 → 2, sort keys 665,600 → 3,328, IR out 2.17 MB → 11 KB | TS |
| 3 | `stabilize`: precompute the sort keys once per row (or compare `Value`s without allocating); cache the stabilized result per (result hash, keys) | table 10k: 288,478 → ≤ 30,000 keys; flow 7k: 185,110 → ≤ 21,000; W6 sorts 200 → 1 | Rust |
| 4 | Change report: per-binding dependency on its query and result hash; `diff()` for row-level change; resolve only the bindings whose query changed | 50 bindings: resolves 50 → bindings on the changed query; sorts 10 → 0 with #3's cache | Rust |
| 5 | Variable placement in `lowerAll`: read the active page once per command; one `insertTextFrame` + `insertField` batch using `minted[].story` (D-16) instead of `elementGeometry` + `hitTest` | W5: host calls 240 → ~60, undo steps 40 → 20 (or 1 with one batch), reads 120 → ~2 | TS |
| 6 | Refresh skips work when the source did not change: no re-query when the source content key is unchanged; no re-convert or re-ingest when the result hash is unchanged | W5 / W1: `ingest_result` cells 150 / 1,500 → 0 on an unchanged source | TS + Rust |
| 7 | Arrow → engine as typed column buffers (one copy per column), not `{t, v}` per cell | W1 1,500 cell objects → 3 column buffers; 1M rows: 2.1 s → expected < 0.5 s | TS + Rust |
| 8 | `group_by` with a hash index | 2k × 100: compares 100,900 → 2,000 | Rust |
| 9 | `resolveElementId` from a one-pass index or the known kind | not reached by any workload today | TS |

The hitTest-versus-`minted[].story` row is folded into #5, where W5's `hitTest` and
`elementGeometry` reads come from. The table lower (W1) pays it once per table.

## Proof that a budget fails

A single extra `host.document.placeholders()` was injected into `refreshFields`, then
reverted. W2 failed:

```
Error: W2: hostCalls: measured 103 vs budget 102 (OVER budget); hostReads: measured 2 vs
budget 1 (OVER budget); placeholdersRead: measured 200 vs budget 100 (OVER budget)
```

With the injection reverted it passes. A count that drops below its pin also fails, with
"UNDER budget — lower the pin in this commit".

## Re-pinned at the Wave 4 merge (persistence)

Saving the session into the document is new work, so five budgets moved up
by exactly its cost; each pin in `test/perf/` names the added calls. Per
command: one `parts.write` of the session part, plus one `payload` and one
`sync_report` to build it (the merge also removed a second `payload` call
that hashed the lowered label's definition: `stampFor` now reuses the recipe
the flush serialised). On open: `parts.read` and the document-switch,
flush-before-save and client subscriptions. A burst of 200 reflows writes the
session once.
