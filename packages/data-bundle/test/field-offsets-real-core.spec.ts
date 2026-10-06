// Field addressing against the REAL core engine (wave 0, data bugs a + b).
//
// What core does, read from core/crates/paged-mutate (2026-10-05) and pinned by
// its own tests/placeholder_fields.rs:
//
// - `placeholders()` (paged-canvas model.rs `document_placeholders`) reports
//   each field as the char offset of its run START, counted as the sum of run
//   chars with NO paragraph separators. The address is valid until the next
//   edit.
// - `setFieldValue` (apply/path_topology.rs `apply_set_field_value`) finds the
//   placeholder run whose start equals the offset OR whose display span
//   strictly contains it, and replaces that run's text with the new display.
//   An offset inside ordinary text is rejected ("no placeholder field at
//   offset N").
//
// So an offset read before a write goes stale after the write whenever the
// display length changes: every later field in that story shifts. Written
// front to back, the second write can land INSIDE the first field's grown span
// and overwrite the wrong field without any error. Written back to front (per
// story, highest offset first), no write moves an address that is still to be
// used. The session therefore orders writes back to front off one read, and
// the preview re-reads instead of trusting a cached offset.
//
// The data engine is a fake here (the field values are the input); the HOST is
// the real engine. Skips when no canvas-wasm is reachable; REQUIRE_REAL_CORE=1
// turns the skip into a failure.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import type { DataEngineLike } from "../src/engine";
import { dataFields, ENGINE_ANCHOR, fixedFrom, openRealHost, REQUIRE_REAL_CORE } from "./real-core";
import { undoMark, undoSteps } from "./perf/harness";

const run = ENGINE_ANCHOR !== null || REQUIRE_REAL_CORE;
const PLUGIN = "media.paged.data";

function fakeEngine(over: Partial<DataEngineLike>): DataEngineLike {
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
    lower_barcode: () => null,
    sync_state: () => null,
    pin() {},
    mark_overridden() {},
    relink() {},
    sync_report: () => [],
    source_manifest: () => ({}),
    authorize_report: () => ({}),
    payload: () => ({}),
    metadata: () => ({}),
    free() {},
    ...over,
  } as DataEngineLike;
}

async function sessionOver(h: HeadlessHost, engine: DataEngineLike) {
  vi.resetModules();
  vi.doMock("../src/engine", async (orig) => ({
    ...(await orig<typeof import("../src/engine")>()),
    bootEngine: async () => engine,
  }));
  vi.doMock("../src/query/duckdb", async (orig) => ({
    ...(await orig<typeof import("../src/query/duckdb")>()),
    bootDuckDB: async () => ({
      registerCsv: async () => {},
      registerFileBuffer: async () => {},
      query: async () => ({}),
      close: async () => {},
    }),
  }));
  const { createSession } = await import("../src/session");
  return createSession(h.host, 20613);
}

/** A fresh text frame on the fixture page; returns its story id. */
async function newStory(h: HeadlessHost): Promise<string> {
  const host = h.host;
  const fr = await host.document.mutate({
    op: "insertTextFrame",
    args: { pageId: "usp" as never, bounds: [100, 100, 200, 300] },
  });
  expect(fr.applied).toBe(true);
  const hit = await host.document.hitTest("usp" as never, [200, 150]);
  expect(hit?.storyId).toBeTruthy();
  return hit!.storyId as string;
}

async function ours(h: HeadlessHost) {
  const all = await h.host.document.placeholders();
  return all.filter((p) => p.plugin === PLUGIN);
}

/** A placeholder field `key` (value `value`) in a fresh story — the field as
 *  a variable was placed before engine protocol 71. From 71 a NEW variable is
 *  a text variable (ADR 559); a document with a placeholder field keeps
 *  being read and written through it, which is what these address tests
 *  exercise. */
async function placeField(h: HeadlessHost, key: string, value: string): Promise<string> {
  const story = await newStory(h);
  const ins = await h.host.document.mutate({
    op: "insertField",
    args: { storyId: story, offset: 0, field: { placeholder: { plugin: PLUGIN, key, value } } },
  });
  expect(ins.applied).toBe(true);
  return story;
}

