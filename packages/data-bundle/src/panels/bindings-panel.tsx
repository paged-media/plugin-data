// The Bindings panel — wire a demo binding over an imported source, refresh the
// data, and lower the result to the document. The full binding-authoring UX is
// a companion spec (out of scope); this is the honest M0 slice that proves the
// resolve → lower → mutate pipeline end-to-end. Honest about the D-01 (tagged
// placeholder) and D-02 (native table) SDK gaps.

import { useState, type CSSProperties, type ReactElement } from "react";
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

const row: CSSProperties = { display: "flex", gap: "var(--space-2, 8px)", flexWrap: "wrap" };

export function makeBindingsPanel(
  host: BundleHost,
  session: DataSourceSession,
): () => ReactElement {
  return function BindingsPanel(): ReactElement {
    const [snapshot, setSnapshot] = useState(session.getState());
    const refresh = () => setSnapshot(session.getState());

    function wireDemo(): void {
      const source = session.getState().sources[0];
      if (!source) {
        host.log.warn("wireDemo: import a CSV source first");
        return;
      }
      session.addQuery("q_all", `SELECT * FROM ${source}`, "recordStream");
      session.addTableBinding("t_demo", "data-region", "q_all", [
        { header: "Column 1", expr: "" },
      ]);
      refresh();
    }

    return (
      <div style={wrap}>
        <strong>paged.data · bindings (v{host.manifest.version})</strong>
        <div style={row}>
          <button type="button" onClick={wireDemo}>
            Wire demo binding
          </button>
          <button
            type="button"
            onClick={() => {
              void session.refreshData().then(refresh);
            }}
          >
            Refresh data
          </button>
          <button
            type="button"
            onClick={() => {
              void session.lowerAll().then(refresh);
            }}
          >
            Lower to document
          </button>
        </div>
        <div>
          bindings:{" "}
          {snapshot.bindings.length === 0 ? (
            <span style={note}>none</span>
          ) : (
            snapshot.bindings.join(", ")
          )}
        </div>
        <div data-status={snapshot.status}>status: {snapshot.status} — {snapshot.message}</div>
        <p style={note}>
          M0 lowers a single-region dynamic table to tab-aligned text + drawn
          rules (no native table op yet, D-02). Variable replacement resolves but
          its in-text placement awaits the tagged-placeholder content model
          (D-01). Record flow, data-driven rules, and the data-provider contract
          are M1+.
        </p>
      </div>
    );
  };
}
