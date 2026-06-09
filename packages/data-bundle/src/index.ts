// @paged-media/data-bundle — the paged.data plugin bundle (manifest + activate
// + panels + the DuckDB-WASM query integration + the data-js engine boot). Thin
// glue ONLY: all binding/expression/sync/lowering semantics live in the Rust
// engine (data-* crates → data-js wasm).

import { defineBundle } from "@paged-media/plugin-sdk";
import type { PluginManifest } from "@paged-media/plugin-api";

import { activate } from "./activate";
import manifestJson from "../manifest.json";

export const dataBundle = defineBundle({
  manifest: manifestJson as PluginManifest,
  activate,
});

export { activate, SOURCES_PANEL_ID, BINDINGS_PANEL_ID } from "./activate";
export { createSession, type DataSourceSession, type SessionState } from "./session";
export { bootEngine, ENGINE_NOT_BUILT, type DataEngineLike } from "./engine";
export { commitLoweredTable, commitLoweredVariable } from "./lower";
export { bootDuckDB, DUCKDB_NOT_VENDORED, type DuckDBHandle } from "./query/duckdb";
export {
  arrowToRecordSet,
  classifyType,
  cellToValue,
  type RecordSetJson,
  type ValueJson,
} from "./query/recordset";
export { makeSourcesPanel } from "./panels/sources-panel";
export { makeBindingsPanel } from "./panels/bindings-panel";
