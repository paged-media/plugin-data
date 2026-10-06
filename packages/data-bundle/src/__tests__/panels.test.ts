// The panels, rendered without a DOM: `useState` is swapped for a tiny
// re-renderable hook store, the component is called as a function, and the
// returned element tree is walked (function components such as the diagnostics
// list are expanded; they hold no hooks). Enough to press a button, type into
// an input, and read what the panel shows.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BundleHost } from "@paged-media/plugin-api";

import type { DataProviderPublication, DataSourceSession, SessionState } from "../session";

// ── the hook store ───────────────────────────────────────────────────────────
const slots: unknown[] = [];
let cursor = 0;
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  useState: (init: unknown) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (v: unknown) => {
      slots[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(slots[i]) : v;
    };
    return [slots[i], set];
  },
  // No renderer here: effects (the session subscription) do not run.
  useEffect: () => {},
}));

type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

function render(component: () => unknown): El[] {
  cursor = 0;
  const out: El[] = [];
  const walk = (n: unknown): void => {
    if (n == null || typeof n === "boolean" || typeof n === "string" || typeof n === "number") return;
    if (Array.isArray(n)) return n.forEach(walk);
    const el = n as El;
    if (typeof el.type === "function") return walk((el.type as (p: unknown) => unknown)(el.props));
    out.push(el);
    walk(el.props?.children);
  };
  walk(component());
  return out;
}

const text = (n: unknown): string =>
  n == null || typeof n === "boolean"
    ? ""
    : typeof n === "string" || typeof n === "number"
      ? String(n)
      : Array.isArray(n)
        ? n.map(text).join("")
        : text((n as El).props?.children);

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function stubSession(over: Partial<DataSourceSession>, state?: Partial<SessionState>): DataSourceSession {
  const base: SessionState = {
    status: "ready",
    message: "",
    sources: ["people"],
    queries: [],
    bindings: [],
    remote: [],
    diagnostics: [],
    persistence: { status: "saved", hash: null },
    files: [],
    refresh: {},
    polling: [],
    ...state,
  };
  return new Proxy(over as DataSourceSession, {
    get(target, key) {
      if (key in target) return (target as unknown as Record<string | symbol, unknown>)[key];
      if (key === "getState") return () => base;
      return () => undefined;
    },
  });
}

const host = {
  log: silent,
  supports: () => true,
  selection: { get: () => [] },
} as unknown as BundleHost;

beforeEach(() => {
  slots.length = 0;
});

describe("bindings panel [data.bind.authoring]", () => {
  it("a variable binding gets the chosen field as its expression, not an empty one [data.bind.authoring]", async () => {
    const calls: unknown[][] = [];
    const session = stubSession({
      addQuery: () => {},
      addVariableBinding: (...a: unknown[]) => void calls.push(a),
    });
    const { makeBindingsPanel } = await import("../panels/bindings-panel");
    const Panel = makeBindingsPanel(host, session);

    let tree = render(Panel);
    const input = tree.find((e) => "data-data-bind-field" in e.props)!;
    (input.props.onChange as (e: unknown) => void)({ target: { value: "unit_price" } });
    tree = render(Panel);
    const add = tree.find((e) => "data-data-bind-add" in e.props)!;
    (add.props.onClick as () => void)();

    expect(calls).toHaveLength(1);
    const [, , query, expr] = calls[0];
    expect(query).toBe("q_all");
    expect(expr).toBe("unit_price");
  });

  it("\"Bind to data…\" completes the editor's draft into a property binding [data.bind.property]", async () => {
    const calls: unknown[][] = [];
    let draft: unknown = { selector: "rectangle:u9", path: "frameFillColor", schema: '{"path":"frameFillColor","type":{"kind":"color"}}' };
    const session = stubSession(
      {
        getPropertyDraft: () => draft as never,
        setPropertyDraft: (d: unknown) => void (draft = d),
        addPropertyBinding: async (...a: unknown[]) => (calls.push(a), { ok: true }),
        applyProperties: async () => ({ applied: 1, undoSteps: 1, skipped: {}, written: {}, calls: 2 }),
      } as never,
      { queries: ["q"] },
    );
    const { makeBindingsPanel } = await import("../panels/bindings-panel");
    const Panel = makeBindingsPanel(host, session);
    let tree = render(Panel);
    expect(text(tree.find((e) => "data-data-bind-property" in e.props))).toContain("frameFillColor");
    (tree.find((e) => "data-data-bind-property-expr" in e.props)!.props.onChange as (e: unknown) => void)({ target: { value: "tint" } });
    tree = render(Panel);
    await (tree.find((e) => "data-data-bind-property-define" in e.props)!.props.onClick as () => Promise<void>)();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual({
      target: "rectangle:u9",
      path: "frameFillColor",
      query: "q",
      expr: "tint",
      schema: '{"path":"frameFillColor","type":{"kind":"color"}}',
    });
    expect(draft).toBeNull();
  });

  it("shows the session's refresh/binding diagnostics [data.plugin.bundle]", async () => {
    const session = stubSession(
      {},
      {
        diagnostics: [
          { level: "error", source: "import", message: "bad csv" },
          { level: "warn", source: "refresh", binding: "v_price", message: "did not resolve" },
        ],
      },
    );
    const { makeBindingsPanel } = await import("../panels/bindings-panel");
    const tree = render(makeBindingsPanel(host, session));
    const items = tree.filter((e) => e.type === "li" && "data-source" in e.props).map((e) => text(e));
    expect(items).toEqual(["refresh · v_price: did not resolve"]);
  });
});

