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
  const host = {
    manifest: dataBundle.manifest,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    contribute: {
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
  return { host, panels, commands, openedPanels, disposedCount: () => disposed };
}

describe("data_plugin_bundle_activate", () => {
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
    expect(fake.panels[2].title).toBe("Dataset");
  });

  it("registers the five commands under their declared ids", () => {
    const fake = fakeHost();
    dataBundle.activate(fake.host);
    expect(fake.commands.map((c) => c.id)).toEqual([
      "media.paged.data.command.importData",
      "media.paged.data.command.defineBinding",
      "media.paged.data.command.resolveBindings",
      "media.paged.data.command.lowerBinding",
      "media.paged.data.command.openDataset",
    ]);
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
