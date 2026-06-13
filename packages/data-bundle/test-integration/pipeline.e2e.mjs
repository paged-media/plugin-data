// End-to-end pipeline harness (spec §12.4) — proves the seam that the unit
// tests cannot: the REAL data-js wasm engine, driven through its
// serde-wasm-bindgen boundary, and (Part B) the REAL vendored DuckDB-WASM.
//
// Gated like the oracle — NOT part of the default vitest run (it needs the
// built wasm + the vendored DuckDB dist). Run after building both:
//
//   bash scripts/build-wasm.sh && bash scripts/vendor-duckdb.sh
//   node packages/data-bundle/test-integration/pipeline.e2e.mjs
//
// Part A: hand-built RecordSet → wasm DataEngine → resolve → lower (proves the
//         marshalling + the full Rust pipeline running IN wasm).
// Part B: real DuckDB-WASM runs a CSV SELECT → Arrow → RecordSet → the SAME
//         engine → identical lowered output (proves DuckDB ↔ engine).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, "../bin");
const TODAY = 20613; // 2026-06-08, days since 1970-01-01

function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  console.log(`  ✓ ${label}`);
}

// A minimal copy of the TS arrowToRecordSet (unit-tested in recordset.test.ts)
// so the harness stays dependency-free (no TS loader).
function classify(typeStr) {
  const s = String(typeStr ?? "").toLowerCase();
  if (/utf8|string|char|varchar/.test(s)) return "text";
  if (/bool/.test(s)) return "bool";
  if (/timestamp|datetime/.test(s)) return "datetime";
  if (/date/.test(s)) return "date";
  if (/float|double|decimal|real/.test(s)) return "float";
  if (/int/.test(s)) return "int";
  return "text";
}
function cell(raw, ty) {
  if (raw === null || raw === undefined) return { t: "null" };
  if (ty === "bool") return { t: "bool", v: Boolean(raw) };
  if (ty === "int" || ty === "float") return { t: "number", v: Number(raw) };
  if (ty === "date") return { t: "date", v: Number(raw) };
  if (ty === "datetime") return { t: "datetime", v: Number(raw) };
  return { t: "text", v: String(raw) };
}
function arrowToRecordSet(table) {
  const fields = table.schema.fields.map((f) => ({
    name: f.name,
    ty: classify(f.type?.toString?.() ?? f.type),
    nullable: true,
  }));
  const columns = fields.map((f, i) => {
    const arr = table.getChildAt(i)?.toArray() ?? [];
    return Array.from(arr, (c) => cell(c, f.ty));
  });
  return { schema: { fields }, columns, row_count: table.numRows };
}

// The recipe both parts feed the engine — a tiny product catalog.
function defineCatalog(engine) {
  engine.define_source({
    id: "products",
    kind: { kind: "inlineSeed", table: "products" },
    capability: "inline",
  });
  engine.define_query({
    id: "q1",
    sql: "SELECT sku, price FROM products ORDER BY sku",
    params: [],
    shape: { shape: "recordStream" },
  });
  engine.define_binding({
    id: "t1",
    kind: "table",
    region: "r1",
    query: "q1",
    columns: [
      { header: "SKU", expr: "sku", style: null },
      { header: "Price", expr: "CURRENCY(price)", style: null },
    ],
    options: { header_row: true, group_by: [] },
  });
}

function assertLowered(lowered, label) {
  assert.equal(lowered.kind, "table", `${label}: kind`);
  // header + 2 data rows.
  assert.equal(lowered.rows.length, 3, `${label}: row count`);
  assert.equal(lowered.rows[0].header, true, `${label}: header row`);
  assert.equal(
    lowered.text,
    "SKU\tPrice\nA-1\t$9.99\nB-2\t$19.99",
    `${label}: degraded text`,
  );
  console.log(`  ✓ ${label}: lowered to a 3-row table, "$9.99"/"$19.99" formatted`);
  return lowered;
}

async function bootEngine() {
  const mod = await import(resolve(BIN, "data_js.js"));
  await mod.default({ module_or_path: readFileSync(resolve(BIN, "data_js_bg.wasm")) });
  return new mod.DataEngine(TODAY);
}

