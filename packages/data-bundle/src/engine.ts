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

// Boot the paged.data engine wasm (data-js) in the bundle realm — the
// canvas-wasm pattern (the wasm-bindgen `--target web` glue, NOT
// host.loadBundleWasm; BREAKAGE D-07). The artifact lands in ./bin via
// scripts/build-wasm.sh; absent until built → ENGINE_NOT_BUILT (honest, never
// faked). ALL binding/expression/sync/lowering semantics live behind this
// boundary (CLAUDE.md hard rule) — this file only constructs the handle (and
// hands a result's typed column buffers across the column door).

import { columnToValues, type ColumnBatch } from "./query/recordset";

export const ENGINE_NOT_BUILT =
  "data-js wasm not built — run `bash scripts/build-wasm.sh` (100 MB app wasm budget, lands in packages/data-bundle/bin/)";

/** The wasm class surface (`data-js` `DataEngine`) the bundle consumes. The
 *  method names + JSON shapes match the Rust `#[wasm_bindgen]` impl exactly. */
export interface DataEngineLike {
  define_source(source: unknown): void;
  define_query(query: unknown): void;
  define_binding(def: unknown): void;
  define_template(template: unknown): void;
  define_placeholder(placeholder: unknown): void;
  set_param(name: string, value: unknown): void;
  set_locale(locale: unknown): void;
  ingest_result(query: string, records: unknown): void;
  /** The typed column door (Wave 2): `begin_columns` → one `push_*` per
   *  schema field → `finish_columns` (`"changed"` | `"unchanged"`). Each
   *  buffer is copied into wasm once; no per-cell objects. Use
   *  `ingestColumnBatch`, which falls back to `ingest_result` on an engine
   *  without the door. */
  begin_columns?(query: string, schema: unknown, rows: number): void;
  push_f64?(values: Float64Array, valid?: Uint8Array): void;
  push_bool?(values: Uint8Array, valid?: Uint8Array): void;
  push_date?(values: Int32Array, valid?: Uint8Array): void;
  push_datetime?(values: Float64Array, valid?: Uint8Array): void;
  push_utf8?(bytes: Uint8Array, offsets: Int32Array, valid?: Uint8Array): void;
  push_binary?(bytes: Uint8Array, offsets: Int32Array, valid?: Uint8Array): void;
  finish_columns?(): string;
  /** The content token (hex content hash) of a query's ingested result —
   *  equal tokens, equal data. `undefined` before an ingest. */
  result_token?(query: string): string | undefined;
  resolve_lowered(binding: string): unknown;
  /** ADR 558: every property binding's lowering over `record` (with
   *  `withVisibility`, visibility bindings re-expressed too), for ONE apply
   *  (`PropertyApply[]`). Optional: a wasm built before it lacks it. */
  resolve_properties_at?(record: number, withVisibility: boolean, bindings?: string[]): unknown;
  /** Remove a binding from the recipe. Optional (a wasm built before it). */
  remove_binding?(binding: string): boolean;
  /** §9 record-preview stepper: the count of records ingested for a query — the
   *  stepper's "of N" upper bound (0 before a refresh). Optional: a wasm
   *  artifact built before the preview lane lacks it. */
  query_record_count?(query: string): number;
  /** §9 field-mapping wizard: the column → variable-binding suggestions for a
   *  query's ingested result (`ColumnMapping[]`). Optional: absent on a wasm
   *  artifact built before the wizard lane (the panel degrades honestly). */
  query_mappings?(query: string): unknown;
  /** §8 change report: diff every binding's current resolved content against the
   *  previous report's snapshot — `{ entries, changed, unchanged, added,
   *  removed }`. Call AFTER re-ingesting the queries. Optional: absent on a wasm
   *  artifact built before the change-report lane (the panel degrades honestly). */
  refresh_change_report?(): unknown;
  /** §9 record-preview stepper: resolve a binding against a chosen RECORD INDEX
   *  (`record`) and return its lowered IR — per-record kinds (variable/image)
   *  resolve over `records[record]`; a table renders in full. Optional: absent
   *  on a wasm artifact built before the preview lane (the session falls back to
   *  the record-0 resolve, honestly). */
  resolve_lowered_at?(binding: string, record: number): unknown;
  /** §9.9: the declared variables + captured data sets (`VariableSet`). Optional:
   *  absent on a wasm artifact built before the variables lane (the session
   *  degrades to an empty palette, honestly). */
  variables?(): unknown;
  /** §9.9: capture the current resolved values as a named data set, resolved
   *  against a record index. Optional (see `variables`). */
  capture_data_set?(name: string, record: number): unknown;
  /** §9.9: capture ONE data set per record of a query. Returns the names in
   *  record order. Optional (see `variables`). */
  capture_every_record?(query: string, prefix: string, nameColumn?: string): unknown;
  /** §9.9: the named data sets, in palette order. Optional (see `variables`). */
  list_data_sets?(): unknown;
  /** §9.9: delete a data set by name. Optional (see `variables`). */
  delete_data_set?(name: string): boolean;
  /** §9.9: plan a data-set application — one `DataSetApply` per captured
   *  variable. The BUNDLE commits the applicable rows as ONE batch (one undo
   *  step); this only decides values. Optional (see `variables`). */
  apply_data_set?(name: string): unknown;
  /** §9.9: export the variable set as Illustrator-compatible library XML.
   *  Optional (see `variables`). */
  export_variable_library?(): string;
  /** §9.9: import a variable library, replacing the current set. Returns the
   *  `ImportReport`. Optional (see `variables`). */
  import_variable_library?(xml: string): unknown;
  /** §9.9: the serialized byte size of the variable half of the payload — the
   *  D-08 budget check. Optional (see `variables`). */
  data_set_payload_bytes?(): number;
  /** Wave 5 Data Merge: plan a merge of a query's records (in delivered
   *  order) through a record template (`MergeSpec` → `MergePlan`). Optional:
   *  absent on a wasm artifact built before the merge lane. */
  plan_merge?(query: string, spec: unknown): unknown;
  /** Wave 5: the distinct words of a merge plan's texts per template frame. */
  merge_words?(plan: unknown, frames: number): unknown;
  /** Wave 5: per record, per frame, is the merged text overset (DM-7)? */
  merge_overset?(plan: unknown, metrics: unknown): unknown;
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
  /** Wave 6: read one worksheet of an `.xlsx` (data-xlsx) as
   *  `{sheet, sheets, columns, rows, errorCells, json}` for DuckDB. Optional:
   *  a wasm built before it lacks it (the import says so). */
  xlsx_import?(bytes: Uint8Array, sheet?: string): unknown;
  /** §9.1: override one binding's formatting locale (a tag; `null` clears).
   *  Optional: absent on a wasm artifact built before the locale table. */
  set_binding_locale?(binding: string, locale: string | null): void;
  /** §9.1: the per-binding locale overrides, `{ binding: tag }`. */
  binding_locales?(): unknown;
  /** §9.1: every locale with formatted samples (`LocaleInfo[]`). */
  locales?(): unknown;
  /** §9.1: wrap an expression in a display pattern. */
  format_expression?(inner: string, pattern: unknown): string;
  /** §9.1: split an expression into `{ inner, pattern }`. */
  split_expression?(src: string): unknown;
  /** §8: snapshot each query's result as the one the document was written
   *  from (the "before" of `row_diff`). */
  mark_rows_applied?(): void;
  /** §8: the row diff per query since `mark_rows_applied` (`QueryRowDiff[]`). */
  row_diff?(opts: unknown): unknown;
  /** Check an expression: `{ ok, error?, fields, unknownFields }`. */
  check_expression?(src: string, query?: string | null): unknown;
  /** §9.5: which records a condition fires on, `{ fires, total, error? }`. */
  preview_condition?(query: string, when: string): unknown;
  /** A per-record binding's display text for a record, without re-linking. */
  preview_display?(binding: string, record: number): unknown;
  sync_state(binding: string): unknown;
  /** The field-refresh decision per binding, in ONE call
   *  (`[{outcome: "value"|"kept"|"notVariable"|"failed", binding, value?, error?}]`):
   *  pinned / overridden bindings are kept without resolving. Optional: a wasm
   *  built before it lacks it (the refresh falls back to two calls per binding). */
  refresh_field_values?(bindings: string[]): unknown;
  pin(binding: string): void;
  mark_overridden(binding: string): void;
  relink(binding: string): void;
  sync_report(): unknown;
  source_manifest(): unknown;
  authorize_report(): unknown;
  payload(): unknown;
  /** Replace the recipe with a saved `payload()` (the session restore path).
   *  Optional: a wasm artifact built before it lacks it (restore reports it). */
  load_payload?(payload: unknown): void;
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

/** Deliver a query result to the engine as typed column buffers (the column
 *  door: one copy per column, no `{t, v}` object per cell). Returns whether
 *  the engine's result changed: a re-delivery of the same data is
 *  `"unchanged"` and decodes nothing. An engine built before the door gets
 *  the same data through `ingest_result` (reported `"changed"`). */
export function ingestColumnBatch(
  e: DataEngineLike,
  query: string,
  batch: ColumnBatch,
): "changed" | "unchanged" {
  if (typeof e.begin_columns !== "function" || typeof e.finish_columns !== "function") {
    e.ingest_result(query, {
      schema: batch.schema,
      columns: batch.columns.map((c) => columnToValues(c, batch.row_count)),
      row_count: batch.row_count,
    });
    return "changed";
  }
  e.begin_columns(query, batch.schema, batch.row_count);
  for (const c of batch.columns) {
    const valid = c.valid ?? undefined;
    switch (c.kind) {
      case "f64":
        e.push_f64!(c.values, valid);
        break;
      case "bool":
        e.push_bool!(c.values, valid);
        break;
      case "date":
        e.push_date!(c.values, valid);
        break;
      case "datetime":
        e.push_datetime!(c.values, valid);
        break;
      case "utf8":
        e.push_utf8!(c.bytes, c.offsets, valid);
        break;
      case "binary":
        e.push_binary!(c.bytes, c.offsets, valid);
        break;
    }
  }
  return e.finish_columns() === "unchanged" ? "unchanged" : "changed";
}
