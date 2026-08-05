// The §9.8 visibility lane and the §9.9 data-set lane wired through the SESSION
// against a capturing fake host + a fake engine. The pure translation is proven
// in data-host-model/src/__tests__/variables.test.ts; this pins the bundle
// ORCHESTRATION and, above all, the two claims that are only true end-to-end:
//
//   1. the C-9 caret decides WHERE a new variable field lands — both branches;
//   2. switching a data set costs the user ONE undo step, MEASURED as the count
//      of `host.document.mutate` calls the session makes.

import { describe, expect, it, vi } from "vitest";

import type { BundleHost, Mutation } from "@paged-media/plugin-api";

import type { DataEngineLike } from "../engine";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

interface FakeOpts {
  supports?: (f: string) => boolean;
  caret?: () => { storyId: string; offset: number } | null;
  /** Omit the caret member entirely — a host that reports the capability but
   *  injects no reader (the real degrade path, not a hypothetical). */
  noCaretMember?: boolean;
  placeholders?: () => {
    storyId: string;
    offset: number;
    plugin: string;
    key: string;
    value: string | null;
  }[];
  tree?: () => unknown[];
  selection?: () => { kind: string; id: string }[];
}

/** A capturing fake host. `mutations` records every mutation; `mutateCalls`
 *  counts the CALLS — which is the undo-step count, the thing a batch
 *  collapses and a per-op loop does not. */
function fakeHost(opts?: FakeOpts) {
  const mutations: Mutation[] = [];
  let mutateCalls = 0;
  const text: Record<string, unknown> = {
    measureString: async () => ({ advance: 0, ascender: 0, descender: 0 }),
  };
  if (!opts?.noCaretMember) text.caret = () => opts?.caret?.() ?? null;

  const host = {
    manifest: { id: "media.paged.data", version: "0.0.1" },
    log: silent,
    supports: (f: string) => (opts?.supports ? opts.supports(f) : true),
    selection: { get: () => opts?.selection?.() ?? [], set: async () => [] },
    network: { consentedOrigins: () => [], requestConsent: async () => ({ granted: [], denied: [] }) },
    text,
    document: {
      mutate: async (m: Mutation) => {
        mutateCalls += 1;
        mutations.push(m);
        if (m.op === "insertTextFrame") {
          return { applied: true, createdId: { kind: "textFrame", id: "frame-new" }, pageIds: [] };
        }
        return { applied: true, createdId: null, pageIds: [] };
      },
      placeholders: async () => opts?.placeholders?.() ?? [],
      frameChain: async () => [],
      tree: async () => opts?.tree?.() ?? [],
      elementGeometry: async (ids: { id: string }[]) =>
        ids.map((i) => ({ id: { kind: "textFrame", id: i.id }, pageId: "p1", bounds: [0, 0, 100, 200] })),
      hitTest: async () => ({ storyId: "story-new" }),
      meta: async () => ({ activePage: "p1" }),
      collection: async () => [{ selfId: "p1" }],
      onDidChange: () => ({ dispose() {} }),
    },
  } as unknown as BundleHost;
  return { host, mutations, calls: () => mutateCalls };
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
    lower_barcode: () => null,
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
    bootDuckDB: async () => ({
      registerCsv: async () => {},
      query: async () => ({}),
      close: async () => {},
    }),
  }));
  const { createSession: make } = await import("../session");
  return make(host, 20613);
}

// ── §9.8 — the visibility variable ──────────────────────────────────────────