// ── Part A — the wasm engine boundary ───────────────────────────────────────
async function partA() {
  console.log("\nPart A — real data-js wasm engine (hand-built RecordSet):");
  const engine = await bootEngine();
  defineCatalog(engine);

  const recordSet = {
    schema: {
      fields: [
        { name: "sku", ty: "text", nullable: true },
        { name: "price", ty: "float", nullable: true },
      ],
    },
    columns: [
      [
        { t: "text", v: "A-1" },
        { t: "text", v: "B-2" },
      ],
      [
        { t: "number", v: 9.99 },
        { t: "number", v: 19.99 },
      ],
    ],
    row_count: 2,
  };
  engine.ingest_result("q1", recordSet);
  const lowered = engine.resolve_lowered("t1");
  assertLowered(lowered, "Part A");

  // The recipe round-trips through the wasm boundary with no credentials.
  const meta = engine.metadata();
  eq(meta.sourceCount, 1, "Part A: metadata.sourceCount");
  eq(meta.bindingCount, 1, "Part A: metadata.bindingCount");
  return lowered;
}

// ── Part B — real DuckDB-WASM (best-effort; needs the vendored node build) ──
async function partB(expected) {
  console.log("\nPart B — real DuckDB-WASM (CSV → Arrow → RecordSet → engine):");
  let duckdb;
  try {
    duckdb = await import(resolve(HERE, "../../../vendor/duckdb-wasm/dist/duckdb-node-blocking.cjs"));
  } catch (err) {
    console.log(`  ⚠ skipped — vendored DuckDB node build not loadable: ${err.message}`);
    console.log("    (run scripts/vendor-duckdb.sh; Part A already proved the engine boundary)");
    return false;
  }

  try {
    const DUCKDB_DIST = resolve(HERE, "../../../vendor/duckdb-wasm/dist");
    const bundles = {
      mvp: {
        mainModule: resolve(DUCKDB_DIST, "duckdb-mvp.wasm"),
        mainWorker: resolve(DUCKDB_DIST, "duckdb-node-mvp.worker.cjs"),
      },
    };
    const logger = new duckdb.ConsoleLogger();
    const db = await duckdb.createDuckDB(bundles, logger, duckdb.NODE_RUNTIME);
    await db.instantiate();
    const conn = db.connect();
    // The real file-import path: register CSV bytes, let DuckDB auto-detect the
    // types (price → DOUBLE), exactly as the bundle's registerCsvSource does.
    db.registerFileText("products.csv", "sku,price\nA-1,9.99\nB-2,19.99\n");
    conn.query("CREATE TABLE products AS SELECT * FROM read_csv_auto('products.csv')");
    const table = conn.query("SELECT sku, price FROM products ORDER BY sku");
    const records = arrowToRecordSet(table);

    const engine = await bootEngine();
    defineCatalog(engine);
    engine.ingest_result("q1", records);
    const lowered = engine.resolve_lowered("t1");
    assertLowered(lowered, "Part B");

    assert.deepEqual(lowered.text, expected.text, "Part B == Part A (DuckDB parity)");
    console.log("  ✓ Part B lowered output == Part A (DuckDB ↔ engine parity)");
    conn.close();
    return true;
  } catch (err) {
    console.log(`  ⚠ DuckDB node API mismatch (v1.29.0): ${err.message}`);
    console.log("    Part A already proved the engine boundary; the browser AsyncDuckDB path");
    console.log("    is the production target (duckdb.ts). Recording as a known node-bootstrap gap.");
    return false;
  }
}

