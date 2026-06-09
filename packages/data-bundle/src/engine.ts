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
  ingest_result(query: string, records: unknown): void;
  resolve_lowered(binding: string): unknown;
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
