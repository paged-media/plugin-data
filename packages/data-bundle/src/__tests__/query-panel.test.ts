// Wave 6 panels — the Data query panel and the Sources panel's import /
// worksheet / refresh-policy controls — rendered without a DOM, the same
// hook-store harness as panels.test.ts: `useState` is a re-renderable store,
// the component is called as a function, the element tree is walked.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BundleHost } from "@paged-media/plugin-api";

import type { DataSourceSession, QueryPreview, SessionState } from "../session";

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
  shell: { pickFile: async () => [] },
} as unknown as BundleHost;

const flush = () => new Promise((r) => setTimeout(r, 0));
const find = (tree: El[], attr: string, value?: unknown) =>
  tree.find((e) => attr in e.props && (value === undefined || e.props[attr] === value))!;
const change = (el: El, value: string) =>
  (el.props.onChange as (e: unknown) => void)({ target: { value } });
const click = (el: El) => (el.props.onClick as () => void)();

beforeEach(() => {
  slots.length = 0;
});

describe("data query panel [data.query.seam]", () => {
  it("builders write SQL from the source's columns; preview shows the grid [data.query.seam]", async () => {
    const previews: [string, number | undefined][] = [];
    const preview: QueryPreview = {
      columns: [
        { name: "sku", type: "VARCHAR" },
        { name: "price", type: "DOUBLE" },
      ],
      rows: [["A-1", "9.99"], ["B-2", null]],
      total: 7,
      diagnostic: null,
    };
    const session = stubSession(
      {
        describeSource: async () => [
          { name: "sku", type: "VARCHAR" },
          { name: "price", type: "DOUBLE" },
        ],
        previewQuery: async (sql: string, limit?: number) => {
          previews.push([sql, limit]);
          return preview;
        },
      },
      { sources: ["products"] },
    );
    const { makeQueryPanel, PREVIEW_ROWS } = await import("../panels/query-panel");
    const Panel = makeQueryPanel(host, session);
    let tree = render(Panel);
    click(find(tree, "data-data-query-columns"));
    await flush();
    tree = render(Panel);
    click(find(tree, "data-data-query-add-filter"));
    tree = render(Panel);
    // filter: price > 5
    const filterRow = find(tree, "data-data-query-filter", 0);
    const [colSel] = (filterRow.props.children as El[]).filter((c) => c && c.type === "select");
    change(colSel, "price");
    tree = render(Panel);
    change((find(tree, "data-data-query-filter", 0).props.children as El[]).filter((c) => c && c.type === "select")[1], ">");
    tree = render(Panel);
    change((find(tree, "data-data-query-filter", 0).props.children as El[]).find((c) => c && c.type === "input")!, "5");
    tree = render(Panel);
    click(find(tree, "data-data-query-add-sort"));
    tree = render(Panel);
    click(find(tree, "data-data-query-build"));
    tree = render(Panel);
    expect(find(tree, "data-data-query-sql").props.value).toBe(
      'SELECT *\nFROM "products"\nWHERE "price" > 5\nORDER BY "sku" ASC',
    );

    click(find(tree, "data-data-query-preview"));
    await flush();
    tree = render(Panel);
    expect(previews).toEqual([['SELECT *\nFROM "products"\nWHERE "price" > 5\nORDER BY "sku" ASC', PREVIEW_ROWS]]);
    const grid = find(tree, "data-data-query-grid");
    expect(text(grid)).toContain("2 of 7 row(s)");
    const cells = tree.filter((e) => e.type === "td").map((e) => text(e));
    expect(cells).toEqual(["A-1", "9.99", "B-2", "NULL"]);
    const heads = tree.filter((e) => e.type === "th").map((e) => [text(e), e.props.title]);
    expect(heads).toEqual([["sku", "VARCHAR"], ["price", "DOUBLE"]]);
  });

  it("a refused or failing query shows DuckDB's class and position; a good one saves under its id [data.query.seam]", async () => {
    const saves: [string, string][] = [];
    let verdict: unknown = { kind: "Binder", message: 'column "nope" not found', line: 2, column: 3 };
    const session = stubSession(
      {
        saveQuery: async (id: string, sql: string) => {
          saves.push([id, sql]);
          return verdict as never;
        },
        listQueries: () => [{ id: "cheap", sql: "SELECT 1" }],
      },
      { sources: ["products"], queries: ["cheap"] },
    );
    const { makeQueryPanel } = await import("../panels/query-panel");
    const Panel = makeQueryPanel(host, session);
    let tree = render(Panel);
    change(find(tree, "data-data-query-sql"), "SELECT sku,\n  nope FROM products");
    tree = render(Panel);
    click(find(tree, "data-data-query-save"));
    await flush();
    tree = render(Panel);
    expect(text(find(tree, "data-data-query-diagnostic"))).toBe(
      'Binder (line 2, column 3): column "nope" not found',
    );
    verdict = null;
    change(find(tree, "data-data-query-id"), "mine");
    tree = render(Panel);
    click(find(tree, "data-data-query-save"));
    await flush();
    tree = render(Panel);
    expect(saves.map(([id]) => id)).toEqual(["q", "mine"]);
    expect(text(find(tree, "data-data-query-saved"))).toBe("Saved as mine.");
    // A saved query loads back into the field.
    click(find(tree, "data-data-query-load", "cheap"));
    tree = render(Panel);
    expect(find(tree, "data-data-query-sql").props.value).toBe("SELECT 1");
    expect(find(tree, "data-data-query-id").props.value).toBe("cheap");
  });
});

describe("sources panel — files, worksheets, refresh policy [data.source.adapters]", () => {
  it("lists each file with its format; a workbook offers its worksheets; policies are set and refusals shown [data.source.adapters]", async () => {
    const sheets: [string, string][] = [];
    const policies: [string, unknown][] = [];
    const session = stubSession(
      {
        selectSheet: async (s: string, sh: string) => {
          sheets.push([s, sh]);
          return { source: s, format: "xlsx" };
        },
        setRefreshPolicy: (s: string, p: unknown) => {
          policies.push([s, p]);
          return "a local file cannot be watched from the browser";
        },
      },
      {
        sources: ["book", "items"],
        files: [
          { source: "book", format: "xlsx", fileName: "book.xlsx", sheet: "Products", sheets: ["Products", "Prices"] },
          { source: "items", format: "json", fileName: "items.json" },
        ],
      },
    );
    const { makeSourcesPanel } = await import("../panels/sources-panel");
    const Panel = makeSourcesPanel(host, session);
    let tree = render(Panel);
    expect(text(find(tree, "data-data-source", "items"))).toContain("json · items.json");
    change(find(tree, "data-data-sheet", "book"), "Prices");
    await flush();
    expect(sheets).toEqual([["book", "Prices"]]);
    const picker = find(tree, "data-data-refresh-policy", "items");
    const sel = (picker.props.children as El[]).find((c) => c && c.type === "select")!;
    // A local file offers no interval.
    expect((sel.props.children as El[]).flat().filter(Boolean).map((o) => (o as El).props.value)).toEqual([
      "manual",
      "onOpen",
      "never",
    ]);
    change(sel, "onOpen");
    tree = render(Panel);
    expect(policies).toEqual([["items", { policy: "onOpen" }]]);
    expect(text(find(tree, "data-data-policy-note"))).toMatch(/cannot be watched/);
    expect(find(tree, "data-data-import-file")).toBeDefined();
  });
});
