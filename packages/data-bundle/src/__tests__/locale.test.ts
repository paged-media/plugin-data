/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

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
