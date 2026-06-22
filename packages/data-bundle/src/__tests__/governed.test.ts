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

// §7 — the session's governed-catalog surface. The bundle reads a column-metadata
// sidecar (JSON) and the engine enriches the query's resolved schema with it →
// documented columns + governance-drift diagnostics. The enrichment semantics are
// proven in Rust (data-conformance/tests/governed.rs + data-sources unit tests);
// here we prove the bundle reaches the engine and passes the sidecar through.

import { describe, expect, it, vi } from "vitest";

import type { BundleHost } from "@paged-media/plugin-api";

vi.mock("../engine", () => ({
  ENGINE_NOT_BUILT: "not built",
  bootEngine: vi.fn(async () => ({
    set_locale() {},
    governed_catalog(_query: string, metadata: { columns: { name: string }[] }) {
      // A faithful-enough stand-in: echo the documented names so the test proves
      // the sidecar reached the engine (the real merge is Rust-tested).
      return {
        columns: metadata.columns.map((c) => ({
          name: c.name,
          label: c.name,
          dataType: "text",
          documented: true,
        })),
        diagnostics: [],
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

describe("session.governedCatalog (§7)", () => {
  it("passes the sidecar to the engine and returns the catalog", async () => {
    const session = createSession(fakeHost(), 0);
    const cat = await session.governedCatalog("q1", {
      dataset: "fct_products",
      columns: [{ name: "sku", label: "SKU" }],
    });
    expect(cat.columns).toHaveLength(1);
    expect(cat.columns[0].name).toBe("sku");
    expect(cat.diagnostics).toEqual([]);
  });
});
