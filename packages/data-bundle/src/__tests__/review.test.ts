// The session's sync decisions and review lanes (wave 7) over a capturing fake
// host + fake engine: accept-source relinks then writes the source value even
// though the binding was overridden; a display pattern or locale is written
// now unless the binding is frozen; the row diff gets the rule→query map and
// the chosen keys; a lower records what the document was written from.

import { describe, expect, it, vi } from "vitest";

import type { BundleHost, Mutation } from "@paged-media/plugin-api";

import type { DataEngineLike } from "../engine";
import { decodeSession, encodeSession, emptyTargets } from "../persist";

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

describe("accept source [data.bind.sync-review]", () => {
  it("relinks an overridden variable and writes the source value into its field [data.bind.sync-review]", async () => {
    const fake = fakeHost({ placeholders: () => [field("v", 3, "typed by hand")] });
    const log: string[] = [];
    let status = "overridden";
    const engine = fakeEngine({
      sync_state: () => ({ status }),
      relink: (id: string) => {
        log.push(`relink ${id}`);
        status = "stale";
      },
      resolve_lowered: (id: string) => {
        log.push(`resolve ${id} (${status})`);
        return variable("from source");
      },
    });
    const s = await sessionWith(fake.host, engine);
    s.addVariableBinding("v", "anchor", "q", "name");
    expect(await s.acceptSource("v")).toBe(true);
    expect(log).toEqual(["relink v", "resolve v (stale)"]);
    expect(fake.mutations).toEqual([
      { op: "setFieldValue", args: { storyId: "s1", offset: 3, value: "from source" } },
    ]);
  });

  it("pin and unpin are the engine's pin and relink [data.bind.sync-review]", async () => {
    const fake = fakeHost();
    const log: string[] = [];
    const engine = fakeEngine({
      pin: (id: string) => void log.push(`pin ${id}`),
      relink: (id: string) => void log.push(`relink ${id}`),
    });
    const s = await sessionWith(fake.host, engine);
    s.addVariableBinding("v", "anchor", "q", "name");
    await s.recordCount("q"); // boot the engine
    await s.pin("v");
    await s.unpin("v");
    expect(log).toEqual(["pin v", "relink v"]);
  });
});

describe("display pattern and locale per field [data.i18n.locale-table]", () => {
  for (const status of ["linked", "pinned"] as const) {
    it(`a pattern rewrites the expression and writes the field unless frozen (${status}) [data.i18n.locale-table]`, async () => {
      const fake = fakeHost({ placeholders: () => [field("v", 0, "1234.5")] });
      const defined: unknown[] = [];
      const engine = fakeEngine({
        sync_state: () => ({ status }),
        payload: () => ({
          bindings: [{ id: "v", kind: "variable", target: "anchor", query: "q", expr: "price" }],
        }),
        split_expression: (src: string) => ({ inner: src, pattern: { kind: "plain" } }),
        format_expression: (inner: string, p: unknown) =>
          `CURRENCY(${inner}, ${(p as { decimals: number }).decimals})`,
        define_binding: (d: unknown) => void defined.push(d),
        resolve_lowered: () => variable("$1,235"),
      });
      const s = await sessionWith(fake.host, engine);
      await s.recordCount("q");
      defined.length = 0;
      expect(await s.setBindingFormat("v", { kind: "currency", decimals: 0 })).toBe(true);
      expect(defined).toEqual([
        { id: "v", kind: "variable", target: "anchor", query: "q", expr: "CURRENCY(price, 0)" },
      ]);
      expect(fake.mutations).toEqual(
        status === "linked"
          ? [{ op: "setFieldValue", args: { storyId: "s1", offset: 0, value: "$1,235" } }]
          : [],
      );
    });
  }

  it("a binding locale goes to the engine; an unknown one is reported [data.i18n.locale-table]", async () => {
    const fake = fakeHost();
    const set: unknown[][] = [];
    const engine = fakeEngine({
      set_binding_locale: (id: string, tag: string | null) => {
        if (tag === "xx") throw new Error("unknown locale 'xx'");
        set.push([id, tag]);
      },
    });
    const s = await sessionWith(fake.host, engine);
    await s.setBindingLocale("v", "fr");
    await s.setBindingLocale("v", null);
    await s.setBindingLocale("v", "xx");
    expect(set).toEqual([
      ["v", "fr"],
      ["v", null],
    ]);
    expect(s.getState().diagnostics.map((d) => d.message).join()).toMatch(/unknown locale 'xx'/);
  });

  it("the session locale is any tag the engine knows, saved as it is [data.i18n.locale-table]", () => {
    const bytes = encodeSession({
      v: 1,
      engine: null,
      locale: "de-CH",
      sync: [{ binding: "v", status: "overridden" }],
      targets: emptyTargets(),
      data: [],
      remote: [],
    });
    const back = decodeSession(bytes);
    expect(back).toMatchObject({ locale: "de-CH", sync: [{ binding: "v", status: "overridden" }] });
  });
});

describe("row diff lane [data.bind.row-diff]", () => {
  it("passes the chosen keys and each rule's query; a lower marks the rows applied [data.bind.row-diff]", async () => {
    const fake = fakeHost();
    const log: unknown[] = [];
    const engine = fakeEngine({
      row_diff: (opts: unknown) => (log.push(opts), []),
      mark_rows_applied: () => void log.push("applied"),
    });
    const s = await sessionWith(fake.host, engine);
    s.addRuleBinding("r", "r", "q_all", "price < 5", { action: "tableStyle", name: "x" }, {
      kind: "tableColumn",
      storyId: "s",
      tableId: "t",
      col: 0,
      headerRows: 1,
    });
    s.setDiffKey("q_all", ["sku"]);
    await s.rowDiff();
    await s.lowerAll();
    expect(log[0]).toEqual({ keys: { q_all: ["sku"] }, ruleQueries: { r: "q_all" } });
    expect(log).toContain("applied");
  });
});
