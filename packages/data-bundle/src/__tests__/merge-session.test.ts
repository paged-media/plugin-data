// The session's Data Merge over a template it has consumed before.
//
// A `consume` merge removes the template frames, so the session keeps the
// template it read to merge again over its own output. When the merge was
// UNDONE, though, the template frames are back on the page: a re-merge must
// read and consume them again, not reuse the stored template as if they were
// gone (which left the <<field>> frame on every output page).

import { describe, expect, it, vi } from "vitest";

import type { BundleHost } from "@paged-media/plugin-api";

import type { DataEngineLike } from "../engine";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function fakeEngine(): DataEngineLike {
  return {
    define_source() {},
    define_query() {},
    define_binding() {},
    define_placeholder() {},
    set_param() {},
    set_locale() {},
    ingest_result() {},
    resolve_lowered: () => null,
    sync_state: () => null,
    sync_report: () => [],
    pin() {},
    mark_overridden() {},
    relink() {},
    payload: () => ({ bindings: [], queries: [{ id: "q", sql: "SELECT 1" }] }),
    load_payload() {},
    free() {},
    plan_merge: () => ({}),
    merge_words: () => [],
    merge_overset: () => [],
    query_record_count: () => 3,
  } as unknown as DataEngineLike;
}

const host = {
  manifest: { id: "media.paged.data", version: "0.0.1" },
  log: silent,
  supports: () => false,
  selection: { get: () => [], set: async () => [] },
  document: {
    mutate: async () => ({ applied: true, pageIds: [] }),
    meta: async () => ({ activePage: "p1", documentName: "Catalog" }),
    collection: async () => [{ selfId: "p1" }],
    tree: async () => [],
  },
} as unknown as BundleHost;

const template = { pageId: "p1", frames: [{ element: { id: "f1" } }], spec: { marginBox: [0, 0, 1, 1], frames: [] } };

/** A session whose template reader answers `onPage()` in turn and whose
 *  writer records what it was asked to do. */
async function session(onPage: (() => typeof template | null)[]) {
  const writes: { template: unknown; templatePresent?: boolean }[] = [];
  vi.resetModules();
  vi.doMock("../engine", async (orig) => ({
    ...(await orig<typeof import("../engine")>()),
    bootEngine: async () => fakeEngine(),
  }));
  vi.doMock("../merge", async (orig) => ({
    ...(await orig<typeof import("../merge")>()),
    readMergeTemplate: async () => {
      const t = onPage.shift()?.() ?? null;
      return { template: t, diagnostics: t ? [] : ["merge: no text frame with a <<field>> on the template page"] };
    },
    mergeRecords: async (_h: unknown, _e: unknown, t: unknown, o: { templatePresent?: boolean }) => {
      writes.push({ template: t, templatePresent: o.templatePresent });
      return { ok: true, plan: null, pages: [], records: [], overset: [], mutateCalls: 1, diagnostics: [] };
    },
  }));
  const { createSession } = await import("../session");
  const s = createSession(host, 20613);
  s.addQuery("q", "SELECT 1", "recordStream");
  return { s, writes };
}

describe("a consumed template merged again [data.lower.merge-writer]", () => {
  it("over its own output: the stored template, nothing of it left to remove", async () => {
    const { s, writes } = await session([() => template, () => null]);
    expect((await s.mergeRecords({ query: "q", template: "consume" })).ok).toBe(true);
    expect((await s.mergeRecords({ query: "q", template: "consume" })).ok).toBe(true);
    expect(writes.map((w) => w.templatePresent)).toEqual([true, false]);
    expect(writes[1]!.template).toBe(template);
  });

  it("after the merge was undone: the template is on the page again and is consumed again", async () => {
    const { s, writes } = await session([() => template, () => template]);
    await s.mergeRecords({ query: "q", template: "consume" });
    // Edit ▸ Undo took the merge back: the template frames are there again.
    await s.mergeRecords({ query: "q", template: "consume" });
    expect(writes.map((w) => w.templatePresent)).toEqual([true, true]);
  });
});
