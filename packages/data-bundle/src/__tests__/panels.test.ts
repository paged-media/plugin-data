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
