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

// The paged.data perf harness: the REAL pieces a data command touches, each
// behind a counter.
//
//   host    the real core engine (canvas-wasm via plugin-sdk's headless host,
//           test/real-core.ts) behind countingHost — door calls, mutates,
//           batch ops, fields read back, undo steps.
//   engine  the real data-js wasm (bin/data_js_bg.wasm, initSync in Node)
//           behind countingEngine — wasm calls by method, the cells and JSON
//           bytes that cross INTO it (ingest_result), the JSON bytes that come
//           back OUT of a resolve/lower, and the engine's own perfCounters()
//           (resolves, stabilize sorts, sort-key allocations, fingerprints).
//   duck    real DuckDB-WASM over the shipped bin/duckdb-engine.wasm, driven
//           through the bundle's own duckdbHandle (Node blocking build — the
//           browser worker cannot run here; same as test/duckdb-real.spec.ts)
//           behind a counter of registrations, queries and rows returned.
//
// The session under test is the bundle's own createSession, with bootEngine /
// bootDuckDB pointed at the counted real instances — nothing in src/ changes.

import Module, { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

import type { BundleHost } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import type { DataEngineLike } from "../../src/engine";
import type { DuckDBHandle } from "../../src/query/duckdb";
import type { DataSourceSession } from "../../src/session";
import manifest from "../../manifest.json";
import { ENGINE_ANCHOR, openRealHost, REQUIRE_REAL_CORE } from "../real-core";
import { type WorkLog } from "./counting-host";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..", "..");
const BIN = join(PKG, "bin");
export const DATA_JS_WASM = join(BIN, "data_js_bg.wasm");
const DUCK_WASM = join(BIN, "duckdb-engine.wasm");
const DUCK_NODE_API = join(PKG, "..", "..", "vendor", "duckdb-wasm", "dist", "duckdb-node-blocking.cjs");

export const TODAY = 20613;

/** Every piece the budgets need is here (or a REQUIRE_* flag turns its
 *  absence into a failure instead of a skip). */
export const HAVE_ENGINE = existsSync(DATA_JS_WASM);
export const HAVE_DUCK = existsSync(DUCK_WASM) && existsSync(DUCK_NODE_API);
export const HAVE_CORE = ENGINE_ANCHOR !== null;
export const REQUIRED =
  REQUIRE_REAL_CORE ||
  process.env.REQUIRE_REAL_ENGINE === "1" ||
  process.env.REQUIRE_REAL_DUCKDB === "1";
/** Run the budgets when every piece is present, or when a lane requires them
 *  (then a missing piece fails loudly inside the boot). */
export const RUN_BUDGETS = (HAVE_ENGINE && HAVE_DUCK && HAVE_CORE) || REQUIRED;

/** The per-test timeout the budget specs set. A count does not get slower on a
 *  loaded CI runner; the wall clock around it does. No budget is a duration. */
export const BUDGET_TIMEOUT_MS = 120_000;

// ── the counted data-js engine ──────────────────────────────────────────────

/** The engine's own work counters (data-js `perfCounters()`). */
export interface EngineCounters {
  enabled: boolean;
  resolves: number;
  stabilize_calls: number;
  key_allocs: number;
  fingerprints: number;
  diff_rows: number;
  ingest_cells: number;
  content_hashes: number;
  group_key_compares: number;
}

export interface EngineLog {
  /** wasm calls by method name. */
  calls: Record<string, number>;
  /** Cells handed to `ingest_result` (rows × columns): each one is a JS
   *  `{t, v}` object built from an Arrow cell, then serde-decoded in Rust. */
  cellsIn: number;
  /** JSON bytes of everything handed to `ingest_result` — the size of the
   *  serde-wasm-bindgen object graph that crosses, as text. */
  bytesIn: number;
  /** JSON bytes of every resolve/lower reply (the IR that comes back). */
  bytesOut: number;
}

export interface CountedEngine {
  engine: DataEngineLike;
  log: EngineLog;
  /** All wasm calls. */
  total(): number;
  counters(): EngineCounters;
  reset(): void;
}

const OUT_METHODS = new Set([
  "resolve_lowered",
  "resolve_lowered_at",
  "lower_barcode",
  "lower_barcode_at",
  "lower_record_flow",
  "refresh_change_report",
]);

/** Boot a FRESH data-js wasm instance (its own memory and counters) and wrap
 *  its DataEngine in a counting Proxy. */
export async function bootCountedEngine(): Promise<CountedEngine> {
  if (!HAVE_ENGINE) {
    throw new Error(`${DATA_JS_WASM} missing — run \`bash scripts/build-wasm.sh\``);
  }
  // A query string makes every boot a fresh module instance: counters and
  // memory start at zero, whatever ran before in this worker.
  const glue = await import(/* @vite-ignore */ `${join(BIN, "data_js.js")}?boot=${bootSeq++}`);
  glue.initSync({ module: readFileSync(DATA_JS_WASM) });
  const raw = new glue.DataEngine(TODAY) as DataEngineLike;
  let log: EngineLog = { calls: {}, cellsIn: 0, bytesIn: 0, bytesOut: 0 };
  const engine = new Proxy(raw as object, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver) as unknown;
      if (typeof prop !== "string" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        log.calls[prop] = (log.calls[prop] ?? 0) + 1;
        if (prop === "ingest_result") {
          const rs = args[1] as { row_count?: number; columns?: unknown[] };
          log.cellsIn += (rs?.row_count ?? 0) * (rs?.columns?.length ?? 0);
          log.bytesIn += JSON.stringify(rs).length;
        }
        const out = Reflect.apply(value, obj, args) as unknown;
        if (OUT_METHODS.has(prop) && out != null) {
          log.bytesOut += JSON.stringify(out).length;
        }
        return out;
      };
    },
  }) as DataEngineLike;
  glue.resetPerfCounters();
  return {
    engine,
    log: new Proxy({} as EngineLog, { get: (_, k) => (log as never)[k] }),
    total: () => Object.values(log.calls).reduce((n, v) => n + v, 0),
    counters: () => glue.perfCounters() as EngineCounters,
    reset: () => {
      log = { calls: {}, cellsIn: 0, bytesIn: 0, bytesOut: 0 };
      glue.resetPerfCounters();
    },
  };
}
let bootSeq = 0;

