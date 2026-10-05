// The session part's schema and the session's behaviour on a host without
// container parts — no real engine needed (the round trip through a real
// `.paged` is test/persist-real-core.spec.ts).

import { describe, expect, it } from "vitest";

import {
  INLINE_DATA_MAX_BYTES,
  decodeSession,
  encodeSession,
  loadData,
  storeData,
  type PersistedSession,
} from "../persist";
import { createSession } from "../session";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe("the session part schema [data.plugin.persistence]", () => {
  const sample: PersistedSession = {
    v: 1,
    engine: { sources: [], queries: [], templates: [], bindings: [] },
    locale: "de",
    sync: [{ binding: "v", status: "pinned" }],
    targets: { image: {}, barcode: {}, visibility: {}, rule: {}, lowered: {} },
    data: [{ source: "s", format: "csv", text: "a\n1\n" }],
    remote: [],
  };

  it("round-trips through encode/decode", () => {
    expect(decodeSession(encodeSession(sample))).toEqual(sample);
  });

  it("refuses a newer version and names it", () => {
    const r = decodeSession(new TextEncoder().encode(JSON.stringify({ ...sample, v: 2 })));
    expect("error" in r && r.error).toMatch(/version 2/);
  });

  it("refuses text that is not JSON", () => {
    expect("error" in decodeSession(new TextEncoder().encode("{nope"))).toBe(true);
  });

  it("fills what an older writer left out", () => {
    const r = decodeSession(new TextEncoder().encode(JSON.stringify({ v: 1, engine: {} })));
    expect(r).toMatchObject({ locale: "en", sync: [], data: [], remote: [] });
  });

  it("keeps small data inline and writes large data once, by content", async () => {
    const written: string[] = [];
    const write = async (p: string) => void written.push(p);
    const known = new Set<string>();
    expect(await storeData("s", "a\n1\n", write, known)).toEqual({
      source: "s",
      format: "csv",
      text: "a\n1\n",
    });
    const big = "x".repeat(INLINE_DATA_MAX_BYTES + 1);
    const a = await storeData("big", big, write, known);
    const b = await storeData("again", big, write, known);
    expect("ref" in a && a.ref.bytes).toBe(INLINE_DATA_MAX_BYTES + 1);
    expect(b).toEqual({ ...a, source: "again" });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^data\/[0-9a-f]{32}\.csv$/);
    expect(await loadData(a, async () => null)).toBeNull();
  });
});

describe("a host without container parts [data.plugin.persistence]", () => {
  it("says the session is not saved, once, and never writes", async () => {
    const host = {
      log: silent,
      supports: () => false,
      parts: {
        write: async () => {
          throw new Error("no container");
        },
        read: async () => null,
      },
      document: {},
    } as never;
    const s = createSession(host, 0);
    await s.restore();
    s.addQuery("q", "SELECT 1", "scalar");
    s.addQuery("q2", "SELECT 2", "scalar");
    await s.flushPersist();
    const st = s.getState();
    expect(st.persistence.status).toBe("unavailable");
    expect(st.diagnostics.filter((d) => d.source === "persist")).toHaveLength(1);
  });
});
