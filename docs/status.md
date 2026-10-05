# Status

What `paged.data` ships and what it does not, read from the code at commit `6b96ce5`
(`@paged-media/data` 0.1.0-canary.9), with the gates and records corrected on 2026-10-05. How
the parts fit is in [`architecture.md`](architecture.md); the analysis behind the current round
of work, with file and line references, is
[`design/analysis-2026-10-05.md`](design/analysis-2026-10-05.md).
"The session" below is the object returned by `createSession`, which the package exports.

## Shipped

- **The session is saved with the document** (since 2026-10-05, wave 4). Sources, queries,
  binding definitions, data sets, the locale, pinned bindings and the imported CSV text are
  written to this plugin's `session` container part (`paged/media.paged.data/session.json`,
  declared in `contributes.partTypes`) after each change and before every save. An imported
  file over 64 KiB is written once as `data/<hash>.csv` and the session names it by hash.
  Opening a document restores its session: the recipe through `DataEngine.load_payload`, the
  data into DuckDB on DuckDB's first boot, remote sources as inert descriptors (nothing is
  fetched on open). The restore checks the document: placed fields are found again, and a
  table whose label no longer names its binding is reported. Opening another document drops
  the previous session first. On a host without container parts the Sources panel says the
  session is not saved.
- **Sources.** The Data sources panel imports a `.csv` or `.tsv` file into an in-memory
  DuckDB table. A remote URL (CSV, TSV, JSON or Parquet) can be added as a descriptor; Load
  calls `fetch` only for an origin the host reports as consented and hands DuckDB the bytes.
- **Bindings from the panel.** "Map fields…" lists the columns of the first source and
  creates one variable binding per chosen column. "Add binding" defines every binding kind:
  a variable field, an image or a barcode in the selected rectangle, a table with
  comma-separated columns, show/hide on the selected element, a style rule (condition and
  document style, on the selected table cell's column or the caret's story) and a record
  flow (fields per record, optional grouping) with a preview list of what it would place. "Lower to document" writes native content: a variable as a
  tagged placeholder field, an image through `placeImage`, a barcode (EAN-13, UPC-A,
  Code-128, QR) as one closed vector path per dark module, scaled to the rectangle.
- **Refresh.** "Refresh data" runs the queries again; "Refresh fields" rewrites the
  placeholder fields whose value changed; "What changed?" lists the bindings whose resolved
  content differs from the previous report; a stepper previews the bindings against record N.
- **Data set tools** (Dataset preview panel): a column list for a query; a batch plan per
  record, per group or as one catalog; number and date formatting in `en` or `de`; publishing
  a query result as a data provider, which other plugins can read when the host has a
  provider registry; a variables palette that captures the current values or one data set
  per record, applies a data set in one undo step, and imports or exports a variable library.
- **Seven commands, seven menu entries** and a `dataBinding` edit context: double-click on an
  element that carries this plugin's metadata; no canvas tools, the Bindings panel.
- **The binding language**: 42 functions, arithmetic, comparison and `&`, with errors as
  values. The image and barcode bindings of the panel take an expression; so do all
  bindings defined through the session or in a batch job.
- **Lowering**: a table binding lowers to a native table; a visibility binding sets
  `elementVisible`; a rule applies a named style to a story range or to table cells.
- **Headless batch.** `paged-data-batch`, built from source, reads a JSON job with
  materialised query results and prints the paginated flow of each output document. A
  script evaluated in Boa can supply the locale, the parameters and the build.

## Limits of what is shipped

- **Saving the session is not undoable.** Container parts take no part in undo, and
  defining a binding is not a document change. What a binding writes into the document
  (fields, tables, barcodes, styles, visibility) undoes as usual; the label on a lowered
  table or barcode names the binding, the hash of its definition and the hash of the session
  part it was lowered under, and goes with the content on undo. The engine has no
  document-level label a plugin could write, so the session itself cannot follow undo.
- **The panels' only query is** `SELECT * FROM <first source>`. There is no SQL field.
  "Wire demo binding" still passes empty expressions.
- **Tables and barcodes are written again on every lower** and on every preview step.
  Nothing removes or updates the earlier frame or paths. A table goes into a new frame at a
  fixed inset on the active page, with column widths estimated from character counts. The
  bundle sets no paint on barcode paths; they take the document's defaults for new objects.
