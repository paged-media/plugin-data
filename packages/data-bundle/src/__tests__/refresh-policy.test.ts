// Wave 6: acting on a source's RefreshPolicy. Interval polling runs only for
// a remote source whose origin is consented, re-runs the queries only when the
// fetched content changed, and stops when consent goes; a local file refuses
// an interval (a browser page cannot watch a file); `onOpen` acts once on
// restore and never fetches an unconsented origin. Engine and DuckDB are
// stubs here — the fetch → DuckDB → engine path runs for real in
// test/sources-real.spec.ts and duckdb-real.spec.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BundleHost } from "@paged-media/plugin-api";

import { encodeSession, SESSION_PART, type PersistedSession } from "../persist";
import { IntervalScheduler, refusePolicy, readPolicy } from "../refresh";
import { createSession } from "../session";

const ingests: string[] = [];
const defined: { id: string; refresh?: unknown }[] = [];

vi.mock("../engine", () => ({
  ENGINE_NOT_BUILT: "engine not built",
  bootEngine: async () => {
    const sources = new Map<string, unknown>();
    const queries: { id: string; sql: string }[] = [];
    return {
      set_locale() {},
      define_source(s: { id: string; refresh?: unknown }) {
        defined.push({ id: s.id, refresh: s.refresh });
        sources.set(s.id, s);
      },
      define_query(q: { id: string; sql: string }) {
        queries.push(q);
      },
      ingest_result(id: string) {
        ingests.push(id);
      },
      remote_invalidation_key(_s: string, bytes: Uint8Array) {
        return `key-${new TextDecoder().decode(bytes).length}`;
      },
      payload() {
        return { sources: [...sources.values()], queries, templates: [], bindings: [] };
      },
      load_payload(p: { queries?: { id: string; sql: string }[] }) {
        queries.push(...(p.queries ?? []));
      },
      sync_report() {
        return [];
      },
      free() {},
    };
  },
}));

vi.mock("../query/duckdb", () => ({
  DUCKDB_NOT_VENDORED: "duckdb not vendored",
  bootDuckDB: async () => ({
    async registerCsv() {},
    async registerFileBuffer() {},
    async query() {
      return { schema: { fields: [] }, columns: [], row_count: 0 };
    },
    async rows() {
      // Not the guard any more (it asks DuckDB nothing); kept for older callers.
      const ast = {
        error: false,
        statements: [{ node: { from_table: { type: "BASE_TABLE", table_name: "feed", schema_name: "", catalog_name: "" } } }],
      };
      return { columns: ["j"], rows: [[JSON.stringify(ast)]] };
    },
    async exec() {},
    async dropFile() {},
    async close() {},
  }),
}));

let body = "a,b\n1,2\n";
const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
}));

