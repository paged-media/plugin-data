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

// The Data sources panel — a React expert-leaf factory closing over the
// BundleHost + the session. It owns the CSV import (the platform picker via
// shell.pickFile@1, with the raw file input kept as the harness-host fallback),
// the source list, the remote-source lane (M1, D-03: per-source consent state,
// request-consent + edit-time load — inert until granted), and the HONEST
// status (engine/DuckDB availability, the "no OPFS persistence" notice —
// rendered honestly, never faked).
//
// Built from host surfaces + React ONLY (no @paged-media/shell). Token-layer
// styling (--pg-*, --space-*) reads native in both themes; prose is sans,
// mono is reserved for values/ids.

import { useState, type ChangeEvent, type CSSProperties, type ReactElement } from "react";
import type { BundleHost } from "@paged-media/plugin-api";

import type { DataSourceSession, RemoteFormat } from "../session";

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

    async function importCsv(fileName: string, text: string): Promise<void> {
      const name =
        fileName.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_]/g, "_") || "data";
      await session.registerCsvSource(name, text);
      refresh();
    }

    // The platform picker (shell.pickFile@1) — same door + guard as
    // plugin-doc's pickAndIngest. The raw <input type="file"> below stays
    // ONLY as the fallback for hosts without the door (the SDK test
    // harness), so the bundle's own tests keep driving the import.
    async function onPick(): Promise<void> {
      const picked = await host.shell.pickFile({ accept: [".csv", ".tsv"] });
      const file = picked[0];
      if (!file) return;
      await importCsv(file.name, new TextDecoder().decode(file.bytes));
    }

    async function onFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
      const file = event.target.files?.[0];
      if (!file) return;
      await importCsv(file.name, await file.text());
    }

    return (
      <div style={wrap}>
        {host.supports("shell.pickFile@1") ? (
          <button
            type="button"
            data-data-import-csv
            onClick={() => void onPick()}
            style={{ alignSelf: "flex-start", padding: "4px 10px" }}
          >
            Import CSV…
          </button>
        ) : (
          <label>
            Import CSV{" "}
            <input type="file" accept=".csv,.tsv" onChange={onFile} />
          </label>
        )}
        <div>
          {snapshot.sources.length === 0 ? (
            <span style={note}>No sources yet.</span>
          ) : (
            <ul>
              {snapshot.sources.map((s) => (
                <li key={s} style={mono}>{s}</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          {/* Remote sources are consent-gated per the D-03 contract:
              per-origin consent state, request-consent + edit-time load —
              inert until granted, never fetched on document open. */}
          <strong>Remote sources</strong>
          <p style={note}>Remote data loads only after you allow it.</p>
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
                  <span style={mono}>{r.name}</span> · <span style={mono}>{r.origin}</span> ·{" "}
                  {r.format} ·{" "}
                  {r.consent === "granted" ? "consented" : "consent required"} · {r.status}
                  {r.contentKey ? (
                    <>
                      {" "}· key <span style={mono}>{r.contentKey}</span>
                    </>
                  ) : null}
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
        {/* Developer knowledge (was user-facing copy): the query engine is
            the vendored DuckDB-WASM (run scripts/vendor-duckdb.sh); the
            engine wasm is scripts/build-wasm.sh. Remote sources (M1) are
            inert until per-origin consent (D-03) and fetch at edit time
            only — never on document open. Imported data is in-memory only —
            reload re-imports (no OPFS, D-04). */}
        {(snapshot.status === "duckdb-missing" ||
          snapshot.status === "engine-missing") && (
          <p style={note}>The query engine isn&apos;t bundled in this build.</p>
        )}
        <p style={note}>
          Imported data stays in memory only — reopening the document imports it
          again.
        </p>
      </div>
    );
  };
}
