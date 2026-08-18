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

// data.plugin.bundle.activate — registration wiring against a minimal
// hand-rolled fake BundleHost (no editor, no engine, no DuckDB): the bundle
// contributes the two panels + the four commands, the open commands open their
// panels, and dispose tears the session down cleanly (the honesty smoke test).
// Engine/DuckDB behavior is NOT exercised here — this is wiring only.

import { describe, expect, it } from "vitest";

import type {
  BundleHost,
  CommandContribution,
  Disposable,
  PanelContribution,
} from "@paged-media/plugin-api";

import { dataBundle } from "../index";

function fakeHost() {
  const panels: PanelContribution[] = [];
  const commands: CommandContribution[] = [];
  let disposed = 0;
  const track = (): Disposable => ({
    dispose() {
      disposed += 1;
    },
  });
  const openedPanels: string[] = [];
  const editContexts: Array<Record<string, unknown>> = [];
  const host = {
    manifest: dataBundle.manifest,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    // ADR 024 — this fake had NO `supports`, which is why adding the
    // first `host.supports(...)` call to `activate` broke six tests at
    // once. That is the fake telling the truth about its own coverage:
    // it modelled only the doors the bundle happened to use, so a new
    // door had nowhere to land. Answering honestly (this host DOES wire
    // the edit-context registry) is the fix; a blanket `() => true`
    // would make the degradation path untestable.
    supports: (f: string) => f === "contribute.editContext@1",
    contribute: {
      editContext(c: Record<string, unknown>) {
        editContexts.push(c);
        return track();
      },
      panel(c: PanelContribution): Disposable {
        panels.push(c);
        return track();
      },
      command(c: CommandContribution): Disposable {
        commands.push(c);
        return track();
      },
    },
    shell: {
      openPanel(id: string) {
        openedPanels.push(id);
      },
      closePanel() {},
    },
  } as unknown as BundleHost;
  return {
    host,
    panels,
    commands,
    openedPanels,
    editContexts,
    disposedCount: () => disposed,
  };
}

describe("data_plugin_bundle_activate", () => {
  it("ADR 024 — registers the dataBinding edit context, claimed by its OWN metadata", () => {
    // paged.data was the one content-bearing plugin with no context at
    // all: it stamps `x-paged:media.paged.data` onto the frames it
    // creates, so those frames ARE plugin content, but double-clicking
    // one fell through to group descent with no owned-type hint.
    const fake = fakeHost();
    dataBundle.activate(fake.host);
    expect(fake.editContexts).toHaveLength(1);
    const ctx = fake.editContexts[0] as {
      type: string;
      entry: string;
      toolIds?: string[];
      panelIds?: string[];
      matches?: (c: { metadata: unknown }) => boolean;
    };

    expect(ctx.type).toBe("dataBinding");
    // K-13 — the one entry gesture for canvas content.
    expect(ctx.entry).toBe("doubleClick");
    // A bound frame's content IS its binding, and the Bindings panel is
    // the surface that edits it.
    expect(ctx.panelIds).toEqual(["media.paged.data.panel.bindings"]);
    // NO canvas tool: a binding is an expression over a data source, not
    // geometry. Declared empty, which is a statement — omitting the
    // field reads as "unrestricted" and leaves the whole rail lit.
    expect(ctx.toolIds, "toolIds is DECLARED").toBeDefined();
    expect(ctx.toolIds).toEqual([]);
    // Claimed by OUR OWN envelope, never by kind — matching on kind
    // would claim every rectangle in the document.
    expect(ctx.matches?.({ metadata: { v: 1, data: {} } })).toBe(true);
    expect(ctx.matches?.({ metadata: null })).toBe(false);
  });

  it("registers the sources + bindings panels under their declared ids", () => {
    const fake = fakeHost();
    dataBundle.activate(fake.host);
    expect(fake.panels.map((p) => p.id)).toEqual([
      "media.paged.data.panel.sources",
      "media.paged.data.panel.bindings",
      "media.paged.data.panel.dataset",
    ]);
    expect(fake.panels[0].title).toBe("Data sources");
    expect(fake.panels[1].title).toBe("Bindings");
    // "Dataset preview" (U12): distinct from the editor Window menu's
    // Data / Data Source / Data sources / Datasets cluster.
    expect(fake.panels[2].title).toBe("Dataset preview");
  });

  it("registers the seven commands under their declared ids", () => {
    const fake = fakeHost();
    dataBundle.activate(fake.host);
    expect(fake.commands.map((c) => c.id)).toEqual([
      "media.paged.data.command.importData",
      "media.paged.data.command.defineBinding",
      "media.paged.data.command.resolveBindings",
      "media.paged.data.command.lowerBinding",
      "media.paged.data.command.openDataset",
      "media.paged.data.command.captureDataSet",
      "media.paged.data.command.applyDataSet",
    ]);
  });

  it("the §9.9 data-set commands take their target from the command PAYLOAD", async () => {
    // The composability claim for "batch output through actions/scripts": a data
    // set switch is one payload-carrying command, so a host-side loop (the
    // editor's Actions recorder replays `CommandRegistry.invoke` steps) can
    // drive N outputs without this bundle knowing the recorder exists.
    const fake = fakeHost();
    dataBundle.activate(fake.host);
    const apply = fake.commands.find((c) => c.id === "media.paged.data.command.applyDataSet")!;
    // A missing name is a warned no-op, never a guess at which set was meant —
    // and it short-circuits synchronously, without touching the session.
    expect(apply.handler(null, {})).toEqual({ applied: 0, skipped: {} });
    // A named one runs (the engine wasm is absent here, so it degrades to 0
    // applied — the point is that the payload reached the session).
    await expect(apply.handler(null, { name: "Beta" })).resolves.toMatchObject({ applied: 0 });
  });

  it("registered ids match the manifest's contributes declaration", () => {
    const fake = fakeHost();
    dataBundle.activate(fake.host);
    expect(fake.panels.map((p) => p.id)).toEqual(dataBundle.manifest.contributes?.panels);
    expect(fake.commands.map((c) => c.id)).toEqual(dataBundle.manifest.contributes?.commands);
  });

  it("importData / defineBinding open their panels", () => {
    const fake = fakeHost();
    dataBundle.activate(fake.host);
    fake.commands.find((c) => c.id.endsWith("importData"))?.handler(undefined);
    fake.commands.find((c) => c.id.endsWith("defineBinding"))?.handler(undefined);
    fake.commands.find((c) => c.id.endsWith("openDataset"))?.handler(undefined);
    expect(fake.openedPanels).toEqual([
      "media.paged.data.panel.sources",
      "media.paged.data.panel.bindings",
      "media.paged.data.panel.dataset",
    ]);
  });

  it("dispose tears the session down (no throw — honesty smoke test)", () => {
    const fake = fakeHost();
    const handle = dataBundle.activate(fake.host);
    expect(() => handle.dispose()).not.toThrow();
  });
});
