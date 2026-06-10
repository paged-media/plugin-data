// The paged.data bundle entry. M0 scope (the honest slice): import a CSV into
// the vendored DuckDB-WASM engine, define a query + binding, resolve through the
// Rust engine, and lower to a page frame (variable replacement + single-region
// dynamic table degraded to tab-text + rules, D-02). Remote/DB sources +
// network consent, record flow, the data-provider contract, and OPFS
// persistence are NOT implemented — the panels + BREAKAGE_LOG say so.
//
// Wiring mirrors plugin-sheet: contributePanel for the two panels + the four
// commands. The host tracks every registration; the session is the one thing
// allocated OUTSIDE a facade-tracked registration, so dispose tears it down.

import type { BundleHandle, BundleHost } from "@paged-media/plugin-api";
import { contributePanel } from "@paged-media/plugin-sdk";

import manifest from "../manifest.json";
import { createSession } from "./session";
import { makeSourcesPanel } from "./panels/sources-panel";
import { makeBindingsPanel } from "./panels/bindings-panel";
import { makeDatasetPanel } from "./panels/dataset-panel";

const SOURCES_PANEL_ID = "media.paged.data.panel.sources";
const BINDINGS_PANEL_ID = "media.paged.data.panel.bindings";
const DATASET_PANEL_ID = "media.paged.data.panel.dataset";

/** The injected eval clock for `TODAY()` (days since 1970-01-01). The host
 *  supplies a real clock in production; M0 uses the load-time UTC day. */
function todaySerial(): number {
  return Math.floor(Date.now() / 86_400_000);
}

export function activate(host: BundleHost): BundleHandle {
  const session = createSession(host, todaySerial());

  contributePanel(host, {
    id: SOURCES_PANEL_ID,
    title: "Data sources",
    icon: "panel-canvas",
    component: makeSourcesPanel(host, session),
    defaultDock: "right",
  });

  contributePanel(host, {
    id: BINDINGS_PANEL_ID,
    title: "Bindings",
    icon: "panel-canvas",
    component: makeBindingsPanel(host, session),
    defaultDock: "right",
  });

  contributePanel(host, {
    id: DATASET_PANEL_ID,
    title: "Dataset",
    icon: "panel-canvas",
    component: makeDatasetPanel(host, session),
    defaultDock: "right",
  });

  host.contribute.command({
    id: "media.paged.data.command.importData",
    title: "Import data (.csv)",
    category: "Data",
    handler: () => host.shell.openPanel(SOURCES_PANEL_ID),
  });
  host.contribute.command({
    id: "media.paged.data.command.defineBinding",
    title: "Define a binding",
    category: "Data",
    handler: () => host.shell.openPanel(BINDINGS_PANEL_ID),
  });
  host.contribute.command({
    id: "media.paged.data.command.resolveBindings",
    title: "Refresh data from sources",
    category: "Data",
    handler: () => session.refreshData(),
  });
  host.contribute.command({
    id: "media.paged.data.command.lowerBinding",
    title: "Resolve + lower bindings to the document",
    category: "Data",
    handler: () => session.lowerAll(),
  });
  host.contribute.command({
    id: "media.paged.data.command.openDataset",
    title: "Open the dataset catalog & build panel",
    category: "Data",
    handler: () => host.shell.openPanel(DATASET_PANEL_ID),
  });

  host.log.info(`activated (apiVersion ${manifest.apiVersion})`);

  return {
    dispose() {
      session.dispose();
    },
  };
}

export { manifest, SOURCES_PANEL_ID, BINDINGS_PANEL_ID, DATASET_PANEL_ID };
