// §10 — the session's batch-plan surface. The engine partitions a query's
// resolved result into generation units (per-record / per-group / one-catalog);
// executing the plan reuses the normal resolve/lower/paginate pipeline. The
// plan semantics are proven in Rust (data-conformance/tests/automation.rs +
// data-automation unit tests); here we prove the bundle reaches the engine and
// passes the mode through.

import { describe, expect, it, vi } from "vitest";

import type { BundleHost } from "@paged-media/plugin-api";

vi.mock("../engine", () => ({
  ENGINE_NOT_BUILT: "not built",
  bootEngine: vi.fn(async () => ({
    set_locale() {},
    plan_batch(_query: string, mode: { mode: string }) {
      return {
        mode: mode.mode,
        units: [{ label: "catalog", recordIndices: [0, 1] }],
        totalRecords: 2,
      };
    },
    free() {},
  })),
}));

import { createSession } from "../session";

function fakeHost(): BundleHost {
  return {
    manifest: { id: "media.paged.data", name: "d", version: "0.0.1", apiVersion: "^0.2" },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    supports: () => false,
  } as unknown as BundleHost;
}

describe("session.planBatch (§10)", () => {
  it("passes the batch mode to the engine and returns the plan", async () => {
    const session = createSession(fakeHost(), 0);
    const plan = await session.planBatch("q1", { mode: "oneCatalog" });
    expect(plan.mode).toBe("oneCatalog");
    expect(plan.units).toHaveLength(1);
    expect(plan.totalRecords).toBe(2);
  });
});