function fakeHost(consented: Set<string>, saved?: PersistedSession): BundleHost {
  const parts = new Map<string, Uint8Array>();
  if (saved) parts.set(SESSION_PART, encodeSession(saved));
  return {
    manifest: { id: "media.paged.data", name: "d", version: "0.0.1", apiVersion: "^0.2" },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    supports: (k: string) => k === "storage.parts@1",
    parts: {
      write: async (p: string, b: Uint8Array) => void parts.set(p, b),
      read: async (p: string) => parts.get(p) ?? null,
      list: async () => [...parts.keys()],
      delete: async (p: string) => parts.delete(p),
    },
    network: {
      consentedOrigins: () => [...consented],
      requestConsent: async (origins: readonly string[]) => {
        for (const o of origins) consented.add(o);
        return { granted: [...origins], denied: [], remembered: true };
      },
    },
    document: {},
  } as unknown as BundleHost;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  ingests.length = 0;
  defined.length = 0;
  body = "a,b\n1,2\n";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("refresh policies [data.source.adapters]", () => {
  it("parses and refuses what the editor cannot honour", () => {
    expect(readPolicy({ policy: "interval", secs: 60 })).toEqual({ policy: "interval", secs: 60 });
    expect(readPolicy({ policy: "interval", secs: 1 })).toEqual({ policy: "manual" });
    expect(readPolicy({ policy: "weird" })).toEqual({ policy: "manual" });
    expect(refusePolicy("file", { policy: "interval", secs: 60 })).toMatch(/cannot be watched/);
    expect(refusePolicy("remote", { policy: "interval", secs: 5 })).toMatch(/at least 15/);
    expect(refusePolicy("file", { policy: "onOpen" })).toBeNull();
  });

  it("a local file refuses an interval, takes onOpen, and the policy is saved [data.source.adapters]", async () => {
    const host = fakeHost(new Set());
    const s = createSession(host, 0);
    await s.registerCsvSource("local", "a\n1\n");
    expect(s.setRefreshPolicy("local", { policy: "interval", secs: 60 })).toMatch(/cannot be watched/);
    expect(s.setRefreshPolicy("nope", { policy: "onOpen" })).toMatch(/no source named/);
    expect(s.setRefreshPolicy("local", { policy: "onOpen" })).toBeNull();
    expect(s.getRefreshPolicy("local")).toEqual({ policy: "onOpen" });
    // Mirrored into the engine's source definition.
    expect(defined.at(-1)).toEqual({ id: "local", refresh: { policy: "onOpen" } });
    await s.flushPersist();
    const part = JSON.parse(new TextDecoder().decode((await host.parts.read(SESSION_PART))!));
    expect(part.refresh).toEqual({ local: { policy: "onOpen" } });
    s.dispose();
  });

  it("polls a consented remote source, re-runs queries only on a content change, stops without consent [data.security.gates]", async () => {
    const consented = new Set<string>();
    const s = createSession(fakeHost(consented), 0);
    expect(s.addRemoteSource("feed", "https://api.test/feed.csv", "csv")).toBeNull();
    expect(s.setRefreshPolicy("feed", { policy: "interval", secs: 60 })).toBeNull();
    // No consent: nothing polls, nothing fetches.
    expect(s.getState().polling).toEqual([]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).not.toHaveBeenCalled();

    await s.requestConsentForRemote("feed");
    await s.loadRemoteSource("feed");
    s.addQuery("q", "SELECT * FROM feed", "recordStream");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(s.getState().polling).toEqual(["feed"]);

    // Same bytes: fetched, nothing re-run.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ingests).toEqual([]);

    // Changed bytes: the queries run again.
    body = "a,b\n1,2\n3,4\n";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(ingests).toEqual(["q"]);

    // Consent withdrawn: the next tick stops the timer without fetching.
    consented.clear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(s.getState().polling).toEqual([]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    s.dispose();
  });

  it("on open: a remembered origin is fetched for onOpen and polled for interval; an unconsented one is not [data.security.gates]", async () => {
    const saved: PersistedSession = {
      v: 1,
      engine: { sources: [], queries: [{ id: "q", sql: "SELECT * FROM feed" }], templates: [], bindings: [] },
      locale: "en",
      sync: [],
      targets: { image: {}, barcode: {}, visibility: {}, rule: {}, lowered: {} },
      data: [],
      remote: [
        { name: "feed", url: "https://api.test/feed.csv", format: "csv", params: {} },
        { name: "other", url: "https://other.test/x.csv", format: "csv", params: {} },
      ],
      refresh: {
        feed: { policy: "onOpen" },
        other: { policy: "interval", secs: 30 },
      },
    };
    const s = createSession(fakeHost(new Set(["https://api.test"]), saved), 0);
    await s.restore();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual(["https://api.test/feed.csv"]);
    expect(ingests).toEqual(["q"]);
    // `other` is not consented: no timer.
    expect(s.getState().polling).toEqual([]);
    expect(s.getState().refresh).toEqual(saved.refresh);
    s.dispose();
  });

  it("an interval tick that is still running is skipped, not stacked", async () => {
    let release!: () => void;
    let runs = 0;
    const sched = new IntervalScheduler(
      () =>
        new Promise<void>((r) => {
          runs += 1;
          release = r;
        }),
    );
    sched.sync(new Map([["a", 20]]));
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runs).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runs).toBe(2);
    sched.sync(new Map());
    expect(sched.running().size).toBe(0);
  });
});
