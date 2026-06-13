// The v43 consumer lanes wired through the SESSION against a capturing fake host
// + a fake engine (the host-model translation is proven pure in
// data-host-model/fields.test.ts; the REAL engine in
// test-integration/pipeline.e2e.mjs Part D). This pins the bundle ORCHESTRATION:
//   D-01 in-text variables — place a field once, refresh re-resolves changed values
//   D-14 image bindings    — placeImage onto the bound rectangle, with fit
//   D-12 record-flow live  — paginate over the live frameChain + reflow re-split
//   D-13 rules application  — evaluate_rule → per-cell appliedCellStyle mutations

import { describe, expect, it, vi } from "vitest";

import type { BundleHost, Mutation } from "@paged-media/plugin-api";

import type { DataEngineLike } from "../engine";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** A capturing fake host: records every mutation, serves placeholders/frameChain/
 *  geometry from in-memory fixtures, and a `supports` allow-list. */
function fakeHost(opts?: {
  supports?: (f: string) => boolean;
  placeholders?: () => { storyId: string; offset: number; plugin: string; key: string; value: string | null }[];
  frameChain?: () => { frameId: string; next: string | null; overflow: boolean }[];
  geometry?: (id: string) => [number, number, number, number];
}) {
  const mutations: Mutation[] = [];
  let changeListener: ((e: { reflow?: unknown }) => void) | null = null;
  const host = {
    manifest: { id: "media.paged.data", version: "0.0.1" },
    log: silent,
    supports: (f: string) => (opts?.supports ? opts.supports(f) : true),
    selection: { get: () => [], set: async () => [] },
    network: { consentedOrigins: () => [], requestConsent: async () => ({ granted: [], denied: [] }) },
    document: {
      mutate: async (m: Mutation) => {
        mutations.push(m);
        // A freshly inserted frame mints a createdId so commitLoweredVariable can
        // resolve a story from a new frame when selection is empty.
        if (m.op === "insertTextFrame") {
          return { applied: true, createdId: { kind: "textFrame", id: "frame-new" }, pageIds: [] };
        }
        return { applied: true, createdId: null, pageIds: [] };
      },
      placeholders: async () => opts?.placeholders?.() ?? [],
      frameChain: async () => opts?.frameChain?.() ?? [],
      elementGeometry: async (ids: { id: string }[]) =>
        ids.map((i) => ({
          id: { kind: "textFrame", id: i.id },
          pageId: "p1",
          bounds: opts?.geometry?.(i.id) ?? [0, 0, 100, 200],
        })),
      hitTest: async () => ({ storyId: "story-new" }),
      meta: async () => ({ activePage: "p1" }),
      collection: async () => [{ selfId: "p1" }],
      onDidChange: (l: (e: { reflow?: unknown }) => void) => {
        changeListener = l;
        return { dispose() { changeListener = null; } };
      },
    },
  } as unknown as BundleHost;
  return {
    host,
    mutations,
    fireReflow: () => changeListener?.({ reflow: { frameId: "f0", contentBox: [0, 0, 80, 200] } }),
    fireTransformOnly: () => changeListener?.({}),
  };
}

/** A fake engine the session boots in place of the wasm (bootEngine is mocked). */
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

/** Boot the session with a stubbed engine (no wasm). */
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

describe("data_lower_variable_field session lane (D-01)", () => {
  it("places a variable field once, then refresh re-resolves only changed values", async () => {
    const fields = [
      { storyId: "s1", offset: 0, plugin: "media.paged.data", key: "v_price", value: "old" },
    ];
    const fake = fakeHost({ placeholders: () => fields });
    const engine = fakeEngine({
      resolve_lowered: (id: string) =>
        id === "v_price" ? { kind: "variable", text: "€ 9,99", hidden: false } : null,
    });
    const s = await sessionWith(fake.host, engine);
    s.addVariableBinding("v_price", "anchor", "q1", "CURRENCY(price)");
    await s.lowerBinding("v_price"); // first lower → insertField
    const inserted = fake.mutations.find((m) => m.op === "insertField");
    expect(inserted).toBeDefined();
    expect((inserted as { args: { field: { placeholder: { key: string } } } }).args.field.placeholder.key).toBe(
      "v_price",
    );

    // Refresh: the resolved value (€ 9,99) differs from the field value (old) → setFieldValue.
    const written = await s.refreshFields();
    expect(written).toBe(1);
    const set = fake.mutations.find((m) => m.op === "setFieldValue");
    expect((set as { args: { value: string | null } }).args.value).toBe("€ 9,99");
  });

  it("refreshFields is a no-op when the host lacks document.placeholders@1", async () => {
    const fake = fakeHost({ supports: (f) => f !== "document.placeholders@1" });
    const s = await sessionWith(fake.host, fakeEngine());
    expect(await s.refreshFields()).toBe(0);
  });
});

