/**
 * paged.data — the menu bar entries.
 *
 * A top-level `Data` menu — which the host already opened, holding three panel-raising rows, so these MERGE into it rather than minting a second data menu.
 *
 * Registered through `contribute.menu()` (plugin-api 0.2.33). Before it
 * there was no menu door at all, so every verb here lived behind Cmd+K
 * and nowhere else.
 *
 * THE PATHS HERE ARE NAMED FOR WHAT THE COMMANDS DO, NOT FOR THEIR
 * TITLES, and in two cases those differ. `importData` is registered as
 * "Import data (.csv)" and its handler is `openPanel(SOURCES_PANEL_ID)`
 * — it opens a panel and imports nothing, which the 2026-08 audit filed
 * as a label that lies. `defineBinding` is the same shape. Repeating
 * those titles in a menu would spread the claim to a second surface, so
 * these rows say "Sources…" and "Bindings…", which is what clicking
 * them does. Fixing the command titles is separate work in this bundle.
 *
 * `lowerBinding` likewise reads as "Place bindings on the page" rather
 * than "Resolve + lower bindings to the document": lower is compiler
 * vocabulary for the step a designer thinks of as placing.
 * */

import type { BundleHost, Disposable } from "@paged-media/plugin-api";

const C = "media.paged.data.command";

/** `[path, command suffix, group]`. */
const ENTRIES: [path: string, suffix: string, group: string][] = [
  ["Data/Sources…", "importData", "panel"],
  ["Data/Bindings…", "defineBinding", "panel"],
  ["Data/Dataset catalog…", "openDataset", "panel"],
  ["Data/Refresh from sources", "resolveBindings", "resolve"],
  ["Data/Place bindings on the page", "lowerBinding", "resolve"],
  ["Data/Capture current values as a data set", "captureDataSet", "dataset"],
  ["Data/Apply a data set…", "applyDataSet", "dataset"],
];

/**
 * Register every entry; one Disposable drops them all. Degrades on a
 * host older than plugin-api 0.2.33 by contributing nothing and saying
 * so, rather than throwing and taking the bundle down over a menu.
 */
export function contributeMenu(host: BundleHost): Disposable {
  const contribute = host.contribute as BundleHost["contribute"] & {
    menu?: (c: {
      path: string;
      command: string;
      order?: number;
      group?: string;
    }) => Disposable;
  };
  if (typeof contribute.menu !== "function") {
    host.log.info(
      "host predates contribute.menu (plugin-api 0.2.33) — " +
        `${ENTRIES.length} menu entries not contributed; every command ` +
        "remains reachable through the command palette",
    );
    return { dispose() {} };
  }

  const handles: Disposable[] = [];
  const perGroup = new Map<string, number>();
  for (const [path, suffix, group] of ENTRIES) {
    const n = (perGroup.get(group) ?? 0) + 1;
    perGroup.set(group, n);
    handles.push(
      contribute.menu({ path, command: `${C}.${suffix}`, group, order: n * 10 }),
    );
  }
  host.log.info(`contributed ${handles.length} menu entries`);
  return {
    dispose() {
      for (const h of handles) h.dispose();
      handles.length = 0;
    },
  };
}

/** Exported for the bundle's own test. */
export const MENU_ENTRIES = ENTRIES;
export const MENU_COMMAND_PREFIX = C;