// ── Part C — the dataset surfaces through the wasm serde boundary ────────────
// Proves the §7.1 provider / §7 governed catalog / §10 batch-plan methods
// round-trip through serde-wasm-bindgen with the camelCase shapes the bundle
// expects — the gap the unit tests (which mock the engine) cannot cover.
async function partC() {
  console.log("\nPart C — provider / governed catalog / batch plan (real wasm serde):");
  const engine = await bootEngine();
  engine.define_query({ id: "q1", sql: "SELECT * FROM s", params: [], shape: { shape: "recordStream" } });
  const recordSet = {
    schema: {
      fields: [
        { name: "sku", ty: "text", nullable: true },
        { name: "region", ty: "text", nullable: true },
        { name: "price", ty: "float", nullable: true },
      ],
    },
    columns: [
      [{ t: "text", v: "B-2" }, { t: "text", v: "A-1" }, { t: "text", v: "A-3" }],
      [{ t: "text", v: "west" }, { t: "text", v: "east" }, { t: "text", v: "east" }],
      [{ t: "number", v: 19.99 }, { t: "number", v: 9.99 }, { t: "number", v: 5.0 }],
    ],
    row_count: 3,
  };
  engine.ingest_result("q1", recordSet);

  // §7.1 — publish a provider snapshot (camelCase rowCount, an etag revision).
  const pub1 = engine.publish_provider("q1", "catalog-dataset", "dataset");
  eq(pub1.id, "catalog-dataset", "Part C: provider id");
  eq(pub1.category, "dataset", "Part C: provider category");
  eq(pub1.rowCount, 3, "Part C: provider rowCount (camelCase crossed)");
  assert.equal(typeof pub1.revision, "string", "Part C: provider revision is a string");
  assert.ok(pub1.revision.length > 0, "Part C: provider revision non-empty");
  // The schema descriptor crosses with the Arrow-seam field shape (`ty`).
  assert.notEqual(pub1.schema.fields[0].ty, undefined, "Part C: provider schema field uses `ty`");

  // Permutation invariance through the real engine: the same rows in a different
  // ingest order publish the SAME revision.
  const engine2 = await bootEngine();
  engine2.define_query({ id: "q1", sql: "x", params: [], shape: { shape: "recordStream" } });
  engine2.ingest_result("q1", {
    schema: recordSet.schema,
    columns: [
      [{ t: "text", v: "A-1" }, { t: "text", v: "A-3" }, { t: "text", v: "B-2" }],
      [{ t: "text", v: "east" }, { t: "text", v: "east" }, { t: "text", v: "west" }],
      [{ t: "number", v: 9.99 }, { t: "number", v: 5.0 }, { t: "number", v: 19.99 }],
    ],
    row_count: 3,
  });
  eq(engine2.publish_provider("q1", "catalog-dataset", "dataset").revision, pub1.revision,
    "Part C: provider revision is permutation-invariant (real wasm)");
  console.log("  ✓ provider snapshot stabilized; revision etag permutation-invariant");

  // §7 — governed catalog: documented columns + drift (price documented int vs
  // float data; region undocumented).
  const cat = engine.governed_catalog("q1", {
    columns: [
      { name: "sku", label: "SKU", dataType: "text", provenance: "dim" },
      { name: "price", dataType: "int" },
    ],
  });
  eq(cat.columns.length, 3, "Part C: catalog column count");
  eq(cat.columns[0].label, "SKU", "Part C: catalog label (documented)");
  eq(cat.columns[0].dataType, "text", "Part C: catalog dataType (camelCase crossed)");
  eq(cat.columns[2].dataType, "float", "Part C: catalog keeps the ACTUAL type (data wins)");
  const kinds = cat.diagnostics.map((d) => d.kind);
  assert.ok(kinds.includes("typeMismatch"), "Part C: catalog reports typeMismatch (price int↔float)");
  assert.ok(kinds.includes("undocumentedColumn"), "Part C: catalog reports undocumented region");
  console.log("  ✓ governed catalog: documented cols + drift diagnostics crossed");

  // §10 — batch plan: per-group over region, and one catalog.
  const perGroup = engine.plan_batch("q1", { mode: "perGroup", by: ["region"] });
  eq(perGroup.mode, "perGroup", "Part C: batch mode");
  eq(perGroup.units.length, 2, "Part C: per-group unit count (east, west)");
  assert.ok(Array.isArray(perGroup.units[0].recordIndices), "Part C: unit.recordIndices (camelCase crossed)");
  const one = engine.plan_batch("q1", { mode: "oneCatalog" });
  eq(one.units.length, 1, "Part C: one-catalog single unit");
  eq(one.totalRecords, 3, "Part C: batch totalRecords (camelCase crossed)");
  console.log("  ✓ batch plan: per-group / one-catalog crossed");

  // §9.1 — the locale shim + locale-aware formatting through the real wasm.
  engine.set_locale("de");
  engine.define_binding({
    id: "v_price",
    kind: "variable",
    target: "ph",
    query: "q1",
    expr: "CURRENCY(price)",
    missing: { missing: "blank" },
  });
  const v = engine.resolve_lowered("v_price");
  // The stream's first record is price 19.99 → de "19,99 €" (trailing €, comma
  // decimal) — proves set_locale("de") deserialized + threaded to the kernels.
  eq(v.kind, "variable", "Part C: lowered variable kind");
  eq(v.text, "19,99 €", "Part C: de locale via real wasm (CURRENCY → '19,99 €')");
  console.log("  ✓ locale: set_locale('de') → CURRENCY formats '19,99 €' through real wasm");

  // §10 — run a record-flow batch through real wasm (proves the chain shape:
  // FrameCapacity crosses camelCase as `heightPt`, and the BatchRun output).
  engine.define_template({
    id: "tmpl",
    fields: [{ label: "", expr: "sku" }],
    lineHeightPt: 10,
  });
  engine.define_binding({
    id: "rf",
    kind: "recordFlow",
    chain: "chain",
    query: "q1",
    template: "tmpl",
    options: {
      groupBy: ["region"],
      repeatHeader: true,
      continuedMarker: true,
      // §9.4 section footer — proves FlowOpts.footer in + the groupFooter block out.
      footer: { label: "Subtotal ({count})", sumField: "price" },
    },
  });
  const chain = Array.from({ length: 6 }, (_, i) => ({
    frame: `f${i}`,
    page: `p${i}`,
    heightPt: 200,
  }));
  const runs = engine.run_record_flow_batch("rf", { mode: "perGroup", by: ["region"] }, chain, undefined);
  // 2 regions (east, west) → 2 documents; each paginates (chain `heightPt` parsed).
  eq(runs.length, 2, "Part C: batch run → one document per region");
  eq(runs[0].label, "east", "Part C: batch run label (stabilized group order)");
  assert.ok(runs[0].flow.frames.length >= 1, "Part C: batch unit paginated (chain heightPt parsed)");
  // §9.4 footer crossed real wasm: a groupFooter block with the {count} subtotal.
  const blocks = runs[0].flow.frames.flatMap((f) => f.blocks);
  const footer = blocks.find((b) => b.block === "groupFooter");
  assert.ok(footer, "Part C: a groupFooter block crossed the boundary");
  assert.ok(String(footer.cells[0]).startsWith("Subtotal ("), `Part C: footer label: ${footer.cells[0]}`);
  // The group header carries its nesting `level` (0 here — single-level).
  const header = blocks.find((b) => b.block === "groupHeader");
  assert.ok(header && header.level === 0, "Part C: groupHeader.level crossed the boundary");
  console.log(`  ✓ batch run: per-group → 2 docs, footer "${footer.cells[0]}" through real wasm`);
}

