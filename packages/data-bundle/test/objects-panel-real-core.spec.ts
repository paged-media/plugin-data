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

// ADR 323 §4 against the REAL stack (real core, the headless host's
// host.objects, the real data-js engine, real DuckDB): the "Data objects"
// panel is registered beside the four React panels, its lists publish the
// session's objects, and a binding's expression edited the way the panel's
// PropertyField commits it (host.objects.set on the picked binding's
// address) leaves the document's property untouched; the re-apply it drives
// is ONE host.objects batch, ONE undo step. The edit's own label write is a
// pinned defect below.
//
// Gate: skips without canvas-wasm, DuckDB or the built data-js wasm, EXCEPT
// under REQUIRE_REAL_CORE=1 / REQUIRE_REAL_DUCKDB=1.

import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";

import type { BundleHost } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { ENGINE_ANCHOR, openRealHost, REQUIRE_REAL_CORE } from "./real-core";
import { bootRealDuckDB, bootRealEngine, DATA_JS_WASM, REQUIRE_REAL_DUCKDB } from "./real-duckdb";
import { BIND, OBJECTS_PANEL_ID } from "../src/panels/objects-panel";

const CSV = "sku,weight_mm\nA-1,2\nB-2,4\n";
const BINDING = "plugin:media.paged.data/binding/weight";

const probe = await bootRealDuckDB();
const ready = ENGINE_ANCHOR !== null && probe.handle !== undefined && existsSync(DATA_JS_WASM);
const required = REQUIRE_REAL_CORE || REQUIRE_REAL_DUCKDB;

