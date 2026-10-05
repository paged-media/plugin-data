# paged.data — correctness oracles

**v1.0 · 2026-10-05**

Three lanes check `paged.data` against something other than itself:

- native DuckDB, for queries;
- Adobe InDesign Data Merge, for merging records into pages;
- generated inputs with independent decoders, for the engine's invariants.

Each lane records its answers once, commits them, and replays them in CI without the
reference tool. Where we disagree with the reference today, the test pins the disagreement as
a numbered defect. A pinned defect stays green while the defect exists and fails the day the
behaviour changes, so the fix and the pin change land in the same commit.

| Lane | Reference | Recorded in | Replayed by |
|---|---|---|---|
| DuckDB SQL | `duckdb` CLI v1.1.1 | `conformance/duckdb-sql/recorded/results.json` | `packages/data-bundle/test/duckdb-sql-oracle.spec.ts` |
| Data Merge | InDesign 2025 (20.0.1) | `conformance/indesign-merge/recorded/*.json` | `data-conformance/tests/oracle.rs`, `packages/data-bundle/test/indesign-merge-duckdb.spec.ts` |
| Properties | generated inputs, `rqrr`, GS1 tables | (nothing to record) | `data-conformance/tests/oracle_props.rs` |

## 1. DuckDB SQL lane

**Question.** Does a query that runs through the shipped path give the same answer as native
DuckDB? The shipped path is `bin/duckdb-engine.wasm` → Arrow → `src/query/recordset.ts` →
`data-js` `ingest_result`.

**Fixtures.** The fixtures are `conformance/duckdb-sql/cases.json`, 18 SQL cases. Before the
cases run, each `csv/*.csv` is registered as a table.

- Types: every integer width, HUGEINT, UBIGINT, DOUBLE, FLOAT, DECIMAL at storage widths 16, 32,
  64 and 128 bits with signs and scale 0, DATE and TIMESTAMP before and after 1970 (`_S`, `_MS`,
  `_NS`), BOOLEAN, VARCHAR, and TIME, INTERVAL, UUID, BLOB, LIST and STRUCT.
- Values: NULL in every type, NaN, ±0, ±∞, and 1e300.
- Ordering: the default NULLS LAST, `DESC NULLS FIRST`, binary text order, and ties broken by a
  second key.
- Text: UTF-8 with combining marks, emoji, CJK and right-to-left text.
- CSV quoting: embedded commas, doubled quotes, an embedded newline, padded and empty fields.
- CSV type sniffing: leading zeros, an integer above 2^53, mixed nulls.
- Aggregates: SUM of DECIMAL, AVG, COUNT, and a grouped `string_agg`.

**Recording.** Each cell is recorded losslessly as DuckDB's own `CAST(… AS VARCHAR)`, together
with the `DESCRIBE` type of its column. The sniffed column types of every registered CSV are
recorded too.

**Comparison.** The expected cell is derived from (type, text) by the data-core contract:

| DuckDB type | Expected cell |
|---|---|
| integer types | `number` (f64) |
| DOUBLE, FLOAT, DECIMAL | `number` |
| DATE | `date`, as days since 1970-01-01 |
| TIMESTAMP | `datetime`, as milliseconds UTC (sub-millisecond truncated) |
| BOOLEAN | `bool` |
| BLOB | `bytes` |
| anything else | `text`, in DuckDB's rendering |

Numbers are compared bit for bit with `Object.is`, so NaN equals NaN and −0 differs from 0. The
tolerance is zero. The lane also checks the following, all exactly:

- the shipped engine reports the recorded version and source id;
- `registerCsv` sniffs the same column types as `read_csv_auto`;
- `data-js` accepts every result, counts its rows and maps its column types.

**Agreement today:**

- 13 of 18 cases agree in full, and all 3 CSV sniffs agree.
- 15 of 18 results ingest into `data-js`.
- Decimals agree at every width, which shows the decimal-scale fix holds.
- UTF-8, quoting, ordering and NULL handling agree.