describe("data_lower_visibility session lane (§9.8)", () => {
  it("writes elementVisible on the bound element", async () => {
    const fake = fakeHost();
    const engine = fakeEngine({
      resolve_lowered: () => ({ kind: "visibility", target: "u77", visible: false }),
    });
    const s = await sessionWith(fake.host, engine);
    s.addVisibilityBinding("Badge", "u77", "q1", "in_stock", { kind: "rectangle" });
    await s.lowerBinding("Badge");

    expect(fake.mutations).toEqual([
      {
        op: "setElementProperty",
        args: {
          elementId: { kind: "rectangle", id: "u77" },
          path: "elementVisible",
          value: { type: "bool", value: false },
        },
      },
    ]);
  });

  it("resolves the element KIND from the scene tree when the caller has none", async () => {
    const fake = fakeHost({
      tree: () => [
        {
          kind: "page",
          label: "1",
          children: [
            { id: { kind: "textFrame", id: "u10" }, kind: "textFrame", label: "t" },
            { id: { kind: "oval", id: "u77" }, kind: "oval", label: "o" },
          ],
        },
      ],
    });
    const engine = fakeEngine({
      resolve_lowered: () => ({ kind: "visibility", target: "u77", visible: true }),
    });
    const s = await sessionWith(fake.host, engine);
    s.addVisibilityBinding("Badge", "u77", "q1", "in_stock"); // no kind given
    await s.lowerBinding("Badge");
    expect(fake.mutations[0]).toMatchObject({
      args: { elementId: { kind: "oval", id: "u77" } },
    });
  });

  it("writes NOTHING for the Leave policy and nothing for a vanished element", async () => {
    // Leave ⇒ visible null ⇒ no write at all.
    const leave = fakeHost();
    const s1 = await sessionWith(
      leave.host,
      fakeEngine({
        resolve_lowered: () => ({ kind: "visibility", target: "u77", visible: null }),
      }),
    );
    s1.addVisibilityBinding("Badge", "u77", "q1", "in_stock", { missing: "leave" });
    await s1.lowerBinding("Badge");
    expect(leave.calls()).toBe(0);

    // The bound element is gone (empty scene tree) and no kind was cached ⇒
    // skip, never guess an ElementId kind and write at a wrong address.
    const gone = fakeHost({ tree: () => [] });
    const s2 = await sessionWith(
      gone.host,
      fakeEngine({
        resolve_lowered: () => ({ kind: "visibility", target: "u404", visible: true }),
      }),
    );
    s2.addVisibilityBinding("Badge", "u404", "q1", "in_stock");
    await s2.lowerBinding("Badge");
    expect(gone.calls()).toBe(0);
  });
});

// ── C-9 — the caret decides where a NEW field lands (the D-01 residual) ─────

