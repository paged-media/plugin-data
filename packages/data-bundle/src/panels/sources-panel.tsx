// The Data sources panel — a React expert-leaf factory closing over the
// BundleHost + the session. It owns the file input (D-11: no host file picker),
// the source list, and the HONEST status (engine/DuckDB availability, the M0
// "no network / no OPFS persistence" notices — rendered honestly, never faked).
//
// Built from host surfaces + React ONLY (no @paged-media/shell). Token-layer
// styling (--pg-*, --space-*, --font-mono) reads native in both themes.

import { useState, type ChangeEvent, type CSSProperties, type ReactElement } from "react";
import type { BundleHost } from "@paged-media/plugin-api";

import type { DataSourceSession } from "../session";

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

export function makeSourcesPanel(
  host: BundleHost,
  session: DataSourceSession,
): () => ReactElement {
  return function SourcesPanel(): ReactElement {
    const [snapshot, setSnapshot] = useState(session.getState());
    const refresh = () => setSnapshot(session.getState());

    async function onFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
      const file = event.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      const name =
        file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_]/g, "_") || "data";
      await session.registerCsvSource(name, text);
      refresh();
    }

    return (
      <div style={wrap}>
        <strong>paged.data · sources (v{host.manifest.version})</strong>
        <label>
          Import CSV{" "}
          <input type="file" accept=".csv,.tsv" onChange={onFile} />
        </label>
        <div>
          {snapshot.sources.length === 0 ? (
            <span style={note}>No sources yet.</span>
          ) : (
            <ul>
              {snapshot.sources.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
        </div>
        <div data-status={snapshot.status}>status: {snapshot.status} — {snapshot.message}</div>
        <p style={note}>
          M0: the query engine is the vendored DuckDB-WASM (run{" "}
          <code>scripts/vendor-duckdb.sh</code>); the engine wasm is{" "}
          <code>scripts/build-wasm.sh</code>. Network sources are OFF (no consent
          UI yet, D-03); imported data is in-memory only — reload re-imports (no
          OPFS, D-04).
        </p>
      </div>
    );
  };
}
