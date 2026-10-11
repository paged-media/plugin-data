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

// The Dataset panel — surfaces the three dataset-level capabilities over a
// selected query: a preview of its first rows, the §7 governed catalog (documented columns + governance
// drift), the §10 batch plan (per-record / per-group / one-catalog generation
// units), and the §7.1 data-provider publish (registered with the host's
// shared registry, D-09, when the host injects one). Honest about the gates: no
// sidecar file read yet (data.governed.extract) and no native batch execution
// (napi-rs) — the ENGINE sides are done; these are the seams.

import { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import type { BundleHost } from "@paged-media/plugin-api";

import type { LocaleInfo } from "../review";
import { DiagnosticsList } from "./diagnostics";
import { useSessionSnapshot } from "./use-session";

import type {
  BatchMode,
  BatchPlan,
  BatchRun,
  DataSourceSession,
  GovernedCatalog,
  QueryPreview,
  VariableSummary,
} from "../session";

const wrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3, 12px)",
  padding: "var(--space-3, 12px)",
  fontSize: "12px",
  color: "var(--pg-fg, #ddd)",
};

const note: CSSProperties = {
  color: "var(--pg-muted-fg, #999)",
  fontSize: "11px",
  lineHeight: 1.5,
};

/** Values/ids stay mono; prose is the host's sans. */
const mono: CSSProperties = {
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
};

/** How many rows "Preview rows" shows. */
const PREVIEW_ROWS = 20;

const SOURCES_PANEL_ID = "media.paged.data.panel.sources";
const QUERY_PANEL_ID = "media.paged.data.panel.query";

const row: CSSProperties = {
  display: "flex",
  gap: "var(--space-2, 8px)",
  flexWrap: "wrap",
  alignItems: "center",
};

type ModeKind = "perRecord" | "perGroup" | "oneCatalog";

