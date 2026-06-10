// The Dataset panel — surfaces the three dataset-level capabilities over a
// selected query: the §7 governed catalog (documented columns + governance
// drift), the §10 batch plan (per-record / per-group / one-catalog generation
// units), and the §7.1 data-provider publish (ready to register when the D-09
// SDK door lands). Honest about the gates: no sidecar file read yet
// (data.governed.extract), no host.dataProviders registry (D-09), no native
// batch execution (napi-rs) — the ENGINE sides are done; these are the seams.

import { useState, type CSSProperties, type ReactElement } from "react";
import type { BundleHost } from "@paged-media/plugin-api";

import type { BatchMode, BatchPlan, DataSourceSession, GovernedCatalog } from "../session";

const wrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3, 12px)",
  padding: "var(--space-3, 12px)",
  font: "var(--font-mono, 12px ui-monospace, monospace)",
  color: "var(--pg-fg, #ddd)",
};

const note: CSSProperties = {
  color: "var(--pg-fg-muted, #999)",
  fontSize: "11px",
  lineHeight: 1.5,
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
    const [providerNote, setProviderNote] = useState<string>("");
    const [error, setError] = useState<string>("");
    const [locale, setLocaleState] = useState<"en" | "de">(session.getLocale());

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
      } catch (e) {
        setError(String(e));
        setPlan(null);
      }
    }

    async function publish(): Promise<void> {
      setError("");
      try {
        const pub = await session.publishProvider(selected, `${selected}-dataset`, "dataset");
        setProviderNote(
          `provider "${pub.id}" ready · rev ${pub.revision} · registration deferred (D-09)`,
        );
      } catch (e) {
        setError(String(e));
        setProviderNote("");
      }
    }

    const documented = catalog?.columns.filter((c) => c.documented).length ?? 0;
    const drift = catalog?.diagnostics.length ?? 0;

    return (
      <div style={wrap}>
        <strong>paged.data · dataset (v{host.manifest.version})</strong>

        <label style={row}>
          locale (§9.1):{" "}
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

            <div style={row}>
              <button type="button" onClick={() => void showCatalog()}>
                Refresh + catalog (§7)
              </button>
              <button type="button" onClick={() => void publish()}>
                Publish provider (§7.1)
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

            <div style={row}>
              build (§10):
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
              </div>
            )}

            {providerNote && <div style={note}>{providerNote}</div>}
            {error && (
              <div data-status="error" style={{ color: "var(--status-error, #e66)" }}>
                {error}
              </div>
            )}
          </>
        )}

        <p style={note}>
          Honest gates: the metadata sidecar is read from the source&apos;s metadata_sidecar by the
          broader data.governed.extract path (file/URL/DB); provider registration awaits the
          host.dataProviders door (D-09); native server/CI batch awaits the napi-rs binding. The
          engine sides are done.
        </p>
      </div>
    );
  };
}