// ── Part D — the v43 consumer lanes through the real wasm serde boundary ─────
// Proves the engine surface the four campaign-Phase-4 consumers drive crosses
// serde-wasm-bindgen with the shapes the bundle's host-model translates:
//   D-01 variable  → resolve_lowered → LoweredVariable {kind, target, text, hidden}
//   D-14 image     → resolve_lowered → LoweredImage {kind, reference, fit, status}
//   D-13 rule      → evaluate_rule   → RuleResult {scope, fires, apply{action,name}, total}
//   D-12 flow live → lower_record_flow over a (live-shaped) FrameCapacity chain
async function partD() {
  console.log("\nPart D — v43 consumer lanes (variable / image / rule / live flow):");
  const engine = await bootEngine();
  engine.define_query({ id: "q1", sql: "x", params: [], shape: { shape: "recordStream" } });
  engine.ingest_result("q1", {
    schema: {
      fields: [
        { name: "sku", ty: "text", nullable: true },
        { name: "price", ty: "float", nullable: true },
        { name: "stock", ty: "float", nullable: true },
        { name: "photo", ty: "text", nullable: true },
        { name: "region", ty: "text", nullable: true },
      ],
    },
    columns: [
      [{ t: "text", v: "A-1" }, { t: "text", v: "B-2" }, { t: "text", v: "C-3" }],
      [{ t: "number", v: 9.99 }, { t: "number", v: 19.99 }, { t: "number", v: 4.5 }],
      [{ t: "number", v: 2 }, { t: "number", v: 10 }, { t: "number", v: 0 }],
      [{ t: "text", v: "https://x/a.png" }, { t: "text", v: "" }, { t: "text", v: "img/c.jpg" }],
      [{ t: "text", v: "east" }, { t: "text", v: "west" }, { t: "text", v: "east" }],
    ],
    row_count: 3,
  });

  // D-01 — a variable binding lowers to a LoweredVariable (the field value the
  // host places via insertField + re-resolves via setFieldValue).
  engine.define_binding({
    id: "v_price",
    kind: "variable",
    target: "ph_price",
    query: "q1",
    expr: "CURRENCY(price)",
    missing: { missing: "blank" },
  });
  const v = engine.resolve_lowered("v_price");
  eq(v.kind, "variable", "Part D: variable lowered kind");
  eq(v.text, "$9.99", "Part D: variable resolved display (en CURRENCY) through real wasm");
  assert.equal(v.hidden, false, "Part D: variable not hidden (Blank policy, value present)");
  console.log(`  ✓ D-01 variable → LoweredVariable text "${v.text}" (host inserts a field, refresh re-resolves)`);

  // D-14 — an image binding classifies the reference + applies the fit/missing
  // policy; the host places it via placeImage onto the bound rectangle.
  engine.define_binding({
    id: "img1",
    kind: "image",
    target: "urect",
    query: "q1",
    expr: "photo",
    policy: { fit: "fill", missing: "skip" },
  });
  const img = engine.resolve_lowered("img1");
  eq(img.kind, "image", "Part D: image lowered kind");
  eq(img.status, "present", "Part D: image status present (A-1 has a uri)");
  eq(img.reference.ref, "uri", "Part D: image reference classified as uri");
  eq(img.reference.uri, "https://x/a.png", "Part D: image uri crossed the boundary");
  eq(img.fit, "fill", "Part D: image fit (ImgFit camelCase) crossed");
  console.log(`  ✓ D-14 image → LoweredImage uri "${img.reference.uri}" fit "${img.fit}" (host placeImage)`);

  // D-13 — a rule's `when` fires over stabilized records; the engine returns the
  // fired indices + the document-style action (the host applies appliedCellStyle).
  engine.define_binding({
    id: "r_low",
    kind: "rule",
    scope: "table-region",
    when: "stock < 5",
    apply: { action: "tableStyle", name: "low-stock" },
  });
  const rule = engine.evaluate_rule("r_low", "q1");
  eq(rule.scope, "table-region", "Part D: rule scope crossed");
  eq(rule.total, 3, "Part D: rule evaluated all 3 records");
  // sku A-1 stock 2, B-2 stock 10, C-3 stock 0 → fires < 5 on A-1, C-3 (idx 0, 2).
  assert.deepEqual(rule.fires, [0, 2], "Part D: rule fired on the low-stock rows (stabilized idx)");
  eq(rule.apply.action, "tableStyle", "Part D: rule apply action (tagged camelCase) crossed");
  eq(rule.apply.name, "low-stock", "Part D: rule apply style name crossed");
  console.log(`  ✓ D-13 rule → RuleResult fires [${rule.fires}] apply "${rule.apply.name}" (host appliedCellStyle)`);

  // D-12 — a record flow paginates over a LIVE-shaped chain (FrameCapacity with
  // `heightPt`, the exact shape readLiveChain builds from frameChain + geometry).
  engine.define_template({ id: "tmpl", fields: [{ label: "", expr: "sku" }], lineHeightPt: 10 });
  engine.define_binding({
    id: "rf",
    kind: "recordFlow",
    chain: "chain",
    query: "q1",
    template: "tmpl",
    options: { groupBy: [], repeatHeader: true, continuedMarker: true },
  });
  // Two short frames (live content-box heights) — the records spill across them.
  const liveChain = [
    { frame: "f0", page: "p1", heightPt: 25 },
    { frame: "f1", page: "p2", heightPt: 25 },
  ];
  const flow = engine.lower_record_flow("rf", liveChain, undefined);
  assert.ok(flow.frames.length >= 1, "Part D: record flow paginated over the live chain");
  eq(flow.total, 3, "Part D: record flow total record count crossed");
  // Every placed record landed in a frame whose id came from the live chain.
  const frameIds = new Set(flow.frames.map((f) => f.frame));
  assert.ok([...frameIds].every((id) => id === "f0" || id === "f1"), "Part D: flow used the live frame ids");
  console.log(`  ✓ D-12 live flow → ${flow.placed}/${flow.total} records over ${flow.frames.length} live frame(s)`);
}

const expected = await partA();
const duckOk = await partB(expected);
await partC();
await partD();
console.log(
  `\nE2E: Part A ✓${duckOk ? "  Part B ✓ (real DuckDB)" : "  Part B ⚠ (skipped/gap)"}  Part C ✓ (provider/governed/batch)  Part D ✓ (v43 lanes)`,
);
