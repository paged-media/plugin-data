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
// selected query: the §7 governed catalog (documented columns + governance
// drift), the §10 batch plan (per-record / per-group / one-catalog generation
// units), and the §7.1 data-provider publish (ready to register when the D-09
// SDK door lands). Honest about the gates: no sidecar file read yet
// (data.governed.extract), no host.dataProviders registry (D-09), no native
// batch execution (napi-rs) — the ENGINE sides are done; these are the seams.

import { useState, type CSSProperties, type ReactElement } from "react";
import type { BundleHost } from "@paged-media/plugin-api";

import type {
  BatchMode,
  BatchPlan,
  BatchRun,
  DataSourceSession,
  GovernedCatalog,
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
  font: "var(--font-mono, 12px ui-monospace, monospace)",
};

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
    const [snapshot, setSnapshot] = useState(session.getState());
    const [query, setQuery] = useState<string>("");
    const [catalog, setCatalog] = useState<GovernedCatalog | null>(null);
    const [plan, setPlan] = useState<BatchPlan | null>(null);
    const [planMode, setPlanMode] = useState<BatchMode | null>(null);
    const [runs, setRuns] = useState<BatchRun[] | null>(null);
    const [providerNote, setProviderNote] = useState<string>("");
    const [error, setError] = useState<string>("");
    const [locale, setLocaleState] = useState<"en" | "de">(session.getLocale());
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
        setSnapshot(session.getState());
      } catch (e) {
        setError(String(e));
        setCatalog(null);
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
        // Technical detail (kept for developers): registration is DEFERRED —
        // it awaits the host.dataProviders door (RFI D-09); the engine-side
        // publication payload is real.
        setProviderNote(
          `Provider "${pub.id}" (revision ${pub.revision}) is ready; this editor can't share it with other plugins yet.`,
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
      setSnapshot(session.getState());
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
      setSnapshot(session.getState());
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
              const next = e.target.value as "en" | "de";
              session.setLocale(next);
              setLocaleState(next);
            }}
          >
            <option value="en">en — $1,234.50 · YYYY-MM-DD</option>
            <option value="de">de — 1.234,56 € · DD.MM.YYYY</option>
          </select>
        </label>

        {queries.length === 0 ? (
          <p style={note}>No queries yet — define one in the Bindings panel, then return here.</p>
        ) : (
          <>
            <label style={row}>
              query:{" "}
              <select value={selected} onChange={(e) => setQuery(e.target.value)}>
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
              <button type="button" onClick={() => void showCatalog()}>
                Refresh + catalog
              </button>
              <button type="button" onClick={() => void publish()}>
                Publish provider
              </button>
            </div>

            {catalog && (
              <div>
                catalog: {catalog.columns.length} cols · {documented} documented · {drift}{" "}
                diagnostic(s)
                <ul style={{ margin: "4px 0", paddingLeft: 16 }}>
                  {catalog.columns.slice(0, 8).map((c) => (
                    <li key={c.name}>
                      {c.label}{" "}
                      <span style={note}>
                        · {c.dataType}
                        {c.documented ? "" : " · undocumented"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* The §10 batch plan (per-record / per-group / one-catalog
                generation units). */}
            <div style={row}>
              Build:
              <button type="button" onClick={() => void showPlan("perRecord")}>
                per record
              </button>
              <button type="button" onClick={() => void showPlan("perGroup")}>
                per group
              </button>
              <button type="button" onClick={() => void showPlan("oneCatalog")}>
                one catalog
              </button>
            </div>
            {plan && (
              <div>
                plan: {plan.mode} · {plan.units.length} unit(s) over {plan.totalRecords} record(s)
                <span style={note}> — {plan.units.slice(0, 4).map((u) => u.label).join(", ")}</span>
                <div style={{ marginTop: 4 }}>
                  {/* The §10 in-app batch executor. */}
                  <button type="button" data-data-batch-run onClick={() => void runBatch()}>
                    Run batch
                  </button>
                </div>
              </div>
            )}
            {runs && (
              <div data-data-batch-runs={runs.length}>
                ran {runs.length} output document(s):
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
                    {dataSets.length} set(s) · switching applies in ONE undo step
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
                    style={{ width: "100%", font: "var(--font-mono, 11px ui-monospace, monospace)" }}
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
            {error && (
              <div data-status="error" style={{ color: "var(--status-error, #e66)" }}>
                {error}
              </div>
            )}
          </>
        )}

        {/* Developer knowledge (was user-facing copy) — the honest gates:
            the metadata sidecar is read from the source's metadata_sidecar
            by the broader data.governed.extract path (file/URL/DB); provider
            registration awaits the host.dataProviders door (D-09); native
            server/CI batch awaits the napi-rs binding. The engine sides are
            done. */}
        <p style={note}>
          Sharing datasets with other plugins and server-side batch runs
          aren&apos;t available in this editor yet.
        </p>
      </div>
    );
  };
}
