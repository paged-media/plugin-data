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

// The §9 field-mapping wizard wired through the SESSION against a fake engine
// (the schema → ColumnMapping[] kernel is proven in Rust:
// data-conformance/tests/mapping.rs). This pins the bundle ORCHESTRATION:
// queryMappings surfaces the engine's column suggestions, and applyMappings
// generates a variable binding per MAPPABLE column from the engine-computed
// expr (non-mappable columns are skipped — the bundle never invents an expr).

import { describe, expect, it, vi } from "vitest";

import type { BundleHost, Mutation } from "@paged-media/plugin-api";

import type { DataEngineLike } from "../engine";
import type { ColumnMapping } from "../session";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function fakeHost() {
  const host = {
    manifest: { id: "media.paged.data", version: "0.0.1" },
    log: silent,
    supports: () => true,
    selection: { get: () => [], set: async () => [] },
    network: { consentedOrigins: () => [], requestConsent: async () => ({ granted: [], denied: [] }) },
    document: {
      mutate: async (_m: Mutation) => ({ applied: true, createdId: null, pageIds: [] }),
      placeholders: async () => [],
      frameChain: async () => [],
      elementGeometry: async () => [],
      hitTest: async () => null,
      meta: async () => ({ activePage: "p1" }),
      collection: async () => [],
      onDidChange: () => ({ dispose() {} }),
    },
  } as unknown as BundleHost;
  return { host };
}

function fakeEngine(over?: Partial<DataEngineLike>): DataEngineLike {
  const defined: unknown[] = [];
  const base = {
    define_source() {},
    define_query() {},
    define_binding(def: unknown) {
      defined.push(def);
    },
    define_placeholder() {},
    set_param() {},
    set_locale() {},
    ingest_result() {},
    resolve_lowered: () => null,
    publish_provider: () => ({}),
    governed_catalog: () => ({}),
    plan_batch: () => ({}),
    run_record_flow_batch: () => [],
    evaluate_rule: () => ({}),
    lower_record_flow: () => ({}),
    sync_state: () => ({}),
    pin() {},
    mark_overridden() {},
    relink() {},
    sync_report: () => ({}),
    source_manifest: () => ({}),
    authorize_report: () => ({}),
    payload: () => ({}),
    metadata: () => ({}),
    free() {},
    ...over,
  } as DataEngineLike;
  (base as unknown as { __defined: unknown[] }).__defined = defined;
  return base;
}

async function sessionWith(host: BundleHost, engine: DataEngineLike) {
  vi.resetModules();
  vi.doMock("../engine", async (orig) => ({
    ...(await orig<typeof import("../engine")>()),
    bootEngine: async () => engine,
  }));
  vi.doMock("../query/duckdb", async (orig) => ({
    ...(await orig<typeof import("../query/duckdb")>()),
    bootDuckDB: async () => ({ registerCsv: async () => {}, query: async () => ({}), close: async () => {} }),
  }));
  const { createSession: make } = await import("../session");
  return make(host, 20613);
}

const MAPPINGS: ColumnMapping[] = [
  { column: "sku", header: "Sku", expr: "sku", fieldType: "text", mappable: true },
  { column: "unit_price", header: "Unit Price", expr: "unit_price", fieldType: "float", mappable: true },
  { column: "Unit Cost", header: "Unit Cost", expr: "", fieldType: "float", mappable: false },
];

describe("data_bind_field_mapping session lane (§9)", () => {
  it("queryMappings surfaces the engine's column suggestions", async () => {
    const fake = fakeHost();
    const engine = fakeEngine({ query_mappings: () => MAPPINGS });
    const s = await sessionWith(fake.host, engine);
    const cols = await s.queryMappings("q_all");
    expect(cols).toEqual(MAPPINGS);
  });

  it("queryMappings degrades to [] when the wasm predates the lane", async () => {
    const fake = fakeHost();
    const s = await sessionWith(fake.host, fakeEngine()); // no query_mappings
    expect(await s.queryMappings("q_all")).toEqual([]);
  });

  it("applyMappings generates a variable binding per MAPPABLE column only", async () => {
    const fake = fakeHost();
    const engine = fakeEngine({ query_mappings: () => MAPPINGS });
    const s = await sessionWith(fake.host, engine);
    // Boot the engine first (queryMappings does) so define_binding reaches it —
    // the real wizard always reads the mappings before confirming.
    await s.queryMappings("q_all");
    const ids = s.applyMappings("q_all", MAPPINGS);
    // Only the two mappable columns become bindings; "Unit Cost" (a space → not
    // a bare DSL identifier) is skipped — the bundle never invents an expr.
    expect(ids).toEqual(["v_sku", "v_unit_price"]);
    expect(s.getState().bindings).toEqual(["v_sku", "v_unit_price"]);

    // The engine received the bindings with the engine-computed exprs.
    const defined = (engine as unknown as { __defined: { id: string; expr: string }[] }).__defined;
    expect(defined.map((d) => [d.id, d.expr])).toEqual([
      ["v_sku", "sku"],
      ["v_unit_price", "unit_price"],
    ]);
  });

  it("applyMappings honours a custom id prefix + target", async () => {
    const fake = fakeHost();
    const s = await sessionWith(fake.host, fakeEngine());
    const ids = s.applyMappings("q_all", MAPPINGS, { idPrefix: "fld_", target: "frame-7" });
    expect(ids).toEqual(["fld_sku", "fld_unit_price"]);
  });
});