async function loadBundleModule() {
  vi.resetModules();
  vi.doMock("../src/engine", async (orig) => ({
    ...(await orig<typeof import("../src/engine")>()),
    bootEngine: (today: number) => bootRealEngine(today),
  }));
  vi.doMock("../src/query/duckdb", async (orig) => ({
    ...(await orig<typeof import("../src/query/duckdb")>()),
    bootDuckDB: async () => {
      const b = await bootRealDuckDB();
      if (!b.handle) throw new Error(b.error);
      return b.handle;
    },
  }));
  return import("../src/index");
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe.skipIf(!ready && !required)("Data objects panel, real core + engine + DuckDB [data.object-model]", () => {
  const hosts: HeadlessHost[] = [];
  afterEach(() => {
    while (hosts.length) hosts.pop()!.dispose();
  });

  it("a binding's expr edited through host.objects (the panel's PropertyField commit) then the re-apply is ONE undo step [data.object-model] [data.bind.property]", async () => {
    expect(ready, "real core, DuckDB and the data-js wasm must all be available").toBe(true);
    const mod = await loadBundleModule();
    const h = await openRealHost();
    hosts.push(h);
    let host!: BundleHost;
    h.loadBundle({ ...mod.dataBundle, activate: (bh: BundleHost) => ((host = bh), mod.dataBundle.activate(bh)) } as typeof mod.dataBundle);
    const s = mod.sessionFor(host)!;
    await s.whenRestored();

    // Registered beside the React panels (none of them removed).
    expect(h.schemaPanelsContributed().map((p) => p.id)).toEqual([OBJECTS_PANEL_ID]);
    expect(h.panelsContributed().map((p) => p.id)).toEqual(
      expect.arrayContaining([
        "media.paged.data.panel.sources",
        "media.paged.data.panel.bindings",
        "media.paged.data.panel.dataset",
        "media.paged.data.panel.query",
      ]),
    );

    await s.registerCsvSource("products", CSV);
    s.addQuery("q", "SELECT * FROM products ORDER BY sku", "recordStream");
    await s.refreshData();
    const r = await s.addPropertyBinding("weight", { target: "rectangle:urect", path: "frameStrokeWeight", query: "q", expr: "MM(weight_mm)" });
    expect(r.ok, r.reason).toBe(true);
    const weight = async () => ((await h.objects.get("rectangle:urect", "frameStrokeWeight")) as { value?: unknown }).value as number;
    await s.lowerAll();
    expect(await weight()).toBeCloseTo((2 * 72) / 25.4, 6);

    // The lists the panel shows: the session's objects, picked by default.
    await settle();
    const rows = (bind: string) => (host.bindings.get(bind) as { selfId: string }[] | undefined)?.map((x) => x.selfId);
    expect(rows(BIND.sources)).toEqual(["plugin:media.paged.data/source/products"]);
    expect(rows(BIND.queries)).toEqual(["plugin:media.paged.data/query/q"]);
    expect(rows(BIND.bindings)).toEqual([BINDING]);
    expect(host.bindings.get(BIND.binding)).toBe(BINDING);

    // The commit the binding section's "expr" PropertyField makes.
    const picked = host.bindings.get(BIND.binding) as string;
    const mutate = vi.spyOn(host.document, "mutate");
    const set = await h.objects.set(picked, "expr", "MM(weight_mm + 1)");
    expect(set.applied, set.reason).toBe(true);
    // The only document write is the binding's own label (ADR 559: the
    // definition rides the target's script label), never the property.
    for (const [m] of mutate.mock.calls) expect((m as { op: string }).op).toBe("setPluginMetadata");
    mutate.mockRestore();
    expect(await h.objects.get(picked, "expr")).toEqual({ kind: "value", value: "MM(weight_mm + 1)" });
    // The document is untouched until the binding applies again.
    expect(await weight()).toBeCloseTo((2 * 72) / 25.4, 6);

    // Re-apply: ONE host.objects batch, ONE undo step.
    const batch = vi.spyOn(host.objects, "batch");
    const applied = await s.applyProperties();
    expect(applied.applied).toBe(1);
    expect(applied.undoSteps).toBe(1);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(await weight()).toBeCloseTo((3 * 72) / 25.4, 6);

    // One undo takes exactly the re-apply back.
    await host.document.undo();
    expect(await weight()).toBeCloseTo((2 * 72) / 25.4, 6);
    expect(await h.objects.get(picked, "expr")).toEqual({ kind: "value", value: "MM(weight_mm + 1)" });
  }, 120_000);

  // A defect, pinned (found building this lane): the edit's only engine write
  // is the binding's element label (syncLabels, a separate host.document
  // .mutate), so host.objects.set reports undoSteps 0 while the engine took a
  // step; undoing that step reverts the label but NOT the session (followLabel
  // follows the document label's session version, not element labels), so the
  // user sees an undo that changes nothing and the label disagrees with the
  // session until the next save re-syncs it. The fix: the binding kind returns
  // the label ops as its ObjectWrite mutations (one step host.objects reports)
  // and the session follows element labels on undo. Then this flips to a pass.
  it.fails("an expr edit through host.objects is one honest undo step the session follows [data.object-model]", async () => {
    const mod = await loadBundleModule();
    const h = await openRealHost();
    hosts.push(h);
    let host!: BundleHost;
    h.loadBundle({ ...mod.dataBundle, activate: (bh: BundleHost) => ((host = bh), mod.dataBundle.activate(bh)) } as typeof mod.dataBundle);
    const s = mod.sessionFor(host)!;
    await s.whenRestored();
    await s.registerCsvSource("products", CSV);
    s.addQuery("q", "SELECT * FROM products ORDER BY sku", "recordStream");
    await s.refreshData();
    expect((await s.addPropertyBinding("weight", { target: "rectangle:urect", path: "frameStrokeWeight", query: "q", expr: "MM(weight_mm)" })).ok).toBe(true);
    const set = await h.objects.set(BINDING, "expr", "MM(weight_mm + 1)");
    expect(set.applied).toBe(true);
    expect(set.undoSteps).toBe(1);
    await host.document.undo();
    await settle();
    expect(await h.objects.get(BINDING, "expr")).toEqual({ kind: "value", value: "MM(weight_mm)" });
  }, 60_000);

  it("a read-only row refuses a write (the PropertyField renders it read-only) [data.object-model]", async () => {
    const mod = await loadBundleModule();
    const h = await openRealHost();
    hosts.push(h);
    let host!: BundleHost;
    h.loadBundle({ ...mod.dataBundle, activate: (bh: BundleHost) => ((host = bh), mod.dataBundle.activate(bh)) } as typeof mod.dataBundle);
    const s = mod.sessionFor(host)!;
    await s.whenRestored();
    await s.registerCsvSource("products", CSV);
    const src = "plugin:media.paged.data/source/products";
    expect((await h.objects.set(src, "name", "other")).applied).toBe(false);
    // The writable one (refresh policy) commits.
    expect((await h.objects.set(src, "refresh", "onOpen")).applied).toBe(true);
    expect(await h.objects.get(src, "refresh")).toEqual({ kind: "value", value: "onOpen" });
  }, 60_000);
});