- **Sync states are not surfaced.** The engine keeps a state per binding (Linked, Pinned,
  Overridden, Stale, Error); the bundle never reads it and resolves every binding regardless.
  The engine marks a binding `Overridden` when a data set is applied; the bundle's field
  refresh does not read that state ([ADR 553](adr/553-non-destructive-refresh.md)).
- **Record flow stops at a data structure.** The panel defines a record flow and previews
  its records; the paginator returns frames and blocks, and no code writes them to the
  document, and no page or frame is created on overflow. "Lower to document" reports a
  record flow as preview-only. A record's height is its field count times a line height,
  not a measured layout ([ADR 554](adr/554-record-flow-pagination.md)).
- **A table lower is four undo steps** (frame, table, cell fill, label), measured by
  `test/persist-real-core.spec.ts`.
- **Images** are placed only from a URL or path. Inline bytes and asset ids are skipped.
- **Remote sources.** JSON and Parquet bytes are registered with DuckDB as a file, not
  inserted as a table. A `credentialRef` can be stored on the descriptor, but nothing
  resolves it and the fetch is made without it. In the editor at `28dc764` the page policy
  is the fixed `connect-src 'self' blob: data:` (`editor: apps/canvas/public/_headers:49`);
  it is not derived from consent grants (`editor: apps/canvas/src/plugin-consent.ts:36-41`).
- **DuckDB was not in the npm package.** Every version up to 0.1.0-canary.9 shipped without
  `bin/duckdb-engine.wasm`. The publish workflow now runs `scripts/vendor-duckdb.sh` and
  refuses a tarball without it (`scripts/pubcheck.sh`, `scripts/pubcheck.mjs`). The bundle now
  loads DuckDB from the package's own `bin/` (one variant, eh: `duckdb-engine.wasm`, its worker
  and `duckdb-browser.mjs`), so a host serves the installed package rather than a checkout of
  this repo ([ADR 015](adr/015-duckdb-wasm-vendored.md)). The first version that ships it is
  the next one published.
- **Smaller gaps.** The column list is built with an empty metadata sidecar, so every column
  shows as undocumented. The variable-library XML was not checked against the application whose
  format it follows ([ADR 557](adr/557-variables-and-data-sets.md)).
- **Tests gate CI since 2026-10-05.** A failing Rust or TypeScript test fails its job, both
  lanes run on pull requests, the TypeScript lane typechecks, vendors DuckDB and runs with
  `REQUIRE_REAL_ENGINE=1` and `REQUIRE_REAL_DUCKDB=1`, and the coverage gate requires every
  registry-mapped test to have run and passed. Publishing waits for both lanes on the same
  commit, runs the tests again, and fails when the package's inputs changed since the
  published version without a version bump (`scripts/package-hash.mjs`). Baseline: 204 Rust
  tests (one skipped: the oracle skeleton), 112 TypeScript tests in 22 files, of which one
  file boots the real engine and none yet the real DuckDB.

## Not built

- Arrow IPC across the wasm boundary: values cross as JSON-shaped objects
  ([ADR 014](adr/014-data-provider-arrow-seam.md)). The registry row is `planned`.
- Database sources. `attach_plan` describes an attach in Rust; nothing performs one.
- Reading a governed table and its metadata sidecar from a location, and applying a
  graph-data variable. Their registry rows are `planned`.
- A Node binding for the batch runner (registry row `planned`); the CLI is the native route.
- Turning a paginated flow into document content, in the editor or anywhere else.
- Scheduled refresh: `RefreshPolicy` is stored and nothing acts on it.
- Local import of JSON, Parquet or Excel files, and raster barcodes.
- An importer or exporter contribution: the manifest declares none.
- The differential test against native DuckDB: `data-conformance/tests/oracle.rs` is a stub.

## Host gaps found in wave 4

Each was checked against the installed contract (plugin-api 0.2.39-canary.0) on 2026-10-05.

| Gap | Class | Effect here |
| --- | --- | --- |
| Container parts are not undoable (`PartsSurface.write`/`delete`, "Not undoable") | not modelled in core (shared with paged.web) | the session part does not follow undo |
| No document-scoped plugin label: `setMetadata` takes a leaf `ElementId` only | not on the wire | the session's hash cannot be recorded in an undoable place of its own; lowered content carries it instead |
| Window ▸ Bindings is greyed outside the `dataBinding` edit context | host UI | the Bindings panel opens from Object ▸ Insert data binding… or the command palette |
