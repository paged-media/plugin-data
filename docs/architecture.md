# Architecture

How the `paged.data` plugin is built: data binding for a page-layout editor (variables,
tables, images, barcodes and record flow driven by query results). It describes what the
code does at commit `6b96ce5`. The reason behind each choice is in an ADR under
[`adr/`](adr/README.md), linked where it applies. Paths are relative to the repo root,
except that `src/…` is short for `packages/data-bundle/src/…`.

## Layout

- A Cargo workspace of 13 crates. They sit at the repo root, not under `crates/`. The
  toolchain is pinned to Rust 1.93.0 (`rust-toolchain.toml`); no crate is published.
- A pnpm workspace with two TypeScript packages under `packages/`.
- `registry/`: YAML. The 42 rows in `functions/`, one per expression function, are read by
  the two `build.rs` scripts. The 73 rows in `features/` are read by the `coverage-gate`
  binary, which also reads the function rows; the 68 feature rows marked `implemented` name
  tests.
- `scripts/`: the wasm build, the DuckDB download and the import lint.
- `vendor/duckdb-wasm/`: git holds only `SOURCE.md` and a `.gitkeep`. The DuckDB-WASM 1.29.0
  files are fetched by `scripts/vendor-duckdb.sh` into its `dist/` folder, which is ignored.

## Rust crates

| Crate | What it owns | Workspace crates it depends on |
|---|---|---|
| `data-core` | The shared types: `Value`, `DataSource`, `Query`, `RecordSet`, the seven `Binding` kinds, the sync types, the `Expr` syntax tree. Its `build.rs` generates the function table from the registry. | none |
| `data-expr` | The binding language: lexer, Pratt parser, evaluator, and the function kernels in five families (format, logic, math, temporal, text). Its `build.rs` generates the dispatch. | `data-core` |
| `data-query` | Reshaping a result by its declared shape, a deterministic row order (`stabilize`), FNV-1a content hashes and the resolve stamp. | `data-core` |
| `data-sources` | One adapter per source kind, the capability check `authorize`, the source manifest, credential redaction, validation of a remote descriptor and its invalidation key, column metadata for governed data sets, `attach_plan`. | `data-core` |
| `data-barcode` | Encoders for EAN-13, UPC-A, Code-128 and QR. Output is a list of rectangles in a unit box. | `data-core` |
| `data-dataset` | Variables, data sets and the variable-library XML codec (uses `quick-xml`). | `data-core` |
| `data-lower` | Resolved content to the lowered form: variable, table, image, barcode, visibility; and `paginate_flow` for record flow. | `data-core`, `data-barcode` |
| `data-bind` | `ResolutionEngine`: resolves a binding against a delivered result, keeps a sync state per binding, evaluates rules, and holds the keyed row diff, the change report and the column-mapping suggestions. | `data-core`, `data-expr`, `data-query` |
| `data-automation` | `plan_batch`: splits a result into generation units (per record, per group, one catalog). | `data-core`, `data-query` |
| `data-js` | `DataSession`, which joins the crates above, and the wasm class `DataEngine`. | `data-core`, `data-sources`, `data-bind`, `data-lower`, `data-barcode`, `data-dataset`, `data-query`, `data-automation` |
| `data-script` | A Boa (`boa_engine` 0.21.1) context that evaluates a script to a `{ locale?, params?, build? }` value. | `data-core`, `data-automation`, `data-js` |
| `data-cli` | The library function `run_job` and the binary `paged-data-batch`. | `data-core`, `data-lower`, `data-automation`, `data-js`, `data-script` |
| `data-conformance` | 27 integration test files and the `coverage-gate` binary. Test only. | every crate except `data-cli` and `data-script` |

- **One wasm module, two layers.** `data-js` builds as `cdylib` and `rlib`. `DataSession`
  (`data-js/src/core.rs`) is plain Rust. `DataEngine` (`data-js/src/lib.rs`) is compiled only
  for `wasm32`; its methods forward to the session and convert structured values with
  `serde-wasm-bindgen`. `data-cli`, `data-script` and `data-conformance` use the session
  natively.
