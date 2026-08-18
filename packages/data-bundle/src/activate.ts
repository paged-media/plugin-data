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
    // "Dataset preview", not "Dataset": the editor's Window menu already
    // carries Data / Data Source / Data sources / Datasets — this title
    // stays distinct from all of them.
    title: "Dataset preview",
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

  // §9.9 — the two data-set verbs as COMMANDS, not just panel buttons.
  //
  // This is deliberate and it is the whole of what "batch output through
  // actions/scripts" (the catalog's clause) needs from THIS side. The editor's
  // Actions recorder taps `CommandRegistry.invoke`, so a recorded action is a
  // list of command steps replayed against the replay-time selection. Given
  // that, batch output over data sets composes as:
  //
  //     for (const name of listDataSets())
  //       invoke("media.paged.data.command.applyDataSet", { name });
  //       replay(<the recorded action>);
  //
  // — a data set switch is one recordable, replayable, payload-carrying command
  // whose effect is ONE undo step. The loop itself is HOST-side (the recorder
  // lives in the editor and this bundle must not depend on it); all this plugin
  // owes it is a command that takes the set name as a payload and applies
  // atomically. That is what these two are. Nothing here reaches for the
  // recorder, and nothing here assumes it exists.
  host.contribute.command({
    id: "media.paged.data.command.captureDataSet",
    title: "Capture the current values as a data set",
    category: "Data",
    handler: (_paged, payload) => {
      const p = (payload ?? {}) as { name?: string; record?: number };
      return session.captureDataSet(p.name ?? "Data Set", p.record ?? 0);
    },
  });
  host.contribute.command({
    id: "media.paged.data.command.applyDataSet",
    title: "Apply a data set to the document",
    category: "Data",
    handler: (_paged, payload) => {
      const p = (payload ?? {}) as { name?: string };
      if (!p.name) {
        host.log.warn("applyDataSet: no data-set name in the command payload");
        return { applied: 0, skipped: {} };
      }
      return session.applyDataSet(p.name);
    },
  });

  // ADR 024 — the dataBinding edit context.
  //
  // paged.data was the one content-bearing plugin with NO context at
  // all, which the context-sensitivity audit caught: it stamps its
  // `x-paged:media.paged.data` envelope onto the frames it creates
  // (`lower-to-mutations`, `barcode`), so those frames ARE plugin
  // content — but double-clicking one fell through to group descent and
  // the Properties panel showed no owned-type row, not even the
  // "double-click to edit in place" hint every other content type gives.
  //
  // What it edits was never actually open: a bound frame's content IS
  // its binding, and the Bindings panel is the surface that edits it.
  //
  // NO CANVAS TOOL, declared empty. A binding is an expression over a
  // data source, not geometry — a brush or a pen has nothing to act on.
  // Empty is a statement here, distinct from omitting the field, which
  // reads as "unrestricted" and would leave the whole rail lit.
  if (host.supports("contribute.editContext@1")) {
    host.contribute.editContext({
      type: "dataBinding",
      entry: "doubleClick",
      // Claimed by OUR OWN metadata envelope — the host pre-resolves
      // this plugin's namespace and never a foreign one, so this cannot
      // claim another plugin's frame. Matching by KIND would claim every
      // rectangle in the document.
      matches: (c) => c.metadata !== null,
      toolIds: [],
      panelIds: [BINDINGS_PANEL_ID],
    });
  }

  host.log.info(`activated (apiVersion ${manifest.apiVersion})`);

  return {
    dispose() {
      session.dispose();
    },
  };
}

export { manifest, SOURCES_PANEL_ID, BINDINGS_PANEL_ID, DATASET_PANEL_ID };
