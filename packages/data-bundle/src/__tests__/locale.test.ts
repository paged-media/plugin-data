// §9.1 — the session formatting locale. setLocale stores the choice and applies
// it to the engine (immediately if up, else on boot). The locale-aware formatting
// itself is proven in Rust (data-conformance/tests/locale.rs); here we prove the
// bundle threads the choice through to engine.set_locale.

import { describe, expect, it, vi } from "vitest";

import type { BundleHost } from "@paged-media/plugin-api";

const localeCalls: string[] = [];
vi.mock("../engine", () => ({
  ENGINE_NOT_BUILT: "not built",
  bootEngine: vi.fn(async () => ({
    set_locale(l: string) {
      localeCalls.push(l);
    },
    plan_batch() {
      return { mode: "oneCatalog", units: [], totalRecords: 0 };
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

describe("session.setLocale (§9.1)", () => {
  it("defaults to en and threads the choice through to the engine on boot", async () => {
    localeCalls.length = 0;
    const session = createSession(fakeHost(), 0);
    expect(session.getLocale()).toBe("en");

    session.setLocale("de"); // before the engine boots
    expect(session.getLocale()).toBe("de");

    await session.planBatch("q1", { mode: "oneCatalog" }); // boots the engine
    expect(localeCalls).toEqual(["de"]); // applied on boot

    session.setLocale("en"); // after boot → applied immediately
    expect(localeCalls).toEqual(["de", "en"]);
  });
});
