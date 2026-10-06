# Architecture decision records

An ADR records one load-bearing decision that has already been made: what was decided, what
in the code shows it, and what it obliges other code to do. It is a record, not a proposal.
When the code stops matching a record, the body is left as it is and a dated amendment is
added at the end.

ADR numbers are unique across the paged-media repositories, so a number names the same
record wherever it is cited. New records in this repository use 550–599. Records 014 and 015
predate that scheme and keep their numbers. Records 550–557 were written on 2026-10-02 from
the code as it stood, for decisions made earlier; their status says so.

| ADR | Title | Status |
|---|---|---|
| [014](014-data-provider-arrow-seam.md) | The data-provider seam: `RecordSet` = Arrow IPC, no `arrow-rs` (D-09) | Accepted (amended 2026-10-02) |
| [015](015-duckdb-wasm-vendored.md) | DuckDB-WASM 1.29 vendored as paged.data's query engine | Accepted (amended 2026-10-02) |
| [550](550-own-binding-language.md) | The binding language is the plugin's own, stored as source text | Accepted, recorded retroactively 2026-10-02 |
| [551](551-compiled-to-native-content.md) | Bound content is compiled to native document content through a pure intermediate form | Accepted, recorded retroactively 2026-10-02 |
| [552](552-binding-is-a-recipe.md) | A binding is a recipe stored in the document; resolved values are committed content | Accepted, recorded retroactively 2026-10-02 |
| [553](553-non-destructive-refresh.md) | Refresh is non-destructive: five sync states over content hashes | Accepted, recorded retroactively 2026-10-02 |
| [554](554-record-flow-pagination.md) | Record flow is paginated by the plugin over a host-supplied frame chain | Accepted, recorded retroactively 2026-10-02 |
| [555](555-batch-reuses-the-engine.md) | Batch generation reuses the interactive engine | Accepted, recorded retroactively 2026-10-02 |
| [556](556-secrets-never-enter-the-plugin.md) | Secrets never enter the plugin | Accepted, recorded retroactively 2026-10-02 |
| [557](557-variables-and-data-sets.md) | Variables and data sets are a projection over bindings | Accepted, recorded retroactively 2026-10-02 |

Proposed, not yet accepted (in the thoughts register): **558** (one universal binding,
`Binding::Property`) and **559** (bindings in the `.paged` file stay InDesign-compatible).
Both are implemented on branch `om/universal-binding`; they move here when accepted.

Decisions made in other repositories that this plugin's code rests on are listed in
[`../README.md`](../README.md).
