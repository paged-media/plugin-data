# Status

What `paged.data` ships and what it does not, read from the code at commit `6b96ce5`
(`@paged-media/data` 0.1.0-canary.9). How the parts fit is in [`architecture.md`](architecture.md).
"The session" below is the object returned by `createSession`, which the package exports.

## Shipped

- **Sources.** The Data sources panel imports a `.csv` or `.tsv` file into an in-memory
  DuckDB table. A remote URL (CSV, TSV, JSON or Parquet) can be added as a descriptor; Load
  calls `fetch` only for an origin the host reports as consented and hands DuckDB the bytes.
- **Bindings from the panel.** "Map fields…" lists the columns of the first source and
  creates one variable binding per chosen column. "Add binding" binds an image or a barcode
  to the selected rectangle. "Lower to document" writes native content: a variable as a
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
- **Through the session only**: a table binding with chosen columns, lowered to a native
  table; a visibility binding that sets `elementVisible`; a rule that applies a named style
  to a story range or to table cells.
- **Headless batch.** `paged-data-batch`, built from source, reads a JSON job with
  materialised query results and prints the paginated flow of each output document. A
  script evaluated in Boa can supply the locale, the parameters and the build.

## Limits of what is shipped

- **Nothing is restored on reopen.** Sources, queries, binding definitions and data sets
  live in the session. The engine can serialise them (`payload()`); the bundle never calls
  it and the wasm class cannot load one. Imported rows stay in memory. Fields and frames
  already in the document survive, but a field is refreshed only if a binding with its key is
  defined again ([ADR 552](adr/552-binding-is-a-recipe.md)).
- **The panels expose a small part of the engine.** Their only query is
  `SELECT * FROM <first source>`. There is no SQL field and no control for a table with
  chosen columns, a visibility binding, a rule or a record flow. "Add binding" for a
  variable passes the typed column name as the binding's `target` and an empty string as
  its expression; "Wire demo binding" passes empty expressions too.
- **Tables and barcodes are written again on every lower** and on every preview step.
  Nothing removes or updates the earlier frame or paths. A table goes into a new frame at a
  fixed inset on the active page, with column widths estimated from character counts. The
  bundle sets no paint on barcode paths; they take the document's defaults for new objects.
- **Sync states are not surfaced.** The engine keeps a state per binding (Linked, Pinned,
  Overridden, Stale, Error); the bundle never reads it and resolves every binding regardless.
  The engine marks a binding `Overridden` when a data set is applied; the bundle's field
  refresh does not read that state ([ADR 553](adr/553-non-destructive-refresh.md)).
- **Record flow stops at a data structure.** The paginator returns frames and blocks; no
  code writes them to the document, and no page or frame is created on overflow. A record's
  height is its field count times a line height, not a measured layout. The session has no
  method that defines a record-flow binding, so "Run batch" in the panel answers that none
  exists ([ADR 554](adr/554-record-flow-pagination.md)).
- **Images** are placed only from a URL or path. Inline bytes and asset ids are skipped.
- **Remote sources.** JSON and Parquet bytes are registered with DuckDB as a file, not
  inserted as a table. A `credentialRef` can be stored on the descriptor, but nothing
  resolves it and the fetch is made without it. In the editor at `28dc764` the page policy
  is the fixed `connect-src 'self' blob: data:` (`editor: apps/canvas/public/_headers:49`);
  it is not derived from consent grants (`editor: apps/canvas/src/plugin-consent.ts:36-41`).
- **DuckDB is not in the npm package.** The manifest declares `bin/duckdb-engine.wasm`, but
  the publish workflow does not run the script that produces it, and the bundle loads DuckDB
  from `vendor/duckdb-wasm/dist/`, which the host application has to serve
  ([ADR 015](adr/015-duckdb-wasm-vendored.md)).
- **Smaller gaps.** A barcode's `quietZone` option reaches no encoder. The column list is
  built with an empty metadata sidecar, so every column shows as undocumented. A note in
  `packages/data-bundle/src/query/recordset.ts` says Arrow decimal columns are read without
  their scale. The variable-library XML was not checked against the application whose
  format it follows ([ADR 557](adr/557-variables-and-data-sets.md)).
- **CI does not gate on tests.** The nextest and vitest commands end in `|| true`. Format,
  clippy, the dependency checks, the coverage gate and the wasm build do fail the job.

## Not built

- Arrow IPC across the wasm boundary: values cross as JSON-shaped objects
  ([ADR 014](adr/014-data-provider-arrow-seam.md)). The registry row is `planned`.
- Database sources. `attach_plan` describes an attach in Rust; nothing performs one.
- Reading a governed table and its metadata sidecar from a location, and applying a
  graph-data variable. Their registry rows are `planned`.
- A Node binding for the batch runner (registry row `planned`); the CLI is the native route.
- Turning a paginated flow into document content, in the editor or anywhere else.
- Saving imported data. Scheduled refresh: `RefreshPolicy` is stored and nothing acts on it.
- Local import of JSON, Parquet or Excel files, and raster barcodes.
- An importer or exporter contribution: the manifest declares none.
- The differential test against native DuckDB: `data-conformance/tests/oracle.rs` is a stub.
