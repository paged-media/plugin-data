// Shared boot for specs that need REAL DuckDB in Node: DuckDB's Node blocking
// build (vendor/duckdb-wasm/dist/duckdb-node-blocking.cjs, never shipped)
// driving the SHIPPED engine (bin/duckdb-engine.wasm), wrapped by the bundle's
// own handle code (duckdbHandle). The same lane duckdb-real.spec.ts proves;
// this file only makes it reusable. Never throws — returns why not.

import Module, { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DUCKDB_ARTIFACTS, duckdbHandle, type DuckDBHandle } from "../src/query/duckdb";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
export const BIN = join(PKG, "bin");
const ENGINE_WASM = join(BIN, DUCKDB_ARTIFACTS.module);
const NODE_API = join(PKG, "..", "..", "vendor", "duckdb-wasm", "dist", "duckdb-node-blocking.cjs");
export const DATA_JS_WASM = join(BIN, "data_js_bg.wasm");
export const REQUIRE_REAL_DUCKDB = process.env.REQUIRE_REAL_DUCKDB === "1";

function requireNodeDuckDB(): any {
  const prev = process.env.NODE_PATH;
  process.env.NODE_PATH = [join(PKG, "node_modules"), prev].filter(Boolean).join(delimiter);
  (Module as unknown as { _initPaths(): void })._initPaths();
  try {
    return createRequire(import.meta.url)(NODE_API);
  } finally {
    if (prev === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = prev;
    (Module as unknown as { _initPaths(): void })._initPaths();
  }
}

/** Boot one real DuckDB over the shipped EH engine. */
export async function bootRealDuckDB(): Promise<{ handle?: DuckDBHandle; error?: string }> {
  if (!existsSync(ENGINE_WASM))
    return { error: `${ENGINE_WASM} is missing — run scripts/vendor-duckdb.sh` };
  if (!existsSync(NODE_API))
    return { error: `${NODE_API} is missing — run scripts/vendor-duckdb.sh` };
  try {
    const duckdb = requireNodeDuckDB();
    const db = await duckdb.createDuckDB(
      {
        mvp: { mainModule: join(BIN, "duckdb-mvp.NOT-SHIPPED.wasm"), mainWorker: "" },
        eh: { mainModule: ENGINE_WASM, mainWorker: "" },
      },
      new duckdb.VoidLogger(),
      duckdb.NODE_RUNTIME,
    );
    await db.instantiate();
    const conn = db.connect();
    return { handle: duckdbHandle(db, conn, () => db.reset?.()) };
  } catch (err) {
    return { error: `DuckDB failed to boot: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Boot the REAL data-js engine in Node (the bundle's glue fetches the wasm by
 *  URL, which Node cannot; hand it the bytes instead). */
export async function bootRealEngine(today: number): Promise<any> {
  const mod = await import(join(BIN, "data_js.js"));
  await mod.default({ module_or_path: readFileSync(DATA_JS_WASM) });
  return new mod.DataEngine(today);
}
