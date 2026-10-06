#!/usr/bin/env node
// pubcheck — assert the @paged-media/data tarball ships what the runtime loads.
//
// Packs packages/data-bundle with `npm pack --dry-run --json` (the same "files"
// resolution `pnpm publish` uses, no scripts run) and fails unless the tarball
// holds:
//   - dist/index.js and manifest.json;
//   - the data-js engine (bin/data_js.js + bin/data_js_bg.wasm);
//   - the DuckDB engine set src/query/duckdb.ts loads: bin/duckdb-engine.wasm,
//     bin/duckdb-browser-eh.worker.js, bin/duckdb-browser.mjs;
//   - DuckDB's json + parquet extensions under bin/duckdb-ext/ (the eh build
//     has neither built in; bootDuckDB points DuckDB's extension repository
//     there, so a missing one is a trap under the editor's CSP);
//   - exactly ONE DuckDB engine wasm, no undeclared wasm, and every declared
//     wasm within its manifest maxBytes;
//   - no vendor/ file and no other DuckDB variant (mvp/coi);
//   - the bin/SOURCE_HASH stamp, and with --release also bin/PACKAGE_HASH.
//
// Run it after `pnpm run build`, `bash scripts/build-wasm.sh` and
// `bash scripts/vendor-duckdb.sh` — `pnpm --filter @paged-media/data pubcheck`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = resolve(ROOT, "packages/data-bundle");
const manifest = JSON.parse(readFileSync(resolve(PKG, "manifest.json"), "utf8"));
const wasmDecl = Object.fromEntries(manifest.capabilities.wasm.map((w) => [w.path, w]));

const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: PKG,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const [pack] = JSON.parse(out);
const files = new Map(pack.files.map((f) => [f.path, f.size]));

const errors = [];
const need = (path, why) => {
  if (!files.has(path)) errors.push(`missing ${path} (${why})`);
};
need("dist/index.js", "the bundle — run `pnpm run build`");
need("manifest.json", "the plugin manifest");
need("bin/data_js.js", "data-js glue — run `bash scripts/build-wasm.sh`");
need("bin/data_js_bg.wasm", "data-js engine — run `bash scripts/build-wasm.sh`");
need("bin/duckdb-engine.wasm", "DuckDB engine — run `bash scripts/vendor-duckdb.sh`");
need("bin/duckdb-browser-eh.worker.js", "DuckDB worker — run `bash scripts/vendor-duckdb.sh`");
need("bin/duckdb-browser.mjs", "DuckDB JS API — run `bash scripts/vendor-duckdb.sh`");
for (const name of ["json", "parquet"]) {
  const w = manifest.capabilities.wasm.find((a) => a.name === `duckdb-ext-${name}`);
  if (!w) errors.push(`the manifest declares no duckdb-ext-${name} artifact`);
  else need(w.path, `DuckDB ${name} extension — run \`bash scripts/vendor-duckdb.sh\``);
}
need("bin/SOURCE_HASH", "wasm freshness stamp — run `bash scripts/build-wasm.sh`");
if (process.argv.includes("--release")) need("bin/PACKAGE_HASH", "bump-check stamp — run `node scripts/package-hash.mjs --stamp`");

const duckWasm = [...files.keys()].filter((p) => /^bin\/duckdb[^/]*\.wasm$/.test(p));
if (duckWasm.length !== 1) errors.push(`expected exactly one DuckDB engine wasm, found ${duckWasm.length}: ${duckWasm.join(", ")}`);
for (const p of files.keys())
  if (p.endsWith(".wasm") && !wasmDecl[p]) errors.push(`undeclared wasm in tarball: ${p}`);
for (const p of files.keys()) {
  if (p.startsWith("vendor/") || p.includes("/vendor/")) errors.push(`vendor file in tarball: ${p}`);
  if (/duckdb-(mvp|coi)|duckdb-node/.test(p)) errors.push(`unshipped DuckDB variant in tarball: ${p}`);
}
for (const [path, decl] of Object.entries(wasmDecl)) {
  const size = files.get(path);
  if (size === undefined) continue; // reported above when required
  if (typeof decl.maxBytes === "number" && size > decl.maxBytes)
    errors.push(`${path} is ${size} bytes, over its manifest maxBytes ${decl.maxBytes}`);
}

const mb = (n) => `${(n / 1048576).toFixed(2)} MiB`;
console.log(`pubcheck: ${pack.name}@${pack.version} — ${pack.entryCount} files, packed ${mb(pack.size)}, unpacked ${mb(pack.unpackedSize)}`);
for (const p of [...files.keys()].filter((p) => p.startsWith("bin/")).sort()) {
  const cap = wasmDecl[p]?.maxBytes;
  console.log(`  ${String(files.get(p)).padStart(10)}  ${p}${cap ? `  (cap ${cap})` : ""}`);
}
if (errors.length) {
  for (const e of errors) console.error(`pubcheck: FAIL — ${e}`);
  process.exit(1);
}
console.log("pubcheck: OK");