// ── the counted DuckDB ──────────────────────────────────────────────────────

export interface DuckLog {
  registerCsv: number;
  registerFileBuffer: number;
  queries: number;
  /** Rows DuckDB handed back across every query. */
  rowsOut: number;
}

export interface CountedDuck {
  handle: DuckDBHandle;
  log: DuckLog;
  reset(): void;
}

/** Load DuckDB's Node build; apache-arrow resolves from this package. */
function requireNodeDuckDB(): any {
  const prev = process.env.NODE_PATH;
  process.env.NODE_PATH = [join(PKG, "node_modules"), prev].filter(Boolean).join(delimiter);
  (Module as unknown as { _initPaths(): void })._initPaths();
  try {
    return createRequire(import.meta.url)(DUCK_NODE_API);
  } finally {
    if (prev === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = prev;
    (Module as unknown as { _initPaths(): void })._initPaths();
  }
}

/** Boot real DuckDB over the shipped EH engine through the bundle's own
 *  handle code, counted. */
export async function bootCountedDuck(): Promise<CountedDuck> {
  if (!HAVE_DUCK) {
    throw new Error(`${DUCK_WASM} or the Node API is missing — run \`bash scripts/vendor-duckdb.sh\``);
  }
  const { duckdbHandle } = await import("../../src/query/duckdb");
  const duckdb = requireNodeDuckDB();
  const db = await duckdb.createDuckDB(
    {
      mvp: { mainModule: join(BIN, "duckdb-mvp.NOT-SHIPPED.wasm"), mainWorker: "" },
      eh: { mainModule: DUCK_WASM, mainWorker: "" },
    },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  );
  await db.instantiate();
  const inner = duckdbHandle(db, db.connect(), () => db.reset?.());
  let log: DuckLog = { registerCsv: 0, registerFileBuffer: 0, queries: 0, rowsOut: 0 };
  const handle: DuckDBHandle = {
    async registerCsv(name, text) {
      log.registerCsv += 1;
      return inner.registerCsv(name, text);
    },
    async registerFileBuffer(name, bytes) {
      log.registerFileBuffer += 1;
      return inner.registerFileBuffer(name, bytes);
    },
    async query(sql) {
      log.queries += 1;
      const rs = await inner.query(sql);
      log.rowsOut += rs.row_count;
      return rs;
    },
    // Wave 6: every statement counts as a query — the guard's parse
    // (`rows`), import DDL (`exec`) and previews.
    async rows(sql) {
      log.queries += 1;
      const out = await inner.rows(sql);
      log.rowsOut += out.rows.length;
      return out;
    },
    async exec(sql) {
      log.queries += 1;
      return inner.exec(sql);
    },
    dropFile: (name) => inner.dropFile(name),
    close: () => inner.close(),
  };
  return {
    handle,
    log: new Proxy({} as DuckLog, { get: (_, k) => (log as never)[k] }),
    reset: () => {
      log = { registerCsv: 0, registerFileBuffer: 0, queries: 0, rowsOut: 0 };
    },
  };
}

// ── the host the bundle really gets ─────────────────────────────────────────

/** A real-core headless host whose `host` is scoped to paged.data's OWN
 *  manifest (enforced capabilities, the `x-paged:media.paged.data` metadata
 *  namespace) — the host the bundle gets in the editor. The neutral harness
 *  host would reject the bundle's binding-metadata writes as foreign, and a
 *  rejected batch costs nothing, which would make the budgets lie. */
export async function openDataHost(): Promise<HeadlessHost> {
  const h = await openRealHost();
  h.loadBundle({
    manifest: manifest as never,
    activate: () => ({ dispose() {} }),
  } as never);
  return h;
}

// ── the session under test ──────────────────────────────────────────────────

/** The bundle's own session over `host`, with its engine and DuckDB boots
 *  pointed at the given counted instances. */
export async function sessionOver(
  host: BundleHost,
  engine: CountedEngine,
  duck: CountedDuck | null,
): Promise<DataSourceSession> {
  vi.resetModules();
  vi.doMock("../../src/engine", async (orig) => ({
    ...(await orig<typeof import("../../src/engine")>()),
    bootEngine: async () => engine.engine,
  }));
  vi.doMock("../../src/query/duckdb", async (orig) => ({
    ...(await orig<typeof import("../../src/query/duckdb")>()),
    bootDuckDB: async () => {
      if (!duck) throw new Error("this scenario boots no DuckDB");
      return duck.handle;
    },
  }));
  const { createSession } = await import("../../src/session");
  return createSession(host, TODAY);
}

// ── undo steps (the plugin-draw probe) ──────────────────────────────────────

interface RawReply {
  kind?: string;
  payload?: { appliedSeq?: number; undoneSeq?: number };
}

/** Commit a marker step through the raw client and return its sequence
 *  number. The marker is a throwaway text frame off to the side. */
export async function undoMark(h: HeadlessHost): Promise<number> {
  const reply = (await h.host.editor.client.mutate({
    op: "insertTextFrame",
    args: { pageId: "usp", bounds: [700, 500, 720, 560] },
  } as never)) as RawReply;
  const seq = reply.payload?.appliedSeq;
  if (reply.kind !== "mutationApplied" || typeof seq !== "number") {
    throw new Error(`undoMark: the marker was refused (${JSON.stringify(reply)})`);
  }
  return seq;
}

/** How many undo steps the document gained since `mark`, by walking the
 *  history back to it (the plugin-draw probe) — the number of Ctrl+Z presses
 *  the work costs the user. The walk also takes the work back.
 *
 *  The engine's undo history is BOUNDED: a walk can run out before the mark
 *  comes back (measured: 89 undos reachable after a 100-field refresh on top
 *  of a 200-step setup). Then `reached` is false and `steps` is how far the
 *  user could get. (Sequence numbers are no substitute: a batch of table-cell
 *  writes advances the applied sequence once per op but undoes as ONE step.) */
export async function undoStepsSince(
  h: HeadlessHost,
  mark: number,
  limit = 5000,
): Promise<{ steps: number; reached: boolean }> {
  for (let steps = 0; steps <= limit; steps++) {
    const reply = (await h.host.editor.client.undo()) as RawReply;
    if (reply.kind !== "undoApplied") return { steps, reached: false };
    const undone = reply.payload?.undoneSeq;
    if (undone === mark) return { steps, reached: true };
    if (typeof undone === "number" && undone < mark) {
      throw new Error(`undoStepsSince: undo reverted seq ${undone}, older than the mark ${mark}`);
    }
  }
  throw new Error(`undoStepsSince: the mark did not come back in ${limit} undos`);
}

/** {@link undoStepsSince}, requiring that the mark came back. */
export async function undoSteps(h: HeadlessHost, mark: number): Promise<number> {
  const r = await undoStepsSince(h, mark);
  if (!r.reached) {
    throw new Error(`undoSteps: the bounded history ran out after ${r.steps} undos, before the mark`);
  }
  return r.steps;
}

// ── measuring and reporting ─────────────────────────────────────────────────

/** One scenario's measured counts — the numbers a budget pins. */
export interface Measured {
  hostCalls: number;
  hostReads: number;
  mutates: number;
  mutationOps: number;
  undoSteps: number | null;
  placeholdersRead: number;
  wasmCalls: number;
  cellsIn: number;
  resolves: number;
  stabilizeCalls: number;
  keyAllocs: number;
  fingerprints: number;
  duckQueries: number;
}

/** What a scenario measured beside the budget numbers (trended, not gated). */
export interface Trended {
  ms: number;
  bytesIn: number;
  bytesOut: number;
  detail: Record<string, unknown>;
}

export function measure(
  work: WorkLog,
  engine: CountedEngine | null,
  duck: CountedDuck | null,
  undoSteps: number | null,
): Measured {
  const c = engine?.counters();
  return {
    hostCalls: work.total(),
    hostReads: work.reads(),
    mutates: work.count("document.mutate"),
    mutationOps: work.ops(),
    undoSteps,
    placeholdersRead: work.placeholdersRead,
    wasmCalls: engine?.total() ?? 0,
    cellsIn: engine?.log.cellsIn ?? 0,
    resolves: c?.resolves ?? 0,
    stabilizeCalls: c?.stabilize_calls ?? 0,
    keyAllocs: c?.key_allocs ?? 0,
    fingerprints: c?.fingerprints ?? 0,
    duckQueries: duck?.log.queries ?? 0,
  };
}

const rows: { scenario: string; m: Measured; t: Trended }[] = [];

/** HOW TO RE-MEASURE: `PERF_SHOW=1 pnpm vitest run test/perf` prints one
 *  `PERF` line per scenario (the full door log) and, at the end of each file,
 *  the counts as a table — the numbers the budgets are pinned from. */
export function report(
  scenario: string,
  m: Measured,
  t: Trended,
  work: WorkLog,
  engine: CountedEngine | null,
): void {
  rows.push({ scenario, m, t });
  if (!process.env.PERF_SHOW) return;
  const doors: Record<string, number> = {};
  for (const k of Object.keys(work.calls).sort()) doors[k] = work.calls[k]!;
  // eslint-disable-next-line no-console
  console.log(
    `PERF ${scenario} ${JSON.stringify({
      ...m,
      ms: Math.round(t.ms),
      bytesIn: t.bytesIn,
      bytesOut: t.bytesOut,
      doors,
      wasm: engine?.log.calls ?? {},
      engineCounters: engine?.counters() ?? null,
      mutations: work.mutations.map((x) => (x.op === "batch" ? `batch(${x.ops})` : x.op)),
      ...t.detail,
    })}`,
  );
}

/** Print the scenarios measured in this file as one table (PERF_SHOW=1). */
export function printTable(): void {
  if (!process.env.PERF_SHOW || rows.length === 0) return;
  // eslint-disable-next-line no-console
  console.table(
    rows.map(({ scenario, m, t }) => ({
      scenario,
      ...m,
      ms: Math.round(t.ms),
      bytesIn: t.bytesIn,
      bytesOut: t.bytesOut,
    })),
  );
}

/** Assert a measured count set equals its pinned budget, field by field, with
 *  a message that says which way it moved. Budgets are lowered only in the
 *  commit that earns it and never raised. */
export function expectBudget(scenario: string, m: Measured, budget: Measured): void {
  const moved: string[] = [];
  for (const k of Object.keys(budget) as (keyof Measured)[]) {
    if (m[k] !== budget[k]) {
      const dir =
        typeof m[k] === "number" && typeof budget[k] === "number" && (m[k] as number) < (budget[k] as number)
          ? "UNDER budget — lower the pin in this commit"
          : "OVER budget";
      moved.push(`${k}: measured ${m[k]} vs budget ${budget[k]} (${dir})`);
    }
  }
  if (moved.length > 0) {
    throw new Error(`${scenario}: ${moved.join("; ")}`);
  }
}

/** A deterministic shuffle of 0..n (i·7919 mod n), so data arrives unsorted. */
export function shuffled(i: number, n: number): number {
  return (i * 7919) % n;
}

/** A product CSV of `n` rows: sku (shuffled), name, price. */
export function productCsv(n: number): string {
  const lines = ["sku,name,price"];
  for (let i = 0; i < n; i++) {
    lines.push(`SKU-${String(shuffled(i, n)).padStart(6, "0")},item ${i},${(i * 1.25).toFixed(2)}`);
  }
  return lines.join("\n") + "\n";
}

export { REQUIRE_REAL_CORE };
