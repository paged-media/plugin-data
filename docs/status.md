# Status

What `paged.data` ships and what it does not, read from the code on branch
`hardening/wave-0-gates` at `9077269` (2026-10-06; package version 0.1.0-canary.10, not yet
published; the newest published version is 0.1.0-canary.9). The 2026-10-05 round of work up
to the engine batch is on that branch; its outcome is summarised at the end of
[`design/analysis-2026-10-05.md`](design/analysis-2026-10-05.md). How
the parts fit is in [`architecture.md`](architecture.md); the analysis behind the current round
of work, with file and line references, is
[`design/analysis-2026-10-05.md`](design/analysis-2026-10-05.md).
"The session" below is the object returned by `createSession`, which the package exports.

## Shipped

- **The session is saved with the document** (since 2026-10-05). Sources, queries,
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
- **Sources** (local formats since 2026-10-06). The Data sources panel imports CSV, TSV, JSON
  (an array or newline-delimited), Parquet and Excel `.xlsx` (one worksheet per source; the
  panel switches worksheet) as one in-memory DuckDB table per source. JSON and Parquet use
  DuckDB's own readers; XLSX is read by the engine (`data-xlsx`, calamine) with one type per
  column and handed to DuckDB's `read_json` with that column list. Imported files are saved
  with the document like CSV (inline up to 64 KiB, else `data/<hash>.<ext>`). File ▸ Import
  and a drop route `.json`, `.ndjson`, `.jsonl` and `.parquet` to the plugin
  (`contribute.importer`). A remote URL (CSV, TSV, JSON or Parquet) can be added as a
  descriptor; Load calls `fetch` only for an origin the host reports as consented and loads
  the bytes as a table, like an imported file.
- **Queries** (since 2026-10-06). The Data query panel has a SQL field with DuckDB's
  diagnostics (error class, line and column in the query as written), filter, sort and group
  builders that write SQL into it, a preview grid of the first 50 rows as DuckDB prints them,
  and saving under a query id. Every query, typed or restored from a document, passes a guard
  (`src/query/sql.ts`): a conservative lexer that reads strings, quoted names and comments
  the way DuckDB does, then an allow-list — exactly one statement with balanced brackets,
  starting with SELECT, WITH, FROM, VALUES or `(`, no statement keyword anywhere, and every
  table position a source table, a subquery or `range` / `generate_series` / `unnest`. No
  file or URL table function and no `'https://…'` or `"file.csv"` table name gets through.
  The guard asks DuckDB nothing. The engine adds `SET lock_configuration = true` at boot, so
  no statement can change a DuckDB setting. A failing query is a diagnostic for that query;
  the refresh carries on with the others. The first guard parsed with DuckDB's
  `json_serialize_sql`, which lives in the json extension: DuckDB autoloaded it from
  extensions.duckdb.org (the json and parquet extensions now ship in `bin/duckdb-ext/`
  and load same-origin), the editor's CSP refused that, and the worker trapped on every
  refresh. `test/duckdb-browser.spec.ts` runs the shipped worker in headless Chromium under
  the editor's headers (CI: `REQUIRE_REAL_BROWSER=1`), and both lanes prove the same
  security matrix (`test/guard-matrix.ts`). `enable_external_access = false` was measured
  and not used: it is global and one-way, and it also refuses DuckDB's readers over the
  registered import buffers, so every import after the first query would fail.
- **Refresh policy** (since 2026-10-06, `src/refresh.ts`). Each source has one: manual; on open
  (the queries re-run when the document opens, and a remote source is fetched again only with
  a remembered grant); every N seconds (at least 15) for a remote source, only while its
  origin is consented, re-running the queries only when the content changed; never. A local
  file refuses the interval policy: a browser page keeps no handle to watch the file.
