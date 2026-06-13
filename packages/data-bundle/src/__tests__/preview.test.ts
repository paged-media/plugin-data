// The §9 record-preview stepper wired through the SESSION against a capturing
// fake host + a fake engine (the per-record resolve is proven in Rust:
// data-conformance/tests/bind.rs::data_bind_preview_step_record). This pins the
// bundle ORCHESTRATION: recordCount reads the engine's "of N" bound, and
// previewRecord resolves a binding against the chosen record index and commits
// it through the SAME lower lanes a normal lower uses (so preview == output).

import { describe, expect, it, vi } from "vitest";

import type { BundleHost, Mutation } from "@paged-media/plugin-api";

import type { DataEngineLike } from "../engine";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function fakeHost() {
  const mutations: Mutation[] = [];
  const host = {
    manifest: { id: "media.paged.data", version: "0.0.1" },
    log: silent,
    supports: () => true,
    selection: { get: () => [], set: async () => [] },
    network: { consentedOrigins: () => [], requestConsent: async () => ({ granted: [], denied: [] }) },
    document: {
      mutate: async (m: Mutation) => {
        mutations.push(m);
        if (m.op === "insertTextFrame") {
          return { applied: true, createdId: { kind: "textFrame", id: "frame-new" }, pageIds: [] };
        }
        return { applied: true, createdId: null, pageIds: [] };
      },
      placeholders: async () => [],
      frameChain: async () => [],
      elementGeometry: async (ids: { id: string }[]) =>
        ids.map((i) => ({ id: { kind: "textFrame", id: i.id }, pageId: "p1", bounds: [0, 0, 100, 200] })),
      hitTest: async () => ({ storyId: "story-new" }),
      meta: async () => ({ activePage: "p1" }),
      collection: async () => [{ selfId: "p1" }],
      onDidChange: () => ({ dispose() {} }),
    },
  } as unknown as BundleHost;
  return { host, mutations };
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
    evaluate_rule: () => ({ scope: "x", fires: [], apply: { action: "tableStyle", name: "s" }, total: 0 }),
    lower_record_flow: () => ({ frames: [], overflow: false, placed: 0, total: 0 }),
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

describe("data_bind_preview_step session lane (§9)", () => {
  it("recordCount reads the engine's of-N bound", async () => {
    const fake = fakeHost();
    const engine = fakeEngine({ query_record_count: (q: string) => (q === "q_all" ? 5 : 0) });
    const s = await sessionWith(fake.host, engine);
    expect(await s.recordCount("q_all")).toBe(5);
    expect(await s.recordCount("other")).toBe(0);
  });

  it("recordCount degrades to 0 when the wasm predates the lane", async () => {
    const fake = fakeHost();
    const engine = fakeEngine(); // no query_record_count
    const s = await sessionWith(fake.host, engine);
    expect(await s.recordCount("q_all")).toBe(0);
  });

  it("previewRecord resolves a variable binding against the chosen record index", async () => {
    const fake = fakeHost();
    const seen: number[] = [];
    const engine = fakeEngine({
      resolve_lowered_at: (id: string, record: number) => {
        seen.push(record);
        return id === "v_name"
          ? { kind: "variable", text: ["ALPHA", "BETA", "GAMMA"][record] ?? "", hidden: false }
          : null;
      },
    });
    const s = await sessionWith(fake.host, engine);
    s.addVariableBinding("v_name", "anchor", "q_all", "UPPER(name)");

    // First preview (record 0) places the field with the previewed value.
    await s.previewRecord("v_name", 0);
    const inserted = fake.mutations.find((m) => m.op === "insertField") as
      | { args: { field: { placeholder: { value?: string } } } }
      | undefined;
    expect(inserted?.args.field.placeholder.value).toBe("ALPHA");

    // Stepping to record 2 re-resolves the SAME field to that record's value.
    await s.previewRecord("v_name", 2);
    const set = fake.mutations.filter((m) => m.op === "setFieldValue").at(-1) as
      | { args: { value: string | null } }
      | undefined;
    expect(set?.args.value).toBe("GAMMA");
    expect(seen).toEqual([0, 2]);
  });

  it("previewRecord falls back to the record-0 resolve when the wasm predates the lane", async () => {
    const fake = fakeHost();
    let calledAt = false;
    const engine = fakeEngine({
      // no resolve_lowered_at — the session must use resolve_lowered
      resolve_lowered: () => {
        calledAt = true;
        return { kind: "variable", text: "ZERO", hidden: false };
      },
    });
    const s = await sessionWith(fake.host, engine);
    s.addVariableBinding("v0", "anchor", "q_all", "name");
    await s.previewRecord("v0", 3);
    expect(calledAt).toBe(true);
    const inserted = fake.mutations.find((m) => m.op === "insertField") as
      | { args: { field: { placeholder: { value?: string } } } }
      | undefined;
    expect(inserted?.args.field.placeholder.value).toBe("ZERO");
  });

  it("previewRecord on a barcode uses lower_barcode_at against the chosen record", async () => {
    const fake = fakeHost();
    const seen: number[] = [];
    const engine = fakeEngine({
      lower_barcode_at: (_id: string, record: number) => {
        seen.push(record);
        return {
          target: "rect-1",
          symbology: "ean-13",
          modules: [{ xPt: 0, yPt: 0, wPt: 1, hPt: 10 }],
          text: "",
        };
      },
    } as Partial<DataEngineLike>);
    const s = await sessionWith(fake.host, engine);
    s.addBarcodeBinding("bc1", "rect-1", "q_all", "ean13", "ean", { missing: "skip" });
    await s.previewRecord("bc1", 4);
    expect(seen).toEqual([4]);
    expect(fake.mutations.find((m) => m.op === "batch")).toBeDefined();
  });
});
