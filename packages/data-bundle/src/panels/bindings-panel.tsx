// The Bindings panel — wire a demo binding over an imported source, refresh the
// data, and lower the result to the document. The full binding-authoring UX is
// a companion spec (out of scope); this is the honest slice that proves the
// resolve → lower → mutate pipeline end-to-end. The v43 lanes are live: in-text
// variable FIELDS (D-01), image placement (D-14), and rule application (D-13)
// commit real mutations; the table path uses the native insertTable op (D-02
// retired). The variable CARET position is still coarse (no caret-read door).

import { useState, type CSSProperties, type ReactElement } from "react";
import type { BundleHost } from "@paged-media/plugin-api";
import type { IdmlFit } from "@paged-media/data-host-model";

import type { BarcodeSymbology, DataSourceSession } from "../session";

/** The IDML FittingOnEmptyFrame choices an image binding offers (D-14). */
const FIT_OPTIONS: { value: IdmlFit; label: string }[] = [
  { value: "Proportionally", label: "Fit (proportional)" },
  { value: "FillProportionally", label: "Fill (proportional, crop)" },
  { value: "FitContentToFrame", label: "Fit content to frame" },
  { value: "ContentAwareFit", label: "Content-aware" },
  { value: "", label: "None (no fitting)" },
];

/** The barcode symbologies the panel offers (§9.7). */
const SYMBOLOGY_OPTIONS: { value: BarcodeSymbology; label: string }[] = [
  { value: "ean13", label: "EAN-13 (retail)" },
  { value: "upca", label: "UPC-A (retail)" },
  { value: "code128", label: "Code-128 (general 1D)" },
  { value: "qr", label: "QR (2D)" },
];

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
    const [fit, setFit] = useState<IdmlFit>("Proportionally");
    const [symbology, setSymbology] = useState<BarcodeSymbology>("ean13");
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
      // A variable binding — placed as a tagged FIELD into the selected frame
      // (else a fresh frame; caret position is coarse, D-01).
      session.addVariableBinding("v_demo", "anchor", "q_all", "");
      refresh();
    }

    function wireImageDemo(): void {
      const source = session.getState().sources[0];
      const target = host.selection.get().find((e) => e.kind === "rectangle");
      if (!source || !target) {
        host.log.warn("wireImageDemo: import a source AND select a rectangle to bind an image");
        return;
      }
      session.addQuery("q_all", `SELECT * FROM ${source}`, "recordStream");
      // The bound rectangle is the selected frame's raw Self id; `fit` is the
      // chosen IDML FittingOnEmptyFrame value (D-14).
      session.addImageBinding("img_demo", target.id as string, "q_all", "", { fit });
      refresh();
    }

    function wireBarcodeDemo(): void {
      const source = session.getState().sources[0];
      const target = host.selection.get().find((e) => e.kind === "rectangle");
      if (!source || !target) {
        host.log.warn(
          "wireBarcodeDemo: import a source AND select a rectangle to render a barcode into",
        );
        return;
      }
      session.addQuery("q_all", `SELECT * FROM ${source}`, "recordStream");
      // The bound rectangle is the symbol's frame; `expr` is the field value to
      // encode (the engine encodes the chosen symbology + draws VECTOR modules).
      session.addBarcodeBinding("bc_demo", target.id as string, "q_all", symbology, "", {
        missing: "skip",
      });
      refresh();
    }

    return (
      <div style={wrap}>
        <strong>paged.data · bindings (v{host.manifest.version})</strong>
        <div style={row}>
          <button type="button" onClick={wireDemo}>
            Wire demo binding
          </button>
          <button type="button" onClick={wireImageDemo} title="Bind an image to the selected rectangle">
            Bind image →
          </button>
          <label style={note}>
            fit:{" "}
            <select value={fit} onChange={(e) => setFit(e.target.value as IdmlFit)}>
              {FIT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div style={row}>
          <button
            type="button"
            onClick={wireBarcodeDemo}
            title="Render a barcode/QR from the field value into the selected rectangle"
          >
            Bind barcode →
          </button>
          <label style={note}>
            symbology:{" "}
            <select
              value={symbology}
              onChange={(e) => setSymbology(e.target.value as BarcodeSymbology)}
            >
              {SYMBOLOGY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div style={row}>
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
          <button
            type="button"
            title="Re-resolve every placed variable field from the live data (D-01)"
            onClick={() => {
              void session.refreshFields().then(refresh);
            }}
          >
            Refresh fields
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
          Live (v43): in-text variables place a tagged FIELD and re-resolve via
          the refresh loop (D-01); images place onto the bound rectangle with the
          chosen fit (D-14); data-driven rules apply a document style per fired
          cell (D-13); tables lower to a native table (D-02 retired); record flow
          paginates over the live frame chain + reflow (D-12); barcodes/QR encode
          the field value (clean-room, in Rust) and draw as native VECTOR modules
          scaled to the bound rectangle (§9.7 — resolution-free, no asset-store
          door; raster is BLOCKED since placeImage needs a uri). Honest gap: a NEW
          variable field lands at the story start, not the user&apos;s caret — no
          caret-read door for a bundle yet (D-01 caret residual).
        </p>
      </div>
    );
  };
}
