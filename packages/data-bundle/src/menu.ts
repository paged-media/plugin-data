/**
 * paged.data — the menu bar entries.
 *
 * A top-level `Data` menu — which the host already opened, holding three panel-raising rows, so these MERGE into it rather than minting a second data menu.
 *
 * Registered through `contribute.menu()` (plugin-api 0.2.33). Before it
 * there was no menu door at all, so every verb here lived behind Cmd+K
 * and nowhere else.
 *
 * The host's Data menu already raises the three main panels by their
 * names ("Data sources…", "Bindings…", "Dataset preview…"), so this
 * table adds no second row for them; the menu registry keys on the
 * path, and two rows reading "Sources…" and "Data sources…" for the
 * same panel would only confuse. The command titles carry the same
 * panel names, so the palette and the menu agree.
 *
 * `lowerBinding` reads as "Place bindings on the page" rather than
 * "Resolve + lower bindings to the document": lower is compiler
 * vocabulary for the step a designer thinks of as placing.
 * */

import type { BundleHost, Disposable } from "@paged-media/plugin-api";

const C = "media.paged.data.command";

/** `[path, command suffix, group]`. */
const ENTRIES: [path: string, suffix: string, group: string][] = [
  // KEEPS THE HOST'S PATH. C1 curated `Object ▸ Insert data binding…`
  // and a spec pins it; filing this verb under `Data/` instead made the
  // Insert entry VANISH, because a courtesy stands down as soon as its
  // command is claimed anywhere. Declaring the same path supersedes the
  // courtesy in place, so the item stays exactly where users and the
  // spec already found it — and paged.data owns it now.
  ["Object/Insert data binding…", "defineBinding", "insert-plugin"],
  ["Data/Data query…", "editQuery", "panel"],
  ["Data/Refresh from sources", "resolveBindings", "resolve"],
  ["Data/Place bindings on the page", "lowerBinding", "resolve"],
  ["Data/Merge records into the document", "mergeRecords", "resolve"],
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
