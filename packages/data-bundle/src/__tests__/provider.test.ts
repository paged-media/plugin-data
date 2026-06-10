// D-09 — the session's data-provider publish surface (§7.1). The bundle exposes
// a query's resolved result as a named, discoverable dataset for OTHER consumers
// (the sheets plugin sourcing a sheet from a governed query) through the future
// core data-provider registry. The engine produces the publication; registration
// is gated (no host.dataProviders door) → honest defer, never faked. The
// engine-side semantics are proven in Rust (data-conformance/tests/provider.rs);
// here we prove the bundle reaches the engine and does not fake a registration.

import { describe, expect, it, vi } from "vitest";

import type { BundleHost } from "@paged-media/plugin-api";

vi.mock("../engine", () => ({
  ENGINE_NOT_BUILT: "not built",
  bootEngine: vi.fn(async () => ({
    publish_provider(_query: string, id: string, category: string) {
      return {
        id,
        category,
        revision: "00000000deadbeef",
        schema: { fields: [{ name: "sku", ty: "text", nullable: true }] },
        rowCount: 3,
        records: { schema: { fields: [] }, columns: [], row_count: 3 },
      };
    },
    free() {},
  })),
}));

import { createSession } from "../session";

function fakeHost(
  supportsRegistry = false,
): BundleHost & { logs: string[]; registered: { id: string; category: string }[] } {
  const logs: string[] = [];
  const registered: { id: string; category: string }[] = [];
  return {
    manifest: { id: "media.paged.data", name: "d", version: "0.0.1", apiVersion: "^0.2" },
    log: { debug() {}, info: (m: string) => logs.push(m), warn() {}, error() {} },
    supports: (f: string) => supportsRegistry && f === "dataProviders@1",
    dataProviders: {
      register: (reg: { id: string; category: string }) => {
        registered.push(reg);
        return { update() {}, dispose() {} };
      },
      discover: () => [],
      get: async () => null,
      onDidChange: () => ({ dispose() {} }),
    },
    logs,
    registered,
  } as unknown as BundleHost & {
    logs: string[];
    registered: { id: string; category: string }[];
  };
}

describe("session.publishProvider (D-09, §7.1)", () => {
  it("returns the engine's publication payload", async () => {
    const session = createSession(fakeHost(), 0);
    const pub = await session.publishProvider("q1", "pricing-dataset", "dataset");
    expect(pub.id).toBe("pricing-dataset");
    expect(pub.category).toBe("dataset");
    expect(pub.revision).toBe("00000000deadbeef");
    expect(pub.rowCount).toBe(3);
    expect(pub.schema.fields[0].name).toBe("sku");
  });

  it("logs the honest 'registration deferred' note when no host registry is wired", async () => {
    const host = fakeHost(false);
    const session = createSession(host, 0);
    await session.publishProvider("q1", "p", "dataset");
    expect(host.logs.some((m) => m.includes("D-09"))).toBe(true);
  });

  it("registers with host.dataProviders (no defer note) once a registry is wired", async () => {
    const host = fakeHost(true);
    const session = createSession(host, 0);
    await session.publishProvider("q1", "pricing-dataset", "dataset");
    expect(host.logs.some((m) => m.includes("D-09"))).toBe(false);
    expect(host.registered).toHaveLength(1);
    expect(host.registered[0]).toMatchObject({ id: "pricing-dataset", category: "dataset" });
  });
});