describe("data_lower_variable_caret placement (C-9 / the D-01 residual)", () => {
  const engine = () =>
    fakeEngine({
      resolve_lowered: () => ({ kind: "variable", text: "Alpha", hidden: false }),
    });

  it("inserts AT THE CARET when the host carries the C-9 door", async () => {
    const fake = fakeHost({ caret: () => ({ storyId: "s7", offset: 42 }) });
    const s = await sessionWith(fake.host, engine());
    s.addVariableBinding("Name", "anchor", "q1", "name");
    await s.lowerBinding("Name");

    const inserted = fake.mutations.find((m) => m.op === "insertField") as {
      args: { storyId: string; offset: number };
    };
    expect(inserted.args).toMatchObject({ storyId: "s7", offset: 42 });
    // ...and it did NOT need to mint a frame: ONE mutate call, one undo step.
    expect(fake.calls()).toBe(1);
  });

  it("falls back to story start when the host reports the door but injects none", async () => {
    // The exact shape of an out-of-date host: supports() says yes (or the
    // capability list is stale) but host.text has no caret member.
    const fake = fakeHost({ noCaretMember: true, selection: () => [{ kind: "textFrame", id: "f1" }] });
    const s = await sessionWith(fake.host, engine());
    s.addVariableBinding("Name", "anchor", "q1", "name");
    await s.lowerBinding("Name");
    const inserted = fake.mutations.find((m) => m.op === "insertField") as {
      args: { storyId: string; offset: number };
    };
    expect(inserted.args.offset).toBe(0);
  });

  it("falls back to story start when the host does not support text.caret@1", async () => {
    const fake = fakeHost({
      supports: (f) => f !== "text.caret@1",
      // A caret reader is PRESENT but uncapable-gated — it must not be consulted.
      caret: () => ({ storyId: "s7", offset: 42 }),
      selection: () => [{ kind: "textFrame", id: "f1" }],
    });
    const s = await sessionWith(fake.host, engine());
    s.addVariableBinding("Name", "anchor", "q1", "name");
    await s.lowerBinding("Name");
    const inserted = fake.mutations.find((m) => m.op === "insertField") as {
      args: { storyId: string; offset: number };
    };
    expect(inserted.args.offset).toBe(0);
  });

  it("ignores a caret that is in a DIFFERENT story than the pinned one", async () => {
    // A cell-qualified caret answers null by contract; a caret in another story
    // answers a real offset that would be nonsense here. Both must not leak.
    const fake = fakeHost({ caret: () => ({ storyId: "elsewhere", offset: 99 }) });
    const s = await sessionWith(fake.host, engine());
    const { commitLoweredVariable } = await import("../lower");
    const placed = await commitLoweredVariable(
      fake.host,
      { kind: "variable", target: "a", text: "x", hidden: false },
      "Name",
      "pinned-story",
    );
    expect(placed).toEqual({ storyId: "pinned-story", offset: 0 });
    void s;
  });

  it("MEASURES the two-step cost of the mint-a-frame path (RFI D-16)", async () => {
    // No caret, no selection ⇒ the bundle mints a frame, then inserts the field.
    // That is TWO mutate calls = two undo steps, and `bindCreated` cannot
    // collapse it: it names a created ELEMENT id, and `insertField` addresses a
    // STORY, which the new frame mints and which has no handle spelling.
    const fake = fakeHost({ caret: () => null, selection: () => [] });
    const s = await sessionWith(fake.host, engine());
    s.addVariableBinding("Name", "anchor", "q1", "name");
    await s.lowerBinding("Name");
    expect(fake.mutations.map((m) => m.op)).toEqual(["insertTextFrame", "insertField"]);
    expect(fake.calls()).toBe(2);
  });
});

// ── §9.9 — the data-set lane ────────────────────────────────────────────────