**Defects found, all FIXED in Wave 2** (`src/query/recordset.ts` now reads Arrow's raw
buffers by type id, and `src/query/duckdb.ts` casts the types without a data-core kind to
VARCHAR in SQL):

- **DQ-1.** DATE cells arrived as epoch milliseconds, not days, and `data-js` rejected the whole
  result (`expected i32`). The DateDay buffer is days and is now read directly.
- **DQ-2.** A TIMESTAMP column with no nulls was read in its storage unit (µs, or s / ns for
  `_S` / `_NS`). The buffer is now floored to ms by its unit.
- **DQ-3.** HUGEINT (an Arrow Decimal(38, 0)) was classified `float`. It is `int` now; a
  declared DECIMAL(38, 0) reads the same way, and its values are integers too.
- **DQ-4.** TIME, INTERVAL, LIST and STRUCT (and MAP, UNION, DURATION) cross as DuckDB's own
  text: when a result has such a column, the handle re-runs the query with exactly those
  columns cast to VARCHAR. BLOB crosses as bytes.

**Re-recording.** The CLI must be the engine inside the vendored duckdb-wasm. For
`@duckdb/duckdb-wasm` 1.29.0 that is v1.1.1 (`af39bd0dcf`): download
`duckdb_cli-osx-universal.zip` from the v1.1.1 GitHub release. Homebrew and PyPI ship newer
engines; `record.mjs` refuses any other version, because CSV sniffing changes between releases.

```sh
DUCKDB=/path/to/duckdb node conformance/duckdb-sql/record.mjs
```

After bumping duckdb-wasm, re-record with the matching CLI and review the diff of
`results.json`.

## 2. InDesign Data Merge lane

**Question.** When InDesign merges a template and a CSV, what pages, frames and text does it
produce, and how close is our record flow?

**Fixtures.** The fixtures are `conformance/indesign-merge/fixtures.json` together with
`csv/<id>.csv` and `images/`. The page is US Letter with 36 pt margins, set in Minion Pro
10/12.

| Fixture | Checks |
|---|---|
| `single-record` | one record per page |
| `multi-record-column` | Multiple Records, one column, 12 pt row spacing, 12 records over 2 pages |
| `multi-record-grid` | two columns, rows first |
| `long-record-set` | 57 records in no column's sort order, two columns, columns first, 3 pages |
| `empty-field-lines` | Remove Blank Lines for Empty Fields |
| `overset` | a record whose text does not fit its frame |
| `number-text` | en/de numbers, leading zeros, signs, exponents |
| `image-field` | an `@photo` image field, fitted proportionally and centred |

**Recording.** `record.sh` drives the local InDesign through `record.jsx`. The script builds
each template from the fixture spec, then turns every `<<field>>` into a real Data Merge text
placeholder and each image frame into an image placeholder. It saves the template as
`templates/<id>.idml`, which InDesign wrote itself, so that Wave 5 can open it. It then runs
`mergeRecords()` and writes `recorded/<id>.json`: page count, and for every page each text
frame (bounds, the frame's own text, line count, overset) and each rectangle (bounds, placed
image name and bounds). The script stages files in the fixed directory
`/tmp/paged-data-merge-stage`, so the IDML's data-source path is the same on every
re-recording. It also turns user interaction off and closes every document without saving.
Two complete recordings produced byte-identical JSON.

```sh
bash conformance/indesign-merge/record.sh                      # all fixtures
PAGED_DM_ONLY=overset bash conformance/indesign-merge/record.sh # one fixture
```

Re-record one fixture at a time when one answer is in doubt. A recording is evidence, and
rewriting all of them at once hides which answer changed.

**Replay** (`oracle.rs`, no InDesign) runs three checks.