describe("data_lower_image_place session lane (D-14)", () => {
  it("places the resolved image onto the bound rectangle with the chosen fit", async () => {
    const fake = fakeHost();
    const engine = fakeEngine({
      resolve_lowered: () => ({
        kind: "image",
        target: "urect",
        reference: { ref: "uri", uri: "https://x/y.png" },
        fit: "fill",
        status: "present",
      }),
    });
    const s = await sessionWith(fake.host, engine);
    s.addImageBinding("img1", "urect", "q1", "photo", { fit: "FillProportionally" });
    await s.lowerBinding("img1");
    const place = fake.mutations.find((m) => m.op === "placeImage");
    expect((place as { args: { elementId: string; uri: string; fit: string } }).args).toEqual({
      elementId: "urect",
      uri: "https://x/y.png",
      fit: "FillProportionally",
    });
  });

  it("skips placement honestly for a missing reference (no fake placeImage)", async () => {
    const fake = fakeHost();
    const engine = fakeEngine({
      resolve_lowered: () => ({
        kind: "image",
        target: "urect",
        reference: { ref: "none" },
        fit: "fit",
        status: "skipped",
      }),
    });
    const s = await sessionWith(fake.host, engine);
    s.addImageBinding("img1", "urect", "q1", "photo");
    await s.lowerBinding("img1");
    expect(fake.mutations.find((m) => m.op === "placeImage")).toBeUndefined();
  });
});

describe("data_lower_recordflow_live session lane (D-12)", () => {
  it("paginates over the live frame chain (frameChain + content-box heights)", async () => {
    const chainSeen: unknown[] = [];
    const fake = fakeHost({
      frameChain: () => [
        { frameId: "f0", next: "f1", overflow: false },
        { frameId: "f1", next: null, overflow: true },
      ],
      geometry: (id) => (id === "f0" ? [0, 0, 200, 300] : [0, 0, 150, 300]),
    });
    const engine = fakeEngine({
      lower_record_flow: (_b: string, chain: unknown) => {
        chainSeen.push(chain);
        return { frames: [{ frame: "f0", page: "p1", blocks: [], usedPt: 0 }], overflow: false, placed: 1, total: 1 };
      },
    });
    const s = await sessionWith(fake.host, engine);
    const flow = await s.paginateChain("rf1", "story-1");
    expect((flow as { frames: unknown[] }).frames).toHaveLength(1);
    // The live chain carries each frame's content-box height (bottom − top).
    expect(chainSeen[0]).toEqual([
      { frame: "f0", page: "p1", heightPt: 200 },
      { frame: "f1", page: "p1", heightPt: 150 },
    ]);
  });

  it("re-paginates on a reflow event, ignores a transform-only change", async () => {
    const repaginations: unknown[] = [];
    const fake = fakeHost({
      frameChain: () => [{ frameId: "f0", next: null, overflow: false }],
      geometry: () => [0, 0, 100, 200],
    });
    const engine = fakeEngine({
      lower_record_flow: () => ({ frames: [], overflow: false, placed: 0, total: 0 }),
    });
    const s = await sessionWith(fake.host, engine);
    const sub = s.subscribeChainReflow("rf1", "story-1", (f) => repaginations.push(f));
    fake.fireTransformOnly(); // no reflow → ignored
    await Promise.resolve();
    expect(repaginations).toHaveLength(0);
    fake.fireReflow(); // resize → re-paginate
    await new Promise((r) => setTimeout(r, 0));
    expect(repaginations).toHaveLength(1);
    sub.dispose();
  });
});

describe("data_lower_rule session lane (D-13)", () => {
  it("evaluates a rule and applies appliedCellStyle per fired cell", async () => {
    const fake = fakeHost();
    const engine = fakeEngine({
      evaluate_rule: () => ({
        scope: "table-region",
        fires: [0, 2],
        apply: { action: "tableStyle", name: "low-stock" },
        total: 3,
      }),
    });
    const s = await sessionWith(fake.host, engine);
    s.addRuleBinding(
      "r1",
      "table-region",
      "q1",
      "stock < 5",
      { action: "tableStyle", name: "low-stock" },
      { kind: "tableColumn", storyId: "s1", tableId: "t1", col: 1, headerRows: 1 },
    );
    const applied = await s.applyRule("r1");
    expect(applied).toBe(2);
    // createCellStyle once + a batch of 2 appliedCellStyle setElementProperty ops.
    expect(fake.mutations.find((m) => m.op === "createCellStyle")).toBeDefined();
    const batch = fake.mutations.find((m) => m.op === "batch") as
      | { args: { ops: { op: string; args: { path: string } }[] } }
      | undefined;
    expect(batch?.args.ops).toHaveLength(2);
    expect(batch?.args.ops.every((o) => o.op === "setElementProperty" && o.args.path === "appliedCellStyle")).toBe(
      true,
    );
  });
});