describe.skipIf(!run)("field offsets against real core [data.lower.v43-consumers]", () => {
  let h: HeadlessHost | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  it("refreshFields writes every field in a story, even when an earlier value grows [data.lower.v43-consumers]", async () => {
    h = await openRealHost();
    const story = await newStory(h);
    const host = h.host;
    // "<k1:x> and <k2:y>": k1 at 0, " and " plain, k2 after it.
    await host.document.mutate({
      op: "insertField",
      args: { storyId: story, offset: 0, field: { placeholder: { plugin: PLUGIN, key: "k1", value: "x" } } },
    });
    await host.document.mutate({ op: "insertText", args: { storyId: story, offset: 1, text: " and " } });
    await host.document.mutate({
      op: "insertField",
      args: { storyId: story, offset: 6, field: { placeholder: { plugin: PLUGIN, key: "k2", value: "y" } } },
    });
    expect((await ours(h)).map((p) => [p.key, p.offset, p.value])).toEqual([
      ["k1", 0, "x"],
      ["k2", 6, "y"],
    ]);

    const values: Record<string, string> = { k1: "a much longer value", k2: "z" };
    const engine = fakeEngine({
      resolve_lowered: (id: string) =>
        id in values ? { kind: "variable", target: id, text: values[id], hidden: false } : null,
    });
    const s = await sessionOver(h, engine);
    s.addVariableBinding("k1", "anchor", "q", "k1");
    s.addVariableBinding("k2", "anchor", "q", "k2");

    const written = await s.refreshFields();
    expect(written).toBe(2);
    const after = await ours(h);
    expect(Object.fromEntries(after.map((p) => [p.key, p.value]))).toEqual({
      k1: "a much longer value",
      k2: "z",
    });
  });

  it("previewRecord re-finds a field that an edit moved, instead of writing a cached offset [data.bind.preview-step]", async () => {
    h = await openRealHost();
    const host = h.host;
    const records = ["ALPHA", "BETA", "GAMMA"];
    const engine = fakeEngine({
      resolve_lowered_at: (id: string, record: number) =>
        id === "v_name"
          ? { kind: "variable", target: "anchor", text: records[record], hidden: false }
          : null,
    });
    await placeField(h, "v_name", "x");
    const s = await sessionOver(h, engine);
    s.addVariableBinding("v_name", "anchor", "q", "name");

    // Record 0 writes the field (a fresh frame, offset 0).
    await s.previewRecord("v_name", 0);
    const placed = await ours(h);
    expect(placed.map((p) => [p.key, p.offset, p.value])).toEqual([["v_name", 0, "ALPHA"]]);

    // Content lands in front of the field (another plugin's field, 8 chars):
    // ours now starts at offset 8. (Plain `insertText` at offset 0 would not
    // do: core's text insert at a run boundary goes INTO the first run, which
    // here is the placeholder itself — a separate core finding.)
    await host.document.mutate({
      op: "insertField",
      args: {
        storyId: placed[0].storyId,
        offset: 0,
        field: { placeholder: { plugin: "other.plugin", key: "label", value: "Product " } },
      },
    });
    expect((await ours(h))[0].offset).toBe(8);

    await s.previewRecord("v_name", 2);
    const after = await ours(h);
    expect(after.map((p) => [p.key, p.offset, p.value])).toEqual([["v_name", 8, "GAMMA"]]);
  });

  it("previewRecord steps do not mint a new frame per step for a placed variable [data.bind.preview-step]", async () => {
    h = await openRealHost();
    const records = ["ALPHA", "BETA", "GAMMA"];
    const engine = fakeEngine({
      resolve_lowered_at: (id: string, record: number) =>
        id === "v_name"
          ? { kind: "variable", target: "anchor", text: records[record], hidden: false }
          : null,
    });
    const s = await sessionOver(h, engine);
    s.addVariableBinding("v_name", "anchor", "q", "name");
    for (const r of [0, 1, 2, 1]) await s.previewRecord("v_name", r);
    const stories = await h.host.document.collection<{ selfId: string }>("stories" as never);
    expect(stories.length).toBe(1);
    // A placeholder field, or (protocol 71) the text variable.
    expect((await dataFields(h.host as never)).map((p) => p.value)).toEqual(["BETA"]);
  });
  it("refreshFields is ONE undo step, and one undo takes every field back [data.lower.v43-consumers]", async () => {
    h = await openRealHost();
    const story = await newStory(h);
    const host = h.host;
    // "<k0:x> <k1:x> <k2:x>": the spaces first, each field inserted into them.
    await host.document.mutate({ op: "insertText", args: { storyId: story, offset: 0, text: "  " } });
    for (const i of [2, 1, 0]) {
      await host.document.mutate({
        op: "insertField",
        args: { storyId: story, offset: i, field: { placeholder: { plugin: PLUGIN, key: `k${i}`, value: "x" } } },
      });
    }
    const values: Record<string, string> = { k0: "first value", k1: "b", k2: "third" };
    const engine = fakeEngine({
      resolve_lowered: (id: string) => ({ kind: "variable", target: id, text: values[id], hidden: false }),
    });
    const s = await sessionOver(h, engine);
    for (const k of Object.keys(values)) s.addVariableBinding(k, "anchor", "q", k);

    const mark = await undoMark(h);
    expect(await s.refreshFields()).toBe(3);
    const text = async () =>
      (await host.document.storyContent(story))?.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("");
    expect(await text()).toBe("first value b third");
    expect(await undoSteps(h, mark)).toBe(1);
    expect((await ours(h)).map((p) => p.value)).toEqual(["x", "x", "x"]);
  });

  it("previewRecord re-uses its field read only while its own write is the only change [data.bind.preview-step]", async () => {
    h = await openRealHost();
    const host = h.host;
    let reads = 0;
    const read = host.document.placeholders.bind(host.document);
    (host.document as { placeholders: unknown }).placeholders = async () => {
      reads += 1;
      return read();
    };
    const records = ["ALPHA", "B", "GAMMA-LONG"];
    const engine = fakeEngine({
      resolve_lowered_at: (id: string, record: number) =>
        id === "v_name" ? { kind: "variable", target: "anchor", text: records[record], hidden: false } : null,
    });
    await placeField(h, "v_name", "x");
    const s = await sessionOver(h, engine);
    s.addVariableBinding("v_name", "anchor", "q", "name");
    reads = 0;
    // Steps with nothing else happening: one read, then the cached address.
    for (const r of [0, 1, 2, 1]) await s.previewRecord("v_name", r);
    expect(reads).toBe(1);
    expect((await ours(h)).map((p) => p.value)).toEqual(["B"]);

    // A second copy of the field in the SAME story: a write to the first
    // moves the second, so every step reads again.
    const [only] = await ours(h);
    await host.document.mutate({
      op: "insertField",
      args: { storyId: only!.storyId, offset: 0, field: { placeholder: { plugin: PLUGIN, key: "v_name", value: "B" } } },
    });
    reads = 0;
    for (const r of [2, 0, 2]) await s.previewRecord("v_name", r);
    expect(reads).toBe(3);
    expect((await ours(h)).map((p) => p.value)).toEqual(["GAMMA-LONG", "GAMMA-LONG"]);
  });

  // DEFECT (core 0.67/0.68, paged-mutate): `insertText` at a placeholder
  // run's START goes INTO that run, so the inserted text becomes part of the
  // field. `setFieldValue` then replaces the run's text with the new display
  // and the inserted text is gone; undoing that write fails with "undo log
  // empty" and drops the history record. The Wave 1 W2 fixture built its
  // separators this way, which read as "the undo history is bounded at 89".
  // FIXED in engine protocol 69 (core ADR 127: typing at a field's edge lands
  // beside the field): passes there, stays pinned on 68.
  fixedFrom(69, it)("DEFECT core <69: text inserted at a field's start joins the field and a field write erases it [data.lower.v43-consumers]", async () => {
    h = await openRealHost();
    const story = await newStory(h);
    const host = h.host;
    for (const i of [1, 0]) {
      await host.document.mutate({
        op: "insertField",
        args: { storyId: story, offset: 0, field: { placeholder: { plugin: PLUGIN, key: `k${i}`, value: "x" } } },
      });
      if (i > 0) await host.document.mutate({ op: "insertText", args: { storyId: story, offset: 0, text: " " } });
    }
    const engine = fakeEngine({
      resolve_lowered: (id: string) => ({ kind: "variable", target: id, text: `${id}-value`, hidden: false }),
    });
    const s = await sessionOver(h, engine);
    s.addVariableBinding("k0", "anchor", "q", "k0");
    s.addVariableBinding("k1", "anchor", "q", "k1");
    const mark = await undoMark(h);
    expect(await s.refreshFields()).toBe(2);
    const text = (await host.document.storyContent(story))?.paragraphs
      .map((p) => p.runs.map((r) => r.text).join(""))
      .join("");
    expect(text).toBe("k0-value k1-value");
    expect(await undoSteps(h, mark)).toBe(1);
  });
});

