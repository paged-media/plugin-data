// Recorder for canary10-payload.json: the session payload the PUBLISHED
// @paged-media/data@0.1.0-canary.10 engine writes (every binding kind that
// existed then, plus a captured data set). Re-record (local only):
//   mkdir c10 && cd c10 && curl -fsSL $(npm view @paged-media/data@0.1.0-canary.10 dist.tarball) | tar xz
//   cp <this file> gen.mjs && node gen.mjs > canary10-payload.json
// The migration test (data-conformance/tests/property.rs) loads it into
// today's engine: ADR 558's additive rule.
import { readFileSync } from "node:fs";
import init, { DataEngine } from "./package/bin/data_js.js";
await init({ module_or_path: readFileSync("./package/bin/data_js_bg.wasm") });
const e = new DataEngine(20000);
e.define_source({ id: "products", kind: { kind: "file", format: "csv", name: "products.csv" }, capability: "fs.read" });
e.define_query({ id: "q", sql: "SELECT * FROM products", params: [], shape: { shape: "recordStream" } });
e.define_binding({ id: "v_name", kind: "variable", target: "v_name", query: "q", expr: "name" });
e.define_binding({ id: "img", kind: "image", target: "u1a2", query: "q", expr: "photo", policy: { fit: "fill", missing: "skip" } });
e.define_binding({ id: "badge", kind: "visibility", target: "u1b3", query: "q", expr: "in_stock", options: { invert: true, missing: "leave" } });
e.define_binding({ id: "sale", kind: "rule", scope: "story:u9", when: "price > 10", apply: { action: "paragraphStyle", name: "Sale" } });
e.define_binding({ id: "ean", kind: "barcode", target: "u1c4", query: "q", symbology: "ean13", expr: "ean", options: { quiet_zone: 2, missing: "flag" } });
e.define_binding({ id: "tbl", kind: "table", region: "u1d5", query: "q", columns: [{ header: "Name", expr: "name" }], options: { header_row: true, group_by: [] } });
e.ingest_result("q", { schema: { fields: [{ name: "name", ty: "text" }, { name: "photo", ty: "text" }, { name: "in_stock", ty: "text" }, { name: "price", ty: "float" }, { name: "ean", ty: "text" }] }, columns: [[{t:"text",v:"Alpha"}],[{t:"text",v:"a.png"}],[{t:"text",v:"true"}],[{t:"number",v:12}],[{t:"text",v:"4006381333931"}]], row_count: 1 });
try { e.capture_data_set("Set A", 0); } catch (err) { console.error("capture", String(err)); }
console.log(JSON.stringify(e.payload(), null, 2));
