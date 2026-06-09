#!/usr/bin/env node
// The contract-only import lint (spec §2.1): every import in this repo's TS
// source must come through the sanctioned plugin surface. Until Decision B
// publishes the packages, this lint IS the "no private backdoors" guarantee.
// paged.data's panels are React (the declared v0 exception for panel
// components), so `react` is allowed here — @paged-media/shell, /client, /ui,
// /catalog remain forbidden, and so does any OTHER plugin's package (the §2.1
// inter-plugin ban: no plugin-image / plugin-sheet imports, ever).
//
// The vendored MIT DuckDB-WASM engine is allowed (it is the query engine, spec
// §6; vendored as a prebuilt artifact, not a sibling plugin). NOTE the second
// guarantee this repo adds (CLAUDE.md hard rule): the TS side is thin glue —
// ALL binding/expression/sync/lowering semantics live in the Rust crates. That
// rule is enforced by review, not by this lint.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

const ROOT = new URL("..", import.meta.url).pathname;

const ALLOWED_PREFIXES = [
  "@paged-media/plugin-api",
  "@paged-media/plugin-sdk",
  "@paged-media/data-", // this repo's own packages
  "@duckdb/duckdb-wasm", // the vendored MIT query engine (spec §6)
  "apache-arrow", // the Arrow interchange substrate (ships with duckdb-wasm)
  "react", // panels are React expert leaves (v0 exception)
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(spec|test)\./.test(name)) {
      out.push(path);
    }
  }
  return out;
}

const IMPORT = /(?:^|\n)\s*(?:import|export)[^"'`;]*?from\s*["']([^"']+)["']/g;

const violations = [];
for (const file of walk(join(ROOT, "packages"))) {
  if (!file.includes("/src/")) continue;
  const text = readFileSync(file, "utf8");
  IMPORT.lastIndex = 0;
  let m;
  while ((m = IMPORT.exec(text)) !== null) {
    const spec = m[1];
    if (spec.startsWith(".") || spec.startsWith("..")) continue;
    if (ALLOWED_PREFIXES.some((p) => spec.startsWith(p))) continue;
    violations.push(`${relative(ROOT, file)} → "${spec}"`);
  }
}

if (violations.length > 0) {
  console.error(
    "contract-import lint: imports outside the plugin surface " +
      "(disposition each: promote to plugin-api / use an existing " +
      "capability / record in BREAKAGE_LOG.md):",
  );
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log("contract-import lint: clean (plugin surface only)");
