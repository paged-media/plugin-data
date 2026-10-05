#!/usr/bin/env node
// Re-bundle DuckDB-WASM's browser API entry (`duckdb-browser.mjs`) into ONE
// self-contained ES module, with its single bare import (`apache-arrow`)
// inlined. Called by scripts/vendor-duckdb.sh; not a build step of its own.
//
// Why: the shipped file is loaded by a runtime-relative dynamic import from the
// bundle's `bin/` (src/query/duckdb.ts). A browser cannot resolve a bare
// specifier in a file served as-is, so without this every host would need an
// import map or a dev-server rewrite. Inlined, a static host serves it like the
// wasm next to it.
//
// esbuild comes from tsup (a root devDependency); apache-arrow from the
// bundle's own node_modules. Both exist after `pnpm install`.
//
// usage: node scripts/bundle-duckdb-api.mjs <in.mjs> <out.mjs>
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = resolve(ROOT, "packages/data-bundle");
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: bundle-duckdb-api.mjs <in.mjs> <out.mjs>");
  process.exit(2);
}

const rootRequire = createRequire(resolve(ROOT, "package.json"));
let esbuild;
try {
  esbuild = createRequire(rootRequire.resolve("tsup"))("esbuild");
} catch (err) {
  console.error(`bundle-duckdb-api: esbuild (via tsup) not found — run \`pnpm install\` first (${err.message})`);
  process.exit(1);
}
try {
  createRequire(resolve(BUNDLE, "package.json")).resolve("apache-arrow");
} catch {
  console.error("bundle-duckdb-api: apache-arrow not installed in packages/data-bundle — run `pnpm install` first");
  process.exit(1);
}

await esbuild.build({
  entryPoints: [resolve(input)],
  outfile: resolve(output),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  minify: true,
  legalComments: "inline",
  // Resolve apache-arrow from the bundle's node_modules, not from vendor/.
  nodePaths: [resolve(BUNDLE, "node_modules")],
  logLevel: "warning",
});
console.log(`bundle-duckdb-api: ${output} (apache-arrow inlined)`);
