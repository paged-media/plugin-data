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

// ADR 323 (object-model design §4 "Panels") — paged.data's OWN objects as a
// SCHEMA panel of property rows: the sources, queries, bindings, data sets
// and variables, each a list (publishObjectList over `host.objects`) with
// the picked item's properties below it. The host renders every row with
// its one schema-driven `PropertyField` over `host.objects` (the widget and
// read-only state come from the kind's manifest schema row; a commit goes
// through the kind's set / batch — the same session paths the panels use).
// The bundle declares fields, never widgets. The React panels (Sources,
// Bindings, Dataset preview, Query) stay: they own import, consent, the
// expression builder, preview and diagnostics; this panel is the property
// view of the same objects.

import type { BundleHost, Disposable, PanelSchema } from "@paged-media/plugin-api";
import { propertyRows, publishObjectList } from "@paged-media/plugin-sdk";

import { PANEL_FIELDS, PLUGIN_ID, type KindName } from "../object-model";
import type { DataSourceSession } from "../session";

export const OBJECTS_PANEL_ID = "media.paged.data.panel.objects";

const qualified = (kind: KindName) => `plugin:${PLUGIN_ID}/${kind}`;

/** Published bindings the lists and their property rows share. */
export const BIND = {
  sources: "data.objects.sources",
  source: "data.objects.source",
  queries: "data.objects.queries",
  query: "data.objects.query",
  bindings: "data.objects.bindings",
  binding: "data.objects.binding",
  dataSets: "data.objects.dataSets",
  dataSet: "data.objects.dataSet",
  variables: "data.objects.variables",
  variable: "data.objects.variable",
} as const;

/** One section per kind: the list, then the picked item's rows. */
const SECTIONS: ReadonlyArray<{
  kind: KindName;
  title: string;
  rows: string;
  select: string;
  labelPath?: string;
  secondaryPath?: string;
}> = [
  { kind: "source", title: "Sources", rows: BIND.sources, select: BIND.source, secondaryPath: "type" },
  { kind: "query", title: "Queries", rows: BIND.queries, select: BIND.query, secondaryPath: "shape" },
  { kind: "binding", title: "Bindings", rows: BIND.bindings, select: BIND.binding, secondaryPath: "kind" },
  { kind: "dataSet", title: "Data sets", rows: BIND.dataSets, select: BIND.dataSet },
  { kind: "variable", title: "Variables", rows: BIND.variables, select: BIND.variable, secondaryPath: "trait" },
];

const paths = (kind: KindName) => PANEL_FIELDS.filter((f) => f.kind === kind).map((f) => f.path);

const list = (rows: string, select: string) => ({
  widget: "paged.list",
  list: { items: { kind: "binding" as const, bind: rows }, labelField: "name", secondaryField: "secondary", selectionBinding: select },
});

/** The panel, from `PANEL_FIELDS` (every entry is a row of its kind). */
export const DATA_OBJECTS_PANEL: PanelSchema = {
  id: OBJECTS_PANEL_ID,
  title: "Data objects",
  icon: "panel-canvas",
  defaultDock: "right",
  sections: SECTIONS.map((s, i) => ({
    title: s.title,
    ...(i > 1 ? { collapsible: true } : {}),
    rows: [list(s.rows, s.select), ...propertyRows(qualified(s.kind), paths(s.kind), { bind: s.select })],
  })),
};

/** Keep the five lists live. The session's objects are session state the
 *  object registry does not announce, so a session change re-reads them
 *  too (coalesced: one re-read per burst). The lists read only a READY
 *  session: listing data sets or variables would boot the engine, and
 *  activation boots nothing; a restore or an undo reloading the session
 *  (status idle meanwhile) is never raced. They start with the first ready
 *  session, so activation pays no host calls for them (perf W7). */
export function publishObjectLists(host: BundleHost, session: DataSourceSession): Disposable {
  const ready = () => session.getState().status === "ready";
  let lists: ReturnType<typeof publishObjectList>[] | null = null;
  const start = () =>
    SECTIONS.map((s) =>
      publishObjectList(host, {
        rows: s.rows,
        select: s.select,
        selector: () => (ready() ? qualified(s.kind) : null),
        ...(s.labelPath ? { labelPath: s.labelPath } : {}),
        ...(s.secondaryPath ? { secondaryPath: s.secondaryPath } : {}),
      }),
    );
  let pending: ReturnType<typeof setTimeout> | null = null;
  const sub = session.onDidChange(() => {
    if (pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      if (lists) for (const l of lists) void l.refresh();
      else if (ready()) lists = start(); // its first read is the refresh
    }, 0);
  });
  return {
    dispose() {
      if (pending !== null) clearTimeout(pending);
      sub.dispose();
      for (const l of lists ?? []) l.dispose();
    },
  };
}
