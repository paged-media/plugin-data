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

// The §8 change report ("what changed since last sync") wired through the
// SESSION against a fake engine (the fingerprint + diff kernel is proven in
// Rust: data-conformance/tests/bind.rs::data_bind_change_report). This pins the
// bundle ORCHESTRATION: refreshDiff surfaces the engine's per-binding report,
// primeChangeBaseline swallows the initial baseline, and the session degrades
// honestly when the engine wasm predates the lane.

import { describe, expect, it, vi } from "vitest";

import type { BundleHost, Mutation } from "@paged-media/plugin-api";

import type { DataEngineLike } from "../engine";
import type { ChangeReport } from "../session";

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
  return {
    define_source() {},
    define_query() {},
    define_binding() {},
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

describe("data_bind_change_report session lane (§8)", () => {
  it("refreshDiff surfaces the engine's per-binding change report", async () => {
    const report: ChangeReport = {
      entries: [
        { binding: "v_price", kind: "changed", before: "old", after: "new" },
        { binding: "v_name", kind: "unchanged", before: "x", after: "x" },
      ],
      changed: 1,
      unchanged: 1,
      added: 0,
      removed: 0,
    };
    const fake = fakeHost();
    const engine = fakeEngine({ refresh_change_report: () => report });
    const s = await sessionWith(fake.host, engine);
    expect(await s.refreshDiff()).toEqual(report);
    // The summary message reflects the counts.
    expect(s.getState().message).toContain("1 changed");
    expect(s.getState().message).toContain("1 unchanged");
  });

  it("primeChangeBaseline swallows one report (the baseline) so the next is real", async () => {
    let call = 0;
    const baseline: ChangeReport = {
      entries: [{ binding: "v1", kind: "added", after: "a" }],
      changed: 0,
      unchanged: 0,
      added: 1,
      removed: 0,
    };
    const real: ChangeReport = {
      entries: [{ binding: "v1", kind: "changed", before: "a", after: "b" }],
      changed: 1,
      unchanged: 0,
      added: 0,
      removed: 0,
    };
    const fake = fakeHost();
    const engine = fakeEngine({
      refresh_change_report: () => (call++ === 0 ? baseline : real),
    });
    const s = await sessionWith(fake.host, engine);
    await s.primeChangeBaseline(); // discards the all-added baseline
    const next = await s.refreshDiff();
    expect(next).toEqual(real);
    expect(call).toBe(2);
  });

  it("refreshDiff degrades to an empty report when the wasm predates the lane", async () => {
    const fake = fakeHost();
    const s = await sessionWith(fake.host, fakeEngine()); // no refresh_change_report
    expect(await s.refreshDiff()).toEqual({
      entries: [],
      changed: 0,
      unchanged: 0,
      added: 0,
      removed: 0,
    });
  });
});
