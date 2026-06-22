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
    run_record_flow_batch(_binding: string, mode: { mode: string }, chain: unknown[]) {
      return [{ label: mode.mode, flow: { frames: [], total: chain.length } }];
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

  it("runRecordFlowBatch executes a plan and returns one BatchRun per unit", async () => {
    const session = createSession(fakeHost(), 0);
    const runs = await session.runRecordFlowBatch("rf", { mode: "perGroup", by: ["region"] }, [
      { frame: "f0", page: "p0", heightPt: 200 },
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].label).toBe("perGroup");
  });
});