- **Bindings from the panel.** "Map fields…" lists the columns of the first source and
  creates one variable binding per chosen column. "Add binding" defines every binding kind:
  a variable field, an image or a barcode in the selected rectangle, a table with
  comma-separated columns, show/hide on the selected element, a style rule (condition and
  document style, on the selected table cell's column or the caret's story) and a record
  flow (fields per record, optional grouping) with a preview list of what it would place. "Lower to document" writes native content: a variable as a
  tagged placeholder field, an image through `placeImage`, a barcode (EAN-13, UPC-A,
  Code-128, QR) as one closed vector path per dark module, scaled to the rectangle.
- **Refresh.** "Refresh data" runs the queries again (an unchanged result is recognised and
  not decoded again); "Refresh fields" rewrites the placeholder fields whose value changed in
  one back-to-front batch, which is one undo step, and skips pinned and overridden fields; "What changed?" lists the bindings whose resolved
  content differs from the previous report; a stepper previews the bindings against record N.
- **Sync review** (since 2026-10-05). Each binding in the Bindings panel shows its
  sync state (synced, stale, pinned, overridden, error) with Pin, Unpin and Accept source.
  Accept source re-links the binding and writes the source value at once. A binding that
  cannot resolve is `Error` unless it is pinned or overridden. Pinned and overridden
  decisions are saved with the session. "What changed?" also shows the row diff of each
  query since the document was last written from it: rows added, removed and changed (each
  changed cell before and after), the key rows are matched by, and which bindings each
  change reaches (`DataSession::row_diff`, built on `data-bind` `diff()`).
- **Rule editor.** A rule's condition is checked as it is defined: a parse error or a field
  the data lacks is shown and the rule is not defined. "Preview" lists the records that fire,
  through the same evaluation that applies the rule. The style comes from the document's
  own paragraph, character or cell styles. A paragraph or character rule styles the whole
  story when any record fires, or one paragraph per record from the cursor; a cell rule
  styles the fired rows' cells through `appliedCellStyle`.
- **Locales and field formats.** Locales are rows of one table in `data-core`
  (`LOCALES`): en, de, en-GB, de-AT, de-CH, fr, it, es, nl, with the CLDR values cited
  beside each row. The session locale is chosen in the Dataset panel; a variable field can
  take its own locale and a number, currency, percent or date pattern ("Format…" in the
  Bindings panel), which is written into the field at once unless it is pinned or
  overridden. The pattern is the field's own expression wrapped in a format function;
  per-field locales are saved in the engine recipe. The canonical value and every content
  hash stay locale-free.
- **Data set tools** (Dataset preview panel): a column list for a query; a batch plan per
  record, per group or as one catalog; the session formatting locale; publishing
  a query result as a data provider, which other plugins can read when the host has a
  provider registry; a variables palette that captures the current values or one data set
  per record, applies a data set in one undo step, and imports or exports a variable library.
- **Nine commands, nine menu entries, four panels, one importer** and a `dataBinding` edit
  context: double-click on an
  element that carries this plugin's metadata; no canvas tools, the Bindings panel.
- **The binding language**: 42 functions, arithmetic, comparison and `&`, with errors as
  values. The image and barcode bindings of the panel take an expression; so do all
  bindings defined through the session or in a batch job.
- **Lowering**: a table binding lowers to a native table; a visibility binding sets
  `elementVisible`; a rule applies a named style to a story range, to one paragraph per
  fired record, or to table cells.
- **Headless batch.** `paged-data-batch`, built from source, reads a JSON job with
  materialised query results and prints the paginated flow of each output document. A
  script evaluated in Boa can supply the locale, the parameters and the build.

## Limits of what is shipped

- **Saving the session follows undo only on engine protocol 69** (not yet released;
  built and feature-detected, `src/doors.ts`, `src/doc-label.ts`). With the document-label
  doors each session version is written once as `sessions/<hash>.json` and the document's
  own label (`setDocumentMetadata`, undoable) names the live one. The label rides the batch
  of the document write that made the change (a lower, a field refresh, a merge), so both
  undo together. A change no write carried takes no undo step: `session.json` records the
  version the label named when it was written (`base`), and a reopen reads `session.json`
  while the label still names that base, else the version the label names. An undo that
  takes the label back reloads the version it names without rebooting either engine (DuckDB
  keeps its tables; a source whose saved data differs is loaded again). Data parts are then
  never collected (an undo can bring back a session that names them), and old versions are
  kept. Verified on a local protocol-69 build (`test/protocol69-real-core.spec.ts`); the
  count budgets carry a protocol-69 variant (`onLabelled`, `test/perf/harness.ts`): a write
  from data carries one more op and first writes the session change it is labelled with. On the published engine (68) and contract
  (0.2.40) container parts take no part in undo and defining a binding is not a document
  change: what a binding writes undoes as usual, the session part does not.
