// The REAL DuckDB lane: boots DuckDB-WASM in Node over the SHIPPED engine
// (bin/duckdb-engine.wasm — the manifest's `duckdb-engine` artifact), ingests a
// CSV through the bundle's own handle code (duckdbHandle in src/query/duckdb.ts),
// converts the Arrow result with src/query/recordset.ts, and feeds the REAL
// data-js wasm engine. This is pipeline Part B, and the one place the whole
// CSV → DuckDB → Arrow → RecordSet → engine → lowered seam runs for real.
//
// In Node the browser worker cannot run, so the lane uses DuckDB's Node
// blocking build (vendor/duckdb-wasm/dist/duckdb-node-blocking.cjs, never
// shipped) to drive the same EH wasm the browser worker instantiates.
//
// GATE: skips when DuckDB cannot boot here, EXCEPT under REQUIRE_REAL_DUCKDB=1
// (CI runs scripts/vendor-duckdb.sh first and sets it), where "cannot boot"
// is a FAILURE that names the reason. The same flag also requires the data-js
// engine, since the lane feeds it.
import Module, { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { binUrl } from "../src/bin-url";
import { DUCKDB_ARTIFACTS, duckdbHandle, type DuckDBHandle } from "../src/query/duckdb";
import { assertLowered, bootEngine, defineCatalog, partA } from "./pipeline-parts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const BIN = join(PKG, "bin");
const ENGINE_WASM = join(BIN, DUCKDB_ARTIFACTS.module);
const NODE_API = join(PKG, "..", "..", "vendor", "duckdb-wasm", "dist", "duckdb-node-blocking.cjs");
const DATA_JS_WASM = join(BIN, "data_js_bg.wasm");
const REQUIRE = process.env.REQUIRE_REAL_DUCKDB === "1";

const CSV = "sku,price\nB-2,19.99\nA-1,9.99\n";

/** Load the Node build. Its one external import, apache-arrow, must resolve
 *  from this package's node_modules (vendor/ has none), so NODE_PATH is
 *  widened for the duration of the synchronous require. */
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

/** Boot real DuckDB over the shipped EH engine; never throws — returns why not. */
async function tryBoot(): Promise<{ handle?: DuckDBHandle; error?: string }> {
  if (!existsSync(ENGINE_WASM))
    return { error: `${ENGINE_WASM} is missing — run \`bash scripts/vendor-duckdb.sh\`` };
  if (!existsSync(NODE_API))
    return { error: `${NODE_API} is missing — run \`bash scripts/vendor-duckdb.sh\`` };
  try {
    const duckdb = requireNodeDuckDB();
    // Only the shipped EH module is offered. The mvp slot is a path that does
    // not exist, so if DuckDB ever picked mvp the boot fails loudly instead of
    // silently testing a variant that does not ship.
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

const boot = await tryBoot();
const engineBuilt = existsSync(DATA_JS_WASM);

if (REQUIRE) {
  describe("real DuckDB — REQUIRED (REQUIRE_REAL_DUCKDB=1) [data.query.seam]", () => {
    it("DuckDB boots over the shipped bin/duckdb-engine.wasm", () => {
      expect(boot.error, boot.error).toBeUndefined();
    });
    it("the data-js engine the lane feeds is built", () => {
      expect(engineBuilt, `${DATA_JS_WASM} missing — run \`bash scripts/build-wasm.sh\``).toBe(true);
    });
  });
}

describe("shipped DuckDB artifact set [data.query.seam]", () => {
  it("resolves every artifact inside the bundle's bin/, never vendor/", () => {
    for (const file of Object.values(DUCKDB_ARTIFACTS)) {
      const url = binUrl(file);
      expect(fileURLToPath(url)).toBe(join(BIN, file));
      expect(url).not.toContain("vendor");
    }
  });

  it.skipIf(!existsSync(ENGINE_WASM) && !REQUIRE)(
    "is staged: engine within the manifest cap, worker present, JS API self-contained",
    () => {
      const manifest = JSON.parse(readFileSync(join(PKG, "manifest.json"), "utf8"));
      const decl = manifest.capabilities.wasm.find((w: { name: string }) => w.name === "duckdb-engine");
      expect(decl.path).toBe(`bin/${DUCKDB_ARTIFACTS.module}`);
      expect(decl.purpose).toBe("engine");
      expect(statSync(ENGINE_WASM).size).toBeLessThanOrEqual(decl.maxBytes);
      expect(existsSync(join(BIN, DUCKDB_ARTIFACTS.worker))).toBe(true);
      // A host serves the API file as-is: no bare specifier may be left in it.
      const api = readFileSync(join(BIN, DUCKDB_ARTIFACTS.api), "utf8");
      expect(api).not.toMatch(/\b(?:from|import)\s*["'](?![./])[^"']+["']/);
    },
  );
});

describe.skipIf(!boot.handle || !engineBuilt)("real DuckDB → recordset.ts → data-js engine [data.query.seam]", () => {
  it("registers a CSV, runs a SELECT, and the engine lowers it like the hand-built RecordSet", async () => {
    const duck = boot.handle!;
    // The bundle's real import path: registerCsv → insertCSVFromPath (detect).
    await duck.registerCsv("products", CSV);
    const records = await duck.query("SELECT sku, price FROM products ORDER BY sku");

    // recordset.ts classified DuckDB's types: VARCHAR → text, DOUBLE → float.
    expect(records.row_count).toBe(2);
    expect(records.schema.fields.map((f) => [f.name, f.ty])).toEqual([
      ["sku", "text"],
      ["price", "float"],
    ]);

    const engine = await bootEngine();
    defineCatalog(engine);
    engine.ingest_result("q1", records);
    const lowered = assertLowered(engine.resolve_lowered("t1"), "DuckDB");
    // Parity with Part A: the same recipe over a hand-built RecordSet.
    const expected = await partA();
    expect(lowered.text).toBe(expected.text);
  });

  it("queries registered file bytes (the file-import path)", async () => {
    const duck = boot.handle!;
    await duck.registerFileBuffer("stock.csv", new TextEncoder().encode("sku,qty\nA-1,3\nB-2,0\n"));
    const rs = await duck.query("SELECT sku, qty FROM read_csv_auto('stock.csv') WHERE qty > 0");
    expect(rs.row_count).toBe(1);
    expect(rs.columns[0][0]).toEqual({ t: "text", v: "A-1" });
    expect(rs.schema.fields[1].ty).toBe("int");
  });
});
