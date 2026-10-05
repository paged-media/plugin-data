/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// The DuckDB-WASM integration (spec §6) — the MIT query/ingest engine. It
// registers inline/file sources, runs SQL, and materialises the Arrow result
// into the `RecordSetJson` the engine ingests (the swappable Arrow seam, §6.1).
//
// WHAT RUNS: the governed artifact set in the bundle's own `bin/`, staged by
// scripts/vendor-duckdb.sh and shipped in the npm tarball ("files": bin):
//
//   bin/duckdb-engine.wasm           the manifest's `duckdb-engine` artifact,
//                                    `purpose: "engine"`, maxBytes 48 MiB;
//                                    the EH variant (exceptions, no threads)
//   bin/duckdb-browser-eh.worker.js  the worker that instantiates it
//   bin/duckdb-browser.mjs           the JS API, apache-arrow inlined
//
// Exactly one variant ships: mvp (40.6 MB) is over the cap and coi needs
// threads plus cross-origin isolation. Nothing here reads vendor/ any more;
// vendor/ is the local fetch cache and the Node test lane's source.
//
// WHY NOT `loadBundleWasm`: the plugin-sdk loader instantiates a module with
// only the imports the caller passes and no worker. DuckDB is an Emscripten
// module that its own worker instantiates with its own imports, so the bundle
// resolves the file URL (src/bin-url.ts, the same mechanism as
// `../bin/data_js.js`) and hands it to DuckDB's worker. The manifest
// declaration stays the governance anchor: the plugin-cli size gate and
// scripts/pubcheck.mjs check the shipped file against its maxBytes.
//
// Absent (not staged, or the host does not serve bin/) → DUCKDB_NOT_VENDORED,
// which the sources panel shows as "duckdb-missing" — never faked.

import { binUrl } from "../bin-url";
import { arrowToRecordSet, type ArrowLikeTable, type RecordSetJson } from "./recordset";

export const DUCKDB_NOT_VENDORED =
  "DuckDB-WASM not available — run `bash scripts/vendor-duckdb.sh` (stages packages/data-bundle/bin/duckdb-engine.wasm), and make sure the host serves the bundle's bin/";

/** The shipped DuckDB files, by role, relative to the bundle's `bin/`. */
export const DUCKDB_ARTIFACTS = {
  module: "duckdb-engine.wasm",
  worker: "duckdb-browser-eh.worker.js",
  api: "duckdb-browser.mjs",
} as const;

/** A booted DuckDB session over the vendored engine. */
export interface DuckDBHandle {
  /** Register an inline CSV text as a named table (the InlineSeed / pasted path). */
  registerCsv(name: string, csvText: string): Promise<void>;
  /** Register imported file bytes under a virtual name (the file-import path). */
  registerFileBuffer(name: string, bytes: Uint8Array): Promise<void>;
  /** Run SQL and materialise the Arrow result as a RecordSet. */
  query(sql: string): Promise<RecordSetJson>;
  /** Tear the session + worker down. */
  close(): Promise<void>;
}

/** The DuckDB database surface the handle drives. Both the browser
 *  `AsyncDuckDB` (promises) and the Node blocking build (plain values) fit:
 *  every call is awaited, so the real-DuckDB test lane runs the SAME handle
 *  code as the editor. */
export interface DuckDBLike {
  registerFileText(name: string, text: string): unknown;
  registerFileBuffer(name: string, bytes: Uint8Array): unknown;
}
export interface DuckDBConnectionLike {
  insertCSVFromPath(path: string, opts: { name: string; schema: string; detect: boolean }): unknown;
  query(sql: string): unknown;
  close(): unknown;
}

/** Wrap a connected DuckDB (browser or Node) as the bundle's [`DuckDBHandle`]. */
export function duckdbHandle(
  db: DuckDBLike,
  conn: DuckDBConnectionLike,
  teardown: () => Promise<void> | void,
): DuckDBHandle {
  return {
    async registerCsv(name: string, csvText: string) {
      await db.registerFileText(`${name}.csv`, csvText);
      await conn.insertCSVFromPath(`${name}.csv`, { name, schema: "main", detect: true });
    },
    async registerFileBuffer(name: string, bytes: Uint8Array) {
      await db.registerFileBuffer(name, bytes);
    },
    async query(sql: string): Promise<RecordSetJson> {
      const table = (await conn.query(sql)) as ArrowLikeTable;
      return arrowToRecordSet(table);
    },
    async close() {
      await conn.close();
      await teardown();
    },
  };
}

/** Boot DuckDB-WASM from the bundle's `bin/`. Throws [`DUCKDB_NOT_VENDORED`]
 *  when the artifact is absent (the panel renders that honestly). */
export async function bootDuckDB(): Promise<DuckDBHandle> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let duckdb: any = null;
  try {
    duckdb = await import(/* @vite-ignore */ binUrl(DUCKDB_ARTIFACTS.api));
  } catch {
    throw new Error(DUCKDB_NOT_VENDORED);
  }
  if (!duckdb) throw new Error(DUCKDB_NOT_VENDORED);

  // Spawn the worker from the bundle's own bin/, same-origin. NOT
  // getJsDelivrBundles(): a Worker on a cross-origin URL is a SecurityError,
  // and the plugin never fetches its engine from a CDN (BREAKAGE D-05).
  const worker = new Worker(binUrl(DUCKDB_ARTIFACTS.worker));
  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  try {
    await db.instantiate(binUrl(DUCKDB_ARTIFACTS.module));
  } catch (err) {
    worker.terminate();
    throw new Error(
      `${DUCKDB_NOT_VENDORED} (instantiate failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const conn = await db.connect();
  return duckdbHandle(db, conn, async () => {
    await db.terminate();
    worker.terminate();
  });
}