- **The Bindings panel still binds over** `SELECT * FROM <first source>`; a query saved in
  the Data query panel is used by bindings defined through the session or by its id.
  "Wire demo binding" still passes empty expressions.
- **CSV, TSV and XLSX are not routed from File ▸ Import.** paged.sheet claims the same
  extensions and the editor's importer registry gives a contested extension to the first
  bundle that registers it; paged.data loads first, so claiming them would take the import
  away from the spreadsheet plugin. They are imported from Data sources ▸ Import file….
- **Tables and barcodes are updated in place** (`src/relower.ts`). A re-lower swaps a
  table inside its own frame and story (deleteTable, insertTable, cells, label: one batch); a
  barcode re-lower or preview step removes the previous symbol's modules in the batch that
  draws the new one. The table's address and the modules come from what the session saw
  minted; after a reopen only the labels are known, so a table frame is replaced rather than
  reused and only a barcode's labelled last module is found. A new table still goes into a
  new frame at a fixed inset on the active page, with column widths estimated from character
  counts.
- **Sync review limits.** Accepting the source of a table only re-links it: a table is
  written again as a whole when lowered ([ADR 551](adr/551-compiled-to-native-content.md)),
  so the panel says to lower it. Nothing marks a field `Overridden` when a user types into
  it; only an applied data set does. The row diff's "before" is recorded when the document
  is written from the data (a lower or a field refresh), not when it is saved, so a
  reopened document starts with every row new. Which bindings a change reaches is read
  from the fields their expressions name; a per-record binding is reported whenever rows
  are added or removed, because the record it shows can move.
- **Record flow writes frames** (`src/flow-writer.ts`). Lowering a record flow
  places one text frame per paginated frame in the active page's margin box, adding pages
  after it as the flow needs them. The frames are not threaded, so the paginator's breaks
  hold. A re-lower replaces the frames and the pages it added. A record's height is still its
  field count times a line height, not a measured layout
  ([ADR 554](adr/554-record-flow-pagination.md)).
- **Data Merge** (`src/merge.ts`; `docs/design/oracles.md` §2). The merge reads the
  `<<field>>` text frames (and the chosen image rectangles) of a page and merges every record,
  Single or Multiple Records, matching InDesign on all 8 recorded fixtures. The limits:
  - It merges into the current document, keeping the template page or consuming it.
    "Merge to a new document" (`destination: "newDocument"`) copies the document through
    the documents door (D-26, contract 0.2.41, unreleased), opens the copy (the host asks
    before unsaved edits are discarded; keeping them cancels the merge) and consumes the
    template there. A host without the door refuses it and says so. `runRecordFlowBatch`
    returns paginated units, not documents.
  - Merged frames are minted fresh: core refuses to copy a frame whose story holds a
    hyperlink (every Data Merge placeholder is one), and a duplicated page shares its frames'
    stories. Story-level formatting is copied; formatting that varies inside the template
    story is not.
  - A merge that needs new pages takes two undo steps (pages, then content) on engine 68,
    because a page minted in a batch cannot be named. On protocol 69 the pages are named in
    the batch and the merge is one batch (falling back to two if the engine refuses). A
    merge that fits the template page takes one. Overset words are measured with one
    `measureStrings` call per face and size where the host has it (D-27), else per word.
  - Added pages have zero margins (insertPage and duplicatePage do not carry them).
  - Core's IDML import misreads a template whose lines are bare placeholders: the paragraph
    mark lands two characters into the next placeholder (pinned in
    `test/merge-real-core.spec.ts`).
