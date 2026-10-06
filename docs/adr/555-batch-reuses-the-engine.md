# ADR 555 — Batch generation reuses the interactive engine

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `6b96ce5`.
- **Scope:** `data-automation`, `DataSession::run_record_flow_batch` in `data-js`, `data-cli`,
  `data-script`

## Context

Batch generation produces many outputs from one bound template: one document per record,
one per group, or one long catalogue. The crate documentation sets the rule that the batch
side "renders nothing" and that every unit goes through the normal resolve, lower and
paginate path (`data-automation/src/lib.rs:22-28`).

For running without a browser, the commit that added the command-line tool gives the
reason for its form: "no browser, no napi-rs, no per-platform prebuilds" (commit `b693440`).

## Decision

Batch generation is built from native-side pieces around the same `DataSession` the editor
drives through wasm. No second engine exists.

- `plan_batch` (`data-automation`) orders a query result and partitions it into units: per
  record, per group, or one catalogue. It returns record indices and labels only.
- `DataSession::run_record_flow_batch` resolves a record-flow binding, splits the resolved
  flow into units by the same mode, and paginates each unit with the `paginate_flow` used for
  the live document ([ADR 554](554-record-flow-pagination.md)).
- `data-cli` is a plain Rust binary, `paged-data-batch`. It reads a JSON job (`today`,
  `locale`, `payload`, `results`, `binding`, `mode`, `chain`, `opts`, `script`), rebuilds
  the session with `from_payload`, ingests the supplied results, runs the batch, and prints
  `{documentCount, runs: [{label, flow}]}`.
- The command-line tool contains no query engine. The caller supplies each query's result
  as a `RecordSet`.
- `data-script` evaluates an optional script in a Boa context that is given no host
  functions. The script must return `{locale?, params?, build?}`; Rust code applies it.
- No scheduler exists. A source's `Interval` refresh policy is stored and reported as not
  honoured interactively.

## Evidence

- `data-automation/src/lib.rs:19-34`, `:112-116` — the plan engine and its rule
- `data-js/src/core.rs:138-149`, `:573-641` — `BatchRun`; the partition feeding `paginate_flow`
- `data-cli/src/lib.rs:19-34`, `:106-141` — the job, `run_job`, no embedded query engine
- `data-cli/src/main.rs:27-39` — the binary's usage text
- `data-script/src/lib.rs:28-33`, `:90-100` — return a value, no host access, native only
- `data-js/Cargo.toml:16-27` — `data-js` depends on neither `data-cli` nor `data-script`
- `data-core/src/model.rs:175-189` — `honored_interactively`: a document runs no scheduler
- `data-conformance/tests/batch_run.rs:94-145`, `data-cli/src/lib.rs:184-279` — the tests

## Alternatives considered

- **A napi-rs Node binding.** Named as the native route in several comments; declined for
  the plain binary in commit `b693440`. It remains a `planned` registry row
  (`registry/features/automation.yaml:39-42`).
- **A query engine inside the command-line tool.** Declined in `data-cli/src/lib.rs:27-30`,
  which cites the repo's licence-boundary rule (`CLAUDE.md:100-109`).
- **A script that calls host functions.** Declined: "The safety model is
  *return-a-value*, not *call-the-host*" (`data-script/src/lib.rs:28`). Commit `0640d15`
  adds that this avoids capturing host state in Boa's garbage collector.
- **Running the plan's record indices.** The run splits the resolved flow instead, which
  commit `c2b1e2d` says "sidesteps any plan/flow index-alignment mismatch".

## Consequences

A job file is made of the serde shapes of `DocumentPayload`, `RecordSet`, `FrameCapacity`
and `BatchMode`, so those shapes are a file format ([ADR 552](552-binding-is-a-recipe.md)).
The batch run handles record-flow bindings only; any other binding kind is an error. Its
output is a `PaginatedFlow` per document. `data-cli/src/lib.rs:30-32` says core's headless
export turns that into documents; no consumer of it exists (ADR 554).

Plan and run partition differently. The plan groups the query result by the columns named
in the mode. The run takes its units from the resolved flow (one per section, or one per
record), which follows the binding's own grouping, and ignores `by` and `key`
(`data-js/src/core.rs:582-619`).

`data-cli` and `data-script` stay out of the wasm module because `data-js` does not depend
on them. The CI dependency guard checks the wasm tree for `data-conformance` and `proptest`
only (`.github/workflows/rust.yml:27-30`). In the editor, the Dataset panel shows the plan;
its run needs a record-flow binding, which the bundle cannot define (ADR 554).

Stale statements: `data-automation/src/lib.rs:30-34`, `registry/features/automation.yaml:1-4`
and `Cargo.toml:4-5` describe native execution and the scripting surface as reserved or
remaining work; `data-cli` and `data-script` implement them. `data-js/src/core.rs:564-565`
and `packages/data-bundle/src/session.ts:523-530` name a napi-rs binding as the native route.

## Related

- [ADR 554](554-record-flow-pagination.md) — the paginator, and what is missing after it
- [ADR 552](552-binding-is-a-recipe.md) — the payload a job carries
- [ADR 015](015-duckdb-wasm-vendored.md) — the query engine used in the editor
- [ADR 315](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/315-isolation-contract.md) — the isolation rules for plugins
