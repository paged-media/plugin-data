// Wave 0 data bugs (c) and (d), over a capturing fake host + fake engine.
//
// (c) ADR 553: a refresh never overwrites a Pinned or Overridden binding. The
//     engine's own guard covers only the set_result transition; resolve_at
//     re-links whatever it resolves. So the refresh loop must read the sync
//     state BEFORE it resolves, and skip the field without resolving it.
// (d) Failures the session used to swallow into a log line become visible
//     diagnostics on the session state, which the panels render.

import { describe, expect, it, vi } from "vitest";

import type { BundleHost, Mutation } from "@paged-media/plugin-api";

import type { DataEngineLike } from "../engine";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

type Field = { storyId: string; offset: number; plugin: string; key: string; value: string | null };

function fakeHost(opts?: { placeholders?: () => Field[] | Promise<Field[]> }) {
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
        return { applied: true, createdId: null, pageIds: [] };
      },
      placeholders: async () => (opts?.placeholders ? await opts.placeholders() : []),
      frameChain: async () => [],
      elementGeometry: async () => [],
      hitTest: async () => null,
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

async function sessionWith(
  host: BundleHost,
  engine: DataEngineLike | (() => Promise<DataEngineLike>),
  duck?: { registerCsv: (n: string, t: string) => Promise<void> },
) {
  vi.resetModules();
  vi.doMock("../engine", async (orig) => ({
    ...(await orig<typeof import("../engine")>()),
    bootEngine: typeof engine === "function" ? engine : async () => engine,
  }));
  vi.doMock("../query/duckdb", async (orig) => ({
    ...(await orig<typeof import("../query/duckdb")>()),
    bootDuckDB: async () => ({
      registerCsv: duck?.registerCsv ?? (async () => {}),
      registerFileBuffer: async () => {},
      query: async () => ({}),
      close: async () => {},
    }),
  }));
  const { createSession } = await import("../session");
  return createSession(host, 20613);
}

const field = (key: string, offset: number, value: string | null, storyId = "s1"): Field => ({
  storyId,
  offset,
  plugin: "media.paged.data",
  key,
  value,
});

const variable = (text: string) => ({ kind: "variable", target: "anchor", text, hidden: false });

describe("refreshFields honours sync state (ADR 553) [data.bind.engine]", () => {
  for (const status of ["overridden", "pinned"] as const) {
    it(`skips a ${status} field and does not resolve it [data.bind.engine]`, async () => {
      const fake = fakeHost({ placeholders: () => [field("kept", 0, "edited by hand"), field("live", 20, "old")] });
      const resolved: string[] = [];
      const engine = fakeEngine({
        sync_state: (id: string) => (id === "kept" ? { status, last_resolved: null } : { status: "stale" }),
        resolve_lowered: (id: string) => {
          resolved.push(id);
          return variable(`new ${id}`);
        },
      });
      const s = await sessionWith(fake.host, engine);
      s.addVariableBinding("kept", "anchor", "q", "a");
      s.addVariableBinding("live", "anchor", "q", "b");

      const written = await s.refreshFields();

      expect(written).toBe(1);
      expect(resolved).toEqual(["live"]); // resolving would have re-linked it
      expect(fake.mutations).toEqual([
        { op: "setFieldValue", args: { storyId: "s1", offset: 20, value: "new live" } },
      ]);
      expect(s.getState().message).toMatch(/1 .*(pinned|overridden)/i);
    });
  }

  it("leaves a written field Linked: it does not call relink (which marks Stale) [data.bind.engine]", async () => {
    const fake = fakeHost({ placeholders: () => [field("v", 0, "old")] });
    const relinked: string[] = [];
    const engine = fakeEngine({
      resolve_lowered: () => variable("new"),
      relink: (id: string) => void relinked.push(id),
    });
    const s = await sessionWith(fake.host, engine);
    s.addVariableBinding("v", "anchor", "q", "x");
    expect(await s.refreshFields()).toBe(1);
    expect(relinked).toEqual([]);
  });
});

describe("refreshFields writes back to front off one read [data.lower.v43-consumers]", () => {
  it("orders writes per story by descending offset [data.lower.v43-consumers]", async () => {
    const fake = fakeHost({
      placeholders: () => [
        field("a", 0, "1"),
        field("b", 10, "2"),
        field("c", 3, "3", "s2"),
        field("a", 25, "1"),
      ],
    });
    const engine = fakeEngine({ resolve_lowered: (id: string) => variable(`${id}-new`) });
    const s = await sessionWith(fake.host, engine);
    for (const id of ["a", "b", "c"]) s.addVariableBinding(id, "anchor", "q", id);
    expect(await s.refreshFields()).toBe(4);
    const order = fake.mutations.map((m) => {
      const a = (m as { args: { storyId: string; offset: number } }).args;
      return `${a.storyId}@${a.offset}`;
    });
    expect(order).toEqual(["s1@25", "s1@10", "s1@0", "s2@3"]);
  });
});

