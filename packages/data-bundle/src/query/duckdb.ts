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

// The DuckDB-WASM integration (spec §6) — the MIT query/ingest engine, vendored
// under vendor/duckdb-wasm/ (scripts/vendor-duckdb.sh) and instantiated in the
// bundle realm (BREAKAGE D-05/D-07: no host worker capability yet; the bundle
// spawns the DuckDB worker from the vendored bundle). It registers inline/file
// sources, runs parameterised SQL, and materialises the Arrow result into the
// `RecordSetJson` the engine ingests (the swappable Arrow seam, §6.1).
//
// Loaded dynamically from the VENDORED dist (not an npm dependency — the engine
// is a prebuilt artifact, spec §3/§4). Absent until vendored → DUCKDB_NOT_VENDORED.
//
// FIRST-CLASS engine load (D-07b / D-11): the manifest declares DuckDB as a
// `purpose: "engine"` wasm artifact (bin/duckdb-engine.wasm, staged by
// scripts/vendor-duckdb.sh), so it earns the governed 64 MiB per-artifact
// ceiling — NOT the 8 MiB compute/codec cap. That declaration is the GOVERNANCE
// anchor (the plugin-cli size-gate verifies it; data-conformance asserts the
// purpose); the runtime still selects the optimal coi/eh/mvp variant from the
// vendored dist below at boot.

import { arrowToRecordSet, type ArrowLikeTable, type RecordSetJson } from "./recordset";

export const DUCKDB_NOT_VENDORED =
  "DuckDB-WASM not vendored — run `bash scripts/vendor-duckdb.sh` (populates vendor/duckdb-wasm/dist)";

// Computed specifiers so the type-checker does not resolve the (vendored)
// dist; loaded at runtime in the bundle realm.
const DUCKDB_DIST = "../../../../vendor/duckdb-wasm/dist/duckdb-browser.mjs";

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

/** Boot DuckDB-WASM from the vendored dist. Throws [`DUCKDB_NOT_VENDORED`] when
 *  the artifact is absent (the panel renders that honestly). */
export async function bootDuckDB(): Promise<DuckDBHandle> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let duckdb: any = null;
  try {
    duckdb = await import(/* @vite-ignore */ DUCKDB_DIST);
  } catch {
    throw new Error(DUCKDB_NOT_VENDORED);
  }
  if (!duckdb) throw new Error(DUCKDB_NOT_VENDORED);

  // Pick a bundle + spawn the worker from the VENDORED files, same-origin
  // (own-realm; the editor is already cross-origin isolated — BREAKAGE D-05).
  // NOT getJsDelivrBundles() — that points mainWorker at the jsDelivr CDN, and
  // `new Worker(<cross-origin URL>)` is a SecurityError. The dist sits next to
  // this module's `../../../../vendor/duckdb-wasm/dist/` import, so resolve the
  // worker/wasm URLs relative to it; the bundle realm serves them same-origin.
  const distBase = new URL("../../../../vendor/duckdb-wasm/dist/", import.meta.url);
  const at = (file: string) => new URL(file, distBase).href;
  const vendored = {
    mvp: {
      mainModule: at("duckdb-mvp.wasm"),
      mainWorker: at("duckdb-browser-mvp.worker.js"),
    },
    eh: {
      mainModule: at("duckdb-eh.wasm"),
      mainWorker: at("duckdb-browser-eh.worker.js"),
    },
    coi: {
      mainModule: at("duckdb-coi.wasm"),
      mainWorker: at("duckdb-browser-coi.worker.js"),
      pthreadWorker: at("duckdb-browser-coi.pthread.worker.js"),
    },
  };
  const bundle = duckdb.selectBundle
    ? await duckdb.selectBundle(vendored)
    : vendored.eh;
  const worker = new Worker(bundle.mainWorker);
  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const conn = await db.connect();

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
      await db.terminate();
      worker.terminate();
    },
  };
}