describe("data_dataset_apply session lane (§9.9)", () => {
  const applies = [
    { variable: "Name", kind: "text", text: "Beta", applicable: true },
    { variable: "Photo", kind: "image", href: "images/beta.png", applicable: true },
    { variable: "Badge", kind: "visibility", visible: false, applicable: true },
  ];

  function engineWithSets() {
    return fakeEngine({
      variables: () => ({
        name: "binding1",
        variables: [
          { name: "Name", trait: "textcontent" },
          { name: "Photo", trait: "filereference" },
          { name: "Badge", trait: "visibility" },
        ],
        dataSets: [],
      }),
      capture_data_set: () => ({ name: "Alpha", values: {} }),
      capture_every_record: () => ["Alpha", "Beta"],
      list_data_sets: () => ["Alpha", "Beta"],
      delete_data_set: () => true,
      apply_data_set: () => applies,
      export_variable_library: () => "<svg/>",
      import_variable_library: () => ({
        setName: "binding1",
        variables: 3,
        dataSets: 2,
        unbound: ["Orphan"],
        graphOnly: ["Sales"],
      }),
      data_set_payload_bytes: () => 1234,
    });
  }

  async function wired() {
    const fake = fakeHost({
      placeholders: () => [
        { storyId: "s1", offset: 12, plugin: "media.paged.data", key: "Name", value: "Alpha" },
      ],
    });
    const s = await sessionWith(fake.host, engineWithSets());
    s.addVariableBinding("Name", "anchor", "q1", "name");
    s.addImageBinding("Photo", "u55", "q1", "photo");
    s.addVisibilityBinding("Badge", "u77", "q1", "in_stock", { kind: "rectangle" });
    return { fake, s };
  }

  it("MEASURES the undo cost: switching a data set is ONE mutate call", async () => {
    const { fake, s } = await wired();
    const result = await s.applyDataSet("Beta");

    expect(result.applied).toBe(3);
    expect(result.skipped).toEqual({});
    // THREE variables moved. The host was asked ONCE. That is one undo step.
    expect(fake.calls()).toBe(1);
    expect(fake.mutations[0].op).toBe("batch");
    const ops = (fake.mutations[0].args as { ops: Mutation[] }).ops;
    expect(ops.map((o) => o.op)).toEqual([
      "setFieldValue",
      "placeImage",
      "setElementProperty",
    ]);
  });

  it("reads the placeholder offset FRESH rather than from the place-time cache", async () => {
    const { fake, s } = await wired();
    await s.applyDataSet("Beta");
    const ops = (fake.mutations[0].args as { ops: Mutation[] }).ops;
    // 12 is what placeholders() answers NOW, not the 0 a first insert used.
    expect(ops[0]).toEqual({
      op: "setFieldValue",
      args: { storyId: "s1", offset: 12, value: "Beta" },
    });
  });

  it("skips — with a reason — a variable whose address cannot be resolved", async () => {
    const fake = fakeHost({ placeholders: () => [] }); // the field was never placed
    const s = await sessionWith(fake.host, engineWithSets());
    s.addImageBinding("Photo", "u55", "q1", "photo");
    s.addVisibilityBinding("Badge", "u77", "q1", "in_stock", { kind: "rectangle" });
    const result = await s.applyDataSet("Beta");
    expect(result.applied).toBe(2);
    expect(Object.keys(result.skipped)).toEqual(["Name"]);
    expect(result.skipped.Name).toContain("no placeholder field");
  });

  it("degrades honestly when the engine wasm predates the lane", async () => {
    const fake = fakeHost();
    const s = await sessionWith(fake.host, fakeEngine()); // no variables members
    expect(await s.variables()).toEqual([]);
    expect(await s.listDataSets()).toEqual([]);
    expect(await s.captureDataSet("X")).toEqual([]);
    expect(await s.applyDataSet("X")).toEqual({ applied: 0, skipped: {} });
    expect(await s.exportVariableLibrary()).toBe("");
    expect(await s.dataSetPayloadBytes()).toBe(0);
    // Nothing was written to the document on any of those paths.
    expect(fake.calls()).toBe(0);
    expect(s.getState().message).toContain("predates the variables lane");
  });

  it("marks a variable unbound when nothing in this document binds it", async () => {
    const fake = fakeHost();
    const s = await sessionWith(fake.host, engineWithSets());
    s.addVariableBinding("Name", "anchor", "q1", "name");
    const vars = await s.variables();
    expect(vars.find((v) => v.name === "Name")?.bound).toBe(true);
    expect(vars.find((v) => v.name === "Badge")?.bound).toBe(false);
  });

  it("surfaces the import report's unapplicable variables in the panel message", async () => {
    const fake = fakeHost();
    const s = await sessionWith(fake.host, engineWithSets());
    const report = await s.importVariableLibrary("<svg/>");
    expect(report.unbound).toEqual(["Orphan"]);
    expect(report.graphOnly).toEqual(["Sales"]);
    expect(s.getState().message).toContain("Orphan");
    expect(s.getState().message).toContain("never applied");
    // Import writes NOTHING to the document.
    expect(fake.calls()).toBe(0);
  });

  it("warns before a bulk capture crosses the D-08 payload cap", async () => {
    const fake = fakeHost();
    const engine = engineWithSets();
    (engine as { data_set_payload_bytes?: () => number }).data_set_payload_bytes = () => 60_000;
    const s = await sessionWith(fake.host, engine);
    await s.captureEveryRecord("q1", { nameColumn: "name" });
    expect(s.getState().message).toContain("D-08");
  });
});
