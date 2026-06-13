// Boot the paged.data engine wasm (data-js) in the bundle realm — the
// canvas-wasm pattern (the wasm-bindgen `--target web` glue, NOT
// host.loadBundleWasm; BREAKAGE D-07). The artifact lands in ./bin via
// scripts/build-wasm.sh; absent until built → ENGINE_NOT_BUILT (honest, never
// faked). ALL binding/expression/sync/lowering semantics live behind this
// boundary (CLAUDE.md hard rule) — this file only constructs the handle.

export const ENGINE_NOT_BUILT =
  "data-js wasm not built — run `bash scripts/build-wasm.sh` (8 MiB budget, lands in packages/data-bundle/bin/)";

/** The wasm class surface (`data-js` `DataEngine`) the bundle consumes. The
 *  method names + JSON shapes match the Rust `#[wasm_bindgen]` impl exactly. */
export interface DataEngineLike {
  define_source(source: unknown): void;
  define_query(query: unknown): void;
  define_binding(def: unknown): void;
  define_placeholder(placeholder: unknown): void;
  set_param(name: string, value: unknown): void;
  set_locale(locale: unknown): void;
  ingest_result(query: string, records: unknown): void;
  resolve_lowered(binding: string): unknown;
  /** §9 record-preview stepper: the count of records ingested for a query — the
   *  stepper's "of N" upper bound (0 before a refresh). Optional: a wasm
   *  artifact built before the preview lane lacks it. */
  query_record_count?(query: string): number;
  /** §9 record-preview stepper: resolve a binding against a chosen RECORD INDEX
   *  (`record`) and return its lowered IR — per-record kinds (variable/image)
   *  resolve over `records[record]`; a table renders in full. Optional: absent
   *  on a wasm artifact built before the preview lane (the session falls back to
   *  the record-0 resolve, honestly). */
  resolve_lowered_at?(binding: string, record: number): unknown;
  publish_provider(query: string, providerId: string, category: string): unknown;
  governed_catalog(query: string, metadata: unknown): unknown;
  plan_batch(query: string, mode: unknown): unknown;
  run_record_flow_batch(binding: string, mode: unknown, chain: unknown, opts: unknown): unknown;
  /** D-13: evaluate a data-driven formatting rule over a query's records —
   *  returns `{scope, fires, apply, total}` (the firing decision; the host
   *  applies the named document style). */
  evaluate_rule(rule: string, query: string): unknown;
  /** D-12: resolve a record-flow binding and paginate it over a caller-supplied
   *  frame chain (`FrameCapacity[]`, `heightPt`) — returns the `PaginatedFlow`
   *  IR. The chain is the host frame-chain topology (D-12), read live. */
  lower_record_flow(binding: string, chain: unknown, opts: unknown): unknown;
  /** §9.7: resolve a barcode binding and lower it scaled to the bound frame's
   *  content box (`boxWPt` × `boxHPt`, pt) — returns the `LoweredBarcode` IR
   *  (content-space filled-rect modules the bundle draws as native insertPath). */
  lower_barcode(binding: string, boxWPt: number, boxHPt: number): unknown;
  /** M1 remote slice: the content-hash invalidation key for a defined remote
   *  source over bundle-fetched bytes. Optional: a wasm artifact built before
   *  the M1 slice lacks it (the session degrades honestly). */
  remote_invalidation_key?(source: string, bytes: Uint8Array): string;
  sync_state(binding: string): unknown;
  pin(binding: string): void;
  mark_overridden(binding: string): void;
  relink(binding: string): void;
  sync_report(): unknown;
  source_manifest(): unknown;
  authorize_report(): unknown;
  payload(): unknown;
  metadata(): unknown;
  free(): void;
}

// A computed specifier so the type-checker does not resolve the (build-time)
// wasm glue path; it is loaded dynamically in the bundle realm at runtime.
const ENGINE_GLUE = "../bin/data_js.js";

/** Boot a `DataEngine` over the wasm-bindgen glue. Throws [`ENGINE_NOT_BUILT`]
 *  when the artifact is absent (the panel renders that honestly). */
export async function bootEngine(today: number): Promise<DataEngineLike> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any = null;
  try {
    mod = await import(/* @vite-ignore */ ENGINE_GLUE);
  } catch {
    throw new Error(ENGINE_NOT_BUILT);
  }
  if (!mod || typeof mod.DataEngine !== "function") {
    throw new Error(ENGINE_NOT_BUILT);
  }
  // wasm-bindgen `--target web` exports a default init() that fetches the .wasm.
  if (typeof mod.default === "function") {
    await mod.default();
  }
  return new mod.DataEngine(today) as DataEngineLike;
}
