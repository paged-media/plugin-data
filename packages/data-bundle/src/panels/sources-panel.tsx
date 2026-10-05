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
// BundleHost + the session. It owns the local import (CSV, TSV, JSON, Parquet,
// XLSX — the platform picker via shell.pickFile@1, with the raw file input
// kept as the harness-host fallback), the worksheet choice of a workbook, each
// source's refresh policy (src/refresh.ts),
// the source list, the remote-source lane (M1, D-03: per-source consent state,
// request-consent + edit-time load — inert until granted), and the HONEST
// status (engine/DuckDB availability, and whether the session is saved with
// the document — rendered honestly, never faked).
//
// Built from host surfaces + React ONLY (no @paged-media/shell). Token-layer
// styling (--pg-*, --space-*) reads native in both themes; prose is sans,
// mono is reserved for values/ids.

import { useState, type ChangeEvent, type CSSProperties, type ReactElement } from "react";
import type { BundleHost } from "@paged-media/plugin-api";

import { IMPORT_ACCEPT } from "../query/import";
import { MIN_INTERVAL_SECS, policyLabel, type RefreshPolicy } from "../refresh";
import type { DataSourceSession, RemoteFormat, SessionState } from "../session";
import { DiagnosticsList } from "./diagnostics";
import { useSessionSnapshot } from "./use-session";

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

/** What the panel says about saving, per persistence state. */
const PERSISTENCE_NOTE: Record<SessionState["persistence"]["status"], string> = {
  empty: "Sources and bindings you define are saved with the document.",
  pending: "Saving the data definitions with the document…",
  saved: "Sources, bindings and imported data are saved with the document.",
  unavailable:
    "This editor cannot save data definitions with the document — reopening it needs a new import.",
};