- **No I/O.** At run time no crate in the wasm tree reads a file, a clock or the network.
  The day number for `TODAY()` and the query results are handed in.
- **Native-only code stays out of the wasm.** `data-script` and `data-cli` depend on
  `data-js`, not the reverse. CI checks two edges with `cargo tree`: `data-expr` must not
  reach `data-sources`, `data-query`, `data-bind`, `data-lower` or `data-js`, and the wasm
  tree of `data-js` must not contain `data-conformance` or `proptest`.

**The function table.** `data-core/build.rs` and `data-expr/build.rs` both read
`registry/functions/*.yaml` and sort the rows by id, so the index one assigns is the index
the other dispatches on. The parser looks a function name up in the generated table; a name
with no row is a parse error, which evaluation turns into the value `#NAME`. The
`coverage-gate` binary fails when a registry row with `status: implemented` names no test
that exists. The language itself is described in [ADR 550](adr/550-own-binding-language.md).

## TypeScript packages

**`packages/data-host-model`** is private (`@paged-media/data-host-model`). It holds pure
functions from the engine's lowered form to host `Mutation` values, a hand-written
TypeScript copy of the lowered types (`lowered.ts`), and the metadata envelope
(`binding.ts`). It makes no host call.

**`packages/data-bundle`** is published to npm as `@paged-media/data` (`dist`, `bin` and
`manifest.json`). It holds `activate(host)`, three React panels (`src/panels/`), the session
(`src/session.ts`), the engine loader (`src/engine.ts`), the DuckDB loader
(`src/query/duckdb.ts`), the Arrow converter (`src/query/recordset.ts`) and the functions
that write to the document (`src/lower.ts`).

- The bundle imports the host model by relative path (`../../data-host-model/src`), and
  tsup inlines it, so the published package does not depend on the private one.
- `@paged-media/plugin-api`, `@paged-media/plugin-sdk` and `react` are peer dependencies.
  `scripts/check-contract-imports.mjs` fails on a package import outside its allow-list:
  those three, this repo's own `@paged-media/data-` packages, `@duckdb/duckdb-wasm` and
  `apache-arrow`.
- The TypeScript interface `DataEngineLike` (`src/engine.ts`) repeats the methods of the
  Rust class by hand, except `define_template` and `lower_barcode_at`. Nothing generates it.

## The path of one binding

```
file picked in the panel            remote URL, after consent: fetch()
        \                               /
         v                             v
   DuckDB-WASM, in a worker the bundle starts          src/query/duckdb.ts
         |  conn.query(sql)  ->  Arrow table
         v
   arrowToRecordSet  ->  { schema, columns, row_count }  src/query/recordset.ts
         |  engine.ingest_result(queryId, records)       JSON-shaped values
         v
   DataEngine (wasm)  ->  DataSession  ->  ResolutionEngine
         |  resolve: evaluate the binding's expressions   data-bind, data-expr
         |  lower:  content-space geometry, in points     data-lower, data-barcode
         v
   lowered output: variable | table | image | barcode | visibility
         |  pure translation to Mutation values           packages/data-host-model
         v
   host.document.mutate(...)                             src/lower.ts, src/session.ts
```

1. **Sources.** The Data sources panel reads a `.csv` or `.tsv` file, through
   `host.shell.pickFile` where the host has it, and hands the text to DuckDB, which creates
   a table named after the file. A remote source is first only a descriptor.
   `loadRemoteSource` checks `host.network.consentedOrigins()` and, if the origin is granted,
   makes the only `fetch` call in the bundle's source and registers the bytes with DuckDB.
   See [ADR 556](adr/556-secrets-never-enter-the-plugin.md).
2. **Query.** `refreshData` runs every defined query in DuckDB. `arrowToRecordSet` maps
   each Arrow column to one of six field types by the type's name and wraps each cell as a
   tagged value `{ t, v }`. That object crosses into the wasm as a `RecordSet`; no Arrow
   bytes cross. See [ADR 014](adr/014-data-provider-arrow-seam.md) and
   [ADR 015](adr/015-duckdb-wasm-vendored.md).