describe("swallowed errors become session diagnostics [data.plugin.bundle]", () => {
  it("a failed CSV import is a diagnostic, not only a log line [data.plugin.bundle]", async () => {
    const fake = fakeHost();
    const s = await sessionWith(fake.host, fakeEngine(), {
      registerCsv: async () => {
        throw new Error("CSV parse error at line 3");
      },
    });
    await s.registerCsvSource("people", "a,b\n1");
    const st = s.getState();
    expect(st.status).toBe("error");
    expect(st.diagnostics.map((d) => [d.source, d.level])).toContainEqual(["import", "error"]);
    expect(st.diagnostics.at(-1)?.message).toMatch(/people.*CSV parse error at line 3/);
  });

  it("refreshFields reports a placeholders() failure [data.plugin.bundle]", async () => {
    const fake = fakeHost({
      placeholders: () => {
        throw new Error("worker gone");
      },
    });
    const s = await sessionWith(fake.host, fakeEngine());
    expect(await s.refreshFields()).toBe(0);
    expect(s.getState().diagnostics.at(-1)).toMatchObject({ source: "refresh", level: "error" });
    expect(s.getState().diagnostics.at(-1)?.message).toMatch(/worker gone/);
  });

  it("refreshFields reports an engine that will not boot [data.plugin.bundle]", async () => {
    const fake = fakeHost({ placeholders: () => [field("v", 0, "x")] });
    const s = await sessionWith(fake.host, async () => {
      throw new Error("data-js wasm not built");
    });
    expect(await s.refreshFields()).toBe(0);
    expect(s.getState().diagnostics.at(-1)).toMatchObject({ source: "refresh", level: "error" });
  });

  it("refreshFields names a binding that does not resolve [data.plugin.bundle]", async () => {
    const fake = fakeHost({ placeholders: () => [field("broken", 0, "x"), field("ok", 5, "y")] });
    const engine = fakeEngine({
      resolve_lowered: (id: string) => {
        if (id === "broken") throw new Error("no result ingested for query 'q'");
        return variable("ok-new");
      },
    });
    const s = await sessionWith(fake.host, engine);
    s.addVariableBinding("broken", "anchor", "q", "a");
    s.addVariableBinding("ok", "anchor", "q", "b");
    expect(await s.refreshFields()).toBe(1);
    const d = s.getState().diagnostics.find((x) => x.binding === "broken");
    expect(d).toMatchObject({ source: "refresh", level: "warn" });
    expect(d?.message).toMatch(/no result ingested/);
  });

  it("refreshFields reports a field write the host rejected [data.plugin.bundle]", async () => {
    const fake = fakeHost({ placeholders: () => [field("v", 0, "x")] });
    (fake.host.document as { mutate: unknown }).mutate = async () => ({ applied: false, error: "no placeholder field at offset 0" });
    const s = await sessionWith(fake.host, fakeEngine({ resolve_lowered: () => variable("y") }));
    s.addVariableBinding("v", "anchor", "q", "a");
    expect(await s.refreshFields()).toBe(0);
    expect(s.getState().diagnostics.find((x) => x.binding === "v")?.message).toMatch(/rejected/);
  });

  it("variables() reports an engine boot failure and a throwing read [data.dataset.palette]", async () => {
    const boot = await sessionWith(fakeHost().host, async () => {
      throw new Error("data-js wasm not built");
    });
    expect(await boot.variables()).toEqual([]);
    expect(boot.getState().diagnostics.at(-1)).toMatchObject({ source: "variables", level: "error" });

    const throwing = await sessionWith(
      fakeHost().host,
      fakeEngine({
        variables: () => {
          throw new Error("serializer failed");
        },
      }),
    );
    expect(await throwing.variables()).toEqual([]);
    expect(throwing.getState().diagnostics.at(-1)?.message).toMatch(/serializer failed/);
  });

  it("an empty variable expression is flagged when the binding is defined [data.bind.authoring]", async () => {
    const s = await sessionWith(fakeHost().host, fakeEngine());
    s.addVariableBinding("v_demo", "anchor", "q", "");
    expect(s.getState().diagnostics.at(-1)).toMatchObject({ source: "binding", binding: "v_demo", level: "warn" });
  });
});