1. **The rule.** This closed form reproduces all 8 recordings exactly:
   - records per column = ⌊(H + row spacing) / (h + row spacing)⌋;
   - columns = ⌊(W + column spacing) / (w + column spacing)⌋;
   - record *k* goes on page ⌊*k* / (rows·columns)⌋, in CSV order, placed rows first or
     columns first;
   - each frame sits at margin + (column·(w + column spacing), row·(h + row spacing)).

   H and W are the margin box, h and w the template frame. Single Record mode gives each record
   its own page at the template position. Remove Blank Lines drops a line only when the line
   holds nothing but fields and every one of them is empty. Field text is inserted verbatim.
   This is the rule the Wave 5 merge writer implements.

2. **The engine.** `DataSession` resolves a record-flow binding whose template comes from the
   fixture lines. It ingests the CSV with every field as text, as Data Merge reads it, and with
   empty fields as null, as DuckDB reads them. `paginate_flow` packs the records into the
   natural chain: one frame per page of the template frame's height for Single Record, and one
   frame per column of the margin-box height for Multiple Records.

3. **The paginator at InDesign's pitch.** `paginate_flow` alone, given CSV order and records
   of frame height + row spacing.

**Comparison and tolerances.**

- InDesign frames are placed on the record grid from their bounds. The bounds must sit on the
  grid, and match the template frame's size, within **±0.5 pt**.
- Text is compared exactly after normalisation: `\r` becomes `\n`, and U+FEFF is removed (InDesign
  leaves these marks where an empty placeholder was).
- InDesign's text for an overset frame is only the part that fits, so ours must *start with*
  it.
- The score reports:
  - pages, ours against InDesign's;
  - placements that agree, meaning the same page, row, column and text;
  - texts that agree wherever they sit;
  - overset flags that agree;
  - image names that agree.

  Every lane's score is pinned per fixture.

**Agreement today** (engine / paginator, placements agreeing out of records):

| Fixture | Pages (ours/InDesign) | Placements | Texts |
|---|---|---|---|
| single-record | 2/3 · 3/3 | 0 · 3 of 3 | 3 · 3 |
| multi-record-column | 1/2 · 2/2 | 10 · 12 of 12 | 12 · 12 |
| multi-record-grid | 1/1 · 1/1 | 1 · 1 of 7 | 7 · 7 |
| long-record-set | 2/3 · 3/3 | 0 · 57 of 57 | 57 · 57 |
| empty-field-lines | 2/3 · 3/3 | 1 · 3 of 3 | 2 · 3 |
| overset | 2/2 · 2/2 | 0 · 2 of 2 | 2 · 2 (overset flag 1/2 in both) |
| number-text | 2/3 · 3/3 | 1 · 3 of 3 | 3 · 3 |
| image-field | 2/3 · 3/3 | 0 · 3 of 3 | 3 · 3 (images 0/3) |

Over the text ingest, the engine's record texts agree with InDesign's except where blank-line
removal (DM-5) applies. Its placement agrees only by accident. The paginator's packing
arithmetic agrees for every columns-first layout.

`indesign-merge-duckdb.spec.ts` runs the same CSVs through the shipped duckdb-wasm and the
`data-js` record flow, and compares texts only. 81 of 90 records agree. DuckDB keeps leading
zeros and mixed number text as VARCHAR, so `number-text` agrees in full.

**Defects pinned** (Wave 5 fixes the merge writer):

- **DM-1.** There is no Single Record mode: the flow packs as many records as fit into a frame.
- **DM-2.** The record flow re-sorts records by full row content (`stabilize`). Data Merge keeps
  data-source order, so `long-record-set` places 0 of 57.
- **DM-3.** The record pitch is lines × leading, where Data Merge uses frame height + row
  spacing. As a result 20 records land per page where InDesign places 10.
