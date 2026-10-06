// The engine-protocol-69 consumers, each over fake hosts on both sides of its
// door: with the door, the protocol-69 path; without it, what the bundle did
// before (src/doors.ts lists the checks).
//
//  1. the session version named in the document label (persistence follows
//     undo), else the session part alone;
//  2. insertField at the caret sends `contentOffset` too;
//  3. merge to a new document through `host.documents`, else refused with
//     the documented gap;
//  4. overset measured in one `measureStrings` call per face, else per word;
//  5. a merge that adds pages as ONE batch (in-batch page handles), else two.

import { describe, expect, it, vi } from "vitest";

import type { BundleHost, Mutation } from "@paged-media/plugin-api";

import { labelMutation, labelRider, labelledVersion, sessionVersionPath } from "../doc-label";
import { documentLabelDoors, documentsDoors, engineHasDocumentLabels, measureStringsDoor } from "../doors";
import type { DataEngineLike } from "../engine";
import { commitLoweredVariable } from "../lower";
import {
  measureWords,
  mergeRecords,
  oneStepMutation,
  type MergeEngine,
  type MergePlan,
  type MergeTemplate,
} from "../merge";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

// ── door detection ──────────────────────────────────────────────────────────

describe("protocol-69 doors are detected without a host call on an older SDK [data.plugin.persistence]", () => {
  it("a 0.2.40-shaped host has none of them and is never asked [data.plugin.persistence]", async () => {
    const calls: string[] = [];
    const host = {
      supports: (f: string) => (calls.push(`supports:${f}`), true),
      document: { meta: async () => (calls.push("meta"), { pluginMetadata: [] }) },
      text: { measureString: async () => ({ advance: 1 }) },
    } as unknown as BundleHost;
    expect(documentLabelDoors(host)).toBeNull();
    expect(documentsDoors(host)).toBeNull();
    expect(measureStringsDoor(host)).toBeNull();
    expect(await engineHasDocumentLabels(host)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("a v69 SDK on a v69 engine has them; on a v68 engine the label is off [data.plugin.persistence]", async () => {
    const v69 = (pluginMetadata: unknown) =>
      ({
        supports: () => true,
        document: {
          meta: async () => ({ activePage: "p1", ...(pluginMetadata ? { pluginMetadata } : {}) }),
          getDocumentMetadata: async () => null,
          setDocumentMetadata: async () => ({ applied: true }),
        },
        documents: { exportPaged: async () => new Uint8Array(), open: async () => ({ opened: true, pageIds: [] }) },
        text: { measureStrings: async () => [] },
      }) as unknown as BundleHost;
    expect(documentLabelDoors(v69([]))).not.toBeNull();
    expect(documentsDoors(v69([]))).not.toBeNull();
    expect(measureStringsDoor(v69([]))).not.toBeNull();
    expect(await engineHasDocumentLabels(v69([]))).toBe(true);
    // The SDK forwards the doors, the engine predates them: no pluginMetadata.
    expect(await engineHasDocumentLabels(v69(null))).toBe(false);
  });
});

// ── 1. the session label ────────────────────────────────────────────────────

function recordingDoc(reply?: (m: Mutation) => { applied: boolean; error?: unknown }) {
  const sent: Mutation[] = [];
  const host = {
    document: {
      mutate: async (m: Mutation) => {
        sent.push(m);
        return reply ? reply(m) : { applied: true, pageIds: [], minted: [] };
      },
      meta: async () => ({}),
    },
  } as unknown as BundleHost;
  return { host, sent };
}

describe("the label rides the document write [data.plugin.persistence]", () => {
  const hash = "0123456789abcdef0123456789abcdef";
  const setField: Mutation = { op: "setFieldValue", args: { storyId: "s", offset: 0, value: "x" } };

  it("appends the pending label to a batch and to a field write, nothing else [data.plugin.persistence]", async () => {
    const rec = recordingDoc();
    let pending: string | null = hash;
    const written: string[] = [];
    const host = labelRider(rec.host, {
      pending: () => pending,
      written: (h) => (written.push(h), (pending = null)),
      refused: () => {},
    });
    await host.document.mutate({ op: "batch", args: { ops: [setField] } } as Mutation);
    expect((rec.sent[0]!.args as { ops: Mutation[] }).ops.map((o) => o.op)).toEqual(["setFieldValue", "setDocumentMetadata"]);
    expect(written).toEqual([hash]);
    // Nothing pending: the write goes as it is.
    await host.document.mutate(setField);
    expect(rec.sent[1]).toEqual(setField);
    // A pending label wraps a single field write; any other single op is left alone.
    pending = hash;
    const other: Mutation = { op: "deleteFrame", args: { frameId: "f" } } as Mutation;
    await host.document.mutate(other);
    expect(rec.sent[2]).toEqual(other);
    await host.document.mutate(setField);
    expect(rec.sent[3]).toEqual({ op: "batch", args: { ops: [setField, labelMutation(hash)] } });
  });

  it("an engine that refuses the label op: the write goes again without it, and the rider stops [data.plugin.persistence]", async () => {
    const rec = recordingDoc((m) =>
      m.op === "batch" ? { applied: false, error: "Mutation::Batch child 1 (setDocumentMetadata): unknown — batch rolled back" } : { applied: true },
    );
    let pending: string | null = hash;
    const host = labelRider(rec.host, { pending: () => pending, written: () => {}, refused: () => (pending = null) });
    const o = await host.document.mutate(setField);
    expect(o.applied).toBe(true);
    expect(rec.sent.map((m) => m.op)).toEqual(["batch", "setFieldValue"]);
    expect(pending).toBeNull();
  });

  it("reads the version a label names, and nothing else [data.plugin.persistence]", () => {
    expect(labelledVersion({ v: 1, data: { session: hash } })).toBe(hash);
    expect(labelledVersion({ v: 1, data: { session: "../x" } })).toBeNull();
    expect(labelledVersion(null)).toBeNull();
    expect(sessionVersionPath(hash)).toBe(`sessions/${hash}.json`);
  });
});

/** A fake engine: only what persistence, refresh and merge touch. */
function fakeEngine(over?: Partial<DataEngineLike>): DataEngineLike {
  const bindings: { id: string }[] = [];
  return {
    define_source() {},
    define_query() {},
    define_binding(def: unknown) {
      bindings.push({ id: String((def as { id?: unknown })?.id ?? bindings.length) });
    },
    define_placeholder() {},
    set_param() {},
    set_locale() {},
    ingest_result() {},
    resolve_lowered: () => null,
    sync_state: () => null,
    sync_report: () => [],
    pin() {},
    mark_overridden() {},
    relink() {},
    payload: () => ({ bindings: [...bindings], queries: [] }),
    load_payload() {},
    free() {},
    ...over,
  } as unknown as DataEngineLike;
}

async function sessionWith(host: BundleHost, engine: DataEngineLike, mergeMock?: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock("../engine", async (orig) => ({
    ...(await orig<typeof import("../engine")>()),
    bootEngine: async () => engine,
  }));
  vi.doMock("../query/duckdb", async (orig) => ({
    ...(await orig<typeof import("../query/duckdb")>()),
    bootDuckDB: async () => ({
      registerCsv: async () => {},
      registerFileBuffer: async () => {},
      query: async () => ({}),
      close: async () => {},
    }),
  }));
  if (mergeMock) {
    vi.doMock("../merge", async (orig) => ({ ...(await orig<typeof import("../merge")>()), ...mergeMock }));
  }
  const { createSession } = await import("../session");
  return createSession(host, 20613);
}

/** A host with container parts, field placeholders and, when `v69`, the
 *  document label doors over an in-memory label that `mutate` writes. */
function labelHost(opts: { v69: boolean; label?: string | null; parts?: Record<string, string> }) {
  const parts = new Map<string, Uint8Array>(
    Object.entries(opts.parts ?? {}).map(([k, v]) => [k, new TextEncoder().encode(v)]),
  );
  let label: string | null = opts.label ?? null;
  const mutations: Mutation[] = [];
  const reads: string[] = [];
  const willSave: (() => Promise<void>)[] = [];
  const changes: ((ev: { kind: string }) => void)[] = [];
  const apply = (m: Mutation) => {
    const ops = m.op === "batch" ? (m.args as { ops: Mutation[] }).ops : [m];
    for (const op of ops) {
      if (op.op === ("setDocumentMetadata" as Mutation["op"])) label = (op.args as { value: string }).value;
    }
  };
  const document: Record<string, unknown> = {
    mutate: async (m: Mutation) => (mutations.push(m), apply(m), { applied: true, pageIds: [], minted: [] }),
    meta: async () => ({ activePage: "p1", ...(opts.v69 ? { pluginMetadata: [] } : {}) }),
    collection: async () => [{ selfId: "p1" }],
    placeholders: async () => [{ storyId: "s1", offset: 0, plugin: "media.paged.data", key: "v", value: "old" }],
    onWillSave: (f: () => Promise<void>) => (willSave.push(f), { dispose() {} }),
    onDidChange: (f: (ev: { kind: string }) => void) => (changes.push(f), { dispose() {} }),
  };
  if (opts.v69) {
    document.getDocumentMetadata = async () => (label ? JSON.parse(label) : null);
    document.setDocumentMetadata = async (env: unknown) => {
      const m = { op: "setDocumentMetadata", args: { key: "x-paged:media.paged.data", value: JSON.stringify(env) } } as unknown as Mutation;
      mutations.push(m);
      apply(m);
      return { applied: true, pageIds: [] };
    };
  }
  const host = {
    manifest: { id: "media.paged.data", version: "0.0.1" },
    log: silent,
    supports: () => true,
    selection: { get: () => [], set: async () => [] },
    network: { consentedOrigins: () => [], requestConsent: async () => ({ granted: [], denied: [] }) },
    parts: {
      write: async (p: string, b: Uint8Array) => void parts.set(p, b),
      read: async (p: string) => (reads.push(p), parts.get(p) ?? null),
      list: async () => [...parts.keys()],
      delete: async (p: string) => void parts.delete(p),
    },
    document,
  } as unknown as BundleHost;
  return {
    host,
    parts,
    mutations,
    reads,
    label: () => (label ? labelledVersion(JSON.parse(label)) : null),
    setLabel: (hash: string | null) => (label = hash ? JSON.stringify({ v: 1, data: { session: hash } }) : null),
    save: async () => {
      for (const f of willSave) await f();
    },
    undo: () => {
      for (const f of changes) f({ kind: "undoApplied" });
    },
  };
}

const variable = (text: string) => ({ kind: "variable", target: "anchor", text, hidden: false });

describe("the session version is named in the document label (protocol 69) [data.plugin.persistence]", () => {
  it("with the doors: each version is its own part, and the refresh that follows carries its label [data.plugin.persistence]", async () => {
    const h = labelHost({ v69: true });
    const s = await sessionWith(h.host, fakeEngine({ resolve_lowered: () => variable("new") }));
    s.addVariableBinding("v", "anchor", "q", "a");
    await s.refreshFields();
    const versions = [...h.parts.keys()].filter((p) => p.startsWith("sessions/"));
    expect(versions).toHaveLength(1);
    expect(h.parts.has("session.json")).toBe(true);
    // The refresh's one write carries the label naming that version.
    const write = h.mutations.at(-1)!;
    expect(write.op).toBe("batch");
    expect((write.args as { ops: Mutation[] }).ops.map((o) => o.op)).toEqual(["setFieldValue", "setDocumentMetadata"]);
    expect(sessionVersionPath(h.label()!)).toBe(versions[0]);
  });

  it("without the doors: the session part alone, the write as before [data.plugin.persistence]", async () => {
    const h = labelHost({ v69: false });
    const s = await sessionWith(h.host, fakeEngine({ resolve_lowered: () => variable("new") }));
    s.addVariableBinding("v", "anchor", "q", "a");
    await s.refreshFields();
    await s.flushPersist();
    expect([...h.parts.keys()].filter((p) => p.startsWith("sessions/"))).toEqual([]);
    expect(h.parts.has("session.json")).toBe(true);
    expect(h.mutations.at(-1)).toEqual({ op: "setFieldValue", args: { storyId: "s1", offset: 0, value: "new" } });
  });

  it("a change no write carried takes no undo step: the part records the label it extends [data.plugin.persistence]", async () => {
    const h = labelHost({ v69: true });
    const s = await sessionWith(h.host, fakeEngine({ resolve_lowered: () => variable("new") }));
    s.addVariableBinding("v", "anchor", "q", "a");
    await s.refreshFields();
    const labelled = h.label()!;
    const writes = h.mutations.length;
    s.addVariableBinding("w", "anchor", "q", "b"); // no document write
    await h.save();
    expect(h.mutations.length).toBe(writes); // nothing written to the document
    expect(h.label()).toBe(labelled);
    const part = JSON.parse(new TextDecoder().decode(h.parts.get("session.json")!));
    expect(part.base).toBe(labelled);
  });

  it("reopen: the part while the label names its base, else the labelled version [data.plugin.persistence]", async () => {
    const base = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const other = "cccccccccccccccccccccccccccccccc";
    const latest = JSON.stringify({ v: 1, engine: { tag: "latest" }, base });
    const versions = { [sessionVersionPath(other)]: JSON.stringify({ v: 1, engine: { tag: "older" } }), "session.json": latest };
    const same = labelHost({ v69: true, label: JSON.stringify({ v: 1, data: { session: base } }), parts: versions });
    await (await sessionWith(same.host, fakeEngine())).restore();
    expect(same.reads).toEqual(["session.json"]);
    const moved = labelHost({ v69: true, label: JSON.stringify({ v: 1, data: { session: other } }), parts: versions });
    await (await sessionWith(moved.host, fakeEngine())).restore();
    expect(moved.reads).toEqual(["session.json", sessionVersionPath(other)]);
  });

  it("restore reads the version the label names before the session part [data.plugin.persistence]", async () => {
    const hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const older = JSON.stringify({ v: 1, engine: { tag: "labelled" }, locale: "de" });
    const latest = JSON.stringify({ v: 1, engine: { tag: "latest" }, locale: "en" });
    const loaded: unknown[] = [];
    const h = labelHost({ v69: true, label: JSON.stringify({ v: 1, data: { session: hash } }), parts: { [sessionVersionPath(hash)]: older, "session.json": latest } });
    const s = await sessionWith(h.host, fakeEngine({ load_payload: (p: unknown) => void loaded.push(p) } as never));
    await s.restore();
    // The part does not extend that label (no base): the labelled version.
    expect(h.reads).toEqual(["session.json", sessionVersionPath(hash)]);
  });

  it("restore without the doors reads the session part [data.plugin.persistence]", async () => {
    const h = labelHost({ v69: false, parts: { "session.json": JSON.stringify({ v: 1, engine: {} }) } });
    const s = await sessionWith(h.host, fakeEngine());
    await s.restore();
    expect(h.reads).toEqual(["session.json"]);
  });

  it("an undo that takes the label back reloads the version it names, keeping the engines [data.plugin.persistence]", async () => {
    const h = labelHost({ v69: true });
    let freed = 0;
    const loaded: unknown[] = [];
    const s = await sessionWith(
      h.host,
      fakeEngine({ resolve_lowered: () => variable("new"), free: () => void freed++, load_payload: (p: unknown) => void loaded.push(p) } as never),
    );
    s.addVariableBinding("v", "anchor", "q", "a");
    await s.refreshFields();
    const first = h.label()!;
    s.addVariableBinding("w", "anchor", "q", "b");
    await s.refreshFields();
    const second = h.label()!;
    expect(second).not.toBe(first);
    // Undo the second write: the document's label names the first version.
    h.setLabel(first);
    h.reads.length = 0;
    h.undo();
    await vi.waitFor(() => expect(h.reads).toContain(sessionVersionPath(first)));
    await s.whenRestored();
    // The data engine took the version's recipe; neither engine rebooted.
    expect(loaded).toHaveLength(1);
    expect(freed).toBe(0);
  });
});

// ── 2. insertField at the caret ─────────────────────────────────────────────

describe("a field placed at the caret carries contentOffset (protocol 69) [data.lower.content]", () => {
  function caretHost(caret: { storyId: string; offset: number } | null) {
    const sent: Mutation[] = [];
    const host = {
      log: silent,
      supports: () => true,
      text: { caret: () => caret },
      selection: { get: () => [] },
      document: {
        mutate: async (m: Mutation) => (sent.push(m), { applied: true, pageIds: [], minted: [{ handle: "frame", element: { kind: "textFrame", id: "u1" }, storyId: "s9" }] }),
        meta: async () => ({ activePage: "p1" }),
      },
    } as unknown as BundleHost;
    return { host, sent };
  }

  it("at the caret: offset AND contentOffset (a v69 engine converts, an older one ignores it) [data.lower.content]", async () => {
    const h = caretHost({ storyId: "s1", offset: 17 });
    await commitLoweredVariable(h.host, variable("x") as never, "v");
    expect(h.sent[0]!.args).toMatchObject({ storyId: "s1", offset: 17, contentOffset: 17 });
  });

  it("without a caret: no contentOffset (offsets are not caret units) [data.lower.content]", async () => {
    const h = caretHost(null);
    await commitLoweredVariable(h.host, variable("x") as never, "v");
    const field = (h.sent[0]!.args as { ops: Mutation[] }).ops.find((o) => o.op === "insertField")!;
    expect(field.args).not.toHaveProperty("contentOffset");
  });
});

// ── 3. merge to a new document ──────────────────────────────────────────────

describe("merge to a new document (D-26) [data.lower.merge-writer]", () => {
  const template = { pageId: "p1", frames: [], spec: { marginBox: [0, 0, 1, 1], frames: [] } };
  function docsHost(docs?: { declined?: boolean }) {
    const calls: string[] = [];
    let opened: Uint8Array | null = null;
    // The editor announces the opened document (documentLoaded); here the
    // test plays that part.
    const announce: { to: (() => void) | null } = { to: null };
    const host = {
      manifest: { id: "media.paged.data", version: "0.0.1" },
      log: silent,
      supports: () => true,
      selection: { get: () => [], set: async () => [] },
      // The copy carries the session part (the query `q`), as an exported
      // `.paged` does.
      parts: {
        write: async () => {},
        read: async (p: string) => (p === "session.json" ? new TextEncoder().encode(JSON.stringify({ v: 1, engine: {} })) : null),
        list: async () => [],
        delete: async () => {},
      },
      document: {
        mutate: async () => ({ applied: true, pageIds: [] }),
        meta: async () => ({ activePage: "p1", documentName: "Catalog" }),
        collection: async () => [{ selfId: "p1" }],
        tree: async () => [],
      },
      ...(docs
        ? {
            documents: {
              exportPaged: async () => (calls.push("export"), new Uint8Array([1, 2, 3])),
              open: async (bytes: Uint8Array, o?: { name?: string }) => {
                calls.push(`open:${o?.name}`);
                opened = bytes;
                if (docs.declined) return { opened: false, reason: "declined" };
                setTimeout(() => announce.to?.(), 0);
                return { opened: true, pageIds: ["p1"] };
              },
            },
          }
        : {}),
    } as unknown as BundleHost;
    return { host, calls, opened: () => opened, announce };
  }
  const engine = () =>
    fakeEngine({
      plan_merge: () => ({}),
      merge_words: () => [],
      merge_overset: () => [],
      query_record_count: () => 3,
      payload: () => ({ queries: [{ id: "q", sql: "SELECT 1" }], bindings: [] }),
    } as never);

  it("without the door: refused with the documented gap, the document untouched [data.lower.merge-writer]", async () => {
    const h = docsHost();
    const s = await sessionWith(h.host, engine(), { readMergeTemplate: async () => ({ template, diagnostics: [] }) });
    s.addQuery("q", "SELECT 1", "recordStream");
    const r = await s.mergeRecords({ query: "q", destination: "newDocument" });
    expect(r.ok).toBe(false);
    expect(r.diagnostics.join(" ")).toMatch(/cannot open a second document/);
  });

  it("with the door: copies the document, opens the copy and merges there, consuming the template [data.lower.merge-writer]", async () => {
    const h = docsHost({});
    const merged: { template: string }[] = [];
    const s = await sessionWith(h.host, engine(), {
      readMergeTemplate: async () => ({ template, diagnostics: [] }),
      mergeRecords: async (_h: unknown, _e: unknown, _t: unknown, o: { template: string }) => {
        merged.push(o);
        return { ok: true, plan: null, pages: [], records: [], overset: [], mutateCalls: 1, diagnostics: [] };
      },
    });
    s.addQuery("q", "SELECT 1", "recordStream");
    h.announce.to = () => void s.documentOpened();
    const r = await s.mergeRecords({ query: "q", destination: "newDocument" });
    expect(h.calls).toEqual(["export", "open:Catalog (merged)"]);
    expect([...h.opened()!]).toEqual([1, 2, 3]);
    expect(r.ok).toBe(true);
    expect(merged.map((m) => m.template)).toEqual(["consume"]);
  });

  it("the user keeps the current document: nothing merged [data.lower.merge-writer]", async () => {
    const h = docsHost({ declined: true });
    const s = await sessionWith(h.host, engine(), { readMergeTemplate: async () => ({ template, diagnostics: [] }) });
    s.addQuery("q", "SELECT 1", "recordStream");
    const r = await s.mergeRecords({ query: "q", destination: "newDocument" });
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toEqual(["merge: the user kept the current document"]);
  });
});

// ── 4. overset measurement ──────────────────────────────────────────────────

describe("overset words are measured in one call per face (D-27) [data.lower.merge-writer]", () => {
  const font = (sizePt: number) => ({ family: "Minion", style: null, sizePt, leadingPt: sizePt * 1.2 });
  const tpl = { frames: [{ font: font(10) }, { font: font(10) }, { font: font(12) }] } as unknown as MergeTemplate;
  const words = [["a", "bb"], ["bb", "ccc"], ["a"]];

  it("with measureStrings: one call per distinct face and size [data.lower.merge-writer]", async () => {
    const calls: string[][] = [];
    const host = {
      supports: () => true,
      text: {
        measureStrings: async (_f: string, _s: string | null, texts: readonly string[]) => (calls.push([...texts]), texts.map((t) => ({ advance: t.length }))),
        measureString: async () => {
          throw new Error("must not measure per word");
        },
      },
    } as unknown as BundleHost;
    const m = await measureWords(host, tpl, words);
    expect(calls).toEqual([["a", "bb", "ccc"], ["a"]]);
    expect(m[1]!.advances).toEqual({ bb: 2, ccc: 3 });
    expect(m[2]!.leadingPt).toBeCloseTo(14.4);
  });

  it("without it: one measureString per word, as before [data.lower.merge-writer]", async () => {
    let n = 0;
    const host = { supports: () => true, text: { measureString: async (_f: string, _s: string | null, t: string) => (n++, { advance: t.length }) } } as unknown as BundleHost;
    const m = await measureWords(host, tpl, words);
    expect(n).toBe(5);
    expect(m[0]!.advances).toEqual({ a: 1, bb: 2 });
  });
});

// ── 5. a merge that adds pages, in one step ─────────────────────────────────

describe("a merge that adds pages is one batch with page handles (protocol 69) [data.lower.merge-writer]", () => {
  const template: MergeTemplate = {
    pageId: "p1" as never,
    frames: [{ element: { kind: "textFrame", id: "t1" } as never, storyId: "s1", format: [], font: { family: "", style: null, sizePt: 12, leadingPt: 14.4 } }],
    spec: { marginBox: [0, 0, 100, 100], frames: [{ id: "t1", bounds: [0, 0, 10, 10], content: { kind: "text", text: "<<a>>" } }] },
  };
  const plan: MergePlan = {
    rows: 1,
    columns: 1,
    perPage: 1,
    pageCount: 3,
    records: [0, 1, 2].map((r) => ({ record: r, page: r, row: 0, column: 0, frames: [{ template: 0, bounds: [0, 0, 10, 10] as [number, number, number, number], text: `r${r}` }] })),
    fields: ["a"],
    missingFields: [],
    diagnostics: [],
  };
  const engine: MergeEngine = { plan_merge: () => plan, merge_words: () => [[]], merge_overset: () => [[false], [false], [false]] };

  function mergeHost(refuseHandles = false) {
    const sent: Mutation[] = [];
    let pages = ["p1"];
    const host = {
      supports: () => true,
      text: { measureString: async () => ({ advance: 1 }) },
      document: {
        mutate: async (m: Mutation) => {
          sent.push(m);
          const ops = (m.args as { ops: Mutation[] }).ops;
          const named = ops.some((o) => o.op === "bindCreated" && /^p\d+$/.test((o.args as { handle: string }).handle));
          if (named && refuseHandles) return { applied: false, error: "Mutation::Batch child 2 (bindCreated): nothing to name" };
          const added = ops.filter((o) => o.op === "duplicatePage" || o.op === "insertPage").length;
          for (let i = 0; i < added; i++) pages.splice(1, 0, `n${pages.length}`);
          const minted = ops
            .filter((o) => o.op === "insertTextFrame")
            .map((_, i) => ({ handle: null, element: { kind: "textFrame", id: `f${i}` }, storyId: `S${i}` }));
          return { applied: true, pageIds: [], minted };
        },
        collection: async (name: string) => (name === "pages" ? pages.map((selfId) => ({ selfId })) : []),
      },
    } as unknown as BundleHost;
    return { host, sent, pages: () => pages };
  }

  it("names each new page and places content on it in the same batch [data.lower.merge-writer]", () => {
    const m = oneStepMutation(plan, template, { template: "consume", mergeId: "m" })!;
    const ops = (m.args as { ops: Mutation[] }).ops;
    expect(ops.slice(0, 5).map((o) => o.op)).toEqual(["deleteFrame", "duplicatePage", "bindCreated", "duplicatePage", "bindCreated"]);
    const framePages = ops.filter((o) => o.op === "insertTextFrame").map((o) => (o.args as { pageId: string }).pageId);
    // Page 0 is the template; each duplicate lands right after it, so the
    // last one made is the second page.
    expect(framePages).toEqual(["p1", "$h:p1", "$h:p0"]);
  });

  it("with page handles: one mutate, one undo step [data.lower.merge-writer]", async () => {
    const h = mergeHost();
    const r = await mergeRecords(h.host, engine, template, { query: "q", recordsPerPage: { mode: "single" }, template: "consume", pageHandles: true });
    expect(r.ok).toBe(true);
    expect(r.mutateCalls).toBe(1);
    expect(h.sent).toHaveLength(1);
    expect(r.pages).toEqual(h.pages());
    expect(r.records.map((x) => x.frames[0]!.storyId)).toEqual(["S0", "S1", "S2"]);
  });

  it("without them: pages, then content — two steps, as before [data.lower.merge-writer]", async () => {
    const h = mergeHost();
    const r = await mergeRecords(h.host, engine, template, { query: "q", recordsPerPage: { mode: "single" }, template: "consume" });
    expect(r.ok).toBe(true);
    expect(r.mutateCalls).toBe(2);
  });

  it("an engine that refuses page handles falls back to two steps [data.lower.merge-writer]", async () => {
    const h = mergeHost(true);
    const r = await mergeRecords(h.host, engine, template, { query: "q", recordsPerPage: { mode: "single" }, template: "consume", pageHandles: true });
    expect(r.ok).toBe(true);
    expect(h.sent).toHaveLength(3);
    expect(r.diagnostics.join(" ")).toMatch(/one-step batch was refused/);
  });
});