export function makeDatasetPanel(
  host: BundleHost,
  session: DataSourceSession,
): () => ReactElement {
  return function DatasetPanel(): ReactElement {
    const [snapshot, refreshSnapshot] = useSessionSnapshot(session);
    const [query, setQuery] = useState<string>("");
    const [catalog, setCatalog] = useState<GovernedCatalog | null>(null);
    const [rows, setRows] = useState<QueryPreview | null>(null);
    const [plan, setPlan] = useState<BatchPlan | null>(null);
    const [planMode, setPlanMode] = useState<BatchMode | null>(null);
    const [runs, setRuns] = useState<BatchRun[] | null>(null);
    const [providerNote, setProviderNote] = useState<string>("");
    const [error, setError] = useState<string>("");
    const [locale, setLocaleState] = useState<string>(session.getLocale());
    // §9.1: every locale the engine's table knows, with its own samples.
    const [localeList, setLocaleList] = useState<LocaleInfo[]>([]);
    useEffect(() => {
      let live = true;
      void session.locales().then((l) => {
        if (live && l) setLocaleList(l);
      });
      return () => {
        live = false;
      };
    }, [session]);
    // §9.9 — the Variables / data sets palette.
    const [variables, setVariables] = useState<VariableSummary[]>([]);
    const [dataSets, setDataSets] = useState<string[]>([]);
    const [activeSet, setActiveSet] = useState<string>("");
    const [setName, setSetName] = useState<string>("Data Set 1");
    const [skips, setSkips] = useState<Record<string, string>>({});
    const [exportedXml, setExportedXml] = useState<string>("");

    const queries = snapshot.queries;
    const selected = query || queries[0] || "";

    async function showCatalog(): Promise<void> {
      setError("");
      try {
        await session.refreshData();
        // No sidecar file loaded yet (data.governed.extract reads it from the
        // source's metadata_sidecar); enrich with an empty sidecar → the live
        // schema, columns undocumented until a sidecar lands.
        const cat = await session.governedCatalog(selected, { columns: [] });
        setCatalog(cat);
        const sql = session.listQueries?.()?.find((q) => q.id === selected)?.sql;
        setRows(sql ? ((await session.previewQuery(sql, PREVIEW_ROWS)) ?? null) : null);
        refreshSnapshot();
      } catch (e) {
        setError(String(e));
        setCatalog(null);
        setRows(null);
      }
    }

    async function showPlan(kind: ModeKind): Promise<void> {
      setError("");
      try {
        const by = catalog?.columns[0]?.name;
        const mode: BatchMode =
          kind === "perGroup" && by
            ? { mode: "perGroup", by: [by] }
            : kind === "perRecord"
              ? { mode: "perRecord", key: by }
              : { mode: "oneCatalog" };
        setPlan(await session.planBatch(selected, mode));
        setPlanMode(mode);
        setRuns(null);
      } catch (e) {
        setError(String(e));
        setPlan(null);
        setPlanMode(null);
      }
    }

    // §10 batch RUN — the in-app executor over the current plan. The chain is
    // caller-supplied until the host frame-chain read (D-12): one nominal
    // page-height frame, so pagination counts are REAL engine output while the
    // readout says plainly that documents materialize via the automation lane.
    async function runBatch(): Promise<void> {
      if (!planMode) return;
      const rf = session.listBindings().find((b) => b.kind === "recordFlow");
      if (!rf) {
        setError("no record-flow binding — define one in the Bindings panel first");
        return;
      }
      setError("");
      try {
        const out = await session.runRecordFlowBatch(rf.id, planMode, [
          { frame: "batch-frame", page: "batch-page", heightPt: 700 },
        ]);
        setRuns(out);
      } catch (e) {
        setError(String(e));
        setRuns(null);
      }
    }

    async function publish(): Promise<void> {
      setError("");
      try {
        const pub = await session.publishProvider(selected, `${selected}-dataset`, "dataset");
        // Registered with the host's data-provider registry (D-09) when the
        // host injects one; only a host without it gets the "can't share" note.
        setProviderNote(
          session.isProviderRegistered(pub.id)
            ? `Provider "${pub.id}" (revision ${pub.revision}) is shared with other plugins.`
            : `Provider "${pub.id}" (revision ${pub.revision}) is ready; this editor can't share it with other plugins yet.`,
        );
      } catch (e) {
        setError(String(e));
        setProviderNote("");
      }
    }

    // ── §9.9 — Variables / data sets ─────────────────────────────────────────

    async function refreshPalette(): Promise<void> {
      setVariables(await session.variables());
      setDataSets(await session.listDataSets());
      refreshSnapshot();
    }

    async function capture(): Promise<void> {
      setError("");
      await session.captureDataSet(setName || "Data Set", 0);
      await refreshPalette();
    }

    async function captureAll(): Promise<void> {
      setError("");
      // One data set PER RECORD — the join a drawing plugin cannot make: an
      // Illustrator author builds these by hand, one artboard state at a time.
      await session.refreshData();
      await session.captureEveryRecord(selected, {
        nameColumn: catalog?.columns[0]?.name,
      });
      await refreshPalette();
    }

    async function switchTo(name: string): Promise<void> {
      setError("");
      setActiveSet(name);
      const result = await session.applyDataSet(name);
      setSkips(result.skipped);
      refreshSnapshot();
    }

    async function exportLibrary(): Promise<void> {
      setError("");
      setExportedXml("");
      const xml = await session.exportVariableLibrary();
      if (!xml) {
        setError("nothing to export (no variables defined)");
        return;
      }
      // Write the file through the host's own save door when it has one. K-10
      // (`shell.saveFile`) is BUILT in plugin-sdk main but is not in any
      // published contract yet, so the probe is structural and the fallback is
      // real: show the XML for the user to copy, rather than reaching for a DOM
      // download the bundle realm may not have — or pretending nothing happened.
      const shell = host.shell as unknown as {
        saveFile?(spec: { name: string; bytes: Uint8Array }): Promise<unknown>;
      };
      if (host.supports("shell.saveFile@1") && typeof shell.saveFile === "function") {
        await shell.saveFile({ name: "variables.xml", bytes: new TextEncoder().encode(xml) });
        return;
      }
      setExportedXml(xml);
    }

    async function importLibrary(): Promise<void> {
      setError("");
      if (!host.supports("shell.pickFile@1")) {
        // Technical detail: the missing door is shell.pickFile@1.
        setError("This host has no file picker.");
        return;
      }
      const picked = await host.shell.pickFile({ accept: [".xml"] });
      const file = picked[0];
      if (!file) return;
      const xml = new TextDecoder().decode(file.bytes);
      await session.importVariableLibrary(xml);
      await refreshPalette();
    }

    const flowBinding = (session.listBindings?.() ?? []).find((b) => b.kind === "recordFlow");
    const openPanel = (id: string): void => {
      try {
        host.shell.openPanel(id);
      } catch {
        // a headless host has no panels
      }
    };
    const documented = catalog?.columns.filter((c) => c.documented).length ?? 0;
    const drift = catalog?.diagnostics.length ?? 0;

    return (
      <div style={wrap}>
        {/* §9.1 localization — the session formatting locale. */}
        <label style={row}>
          Locale:{" "}
          <select
            value={locale}
            onChange={(e) => {
              const next = e.target.value;
              session.setLocale(next);
              setLocaleState(next);
            }}
          >
            {localeList.length === 0 ? (
              <>
                <option value="en">en — $1,234.50 · YYYY-MM-DD</option>
                <option value="de">de — 1.234,56 € · DD.MM.YYYY</option>
              </>
            ) : (
              localeList.map((l) => (
                <option key={l.tag} value={l.tag}>
                  {l.tag} — {l.name}: {l.currency} · {l.date}
                </option>
              ))
            )}
          </select>
        </label>

        {queries.length === 0 ? (
          <div style={row} data-data-dataset-empty>
            <p style={{ ...note, margin: 0, flexBasis: "100%" }}>
              {snapshot.sources.length === 0
                ? "No queries yet. Import a data source first."
                : "No queries yet. Pick records in Bindings, or save a query in Data query."}
            </p>
            {snapshot.sources.length === 0 ? (
              <button type="button" data-data-dataset-open-sources onClick={() => openPanel(SOURCES_PANEL_ID)}>
                Open Data sources
              </button>
            ) : (
              <button type="button" data-data-dataset-open-query onClick={() => openPanel(QUERY_PANEL_ID)}>
                Open Data query
              </button>
            )}
          </div>
        ) : (
          <>
            <label style={row}>
              Query{" "}
              <select
                value={selected}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setRows(null);
                  setCatalog(null);
                }}
              >
                {queries.map((q) => (
                  <option key={q} value={q}>
                    {q}
                  </option>
                ))}
              </select>
            </label>

            {/* Catalog = the §7 governed catalog; provider = the §7.1
                data-provider publish. */}
            <div style={row}>
              <button
                type="button"
                data-data-dataset-preview
                title="Refresh the data and show the query's first rows"
                onClick={() => void showCatalog()}
              >
                Preview rows
              </button>
              <button type="button" onClick={() => void publish()}>
                Publish provider
              </button>
            </div>

            {catalog && (
              <div style={note}>
                {catalog.columns.length} column{catalog.columns.length === 1 ? "" : "s"} · {documented} documented
                {drift > 0 ? ` · ${drift} schema note${drift === 1 ? "" : "s"}` : ""}
              </div>
            )}
            {rows && rows.diagnostic && (
              <div style={{ color: "var(--status-error)" }} data-data-dataset-rows-error>
                {rows.diagnostic.message}
              </div>
            )}
            {rows && !rows.diagnostic && (
              <div data-data-dataset-rows={rows.rows.length}>
                <div style={{ overflowX: "auto", maxWidth: "100%" }}>
                  <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
                    <thead>
                      <tr>
                        {rows.columns.map((c) => (
                          <th
                            key={c.name}
                            title={c.type}
                            style={{ textAlign: "left", padding: "2px 6px", borderBottom: "1px solid var(--pg-border)" }}
                          >
                            {c.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.rows.map((r, i) => (
                        <tr key={i}>
                          {r.map((v, j) => (
                            <td key={j} style={{ ...mono, padding: "2px 6px", whiteSpace: "nowrap" }}>
                              {v ?? ""}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <span style={note}>
                  {rows.rows.length === 0
                    ? "The query returned no rows."
                    : `First ${rows.rows.length}${rows.total !== null ? ` of ${rows.total}` : ""} row${rows.total === 1 ? "" : "s"}.`}
                </span>
              </div>
            )}

            {/* The §10 batch plan (per-record / per-group / one-catalog
                generation units). */}
            <div style={row}>
              Split output:
              <button type="button" onClick={() => void showPlan("perRecord")}>
                Per record
              </button>
              <button type="button" onClick={() => void showPlan("perGroup")}>
                Per group
              </button>
              <button type="button" onClick={() => void showPlan("oneCatalog")}>
                One catalog
              </button>
            </div>
            {plan && (
              <div>
                {plan.units.length} output{plan.units.length === 1 ? "" : "s"} from {plan.totalRecords} record
                {plan.totalRecords === 1 ? "" : "s"}
                <span style={note}> — {plan.units.slice(0, 4).map((u) => u.label).join(", ")}</span>
                <div style={{ marginTop: 4 }}>
                  {/* The §10 in-app batch executor: real pagination over a
                      nominal frame chain. It writes no pages in this editor,
                      so it is labelled as the plan it is. */}
                  <button
                    type="button"
                    data-data-batch-run
                    disabled={!flowBinding}
                    title={
                      flowBinding
                        ? "Count the frames and records each output takes. No pages are made in this editor."
                        : "Needs a record-flow binding — add one in Bindings."
                    }
                    onClick={() => void runBatch()}
                  >
                    Plan batch
                  </button>
                </div>
              </div>
            )}
            {runs && (
              <div data-data-batch-runs={runs.length}>
                Planned {runs.length} output document{runs.length === 1 ? "" : "s"}:
                <ul style={{ margin: "4px 0", paddingLeft: 16 }}>
                  {runs.slice(0, 6).map((r, i) => {
                    const flow = r.flow as { frames?: unknown[]; total?: number };
                    return (
                      <li key={i}>
                        {r.label}
                        <span style={note}>
                          {" "}
                          · {flow.frames?.length ?? "?"} frame(s) ·{" "}
                          {flow.total ?? "?"} record(s)
                        </span>
                      </li>
                    );
                  })}
                  {runs.length > 6 && <li style={note}>… {runs.length - 6} more</li>}
                </ul>
                {/* Developer knowledge (was user-facing copy): real
                    pagination over a nominal one-frame chain (the live
                    frame-chain read is D-12); output documents materialize
                    via the automation lane (data-cli / napi), not in this
                    editor. */}
                <span style={note}>
                  Output documents are produced by the batch automation tools,
                  not inside this editor.
                </span>
              </div>
            )}

            {/* §9.9 — Variables / data sets (the Illustrator palette, over
                paged.data's own bindings). A variable IS a binding: the binding
                id is the name and the binding kind is the trait. */}
            <div data-data-variables>
              <div style={row}>
                Variables:
                <button type="button" onClick={() => void refreshPalette()}>
                  Refresh palette
                </button>
                <button type="button" onClick={() => void importLibrary()}>
                  Import library (XML)
                </button>
                <button type="button" onClick={() => void exportLibrary()}>
                  Export library (XML)
                </button>
              </div>
              {variables.length === 0 ? (
                <p style={note}>
                  No variables yet. A text, image or visibility binding IS a variable —
                  define one in the Bindings panel, then capture a data set here.
                </p>
              ) : (
                <ul style={{ margin: "4px 0", paddingLeft: 16 }}>
                  {variables.map((v) => (
                    <li key={v.name} style={v.bound ? undefined : note}>
                      <span style={mono}>{v.name}</span> <span style={note}>· {v.trait}</span>
                      {!v.bound && (
                        <span style={note}>
                          {" "}
                          ·{" "}
                          {/* Technical detail (kept for developers): graph
                              data is carried through the library verbatim but
                              never applied — the apply lane is RFI D-15. */}
                          {v.trait === "graphdata"
                            ? "graph data — kept in the library, but not applied in this document"
                            : "not bound in this document — skipped on apply"}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <div style={row}>
                <input
                  value={setName}
                  onChange={(e) => setSetName(e.target.value)}
                  aria-label="data set name"
                  size={14}
                />
                <button type="button" onClick={() => void capture()}>
                  Capture current
                </button>
                <button type="button" onClick={() => void captureAll()}>
                  Capture every record
                </button>
              </div>

              {dataSets.length > 0 && (
                <div style={row}>
                  data set:{" "}
                  <select value={activeSet} onChange={(e) => void switchTo(e.target.value)}>
                    <option value="">— pick a data set —</option>
                    {dataSets.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                  <span style={note}>
                    {dataSets.length} set{dataSets.length === 1 ? "" : "s"} · switching is one undo step
                  </span>
                </div>
              )}
              {exportedXml && (
                <div>
                  {/* Technical detail (kept for developers): the missing door
                      is shell.saveFile — K-10, built upstream in plugin-sdk
                      main but not in any published contract yet. */}
                  <span style={note}>
                    This host can&apos;t save files directly — copy the library
                    below into a .xml file.
                  </span>
                  <textarea
                    readOnly
                    value={exportedXml}
                    rows={8}
                    style={{ width: "100%", fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 11 }}
                    data-data-variable-library
                  />
                </div>
              )}
              {Object.keys(skips).length > 0 && (
                <ul style={{ ...note, margin: "4px 0", paddingLeft: 16 }} data-data-set-skips>
                  {Object.entries(skips).map(([name, why]) => (
                    <li key={name}>
                      skipped {name}: {why}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {providerNote && <div style={note}>{providerNote}</div>}
            {snapshot.message && (
              <div
                data-data-dataset-status={snapshot.status}
                style={snapshot.status === "error" ? { color: "var(--status-error)" } : note}
              >
                {snapshot.message}
              </div>
            )}
            {error && (
              <div data-status="error" style={{ color: "var(--status-error, #e66)" }}>
                {error}
              </div>
            )}
          </>
        )}

        <DiagnosticsList
          diagnostics={snapshot.diagnostics}
          sources={["variables"]}
          onClear={() => {
            session.clearDiagnostics();
            refreshSnapshot();
          }}
        />

        {/* Developer knowledge (was user-facing copy) — the honest gates:
            the metadata sidecar is read from the source's metadata_sidecar
            by the broader data.governed.extract path (file/URL/DB); provider
            registration rides host.dataProviders (D-09) when the host injects
            it; native server/CI batch awaits the napi-rs binding. The engine
            sides are done. */}
        <p style={note}>Server-side batch runs aren&apos;t available in this editor yet.</p>
      </div>
    );
  };
}
