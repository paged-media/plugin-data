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

// The Bindings panel — wire a demo binding over an imported source, refresh the
// data, and lower the result to the document. The full binding-authoring UX is
// a companion spec (out of scope); this is the honest slice that proves the
// resolve → lower → mutate pipeline end-to-end. The v43 lanes are live: in-text
// variable FIELDS (D-01), image placement (D-14), and rule application (D-13)
// commit real mutations; the table path uses the native insertTable op (D-02
// retired). The variable CARET position is still coarse (no caret-read door).

import { useState, type CSSProperties, type ReactElement } from "react";
import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import type { IdmlFit, RuleTarget, VisibilityTargetKind } from "../../../data-host-model/src";

import type {
  BarcodeSymbology,
  ChangeReport,
  ColumnMapping,
  DataSourceSession,
  RecordFlowPreview,
} from "../session";
import { DiagnosticsList } from "./diagnostics";
import { useSessionSnapshot } from "./use-session";

/** The binding kinds the panel defines. */
type BindKind = "variable" | "image" | "barcode" | "table" | "visibility" | "rule" | "recordFlow";

const KIND_OPTIONS: { value: BindKind; label: string; field: string }[] = [
  { value: "variable", label: "variable field", field: "field (column name)" },
  { value: "image", label: "image", field: "field with the image path or URL" },
  { value: "barcode", label: "barcode / QR", field: "field to encode" },
  { value: "table", label: "table", field: "columns, comma-separated" },
  { value: "visibility", label: "show / hide", field: "field or expression (true = shown)" },
  { value: "rule", label: "style rule", field: "condition, e.g. stock < 5" },
  { value: "recordFlow", label: "record flow (catalog)", field: "fields per record, comma-separated" },
];

/** The rule actions — each applies a document style by name. */
const RULE_ACTIONS: { value: "characterStyle" | "paragraphStyle" | "tableStyle"; label: string }[] = [
  { value: "characterStyle", label: "character style" },
  { value: "paragraphStyle", label: "paragraph style" },
  { value: "tableStyle", label: "cell style (table column)" },
];

const VISIBILITY_KINDS: readonly string[] = [
  "textFrame",
  "rectangle",
  "oval",
  "polygon",
  "graphicLine",
  "group",
] satisfies VisibilityTargetKind[];

const splitList = (v: string): string[] =>
  v
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");

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

const row: CSSProperties = { display: "flex", gap: "var(--space-2, 8px)", flexWrap: "wrap" };