3. **Resolve.** `ResolutionEngine::set_result` hashes the result and, when the hash changed,
   marks dependent bindings stale, except pinned and overridden ones. `resolve_at` evaluates
   a binding's expression source text against one row (variable, image, barcode, visibility)
   or against all rows in stable order (table, record flow). See
   [ADR 553](adr/553-non-destructive-refresh.md).
4. **Lower.** `data-lower` produces plain data: a display string, a grid with column widths
   estimated from character counts, a classified image reference, rectangles scaled to a
   box, a visibility flag. All geometry is an offset from the region's own top-left corner.
5. **Commit.** `src/lower.ts` issues the mutations and reads their outcomes. A variable
   becomes an `insertField` placeholder tagged with the plugin id and the binding id; a
   table becomes a new text frame, then `insertTable`, then one `insertText` per non-empty
   cell; an image is `placeImage` on a rectangle; a barcode is one `insertPath` per dark
   module, in one batch; visibility is `setElementProperty` on `elementVisible`. The plugin
   draws nothing itself and submits no scene layer. See
   [ADR 551](adr/551-compiled-to-native-content.md).

A later refresh of variables goes through `refreshFields` (`src/session.ts`): it lists the
placeholder fields with `host.document.placeholders()`, resolves each key that is a variable
binding of the current session, and writes `setFieldValue` only where the value changed.

## Other paths

- **Rules.** `evaluate_rule` returns the row indices where a condition holds and a named
  document style. `commitRule` applies it as `applyStyle` over a story range, or as a cell
  style on the fired rows of a table column.
- **Record flow.** `lower_record_flow` resolves a record-flow binding into grouped records
  and packs them into a list of frame heights. The session can read that list from the host
  (`host.document.frameChain` plus `elementGeometry`). The result is a `PaginatedFlow`
  value returned to the caller; no code turns it into mutations. See
  [ADR 554](adr/554-record-flow-pagination.md).
- **Variables and data sets.** A data set is a snapshot of the resolved values of the
  variable, image and visibility bindings. Applying one writes all values in one `batch`.
  The set can be exported to and imported from variable-library XML. See
  [ADR 557](adr/557-variables-and-data-sets.md).
- **Data provider.** `publish_provider` returns a schema, the rows in stable order and a
  revision that is a hash of those rows. The session registers it with
  `host.dataProviders.register`; the rows are produced again on each pull.
- **Batch, without a browser.** `paged-data-batch` reads a JSON job: a `DocumentPayload`,
  the query results already materialised, a frame list and a mode. It rebuilds a session
  with `DataSession::from_payload`, optionally evaluates a script that returns a locale,
  parameters and a build, and prints one paginated flow per output document. It embeds no
  query engine. See [ADR 555](adr/555-batch-reuses-the-engine.md).

## Where data is stored

| Data | Where it lives |
|---|---|
| Imported and fetched rows | DuckDB's memory, in the worker. Gone on reload. |
| Sources, queries, binding definitions, sync states, data sets | The wasm session and maps in `src/session.ts`. Gone on reload. |
| Resolved values | The document, as ordinary content: fields, tables, images, paths, element visibility, applied styles. |
| The link from a text field to its binding | The field's own tag `{ plugin: "media.paged.data", key: <binding id> }`. |
| A mark on the table frames and barcode paths the plugin created | Plugin metadata under the key `x-paged:media.paged.data`, an envelope `{ v, data }`. For a table `data` is `{ kind, region }`; for a barcode `{ kind, target, symbology }`. |

`DataSession::payload()` can serialise the whole recipe with credentials redacted, and
`from_payload()` can rebuild a session. The bundle calls neither, and the wasm class has no
`from_payload`. See [ADR 552](adr/552-binding-is-a-recipe.md).

## The boundary to the host

The manifest (`packages/data-bundle/manifest.json`) declares: `document` read `broad` and
write `scoped`; `rendering: ["hitTest"]`; `network: { origins: "consent" }`; `clipboard:
"none"`; `dataProviders.publish: ["dataset"]`; and four wasm files, `bin/data_js_bg.wasm`
(purpose `compute`), `bin/duckdb-engine.wasm` and DuckDB's json and parquet extensions in
`bin/duckdb-ext/v1.1.1/wasm_eh/` (purpose `engine`). It contributes three
panels, seven commands and one edit context, `dataBinding`.

