// Data Merge as a command: the ONE path the menu (Data ▸ Merge records into
// the document, `media.paged.data.command.mergeRecords`) and a script
// (`paged.invoke("media.paged.data.merge", …)`, the typed command of the
// object model) both take. The options are the session's
// (`SessionMergeOptions`); without a query the first one merges, Single
// Record, through the <<field>> frames on the active page.

import type { BundleHost } from "@paged-media/plugin-api";

import type { MergeResult, RecordsPerPage } from "./merge";
import type { DataSourceSession, SessionMergeOptions } from "./session";

/** Why a merge did not start: there is nothing to merge yet. */
export const NO_QUERY_TO_MERGE = "no query to merge: import a data source first (Data sources)";

/**
 * Run a Data Merge. `null`, at once, when there is no query yet; the Bindings
 * panel (which says what is missing and holds the Data Merge options) is
 * opened then, where the host has panels.
 */
export function runMergeCommand(
  host: BundleHost,
  session: DataSourceSession,
  bindingsPanel: string,
  payload: Partial<SessionMergeOptions>,
): Promise<MergeResult> | null {
  const query = payload.query || session.getState().queries[0];
  if (!query) {
    try {
      host.shell.openPanel(bindingsPanel);
    } catch {
      // headless: nothing to open; the caller reports NO_QUERY_TO_MERGE
    }
    return null;
  }
  return session.mergeRecords({ ...payload, query });
}

/** The arguments of the typed command `media.paged.data.merge`: the merge
 *  options flat, as a script writes them. Every field is optional. */
export interface MergeCommandArgs {
  query?: string;
  /** `single` (default): one record per page; `multiple`: as many as fit. */
  mode?: "single" | "multiple";
  arrange?: "rows" | "columns";
  rowSpacingPt?: number;
  columnSpacingPt?: number;
  removeBlankLines?: boolean;
  /** `keep` (default): the output goes on new pages after the template;
   *  `consume`: the template page holds the first output page. */
  template?: "keep" | "consume";
  /** `current` (default) or `newDocument` (InDesign's "Create Merged
   *  Document"; needs the host's documents door). */
  destination?: "current" | "newDocument";
  /** The template page (default: the active page). */
  pageId?: string;
  documentName?: string;
}

/** The typed command's arguments as the session's merge options. */
export function mergeOptionsOf(a: MergeCommandArgs): Partial<SessionMergeOptions> {
  const recordsPerPage: RecordsPerPage =
    a.mode === "multiple"
      ? {
          mode: "multiple",
          ...(a.arrange ? { arrange: a.arrange } : {}),
          ...(typeof a.rowSpacingPt === "number" ? { rowSpacingPt: a.rowSpacingPt } : {}),
          ...(typeof a.columnSpacingPt === "number" ? { columnSpacingPt: a.columnSpacingPt } : {}),
        }
      : { mode: "single" };
  return {
    ...(a.query ? { query: a.query } : {}),
    recordsPerPage,
    ...(typeof a.removeBlankLines === "boolean" ? { removeBlankLines: a.removeBlankLines } : {}),
    ...(a.template ? { template: a.template } : {}),
    ...(a.destination ? { destination: a.destination } : {}),
    ...(a.pageId ? { pageId: a.pageId } : {}),
    ...(a.documentName ? { documentName: a.documentName } : {}),
  };
}

/** What a script gets back: the counts and the panel's message, not the
 *  whole plan. */
export interface MergeCommandResult {
  ok: boolean;
  records: number;
  pages: number;
  overset: number;
  message: string;
  diagnostics: string[];
}

export function mergeCommandResult(r: MergeResult | null, session: DataSourceSession): MergeCommandResult {
  if (!r) return { ok: false, records: 0, pages: 0, overset: 0, message: NO_QUERY_TO_MERGE, diagnostics: [NO_QUERY_TO_MERGE] };
  return {
    ok: r.ok,
    records: r.records.length,
    pages: r.pages.length,
    overset: r.overset.length,
    message: session.getState().message,
    diagnostics: r.diagnostics,
  };
}
