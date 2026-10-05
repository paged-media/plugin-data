// The Bindings panel's sync and review surfaces (wave 7), rendered without a
// DOM (the hook store of panels.test.ts): per-binding sync states and the
// pin / unpin / accept-source decisions, the row diff view, the rule editor's
// check + preview + document-style picker, and the per-field format editor.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BundleHost } from "@paged-media/plugin-api";

import type { BindingSync, QueryRowDiff } from "../review";
import type { DataSourceSession, SessionState } from "../session";

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

// A handler fires its async work and returns; let every await in it settle.
const tick = () => new Promise((r) => setTimeout(r, 5));
const find = (tree: El[], attr: string) => tree.find((e) => attr in e.props);
const press = async (tree: El[], attr: string) => {
  (find(tree, attr)!.props.onClick as () => unknown)();
  await tick();
};
const change = (tree: El[], attr: string, value: string) =>
  (find(tree, attr)!.props.onChange as (e: unknown) => void)({ target: { value } });

async function panel(over: Partial<DataSourceSession>, state?: Partial<SessionState>, hostOver = {}) {
  const session = stubSession(over, state);
  const { makeBindingsPanel } = await import("../panels/bindings-panel");
  return makeBindingsPanel({ ...host, ...hostOver } as unknown as BundleHost, session);
}