describe("sources panel [data.plugin.bundle]", () => {
  it("shows a failed import [data.plugin.bundle]", async () => {
    const session = stubSession(
      {},
      { status: "error", diagnostics: [{ level: "error", source: "import", message: 'Import of "x" failed: bad csv' }] },
    );
    const { makeSourcesPanel } = await import("../panels/sources-panel");
    const tree = render(makeSourcesPanel(host, session));
    const items = tree.filter((e) => e.type === "li" && "data-source" in e.props).map((e) => text(e));
    expect(items).toEqual(['import: Import of "x" failed: bad csv']);
  });
});

describe("dataset panel provider note [data.provider.contract]", () => {
  const pub: DataProviderPublication = {
    id: "q_all-dataset",
    category: "dataset",
    revision: "r1",
    schema: { fields: [] },
    rowCount: 0,
    records: null,
  };

  for (const registered of [true, false]) {
    it(`says "can't share" only when registration did not happen (registered=${registered}) [data.provider.contract]`, async () => {
      const session = stubSession(
        {
          publishProvider: async () => pub,
          isProviderRegistered: () => registered,
          listBindings: () => [],
        },
        { queries: ["q_all"] },
      );
      const { makeDatasetPanel } = await import("../panels/dataset-panel");
      const Panel = makeDatasetPanel(host, session);
      let tree = render(Panel);
      const publish = tree.find((e) => e.type === "button" && /publish/i.test(text(e)))!;
      await (publish.props.onClick as () => Promise<void>)();
      tree = render(Panel);
      const all = tree.map((e) => (typeof e.props.children === "string" ? e.props.children : "")).join("\n");
      expect(/can't share/.test(all)).toBe(!registered);
      expect(all).toContain('Provider "q_all-dataset"');
    });
  }
});

describe("bindings panel — every binding kind is reachable [data.bind.authoring]", () => {
  async function author(
    kind: string,
    field: string,
    over: Partial<DataSourceSession>,
    hostOver: Record<string, unknown> = {},
    extra: (tree: El[]) => void = () => {},
  ): Promise<string | undefined> {
    const session = stubSession({ addQuery: () => {}, ...over });
    const { makeBindingsPanel } = await import("../panels/bindings-panel");
    const Panel = makeBindingsPanel({ ...host, ...hostOver } as unknown as BundleHost, session);
    let tree = render(Panel);
    (tree.find((e) => "data-data-bind-kind" in e.props)!.props.onChange as (e: unknown) => void)({
      target: { value: kind },
    });
    tree = render(Panel);
    (tree.find((e) => "data-data-bind-field" in e.props)!.props.onChange as (e: unknown) => void)({
      target: { value: field },
    });
    tree = render(Panel);
    extra(tree);
    tree = render(Panel);
    (tree.find((e) => "data-data-bind-add" in e.props)!.props.onClick as () => void)();
    await new Promise((r) => setTimeout(r, 0));
    tree = render(Panel);
    const msg = tree.find((e) => "data-data-bind-msg" in e.props);
    return msg ? text(msg) : undefined;
  }

  it("a table binding takes its columns from the comma-separated fields [data.bind.authoring]", async () => {
    const calls: unknown[][] = [];
    await author("table", "sku, price", { addTableBinding: (...a: unknown[]) => void calls.push(a) });
    expect(calls).toHaveLength(1);
    expect(calls[0][3]).toEqual([
      { header: "sku", expr: "sku" },
      { header: "price", expr: "price" },
    ]);
  });

  it("a show/hide binding binds the selected element, with its kind and invert [data.bind.authoring]", async () => {
    const calls: unknown[][] = [];
    const msg = await author(
      "visibility",
      "discontinued",
      { addVisibilityBinding: (...a: unknown[]) => void calls.push(a) },
      { selection: { get: () => [{ kind: "oval", id: "u9" }] } },
      (tree) =>
        (tree.find((e) => "data-data-bind-invert" in e.props)!.props.onChange as (e: unknown) => void)({
          target: { checked: true },
        }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(1)).toEqual(["u9", "q_all", "discontinued", { invert: true, kind: "oval" }]);
    expect(msg).toMatch(/hidden when true/);
  });

  it("a show/hide binding with nothing selected says what is missing [data.bind.authoring]", async () => {
    const calls: unknown[][] = [];
    const msg = await author("visibility", "x", { addVisibilityBinding: (...a: unknown[]) => void calls.push(a) });
    expect(calls).toHaveLength(0);
    expect(msg).toMatch(/select the frame/);
  });

  it("a style rule over the caret's story applies the named style [data.bind.authoring]", async () => {
    const calls: unknown[][] = [];
    await author(
      "rule",
      "stock < 5",
      { addRuleBinding: (...a: unknown[]) => void calls.push(a) },
      {
        text: { caret: () => ({ storyId: "s1", offset: 2 }) },
        document: {
          storyContent: async () => ({ selfId: "s1", paragraphs: [{ runs: [{ text: "Hello" }, { text: "!" }] }] }),
        },
      },
      (tree) =>
        (tree.find((e) => "data-data-bind-rule-style" in e.props)!.props.onChange as (e: unknown) => void)({
          target: { value: "Low stock" },
        }),
    );
    expect(calls).toHaveLength(1);
    const [, , query, when, apply, target] = calls[0];
    expect([query, when, apply, target]).toEqual([
      "q_all",
      "stock < 5",
      { action: "characterStyle", name: "Low stock" },
      { kind: "storyRange", storyId: "s1", start: 0, end: 6 },
    ]);
  });

  it("a cell-style rule on a selected table cell targets its column [data.bind.authoring]", async () => {
    const calls: unknown[][] = [];
    await author(
      "rule",
      "stock < 5",
      { addRuleBinding: (...a: unknown[]) => void calls.push(a) },
      { selection: { get: () => [{ kind: "tableCell", id: { story_id: "s1", table_id: "t1", row: 2, col: 3 } }] } },
      (tree) => {
        (tree.find((e) => "data-data-bind-rule-style" in e.props)!.props.onChange as (e: unknown) => void)({
          target: { value: "Alert" },
        });
        (tree.find((e) => "data-data-bind-rule-action" in e.props)!.props.onChange as (e: unknown) => void)({
          target: { value: "tableStyle" },
        });
      },
    );
    expect(calls[0][5]).toEqual({ kind: "tableColumn", storyId: "s1", tableId: "t1", col: 3, headerRows: 1 });
  });

  it("a record flow is defined with its fields and grouping [data.bind.authoring]", async () => {
    const calls: unknown[][] = [];
    await author(
      "recordFlow",
      "sku, price",
      { defineRecordFlow: (...a: unknown[]) => void calls.push(a) },
      {},
      (tree) =>
        (tree.find((e) => "data-data-bind-group-by" in e.props)!.props.onChange as (e: unknown) => void)({
          target: { value: "region" },
        }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(1)).toEqual(["q_all", [{ expr: "sku" }, { expr: "price" }], { groupBy: ["region"] }]);
  });

  it("a record flow lists its preview [data.bind.authoring]", async () => {
    const session = stubSession(
      {
        listBindings: () => [{ id: "rf", kind: "recordFlow" }],
        refreshData: async () => {},
        previewRecordFlow: async () => ({
          total: 2,
          blocks: [
            { kind: "header", text: "North" },
            { kind: "record", text: "A-1 · 9.99" },
          ],
        }),
      },
      { bindings: ["rf"] },
    );
    const { makeBindingsPanel } = await import("../panels/bindings-panel");
    const Panel = makeBindingsPanel(host, session);
    let tree = render(Panel);
    (tree.find((e) => "data-data-flow-preview" in e.props)!.props.onClick as () => void)();
    await new Promise((r) => setTimeout(r, 0));
    tree = render(Panel);
    expect(tree.filter((e) => "data-flow-block" in e.props).map((e) => text(e))).toEqual(["North", "A-1 · 9.99"]);
  });
});

describe("sources panel says whether the session is saved [data.plugin.persistence]", () => {
  it.each([
    ["saved", /saved with the document/],
    ["unavailable", /cannot save/],
  ] as const)("%s", async (status, re) => {
    const session = stubSession({}, { persistence: { status, hash: null } });
    const { makeSourcesPanel } = await import("../panels/sources-panel");
    const tree = render(makeSourcesPanel(host, session));
    const p = tree.find((e) => "data-data-persistence" in e.props)!;
    expect(text(p)).toMatch(re);
  });
});