- **Lowering costs.** A table lower is one batch and one undo step (frame, table, cells and
  label, addressed through core's batch handles; budget W1 in
  `test/perf/perf-budgets-commands.spec.ts`). "Place bindings on the page" plans every
  variable first and places them in one batch, so 20 variables are one mutate and one undo
  step (budget W5, was 20); a batch core refuses falls back to one mutate per variable.
- **Engine fixes that protocol 69 brings** (verified on a local build of core
  `data/protocol-69`): typing at a field's edge lands beside the field, and undoing a
  `deleteRange` puts its runs and fields back. Both stay pinned as defects against 68
  (`fixedFrom(69, it)` in `test/real-core.ts`). The IDML import's paragraph mark between
  adjacent placeholders (D-25) is fixed in plugin-publish branch `data/br-between-sources`
  but not yet in core's import pin, so its pin stays.
- **Fields at the caret.** A field placed at the user's caret sends the caret both as
  `offset` and as `insertField.contentOffset`: an engine on protocol 69 converts the caret
  unit and places it right in any paragraph; an older engine ignores `contentOffset` and the
  field lands early after the first paragraph.
- **Images** are placed only from a URL or path. Inline bytes and asset ids are skipped.
- **Remote sources.** A `credentialRef` can be stored on the descriptor, but nothing
  resolves it and the fetch is made without it. The editor's page policy cannot follow
  consent grants (a header CSP is fixed at load). Since editor ADR 218 (branch
  `data/sources`), a deployment lists exact data origins at build time
  (`PAGED_DATA_ORIGINS`); only those are reachable, and still only after consent. The public
  build lists none. The consent dialog says when an origin stays blocked, and the failed fetch
  says so on the source.
- **DuckDB was not in the npm package.** Every version up to 0.1.0-canary.9 shipped without
  `bin/duckdb-engine.wasm`. The publish workflow now runs `scripts/vendor-duckdb.sh` and
  refuses a tarball without it (`scripts/pubcheck.sh`, `scripts/pubcheck.mjs`). The bundle now
  loads DuckDB from the package's own `bin/` (one variant, eh: `duckdb-engine.wasm`, its worker,
  `duckdb-browser.mjs`, and DuckDB's json + parquet extensions in `bin/duckdb-ext/`), so a host serves the installed package rather than a checkout of
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
  published version without a version bump (`scripts/package-hash.mjs`). When this round of work
  started there were 204 Rust tests (one skipped: the oracle skeleton) and 112 TypeScript
  tests in 22 files, of which one file booted the real engine and none the real DuckDB. At
  `9077269` (by grep) there are 293 Rust `#[test]` functions plus property tests and 52
  TypeScript test files; 10 spec files run against the real core host and 11 against real
  DuckDB, one of them in headless Chromium (`test/duckdb-browser.spec.ts`). The InDesign
  Data Merge recordings and native DuckDB results are replayed in CI
  ([`design/oracles.md`](design/oracles.md)).

- **Performance is measured and pinned since 2026-10-05.** Count budgets are pinned:
  - Bundle side, against the real core host, the real data-js wasm and real DuckDB:
    `packages/data-bundle/test/perf/`.
  - Engine side: `data-conformance/tests/perf_counts.rs`, through the `perf-counters`
    feature. The shipped wasm exports `perfCounters()`.
  - Criterion benches trend the wall clock.

  After the optimisation round: a 100-field refresh is 1 mutate and 1 undo step (was 100);
  a burst of 200 reflow events costs one chain read and one pagination (was 200); a 1-cell
  data change re-resolves only the bindings whose inputs changed (10 of 50 in the workload,
  was 50); a 10k-row table resolve allocates no sort keys (was 288,478); an unchanged result
  delivered again is not decoded. The 57-record merge is pinned at 2 mutates and 2 undo
  steps (W8).

  The "1M-row DuckDB" gate the records cited now has a lane. It is opt-in and trended, not
  gated, and measures a 1M-row CSV to a grouped RecordSet in 0.37 s. Bringing the full 1M rows
  into the engine costs about 2.1 s. Numbers and the ranked fixes:
  [`design/perf-baseline-2026-10-05.md`](design/perf-baseline-2026-10-05.md).