describe("bindings panel — sync states and decisions [data.bind.sync-review]", () => {
  const rows: BindingSync[] = [
    { id: "v", kind: "variable", status: "pinned", locale: null, format: null },
    { id: "t", kind: "table", status: "overridden", locale: null, format: null },
    { id: "e", kind: "variable", status: "error", locale: "fr", format: null },
    { id: "s", kind: "image", status: "linked", locale: null, format: null },
  ];
  const listed = () => rows.map((r) => ({ id: r.id, kind: r.kind }));

  it("shows each binding's status and offers the decisions that apply [data.bind.sync-review]", async () => {
    const calls: string[] = [];
    const Panel = await panel(
      {
        listBindings: listed,
        bindingSync: async () => rows,
        locales: async () => [],
        pin: async (id: string) => void calls.push(`pin ${id}`),
        unpin: async (id: string) => void calls.push(`unpin ${id}`),
        acceptSource: async (id: string) => (calls.push(`accept ${id}`), true),
      },
      { bindings: rows.map((r) => r.id) },
    );
    let tree = render(Panel);
    await press(tree, "data-data-sync-reload");
    tree = render(Panel);
    const items = tree.filter((e) => e.type === "li" && "data-binding-kind" in e.props);
    const statusOf = (li: El) => {
      const inner: El[] = [];
      const walk = (n: unknown): void => {
        if (n == null || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(walk);
        inner.push(n as El);
        walk((n as El).props?.children);
      };
      walk(li.props.children);
      return {
        status: inner.find((e) => "data-sync-status" in e.props)?.props["data-sync-status"],
        buttons: inner.filter((e) => e.type === "button").map((e) => text(e)),
      };
    };
    expect(items.map(statusOf)).toEqual([
      { status: "pinned", buttons: ["Unpin", "Accept source", "Format…"] },
      { status: "overridden", buttons: ["Accept source"] },
      { status: "error", buttons: ["Pin", "Format…"] },
      { status: "linked", buttons: ["Pin"] },
    ]);
    expect(text(items[0])).toContain("pinned");
    expect(text(items[3])).toContain("synced");
    expect(text(items[2])).toContain("· fr");

    const buttons = tree.filter((e) => e.type === "button");
    for (const label of ["Unpin", "Accept source", "Pin"]) {
      (buttons.find((b) => text(b) === label)!.props.onClick as () => void)();
    }
    await tick();
    expect(calls).toEqual(["unpin v", "accept v", "pin e"]);
  });

  it("a variable field takes a pattern and a locale, and previews the result [data.i18n.locale-table]", async () => {
    const calls: unknown[][] = [];
    const Panel = await panel(
      {
        listBindings: () => [{ id: "v", kind: "variable" }],
        bindingSync: async () => [
          {
            id: "v",
            kind: "variable",
            status: "linked",
            locale: null,
            format: { inner: "price", pattern: { kind: "plain" } },
          },
        ],
        locales: async () => [
          { tag: "en", name: "English", number: "", currency: "$1.00", date: "" },
          { tag: "fr", name: "Français", number: "", currency: "1,00 €", date: "" },
        ],
        getLocale: () => "de",
        setBindingFormat: async (...a: unknown[]) => (calls.push(["format", ...a]), true),
        setBindingLocale: async (...a: unknown[]) => void calls.push(["locale", ...a]),
        previewBinding: async () => "1 234 €",
      },
      { bindings: ["v"] },
    );
    let tree = render(Panel);
    await press(tree, "data-data-sync-reload");
    tree = render(Panel);
    await press(tree, "data-data-format-open");
    tree = render(Panel);
    change(tree, "data-data-format-kind", "currency");
    tree = render(Panel);
    change(tree, "data-data-format-decimals", "0");
    tree = render(Panel);
    change(tree, "data-data-format-locale", "fr");
    tree = render(Panel);
    expect(text(find(tree, "data-data-format-locale"))).toContain("session locale (de)");
    await press(tree, "data-data-format-apply");
    tree = render(Panel);
    expect(calls).toEqual([
      ["format", "v", { kind: "currency", decimals: 0 }],
      ["locale", "v", "fr"],
    ]);
    expect(text(find(tree, "data-data-format-preview"))).toContain("1 234 €");
  });
});

describe("bindings panel — the row diff view [data.bind.row-diff]", () => {
  const diff: QueryRowDiff = {
    query: "q_all",
    key: ["sku"],
    baseline: false,
    columns: ["sku", "name", "price"],
    insertedCount: 1,
    removedCount: 1,
    updatedCount: 1,
    unchanged: 4,
    inserted: [{ index: 5, key: "d4", values: ["d4", "Dates", "2"] }],
    removed: [{ index: 2, key: "c3", values: ["c3", "Cheese", "9"] }],
    updated: [{ index: 1, key: "b2", changes: [{ column: "price", before: "4", after: "6.5" }] }],
    changedColumns: ["price"],
    affected: [{ binding: "v_price", kind: "variable", reason: "reads price which changed" }],
  };

  it("lists added, removed and changed rows and the bindings they reach [data.bind.row-diff]", async () => {
    const keys: unknown[][] = [];
    const Panel = await panel({
      refreshData: async () => {},
      refreshDiff: async () => ({ entries: [], changed: 0, unchanged: 0, added: 0, removed: 0 }),
      rowDiff: async () => [diff],
      bindingSync: async () => [],
      locales: async () => [],
      setDiffKey: (...a: unknown[]) => void keys.push(a),
    });
    let tree = render(Panel);
    const what = tree.find((e) => e.type === "button" && text(e) === "What changed?")!;
    (what.props.onClick as () => void)();
    await tick();
    tree = render(Panel);
    const q = find(tree, "data-row-diff-query")!;
    expect(text(q)).toContain("+1 added · −1 removed · 1 changed · 4 unchanged");
    const lines = tree.filter((e) => "data-row-change" in e.props).map((e) => [e.props["data-row-change"], text(e)]);
    expect(lines).toEqual([
      ["updated", "~ b2: price 4 → 6.5"],
      ["inserted", "+ d4: d4 · Dates · 2"],
      ["removed", "− c3: c3 · Cheese · 9"],
    ]);
    expect(text(find(tree, "data-row-affected"))).toBe("v_price (variable) — reads price which changed");
    // Re-keying asks the session to match rows by another column.
    change(tree, "data-row-diff-key", "name");
    await tick();
    expect(keys).toEqual([["q_all", ["name"]]]);
  });
});

describe("bindings panel — the rule editor [data.rule.authoring]", () => {
  async function ruleEditor(over: Partial<DataSourceSession>, hostOver = {}) {
    const Panel = await panel({ addQuery: () => {}, ...over }, {}, hostOver);
    let tree = render(Panel);
    change(tree, "data-data-bind-kind", "rule");
    tree = render(Panel);
    return Panel;
  }

  it("shows a condition that does not parse, and where a usable one fires [data.rule.authoring]", async () => {
    let ok = false;
    const Panel = await ruleEditor({
      checkExpression: async () =>
        ok
          ? { ok: true, fields: ["price"], unknownFields: [] }
          : { ok: false, error: "unexpected end of expression", fields: [], unknownFields: [] },
      previewCondition: async () => ({ fires: [0, 2], total: 3 }),
    });
    let tree = render(Panel);
    change(tree, "data-data-bind-field", "price <");
    tree = render(Panel);
    await press(tree, "data-data-rule-preview");
    tree = render(Panel);
    expect(text(find(tree, "data-data-rule-preview-out"))).toBe("unexpected end of expression");
    ok = true;
    change(tree, "data-data-bind-field", "price < 5");
    tree = render(Panel);
    await press(tree, "data-data-rule-preview");
    tree = render(Panel);
    expect(text(find(tree, "data-data-rule-preview-out"))).toBe("fires on 2 of 3 records: #1, #3");
  });

  it("does not define a rule whose condition reads a field the data lacks [data.rule.authoring]", async () => {
    const calls: unknown[][] = [];
    const Panel = await ruleEditor(
      {
        checkExpression: async () => ({
          ok: false,
          error: "no such field: stock",
          fields: ["stock"],
          unknownFields: ["stock"],
        }),
        addRuleBinding: (...a: unknown[]) => void calls.push(a),
      },
      {
        text: { caret: () => ({ storyId: "s1", offset: 0 }) },
        document: { storyContent: async () => ({ selfId: "s1", paragraphs: [{ runs: [{ text: "x" }] }] }) },
      },
    );
    let tree = render(Panel);
    change(tree, "data-data-bind-field", "stock < 5");
    change(tree, "data-data-bind-rule-style", "ParagraphStyle/Low");
    tree = render(Panel);
    await press(tree, "data-data-bind-add");
    tree = render(Panel);
    expect(calls).toEqual([]);
    expect(text(find(tree, "data-data-bind-msg"))).toMatch(/no such field: stock/);
  });

  it("picks a paragraph style from the document and styles one paragraph per record [data.rule.authoring]", async () => {
    const calls: unknown[][] = [];
    const kinds: string[] = [];
    const Panel = await ruleEditor(
      {
        documentStyles: async (kind: string) => {
          kinds.push(kind);
          return [
            { selfId: "ParagraphStyle/Body", name: "Body" },
            { selfId: "ParagraphStyle/Low", name: "Low stock" },
          ];
        },
        checkExpression: async () => ({ ok: true, fields: ["stock"], unknownFields: [] }),
        addRuleBinding: (...a: unknown[]) => void calls.push(a),
      },
      {
        // The caret is in the second paragraph ("Bb|b").
        text: { caret: () => ({ storyId: "s1", offset: 4 }) },
        document: {
          storyContent: async () => ({
            selfId: "s1",
            paragraphs: [{ runs: [{ text: "Aa" }] }, { runs: [{ text: "Bbb" }] }, { runs: [{ text: "Cc" }] }],
          }),
        },
      },
    );
    let tree = render(Panel);
    change(tree, "data-data-bind-field", "stock < 5");
    change(tree, "data-data-bind-rule-action", "paragraphStyle");
    await tick();
    tree = render(Panel);
    expect(kinds).toEqual(["paragraph"]);
    const styleSelect = find(tree, "data-data-bind-rule-style")!;
    expect(styleSelect.type).toBe("select");
    change(tree, "data-data-bind-rule-style", "ParagraphStyle/Low");
    change(tree, "data-data-bind-rule-scope", "paragraphs");
    tree = render(Panel);
    await press(tree, "data-data-bind-add");
    tree = render(Panel);
    expect(calls).toHaveLength(1);
    const [, , query, when, apply, target] = calls[0];
    expect([query, when, apply, target]).toEqual([
      "q_all",
      "stock < 5",
      { action: "paragraphStyle", name: "ParagraphStyle/Low" },
      { kind: "storyParagraphs", storyId: "s1", firstParagraph: 1 },
    ]);
    expect(text(find(tree, "data-data-bind-msg"))).toMatch(/Low stock on the paragraph of each record/);
  });
});