| Door | What the plugin uses it for |
|---|---|
| `contributePanel`, `host.contribute.command`, `host.contribute.menu` | three panels, seven commands, seven menu entries (the menu door is probed and skipped when absent) |
| `host.contribute.editContext` | double-click on an element that carries this plugin's metadata; no canvas tools, the Bindings panel |
| `host.document.mutate` | every write; thirteen operations are used, none of them a delete |
| `host.document.meta`, `collection("pages")`, `hitTest`, `elementGeometry`, `tree` | the active page; the story of a frame just created; frame bounds; the kind of an element |
| `host.document.placeholders` | list this plugin's fields before a refresh or a data-set apply |
| `host.document.frameChain`, `onDidChange` | read a thread of frames; paginate again when a change has `reflow` set |
| `host.selection.get` / `set`, `host.text.caret` | where a new field or binding goes; select a created frame |
| `host.network.requestConsent`, `consentedOrigins` | per-origin consent before a fetch |
| `host.dataProviders.register` | publish a query result to other plugins |
| `host.shell.pickFile`, `saveFile`, `openPanel` | import CSV and XML, export XML, open a panel |
| `host.supports`, `host.log` | probe optional doors; logging |

Neither wasm file goes through a host loader. The engine is imported from
`../bin/data_js.js`, the `wasm-bindgen --target web` glue, which fetches its `.wasm`. DuckDB
is loaded the same way, from the package's own `bin/` (`packages/data-bundle/src/bin-url.ts`):
`duckdb-browser.mjs` (the DuckDB JS API with apache-arrow bundled in), the eh worker and
`duckdb-engine.wasm`. The bundle starts DuckDB's worker itself. All of them are in the files
the npm package lists, so an application serves the installed package's `bin/`; the editor
copies it into its build output.

The plugin offers two things to others: the published data set described above, and the
exports of `@paged-media/data`, among them `createSession`, `bootEngine` and `bootDuckDB`.

## Build and test

- `bash scripts/vendor-duckdb.sh` downloads DuckDB-WASM and copies its `duckdb-eh.wasm` to
  `packages/data-bundle/bin/duckdb-engine.wasm`. `bash scripts/build-wasm.sh` builds
  `data-js` for `wasm32-unknown-unknown`, runs `wasm-bindgen --target web` into
  `packages/data-bundle/bin/` (ignored by git) and `wasm-opt -Oz` when installed. It fails
  above 100 MB, and when the installed `wasm-bindgen` differs from the one in `Cargo.lock`.
- Rust: `cargo test --workspace`; `cargo run -p data-conformance --bin coverage-gate`.
  `deny.toml` allows crates.io as the only source and a fixed list of licences.
- TypeScript: `pnpm test` runs the import lint, then vitest in both packages. The bundle's
  unit tests use hand-written fake hosts and fake engines. `test/engine-real.spec.ts` loads
  the built wasm; when the file is absent it is skipped, or fails if `REQUIRE_REAL_ENGINE=1`.
  `test/pipeline-real.spec.ts` and `test/duckdb-real.spec.ts` (`pnpm --filter @paged-media/data
  test:e2e`) drive the real wasm and the real DuckDB (Node build over the shipped engine); they
  fail instead of skipping under `REQUIRE_REAL_DUCKDB=1`.
- CI (`.github/workflows/`), on pushes to `main`: `rust.yml` runs format, clippy with
  warnings as errors, the two `cargo tree` checks, `cargo-deny`, the tests, the coverage gate
  and the wasm build; `vitest.yml` builds the wasm, runs the import lint and vitest;
  `publish.yml` builds the wasm and the bundle and publishes a version not yet on npm under
  the `canary` tag. In `rust.yml` and `vitest.yml` the test commands end in `|| true`, so a
  failing test does not fail the job; the other steps do.