- **DM-4.** The chain fills column by column, and there is no rows-first arrangement.
- **DM-5.** There is no Remove Blank Lines for Empty Fields.
- **DM-6.** A record-flow template has no image field.
- **DM-7.** The record height is not measured text, so an overset record is not flagged.
- **DM-8.** A CSV column that DuckDB sniffs as DOUBLE loses its trailing zeros (`1234.50` prints
  as `1234.5`). Data Merge prints the field text. PARTLY FIXED (Wave 2): a DECIMAL(p, s) column
  now carries its scale (`Field.scale`), and a bare reference to it displays `1234.50`. A
  DOUBLE-sniffed CSV column has no scale left to carry, so this lane stays pinned until the CSV
  import keeps the text or declares the column type (a sources change).

## 3. Property lane

`oracle_props.rs` uses proptest with 256 cases per property.

| Property | Feature |
|---|---|
| `stabilize` gives the same result for any shuffle of mixed-kind rows (NaN, ±0, ±∞, text, dates), keyed or not | `data.query.seam` |
| `stabilize` returns a permutation, is idempotent, and follows value order within a kind | `data.query.seam` |
| `diff(old, new)` applied to old yields new | `data.bind.engine` |
| the payload survives save → JSON → load → save unchanged | `data.plugin.bundle` |
| a second resolve and a second change report without a data change are no-ops | `data.bind.change-report` |
| EAN-13 (every first digit) and UPC-A decode back with independent GS1 tables | `data.barcode.symbology` |
| Code-128 (printable ASCII and digit runs that switch B↔C) decodes back | `data.barcode.symbology` |
| QR (byte mode, level M, 1–213 bytes, so versions 1–10) decodes back with `rqrr` | `data.barcode.symbology` |

QR is decoded with `rqrr`, an independent decoder (MIT OR Apache-2.0, a dev-dependency only).
The harness was first validated on a reference matrix from python `qrcode`. Code-128 has no
small, permissive, pure-Rust decoder, so the test carries its own. It reads the bar and space
widths, looks them up in the published ISO/IEC 15417 width table (a different form from the
encoder's module strings), checks the mod-103 check symbol, and runs code sets A, B and C. The
published "Wikipedia" vector anchors it, and it rejects a symbol with one module flipped.

**Defects pinned** as `defect_*` tests:

- **DB-1 (fixed).** EAN-13 G-parity symbols were written inverted: digit 0 came out as
  `1011000`, not `0100111`, so every EAN-13 whose first digit is not 0 was unscannable. G is now
  R reversed, per the GS1 table. The EAN-13 property draws every first digit, and
  `data_db1_*` keeps the GS1 worked example as a regression.
- **DB-2 (fixed).** QR symbols did not decode. Their data modules matched a reference encoder
  with the same version, level and mask, but the format information was written bit-reversed
  and the dark module was cleared. Versions 7–10 also lacked their version information. All
  three now follow ISO/IEC 18004. The QR property decodes every payload with `rqrr`. A data-barcode
  unit test decodes every version (1–10) under every mask (0–7), and the matrices match python
  `qrcode` module for module (checked once, 80 of 80).
- **DP-1.** FIXED (Wave 2): dates and times before 1970 stabilized after later ones, because of
  big-endian two's-complement byte keys. The sort key now flips the sign bit.
- **DP-2 (fixed).** An f64 in the payload drifted by one ulp through serde_json, which was built
  without `float_roundtrip`. The workspace now enables it (+8 bytes of wasm). The payload
  property draws any finite f64. The wasm boundary was always exact.
- **DP-3.** FIXED (Wave 2): `RowDelta.removed` held internal key encodings (`"3:k2\u{1f}"`), so a
  change report could not name the rows it removed. It now holds their indices in `old`.
- **DP-4.** FIXED (Wave 2): a variable binding followed the delivery order, so the same rows
  delivered in another order reported a change. Record N is now record N of the stabilized
  order, for every per-record kind.

## Feature links

- **Rust:** test names end in `__feat__<id>`.
- **Vitest:** the describe titles carry `[data.query.seam]` or `[data.lower.content]`.