export function makeSourcesPanel(
  host: BundleHost,
  session: DataSourceSession,
): () => ReactElement {
  return function SourcesPanel(): ReactElement {
    const [snapshot, refresh] = useSessionSnapshot(session);
    const [remoteUrl, setRemoteUrl] = useState("");
    const [remoteFormat, setRemoteFormat] = useState<RemoteFormat>("csv");

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

    const [policyNote, setPolicyNote] = useState<string | null>(null);

    async function importBytes(fileName: string, bytes: Uint8Array): Promise<void> {
      await session.importFile(fileName, bytes);
      refresh();
    }

    async function onSheet(source: string, sheet: string): Promise<void> {
      await session.selectSheet(source, sheet);
      refresh();
    }

    function onPolicy(source: string, value: string, remote: boolean): void {
      const policy: RefreshPolicy =
        value === "interval"
          ? { policy: "interval", secs: remote ? 300 : 0 }
          : ({ policy: value } as RefreshPolicy);
      setPolicyNote(session.setRefreshPolicy(source, policy));
      refresh();
    }

    function onInterval(source: string, secs: number): void {
      setPolicyNote(session.setRefreshPolicy(source, { policy: "interval", secs }));
      refresh();
    }

    // The platform picker (shell.pickFile@1) — same door + guard as
    // plugin-doc's pickAndIngest. The raw <input type="file"> below stays
    // ONLY as the fallback for hosts without the door (the SDK test
    // harness), so the bundle's own tests keep driving the import.
    async function onPick(): Promise<void> {
      const picked = await host.shell.pickFile({ accept: [...IMPORT_ACCEPT] });
      const file = picked[0];
      if (!file) return;
      await importBytes(file.name, file.bytes);
    }

    async function onFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
      const file = event.target.files?.[0];
      if (!file) return;
      await importBytes(file.name, new Uint8Array(await file.arrayBuffer()));
    }

    const fileOf = new Map(snapshot.files.map((f) => [f.source, f]));
    const remoteNames = new Set(snapshot.remote.map((r) => r.name));
    const policyOf = (name: string): RefreshPolicy => snapshot.refresh[name] ?? { policy: "manual" };

    function PolicyPicker({ name }: { name: string }): ReactElement {
      const p = policyOf(name);
      const remote = remoteNames.has(name);
      return (
        <span data-data-refresh-policy={name}>
          {" "}· refresh{" "}
          <select value={p.policy} onChange={(e) => onPolicy(name, e.target.value, remote)}>
            <option value="manual">manual</option>
            <option value="onOpen">on open</option>
            {remote ? <option value="interval">every …</option> : null}
            <option value="never">never (snapshot)</option>
          </select>
          {p.policy === "interval" ? (
            <input
              type="number"
              min={MIN_INTERVAL_SECS}
              value={p.secs}
              style={{ width: 64 }}
              onChange={(e) => onInterval(name, Number(e.target.value))}
            />
          ) : null}
          {snapshot.polling.includes(name) ? <span style={note}> polling ({policyLabel(p)})</span> : null}
        </span>
      );
    }

    return (
      <div style={wrap}>
        {host.supports("shell.pickFile@1") ? (
          <button
            type="button"
            data-data-import-csv
            data-data-import-file
            onClick={() => void onPick()}
            style={{ alignSelf: "flex-start", padding: "4px 10px" }}
          >
            Import file…
          </button>
        ) : (
          <label>
            Import file{" "}
            <input type="file" accept={IMPORT_ACCEPT.join(",")} onChange={onFile} />
          </label>
        )}
        <span style={note}>CSV, TSV, JSON, Parquet or Excel (.xlsx) — one worksheet per source.</span>
        <div>
          {snapshot.sources.length === 0 ? (
            <span style={note}>No sources yet.</span>
          ) : (
            <ul>
              {snapshot.sources.map((s) => {
                const f = fileOf.get(s);
                return (
                  <li key={s} data-data-source={s}>
                    <span style={mono}>{s}</span>
                    {f ? (
                      <span style={note}>
                        {" "}· {f.format} · {f.fileName}
                      </span>
                    ) : null}
                    {f?.sheets && f.sheets.length > 1 ? (
                      <select
                        data-data-sheet={s}
                        value={f.sheet}
                        onChange={(e) => void onSheet(s, e.target.value)}
                      >
                        {f.sheets.map((sh) => (
                          <option key={sh} value={sh}>{sh}</option>
                        ))}
                      </select>
                    ) : f?.sheet ? (
                      <span style={note}> · sheet {f.sheet}</span>
                    ) : null}
                    {remoteNames.has(s) ? null : <PolicyPicker name={s} />}
                  </li>
                );
              })}
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
                  <PolicyPicker name={r.name} />
                  <div style={note}>{r.message}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
        {policyNote ? (
          <p style={note} role="alert" data-data-policy-note>
            {policyNote}
          </p>
        ) : null}
        <p style={note}>
          A local file is read once at import; a browser page cannot watch it for changes. Import
          it again, or let it refresh on open. Remote sources can poll — only while their origin
          is allowed.
        </p>
        <div data-status={snapshot.status}>status: {snapshot.status} — {snapshot.message}</div>
        <DiagnosticsList
          diagnostics={snapshot.diagnostics}
          sources={["import", "persist", "restore"]}
          onClear={() => {
            session.clearDiagnostics();
            refresh();
          }}
        />
        {/* Developer knowledge (was user-facing copy): the query engine is
            the vendored DuckDB-WASM (run scripts/vendor-duckdb.sh); the
            engine wasm is scripts/build-wasm.sh. Remote sources (M1) are
            inert until per-origin consent (D-03) and fetch at edit time
            only — never on document open. Sources, queries, bindings and the
            imported data are saved with the document (the `session`
            container part, persist.ts) on a host with container parts. */}
        {(snapshot.status === "duckdb-missing" ||
          snapshot.status === "engine-missing") && (
          <p style={note}>The query engine isn&apos;t bundled in this build.</p>
        )}
        <p style={note} data-data-persistence={snapshot.persistence.status}>
          {PERSISTENCE_NOTE[snapshot.persistence.status]}
        </p>
      </div>
    );
  };
}