## Not built

- Arrow IPC across the wasm boundary ([ADR 014](adr/014-data-provider-arrow-seam.md)). A
  refresh now hands query results to the engine as typed column buffers, one copy per column
  (`queryColumns` and `ingestColumnBatch`), not as one object per cell; the IPC format itself
  is not used.
- Database sources, SQLite included. `attach_plan` describes an attach in Rust; nothing
  performs one (see the wave-6 gaps below).
- Reading a governed table and its metadata sidecar from a location, and applying a
  graph-data variable. Their registry rows are `planned`.
- A Node binding for the batch runner (registry row `planned`); the CLI is the native route.
- Raster barcodes; an exporter contribution.

## Host gaps found while saving the session

Each was checked against the installed contract (plugin-api 0.2.39-canary.0) on 2026-10-05.

| Gap | Class | Effect here |
| --- | --- | --- |
| Container parts are not undoable (`PartsSurface.write`/`delete`, "Not undoable") | not modelled in core (shared with paged.web) | the session part does not follow undo |
| No document-scoped plugin label: `setMetadata` takes a leaf `ElementId` only | not on the wire | the session's hash cannot be recorded in an undoable place of its own; lowered content carries it instead. Built in the engine as `setDocumentMetadata` (protocol 68, not yet released); the plugin adopts it after the release |
| Window ▸ Bindings is greyed outside the `dataBinding` edit context | host UI | the Bindings panel opens from Object ▸ Insert data binding… or the command palette |

## Gaps found in step 6

Measured on 2026-10-05 against DuckDB-WASM 1.29.0 (engine v1.1.1), the shipped EH variant.

| Gap | Class | Effect here |
| --- | --- | --- |
| DuckDB's `excel` extension has no wasm build for v1.1.1 (extensions.duckdb.org answers 404); `spatial` (GDAL, `st_read`) exists but is 22.8 MB of wasm | engine limitation (third-party) | XLSX is read by `data-xlsx` (calamine, MIT): data-js grew 762,486 → 1,137,695 bytes (+375 KB) |
| `sqlite_scanner` loads offline from a same-origin repository (1.6 MB, signed), and `ATTACH … (TYPE sqlite)` succeeds, but every read fails "unable to open database file": SQLite's own VFS cannot see DuckDB-WASM's registered files | engine limitation (third-party) | no SQLite import; `attach_plan` is not executed (it would attach nothing readable). Options: a newer DuckDB-WASM, sql.js (MIT, about 0.65 MB), or a read-only SQLite reader in Rust |
| Contested importer extensions go to the first registrant, with no per-file choice | host UI | CSV/TSV/XLSX import stays in the Sources panel |
| A page CSP cannot follow runtime consent grants; following them needs a fetch door outside the page's policy (`host.network.fetch` plus a broker origin or proxy) | no plugin door + host UI | remote sources reach only origins a deployment lists (editor ADR 218) |
| A local file cannot be watched from a browser page | platform | file sources refresh on open or by importing again; interval is refused |
| The shipped eh build has no parquet or json extension; DuckDB loaded them on first use from extensions.duckdb.org, which the editor's CSP (connect-src 'self') refuses — the worker trapped ("unreachable") on Parquet, JSON and XLSX (`read_json`) imports, while the Node lanes passed by downloading them | engine limitation (packaging) + host CSP | FIXED 2026-10-06: the package ships both (json 696,809 B, parquet 2,803,379 B, DuckDB Labs-signed, MIT, SHA-256 pinned by `scripts/vendor-duckdb.sh`) in `bin/duckdb-ext/v1.1.1/wasm_eh/`; `bootDuckDB` points `custom_extension_repository` there and turns autoinstall off before the configuration lock. The browser lane imports JSON, NDJSON, Parquet and XLSX with no off-origin request; the Node lanes load the same files through a local-only `XMLHttpRequest` and refuse every other URL. The data plugin's wasm is now 40.6 MB of the app's 94.7 MB |