export function makeBindingsPanel(
  host: BundleHost,
  session: DataSourceSession,
): () => ReactElement {
  return function BindingsPanel(): ReactElement {
    const [snapshot, refresh] = useSessionSnapshot(session);
    const [fit, setFit] = useState<IdmlFit>("Proportionally");
    const [symbology, setSymbology] = useState<BarcodeSymbology>("ean13");
    // Binding AUTHORING (editor-ui-coverage M — promoted past the demo
    // buttons): kind + source + field drive a real addBinding flow; the
    // demo wirings remain reachable through it (field "anchor" over the
    // first source is exactly what the old demo did).
    const [bindKind, setBindKind] = useState<BindKind>("variable");
    const [invert, setInvert] = useState(false);
    const [ruleAction, setRuleAction] = useState<(typeof RULE_ACTIONS)[number]["value"]>(
      "characterStyle",
    );
    const [ruleStyle, setRuleStyle] = useState("");
    const [groupBy, setGroupBy] = useState("");
    const [flowPreview, setFlowPreview] = useState<{ id: string; preview: RecordFlowPreview } | null>(
      null,
    );
    const [bindField, setBindField] = useState("");
    const [bindSeq, setBindSeq] = useState(1);
    const [bindMsg, setBindMsg] = useState<string | null>(null);
    // §9 record-preview stepper: walk the demo query's records before a batch run.
    const [previewIndex, setPreviewIndex] = useState(0);
    const [recordTotal, setRecordTotal] = useState(0);
    // §9 field-mapping wizard: the engine's column → binding suggestions.
    const [mappings, setMappings] = useState<ColumnMapping[]>([]);
    const [chosen, setChosen] = useState<Set<string>>(new Set());
    // §8 change report: "what changed since last sync".
    const [changes, setChanges] = useState<ChangeReport | null>(null);

    /** Refresh the data, then show the per-binding change report (§8). */
    async function refreshAndReport(): Promise<void> {
      await session.refreshData();
      const report = await session.refreshDiff();
      setChanges(report);
      refresh();
    }

    /** First-run import affordance (§9): refresh the demo query, then ask the
     *  engine for the source's columns → variable-binding suggestions. The
     *  author picks which to wire (mappable columns default to checked). */
    async function openWizard(): Promise<void> {
      const source = session.getState().sources[0];
      if (!source) {
        host.log.warn("field-mapping wizard: import a CSV source first");
        return;
      }
      session.addQuery("q_all", `SELECT * FROM ${source}`, "recordStream");
      await session.refreshData();
      const cols = await session.queryMappings("q_all");
      setMappings(cols);
      setChosen(new Set(cols.filter((c) => c.mappable).map((c) => c.column)));
      refresh();
    }

    /** Generate variable bindings for the chosen mappable columns (§9). */
    function confirmWizard(): void {
      const picked = mappings.filter((m) => chosen.has(m.column));
      session.applyMappings("q_all", picked);
      setMappings([]);
      setChosen(new Set());
      refresh();
    }

    /** Resolve the demo query against the stepped-to record and commit the
     *  preview (the SAME lower lanes a batch run uses). Re-reads the record
     *  count so the "of N" bound stays honest after a refresh. */
    async function stepTo(next: number): Promise<void> {
      const total = await session.recordCount("q_all");
      setRecordTotal(total);
      if (total === 0) {
        host.log.info("preview: no records ingested — refresh data first");
        return;
      }
      const clamped = Math.max(0, Math.min(next, total - 1));
      setPreviewIndex(clamped);
      // Preview every wired binding against the chosen record.
      for (const id of session.getState().bindings) {
        await session.previewRecord(id, clamped);
      }
      refresh();
    }

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

    /** Where a rule applies, from what the user has selected: a table cell
     *  names its column; a text caret names its whole story. */
    async function ruleTarget(): Promise<RuleTarget | null> {
      const cell = host.selection.get().find((e) => e.kind === "tableCell");
      if (cell) {
        const id = cell.id as { story_id: string; table_id: string; col: number };
        return {
          kind: "tableColumn",
          storyId: id.story_id,
          tableId: id.table_id,
          col: id.col,
          headerRows: 1,
        };
      }
      let caret: { storyId: string; offset: number } | null = null;
      try {
        caret = host.supports("text.caret@1") ? (host.text?.caret() ?? null) : null;
      } catch {
        caret = null;
      }
      if (!caret) return null;
      let end = caret.offset;
      try {
        const story = await host.document.storyContent(caret.storyId);
        if (story) {
          end = story.paragraphs.reduce(
            (n, p) => n + p.runs.reduce((m, r) => m + [...r.text].length, 0),
            0,
          );
        }
      } catch {
        // no story read: the range ends at the caret
      }
      return { kind: "storyRange", storyId: caret.storyId, start: 0, end };
    }

    // The AUTHORING flow: pick a kind and its field(s); the binding reads the
    // first source's record stream. Image, barcode and show/hide bind to the
    // selected element; a style rule to the selected table cell or the story
    // the caret is in. Every refusal says what is missing.
    async function addBinding(): Promise<void> {
      const source = session.getState().sources[0];
      if (!source) {
        setBindMsg("import a CSV source first (Sources panel)");
        return;
      }
      const field = bindField.trim();
      if (!field) {
        setBindMsg(`enter the ${KIND_OPTIONS.find((k) => k.value === bindKind)!.field}`);
        return;
      }
      const q = "q_all";
      const id = `${bindKind}_${field.replace(/[^A-Za-z0-9_]+/g, "_")}_${bindSeq}`;
      const selection = host.selection.get();
      const rect = selection.find((e) => e.kind === "rectangle");

      switch (bindKind) {
        case "variable":
          session.addQuery(q, `SELECT * FROM ${source}`, "recordStream");
          // The chosen field IS the expression: a bare field reference, which
          // the engine resolves per record (a column the DSL cannot reference
          // bare shows up as a resolve diagnostic, never a silent blank).
          session.addVariableBinding(id, field, q, field);
          setBindMsg(`variable binding ${id} — Lower places the field`);
          break;
        case "image":
        case "barcode":
          if (!rect) {
            setBindMsg(`select a rectangle to bind the ${bindKind} into`);
            return;
          }
          session.addQuery(q, `SELECT * FROM ${source}`, "recordStream");
          if (bindKind === "image") {
            session.addImageBinding(id, rect.id as string, q, field, { fit });
            setBindMsg(`image binding ${id} → the selected rectangle (${fit})`);
          } else {
            session.addBarcodeBinding(id, rect.id as string, q, symbology, field, {
              missing: "skip",
            });
            setBindMsg(`barcode binding ${id} → the selected rectangle (${symbology})`);
          }
          break;
        case "table": {
          const cols = splitList(field);
          session.addQuery(q, `SELECT * FROM ${source}`, "recordStream");
          session.addTableBinding(
            id,
            "data-region",
            q,
            cols.map((c) => ({ header: c, expr: c })),
          );
          setBindMsg(`table binding ${id} (${cols.length} column(s)) — Lower places the table`);
          break;
        }
        case "visibility": {
          const el = selection.find((e) => VISIBILITY_KINDS.includes(e.kind)) as
            | (ElementId & { id: string })
            | undefined;
          if (!el) {
            setBindMsg("select the frame, shape or group to show or hide");
            return;
          }
          session.addQuery(q, `SELECT * FROM ${source}`, "recordStream");
          session.addVisibilityBinding(id, el.id, q, field, {
            invert,
            kind: el.kind as VisibilityTargetKind,
          });
          setBindMsg(
            `show/hide binding ${id} → the selected ${el.kind}${invert ? " (hidden when true)" : ""}`,
          );
          break;
        }
        case "rule": {
          const style = ruleStyle.trim();
          if (!style) {
            setBindMsg("enter the name of the document style the rule applies");
            return;
          }
          const target = await ruleTarget();
          if (!target) {
            setBindMsg("select a table cell, or put the text cursor in the story to style");
            return;
          }
          if ((ruleAction === "tableStyle") !== (target.kind === "tableColumn")) {
            setBindMsg(
              ruleAction === "tableStyle"
                ? "a cell style rule needs a selected table cell"
                : "a character or paragraph rule needs the text cursor in a story",
            );
            return;
          }
          session.addQuery(q, `SELECT * FROM ${source}`, "recordStream");
          session.addRuleBinding(id, id, q, field, { action: ruleAction, name: style }, target);
          setBindMsg(
            `style rule ${id}: when ${field} → ${style} on the ${
              target.kind === "tableColumn" ? "selected column" : "story"
            } — Lower applies it`,
          );
          break;
        }
        case "recordFlow": {
          const fields = splitList(field);
          session.addQuery(q, `SELECT * FROM ${source}`, "recordStream");
          session.defineRecordFlow(
            id,
            q,
            fields.map((f) => ({ expr: f })),
            { groupBy: splitList(groupBy) },
          );
          setBindMsg(`record flow ${id} — Preview lists what it places`);
          break;
        }
      }
      setBindSeq(bindSeq + 1);
      refresh();
    }

    /** Resolve a record flow and list what it would place (no document write). */
    async function previewFlow(id: string): Promise<void> {
      await session.refreshData();
      const preview = await session.previewRecordFlow(id);
      setFlowPreview(preview ? { id, preview } : null);
      refresh();
    }

    return (
      <div style={wrap}>
        <div style={row} data-data-bind-author>
          <select
            data-data-bind-kind
            value={bindKind}
            onChange={(e) => setBindKind(e.target.value as BindKind)}
          >
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <input
            data-data-bind-field
            type="text"
            value={bindField}
            onChange={(e) => setBindField(e.target.value)}
            placeholder={KIND_OPTIONS.find((k) => k.value === bindKind)!.field}
            style={{ width: 160 }}
          />
          {bindKind === "visibility" && (
            <label style={note}>
              <input
                data-data-bind-invert
                type="checkbox"
                checked={invert}
                onChange={(e) => setInvert(e.target.checked)}
              />{" "}
              hide when true
            </label>
          )}
          {bindKind === "rule" && (
            <>
              <select
                data-data-bind-rule-action
                value={ruleAction}
                onChange={(e) => setRuleAction(e.target.value as typeof ruleAction)}
              >
                {RULE_ACTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input
                data-data-bind-rule-style
                type="text"
                value={ruleStyle}
                onChange={(e) => setRuleStyle(e.target.value)}
                placeholder="style name"
                style={{ width: 110 }}
              />
            </>
          )}
          {bindKind === "recordFlow" && (
            <input
              data-data-bind-group-by
              type="text"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value)}
              placeholder="group by (optional)"
              style={{ width: 120 }}
            />
          )}
          {bindKind === "image" && (
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
          )}
          {bindKind === "barcode" && (
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
          )}
          <button
            type="button"
            data-data-bind-add
            onClick={() => {
              void addBinding();
            }}
          >
            Add binding
          </button>
        </div>
        {bindMsg && <p style={note} data-data-bind-msg>{bindMsg}</p>}
        <div style={row}>
          <button type="button" onClick={wireDemo} title="The one-click table+variable demo wiring">
            Wire demo binding
          </button>
          <button type="button" onClick={wireImageDemo} title="Bind an image to the selected rectangle (demo)">
            Bind image →
          </button>
          <button
            type="button"
            onClick={wireBarcodeDemo}
            title="Render a barcode/QR from the field value into the selected rectangle (demo)"
          >
            Bind barcode →
          </button>
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
            title="Refresh, then show what changed since the last sync"
            onClick={() => {
              void refreshAndReport();
            }}
          >
            What changed?
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
            // Technical detail (kept for developers): re-resolves every
            // placed variable FIELD from the live data — the D-01 lane.
            title="Bindings re-resolve when you refresh data."
            onClick={() => {
              void session.refreshFields().then(refresh);
            }}
          >
            Refresh fields
          </button>
        </div>
        <div style={row} data-testid="preview-stepper">
          <span style={note}>preview record:</span>
          <button
            type="button"
            title="Show the document resolved against the previous record"
            disabled={recordTotal === 0 || previewIndex <= 0}
            onClick={() => {
              void stepTo(previewIndex - 1);
            }}
          >
            ‹ prev
          </button>
          <span data-testid="preview-position">
            {recordTotal === 0 ? "— / —" : `${previewIndex + 1} / ${recordTotal}`}
          </span>
          <button
            type="button"
            title="Show the document resolved against the next record"
            disabled={recordTotal === 0 || previewIndex >= recordTotal - 1}
            onClick={() => {
              void stepTo(previewIndex + 1);
            }}
          >
            next ›
          </button>
          <label style={note}>
            jump to:{" "}
            <input
              type="number"
              min={1}
              max={Math.max(1, recordTotal)}
              value={recordTotal === 0 ? "" : previewIndex + 1}
              style={{ width: "4em" }}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) void stepTo(n - 1);
              }}
            />
          </label>
        </div>
        <div style={row} data-testid="field-mapping-wizard">
          <button
            type="button"
            title="Map the source's columns to variable bindings"
            onClick={() => {
              void openWizard();
            }}
          >
            Map fields…
          </button>
          {mappings.length > 0 && (
            <button type="button" onClick={confirmWizard} data-testid="wizard-confirm">
              Create {chosen.size} binding{chosen.size === 1 ? "" : "s"}
            </button>
          )}
        </div>
        {mappings.length > 0 && (
          <div data-testid="wizard-columns" style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {mappings.map((m) => (
              <label key={m.column} style={note} title={m.mappable ? m.expr : "needs a manual expression"}>
                <input
                  type="checkbox"
                  disabled={!m.mappable}
                  checked={chosen.has(m.column)}
                  onChange={(e) => {
                    setChosen((prev) => {
                      const nextSet = new Set(prev);
                      if (e.target.checked) nextSet.add(m.column);
                      else nextSet.delete(m.column);
                      return nextSet;
                    });
                  }}
                />{" "}
                {m.header} <span style={{ opacity: 0.6 }}>({m.fieldType})</span> →{" "}
                {m.mappable ? (
                  <code>{m.expr}</code>
                ) : (
                  <span style={{ color: "var(--status-warn, #c80)" }}>manual expr needed</span>
                )}
              </label>
            ))}
          </div>
        )}
        {changes && (
          <div data-testid="change-report" style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <strong>
              changed since last sync: {changes.changed} changed · {changes.unchanged} unchanged
              {changes.added ? ` · ${changes.added} added` : ""}
              {changes.removed ? ` · ${changes.removed} removed` : ""}
            </strong>
            {changes.entries
              .filter((c) => c.kind !== "unchanged")
              .map((c) => (
                <span
                  key={c.binding}
                  data-change-kind={c.kind}
                  style={{
                    color:
                      c.kind === "changed"
                        ? "var(--status-warn, #c80)"
                        : c.kind === "added"
                          ? "var(--status-ok, #2a2)"
                          : "var(--status-error, #c33)",
                  }}
                >
                  {c.binding}: {c.kind}
                </span>
              ))}
            {changes.changed + changes.added + changes.removed === 0 && (
              <span style={note}>nothing changed — every bound region is up to date.</span>
            )}
          </div>
        )}
        <div data-data-bindings>
          bindings:{" "}
          {snapshot.bindings.length === 0 ? (
            <span style={note}>none</span>
          ) : (
            <ul style={{ margin: 0, paddingLeft: "var(--space-3, 12px)" }}>
              {(session.listBindings() ?? []).map((b) => (
                <li key={b.id} data-binding-kind={b.kind}>
                  <span style={mono}>{b.id}</span> <span style={note}>({b.kind})</span>
                  {b.kind === "recordFlow" && (
                    <button
                      type="button"
                      data-data-flow-preview
                      onClick={() => {
                        void previewFlow(b.id);
                      }}
                    >
                      Preview
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        {flowPreview && (
          <div data-testid="flow-preview" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <strong>
              {flowPreview.id}: {flowPreview.preview.total} record(s)
            </strong>
            {flowPreview.preview.blocks.slice(0, 50).map((b, i) => (
              <span
                key={i}
                data-flow-block={b.kind}
                style={b.kind === "record" ? mono : { ...note, fontWeight: 600 }}
              >
                {b.text}
              </span>
            ))}
            {flowPreview.preview.blocks.length > 50 && (
              <span style={note}>… {flowPreview.preview.blocks.length - 50} more</span>
            )}
            <span style={note}>Placing the flow into frames comes with merge.</span>
          </div>
        )}
        <div data-status={snapshot.status}>status: {snapshot.status} — {snapshot.message}</div>
        <DiagnosticsList
          diagnostics={snapshot.diagnostics}
          sources={["refresh", "preview", "binding", "flow"]}
          onClear={() => {
            session.clearDiagnostics();
            refresh();
          }}
        />
        {/* Developer knowledge (was user-facing copy) — the live lanes as of
            v43: in-text variables place a tagged FIELD and re-resolve via the
            refresh loop (D-01); images place onto the bound rectangle with the
            chosen fit (D-14); data-driven rules apply a document style per
            fired cell (D-13); tables lower to a native table (D-02 retired);
            record flow paginates over the live frame chain + reflow (D-12);
            barcodes/QR encode the field value (clean-room, in Rust) and draw
            as native VECTOR modules scaled to the bound rectangle (§9.7 —
            resolution-free, no asset-store door; raster is BLOCKED since
            placeImage needs a uri). A NEW variable field lands at the
            user's text caret when the host exposes one (C-9,
            host.text.caret), else at the start of the selected frame's
            story, else in a fresh frame. */}
        <p style={note}>Bindings re-resolve when you refresh data.</p>
      </div>
    );
  };
}
