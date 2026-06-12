// The Data sources panel — a React expert-leaf factory closing over the
// BundleHost + the session. It owns the file input (D-11: no host file picker),
// the source list, the remote-source lane (M1, D-03: per-source consent state,
// request-consent + edit-time load — inert until granted), and the HONEST
// status (engine/DuckDB availability, the "no OPFS persistence" notice —
// rendered honestly, never faked).
//
// Built from host surfaces + React ONLY (no @paged-media/shell). Token-layer
// styling (--pg-*, --space-*, --font-mono) reads native in both themes.

import { useState, type ChangeEvent, type CSSProperties, type ReactElement } from "react";
import type { BundleHost } from "@paged-media/plugin-api";

import type { DataSourceSession, RemoteFormat } from "../session";

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
    const [remoteUrl, setRemoteUrl] = useState("");
    const [remoteFormat, setRemoteFormat] = useState<RemoteFormat>("csv");
    const refresh = () => setSnapshot(session.getState());

    function onAddRemote(): void {
      if (!remoteUrl) return;
      const name =
        remoteUrl
          .replace(/^https?:\/\//, "")
          .replace(/\.[^.]+$/, "")
          .replace(/[^a-zA-Z0-9_]/g, "_") || "remote";
      const error = session.addRemoteSource(name, remoteUrl, remoteFormat);
      if (error === null) setRemoteUrl("");
      refresh();
    }

    async function onRequestConsent(name: string): Promise<void> {
      await session.requestConsentForRemote(name);
      refresh();
    }

    async function onLoadRemote(name: string): Promise<void> {
      await session.loadRemoteSource(name);
      refresh();
    }

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
        <div>
          <strong>Remote sources (consent-gated, D-03)</strong>
          <div>
            <input
              type="url"
              placeholder="https://example.com/data.csv"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
            />
            <select
              value={remoteFormat}
              onChange={(e) => setRemoteFormat(e.target.value as RemoteFormat)}
            >
              <option value="csv">csv</option>
              <option value="tsv">tsv</option>
              <option value="json">json</option>
              <option value="parquet">parquet</option>
            </select>
            <button onClick={onAddRemote}>Add remote</button>
          </div>
          {snapshot.remote.length === 0 ? (
            <span style={note}>No remote sources. A remote source never fetches on open.</span>
          ) : (
            <ul>
              {snapshot.remote.map((r) => (
                <li key={r.name} data-consent={r.consent} data-status={r.status}>
                  {r.name} · {r.origin} · {r.format} ·{" "}
                  {r.consent === "granted" ? "consented" : "consent required"} · {r.status}
                  {r.contentKey ? ` · key ${r.contentKey}` : ""}
                  {r.consent === "required" ? (
                    <button onClick={() => void onRequestConsent(r.name)}>
                      Request consent
                    </button>
                  ) : (
                    <button onClick={() => void onLoadRemote(r.name)}>Load</button>
                  )}
                  <div style={note}>{r.message}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div data-status={snapshot.status}>status: {snapshot.status} — {snapshot.message}</div>
        <p style={note}>
          The query engine is the vendored DuckDB-WASM (run{" "}
          <code>scripts/vendor-duckdb.sh</code>); the engine wasm is{" "}
          <code>scripts/build-wasm.sh</code>. Remote sources (M1) are inert until
          per-origin consent (D-03) and fetch at edit time only — never on
          document open. Imported data is in-memory only — reload re-imports (no
          OPFS, D-04).
        </p>
      </div>
    );
  };
}
