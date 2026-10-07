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
import type {
  BindingSync,
  ConditionPreview,
  ExprCheck,
  FormatPattern,
  LocaleInfo,
  QueryRowDiff,
  StyleOption,
  SyncStatus,
} from "../review";
import { documentsDoors } from "../doors";
import { defineBinding } from "../object-model";
import { NO_NEW_DOCUMENT_DOOR } from "../session";
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

/** The document style collection each rule action picks from. */
const RULE_STYLE_KIND = {
  characterStyle: "character",
  paragraphStyle: "paragraph",
  tableStyle: "cell",
} as const;

/** How the engine's sync statuses read in the panel (ADR 553). */
const SYNC_LABEL: Record<SyncStatus, string> = {
  linked: "synced",
  stale: "stale",
  pinned: "pinned",
  overridden: "overridden",
  error: "error",
};
const SYNC_COLOR: Record<SyncStatus, string> = {
  linked: "var(--status-ok, #2a2)",
  stale: "var(--status-warn, #c80)",
  pinned: "var(--pg-muted-fg, #999)",
  overridden: "var(--status-warn, #c80)",
  error: "var(--status-error, #c33)",
};

/** The display patterns a variable field can take. */
const FORMAT_KINDS: { value: FormatPattern["kind"]; label: string }[] = [
  { value: "plain", label: "as is" },
  { value: "number", label: "number" },
  { value: "currency", label: "currency" },
  { value: "percent", label: "percent" },
  { value: "date", label: "date" },
];

/** A pattern draft as the format editor edits it. */
interface FormatDraft {
  kind: FormatPattern["kind"];
  decimals: string;
  symbol: string;
  date: string;
  locale: string;
}

function draftFrom(b: BindingSync): FormatDraft {
  const p = b.format?.pattern ?? { kind: "plain" };
  return {
    kind: p.kind,
    decimals: "decimals" in p ? String(p.decimals) : "2",
    symbol: p.kind === "currency" ? (p.symbol ?? "") : "",
    date: p.kind === "date" ? (p.pattern ?? "") : "",
    locale: b.locale ?? "",
  };
}

function patternFrom(d: FormatDraft): FormatPattern {
  const decimals = Math.max(0, Math.min(10, Number.parseInt(d.decimals, 10) || 0));
  switch (d.kind) {
    case "number":
    case "percent":
      return { kind: d.kind, decimals };
    case "currency":
      return d.symbol.trim() ? { kind: "currency", decimals, symbol: d.symbol.trim() } : { kind: "currency", decimals };
    case "date":
      return d.date.trim() ? { kind: "date", pattern: d.date.trim() } : { kind: "date" };
    default:
      return { kind: "plain" };
  }
}

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

/** "Bind to data…" (ADR 558): the editor names the object and the property;
 *  this asks for the query and the expression, then defines the binding. */
function PropertyDraftRow(props: {
  host: BundleHost;
  session: DataSourceSession;
  queries: readonly string[];
  onDone: () => void;
}): ReactElement | null {
  const { host, session, queries, onDone } = props;
  const draft = session.getPropertyDraft?.() ?? null;
  const [query, setQuery] = useState("");
  const [expr, setExpr] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  if (!draft) return null;
  const bind = async () => {
    const q = query || queries[0];
    if (!q || !expr.trim()) {
      setMsg("pick a query and write an expression");
      return;
    }
    const id = `${draft.path}-${Date.now().toString(36)}`;
    // The same path as host.objects (the Data objects panel, Boa, the CLI):
    // the definition and its labels are ONE undo step the session follows.
    const r = await defineBinding(host, session, id, {
      target: draft.selector,
      path: draft.path,
      query: q,
      expr: expr.trim(),
      ...(draft.schema ? { schema: draft.schema } : {}),
    });
    setMsg(r.ok ? null : (r.reason ?? "refused"));
    if (r.ok) {
      session.setPropertyDraft(null);
      await session.applyProperties({ ids: [id] });
    }
    onDone();
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }} data-data-bind-property>
      <span>
        Bind <code>{draft.path}</code> of <code>{draft.selector}</code> to
      </span>
      <select data-data-bind-property-query value={query} onChange={(e) => setQuery(e.target.value)}>
        {queries.map((q) => (
          <option key={q} value={q}>
            {q}
          </option>
        ))}
      </select>
      <input
        data-data-bind-property-expr
        type="text"
        value={expr}
        placeholder="expression, e.g. MM(width) or tint"
        onChange={(e) => setExpr(e.target.value)}
        style={{ width: 200 }}
      />
      <button type="button" data-data-bind-property-define onClick={() => void bind()}>
        Bind
      </button>
      <button type="button" onClick={() => (session.setPropertyDraft(null), onDone())}>
        Cancel
      </button>
      {msg && <span data-data-bind-property-msg>{msg}</span>}
    </div>
  );
}

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
    // Wave 5 — Data Merge options.
    const [mergeQuery, setMergeQuery] = useState("");
    const [mergeMode, setMergeMode] = useState<"single" | "multiple">("single");
    const [mergeArrange, setMergeArrange] = useState<"rows" | "columns">("rows");
    const [mergeRowSpacing, setMergeRowSpacing] = useState(12);
    const [mergeColSpacing, setMergeColSpacing] = useState(12);
    const [mergeKeep, setMergeKeep] = useState(true);
    const [mergeNewDoc, setMergeNewDoc] = useState(false);
    const [mergeBlank, setMergeBlank] = useState(true);
    const [mergeMsg, setMergeMsg] = useState<string | null>(null);

    /** Merge the chosen query's records through the template on the active
     *  page (every text frame with a <<field>>), InDesign Data Merge style. */
    async function runMerge(): Promise<void> {
      let query = mergeQuery || session.getState().queries[0];
      if (!query) {
        // No query yet: merge the first source as it is, like the binding
        // kinds above do.
        const source = session.getState().sources[0];
        if (!source) {
          setMergeMsg("import a data source first");
          return;
        }
        session.addQuery("q_all", `SELECT * FROM ${source}`, "recordStream");
        query = "q_all";
      }
      const r = await session.mergeRecords({
        query,
        recordsPerPage:
          mergeMode === "single"
            ? { mode: "single" }
            : { mode: "multiple", arrange: mergeArrange, rowSpacingPt: mergeRowSpacing, columnSpacingPt: mergeColSpacing },
        removeBlankLines: mergeBlank,
        template: mergeKeep ? "keep" : "consume",
        ...(mergeNewDoc ? { destination: "newDocument" as const } : {}),
      });
      setMergeMsg(
        r.ok
          ? `merged ${r.records.length} record(s) onto ${r.pages.length} page(s)` +
              (r.overset.length ? ` — ${r.overset.length} overset` : "")
          : `merge failed: ${r.diagnostics.join("; ")}`,
      );
      refresh();
    }
    // §9 record-preview stepper: walk the demo query's records before a batch run.
    const [previewIndex, setPreviewIndex] = useState(0);
    const [recordTotal, setRecordTotal] = useState(0);
    // §9 field-mapping wizard: the engine's column → binding suggestions.
    const [mappings, setMappings] = useState<ColumnMapping[]>([]);
    const [chosen, setChosen] = useState<Set<string>>(new Set());
    // §8 change report: "what changed since last sync".
    const [changes, setChanges] = useState<ChangeReport | null>(null);
    // §8 row diff since the document was last written from the data.
    const [rowDiff, setRowDiff] = useState<QueryRowDiff[] | null>(null);
    // Sync state per binding (ADR 553) and the per-binding decisions.
    const [syncRows, setSyncRows] = useState<BindingSync[] | null>(null);
    const [locales, setLocales] = useState<LocaleInfo[]>([]);
    const [formatOpen, setFormatOpen] = useState<string | null>(null);
    const [draft, setDraft] = useState<FormatDraft | null>(null);
    const [formatPreview, setFormatPreview] = useState<string | null>(null);
    // The rule editor (D-13): styles to pick from, the condition check, the
    // firing preview, and where in a story the style lands.
    const [ruleStyles, setRuleStyles] = useState<StyleOption[]>([]);
    const [ruleCheck, setRuleCheck] = useState<ExprCheck | null>(null);
    const [rulePreview, setRulePreview] = useState<ConditionPreview | null>(null);
    const [ruleScope, setRuleScope] = useState<"story" | "paragraphs">("story");

    /** Re-read every binding's sync state, locale and pattern. */
    async function reloadSync(): Promise<void> {
      const rows = (await session.bindingSync()) ?? null;
      setSyncRows(rows);
      if (locales.length === 0) setLocales((await session.locales()) ?? []);
      refresh();
    }

    /** Run a per-binding decision, then show the states it left. */
    async function decide(run: () => Promise<unknown>): Promise<void> {
      await run();
      await reloadSync();
    }

    /** The document's styles for a rule action (the selfId is what applies). */
    async function loadRuleStyles(action: (typeof RULE_ACTIONS)[number]["value"]): Promise<void> {
      const styles = (await session.documentStyles(RULE_STYLE_KIND[action])) ?? [];
      setRuleStyles(styles);
      if (styles.length > 0 && !styles.some((st) => st.selfId === ruleStyle)) {
        setRuleStyle(styles[0].selfId);
      }
      refresh();
    }

    /** Check the condition and list which records it fires on. */
    async function previewRule(): Promise<void> {
      const when = bindField.trim();
      const check = (await session.checkExpression(when, "q_all")) ?? null;
      setRuleCheck(check);
      setRulePreview(check && check.ok ? ((await session.previewCondition("q_all", when)) ?? null) : null);
      refresh();
    }

    /** Open a variable binding's format editor. */
    function openFormat(b: BindingSync): void {
      setFormatOpen(formatOpen === b.id ? null : b.id);
      setDraft(draftFrom(b));
      setFormatPreview(null);
      refresh();
    }

    /** Apply the drafted pattern and locale, then preview the field. */
    async function applyFormat(id: string): Promise<void> {
      if (!draft) return;
      await session.setBindingFormat(id, patternFrom(draft));
      await session.setBindingLocale(id, draft.locale === "" ? null : draft.locale);
      setFormatPreview((await session.previewBinding(id, 0)) ?? null);
      await reloadSync();
    }

    /** Refresh the data, then show the per-binding change report (§8). */
    async function refreshAndReport(): Promise<void> {
      await session.refreshData();
      const report = await session.refreshDiff();
      setChanges(report);
      setRowDiff((await session.rowDiff()) ?? []);
      await reloadSync();
    }

    /** Match a query's rows by another key, and diff again. */
    async function rekey(query: string, column: string): Promise<void> {
      session.setDiffKey(query, column === "" ? null : [column]);
      setRowDiff((await session.rowDiff()) ?? []);
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
      // The paragraph the caret is in: with "one paragraph per record", record
      // 0 is that paragraph, record 1 the next, and so on. Offsets count run
      // text only (core: a paragraph break is not a character).
      let caretParagraph = 0;
      try {
        const story = await host.document.storyContent(caret.storyId);
        if (story) {
          let at = 0;
          story.paragraphs.forEach((p, i) => {
            const len = p.runs.reduce((m, r) => m + [...r.text].length, 0);
            if (caret!.offset >= at && caret!.offset <= at + len && caretParagraph === 0) {
              caretParagraph = i;
            }
            at += len;
          });
          end = at;
        }
      } catch {
        // no story read: the range ends at the caret
      }
      if (ruleScope === "paragraphs") {
        return { kind: "storyParagraphs", storyId: caret.storyId, firstParagraph: caretParagraph };
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
          // The condition must parse and read only fields the data has.
          const check = (await session.checkExpression(field, q)) ?? null;
          if (check && !check.ok) {
            setRuleCheck(check);
            setBindMsg(`the condition is not usable: ${check.error ?? "it does not parse"}`);
            return;
          }
          session.addRuleBinding(id, id, q, field, { action: ruleAction, name: style }, target);
          const styleName = ruleStyles.find((st) => st.selfId === style)?.name ?? style;
          setBindMsg(
            `style rule ${id}: when ${field} → ${styleName} on the ${
              target.kind === "tableColumn"
                ? "selected column"
                : target.kind === "storyParagraphs"
                  ? "paragraph of each record that fires"
                  : "story"
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
        <PropertyDraftRow host={host} session={session} queries={snapshot.queries} onDone={refresh} />
        {(snapshot.relink ?? []).length > 0 && (
          <div style={note} data-data-relink>
            Re-link data: {(snapshot.relink ?? []).join(", ")} — the bindings came back from the
            document&apos;s labels, the data did not (import the file again in Data sources).
          </div>
        )}
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
                onChange={(e) => {
                  const next = e.target.value as typeof ruleAction;
                  setRuleAction(next);
                  void loadRuleStyles(next);
                }}
              >
                {RULE_ACTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {ruleStyles.length > 0 ? (
                <select
                  data-data-bind-rule-style
                  value={ruleStyle}
                  onChange={(e) => setRuleStyle(e.target.value)}
                  title="A style defined in this document"
                >
                  {ruleStyles.map((st) => (
                    <option key={st.selfId} value={st.selfId}>
                      {st.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  data-data-bind-rule-style
                  type="text"
                  value={ruleStyle}
                  onChange={(e) => setRuleStyle(e.target.value)}
                  placeholder="style name"
                  title="No styles of this kind were read from the document — type a style id"
                  style={{ width: 110 }}
                />
              )}
              <button
                type="button"
                data-data-rule-styles
                title="Read this document's styles for the chosen action"
                onClick={() => {
                  void loadRuleStyles(ruleAction);
                }}
              >
                styles
              </button>
              {ruleAction !== "tableStyle" && (
                <select
                  data-data-bind-rule-scope
                  value={ruleScope}
                  onChange={(e) => setRuleScope(e.target.value as "story" | "paragraphs")}
                  title="Where in the story the style lands"
                >
                  <option value="story">whole story, when any record fires</option>
                  <option value="paragraphs">one paragraph per record, from the cursor</option>
                </select>
              )}
              <button
                type="button"
                data-data-rule-preview
                title="Check the condition and list the records it fires on"
                onClick={() => {
                  void previewRule();
                }}
              >
                Preview
              </button>
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
        {bindKind === "rule" && (ruleCheck || rulePreview) && (
          <p style={note} data-data-rule-preview-out>
            {ruleCheck && !ruleCheck.ok ? (
              <span style={{ color: "var(--status-error, #c33)" }}>
                {ruleCheck.error ?? "the condition does not parse"}
              </span>
            ) : rulePreview ? (
              rulePreview.error ? (
                <span style={{ color: "var(--status-error, #c33)" }}>{rulePreview.error}</span>
              ) : (
                <>
                  fires on {rulePreview.fires.length} of {rulePreview.total} record
                  {rulePreview.total === 1 ? "" : "s"}
                  {rulePreview.fires.length > 0 &&
                    `: ${rulePreview.fires
                      .slice(0, 20)
                      .map((i) => `#${i + 1}`)
                      .join(", ")}${rulePreview.fires.length > 20 ? " …" : ""}`}
                </>
              )
            ) : null}
          </p>
        )}
        <div style={row} data-data-merge>
          <strong>Data Merge</strong>
          <select data-data-merge-query value={mergeQuery} onChange={(e) => setMergeQuery(e.target.value)}>
            <option value="">(first query)</option>
            {session.getState().queries.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
          <select
            data-data-merge-mode
            value={mergeMode}
            onChange={(e) => setMergeMode(e.target.value as "single" | "multiple")}
          >
            <option value="single">Single record per page</option>
            <option value="multiple">Multiple records per page</option>
          </select>
          {mergeMode === "multiple" && (
            <>
              <select value={mergeArrange} onChange={(e) => setMergeArrange(e.target.value as "rows" | "columns")}>
                <option value="rows">Rows first</option>
                <option value="columns">Columns first</option>
              </select>
              <label>
                row spacing{" "}
                <input type="number" value={mergeRowSpacing} onChange={(e) => setMergeRowSpacing(Number(e.target.value))} style={{ width: 48 }} />
              </label>
              <label>
                column spacing{" "}
                <input type="number" value={mergeColSpacing} onChange={(e) => setMergeColSpacing(Number(e.target.value))} style={{ width: 48 }} />
              </label>
            </>
          )}
          <label>
            <input type="checkbox" checked={mergeBlank} onChange={(e) => setMergeBlank(e.target.checked)} /> remove
            blank lines
          </label>
          <label title="Keep the template page and put the merged records on new pages after it">
            <input type="checkbox" checked={mergeKeep} onChange={(e) => setMergeKeep(e.target.checked)} /> keep template
          </label>
          <label
            title={
              documentsDoors(host)
                ? "Copy this document, open the copy and merge into it, consuming the template (the current document is kept as it is)"
                : NO_NEW_DOCUMENT_DOOR
            }
          >
            <input
              type="checkbox"
              data-data-merge-new-doc
              disabled={!documentsDoors(host)}
              checked={mergeNewDoc}
              onChange={(e) => setMergeNewDoc(e.target.checked)}
            />{" "}
            into a new document
          </label>
          <button
            type="button"
            data-data-merge-run
            title="Merge every record through the <<field>> frames on this page (one document; a second merge replaces the first)"
            onClick={() => {
              void runMerge();
            }}
          >
            Merge records
          </button>
        </div>
        {mergeMsg && <p style={note} data-data-merge-msg>{mergeMsg}</p>}
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
        {rowDiff && (
          <div data-testid="row-diff" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {rowDiff.length === 0 && <span style={note}>no query has data yet — refresh first.</span>}
            {rowDiff.map((d) => (
              <div key={d.query} data-row-diff-query={d.query} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <strong>
                  {d.query}:{" "}
                  {d.baseline
                    ? `${d.insertedCount} row(s) — nothing was written from this data yet`
                    : `+${d.insertedCount} added · −${d.removedCount} removed · ${d.updatedCount} changed · ${d.unchanged} unchanged`}
                </strong>
                <label style={note}>
                  rows matched by{" "}
                  <select
                    data-row-diff-key
                    value={d.key.length === 1 ? d.key[0] : ""}
                    onChange={(e) => {
                      void rekey(d.query, e.target.value);
                    }}
                  >
                    <option value="">{d.key.length === 0 ? "the whole row" : "automatic"}</option>
                    {d.columns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
                {!d.baseline &&
                  d.updated.map((u) => (
                    <span key={`u${u.index}`} data-row-change="updated" style={mono}>
                      ~ {u.key}:{" "}
                      {u.changes.map((c) => `${c.column} ${c.before} → ${c.after}`).join("; ")}
                    </span>
                  ))}
                {!d.baseline &&
                  d.inserted.map((r) => (
                    <span key={`i${r.index}`} data-row-change="inserted" style={{ ...mono, color: "var(--status-ok, #2a2)" }}>
                      + {r.key}: {r.values.join(" · ")}
                    </span>
                  ))}
                {d.removed.map((r) => (
                  <span key={`r${r.index}`} data-row-change="removed" style={{ ...mono, color: "var(--status-error, #c33)" }}>
                    − {r.key}: {r.values.join(" · ")}
                  </span>
                ))}
                {d.updatedCount + d.insertedCount + d.removedCount > d.updated.length + d.inserted.length + d.removed.length &&
                  !d.baseline && <span style={note}>… more rows than listed</span>}
                {d.affected.length > 0 ? (
                  <span style={note}>reaches:</span>
                ) : (
                  !d.baseline && <span style={note}>no binding reads what changed.</span>
                )}
                {d.affected.map((a) => (
                  <span key={a.binding} data-row-affected={a.binding} style={note}>
                    <span style={mono}>{a.binding}</span> ({a.kind}) — {a.reason}
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
        <div data-data-bindings>
          bindings:{" "}
          <button
            type="button"
            data-data-sync-reload
            title="Show each binding's sync state"
            onClick={() => {
              void reloadSync();
            }}
          >
            sync states
          </button>
          {snapshot.bindings.length === 0 ? (
            <span style={note}>none</span>
          ) : (
            <ul style={{ margin: 0, paddingLeft: "var(--space-3, 12px)" }}>
              {(session.listBindings() ?? []).map((b) => {
                const sync = syncRows?.find((r) => r.id === b.id) ?? null;
                const status = sync?.status ?? null;
                return (
                <li key={b.id} data-binding-kind={b.kind}>
                  <span style={mono}>{b.id}</span> <span style={note}>({b.kind})</span>
                  {status && (
                    <span
                      data-sync-status={status}
                      title="ADR 553: pinned and overridden content is never replaced by a refresh"
                      style={{ marginLeft: 6, color: SYNC_COLOR[status] }}
                    >
                      {SYNC_LABEL[status]}
                    </span>
                  )}
                  {sync?.locale && <span style={note}> · {sync.locale}</span>}
                  {status && status !== "pinned" && status !== "overridden" && b.kind !== "rule" && (
                    <button
                      type="button"
                      data-data-sync-pin
                      title="Keep this content as it is; refreshes leave it alone"
                      onClick={() => {
                        void decide(() => session.pin(b.id));
                      }}
                    >
                      Pin
                    </button>
                  )}
                  {status === "pinned" && (
                    <button
                      type="button"
                      data-data-sync-unpin
                      title="Follow the source again from the next refresh"
                      onClick={() => {
                        void decide(() => session.unpin(b.id));
                      }}
                    >
                      Unpin
                    </button>
                  )}
                  {(status === "pinned" || status === "overridden") && (
                    <button
                      type="button"
                      data-data-sync-accept
                      title="Replace this content with the source's value now"
                      onClick={() => {
                        void decide(() => session.acceptSource(b.id));
                      }}
                    >
                      Accept source
                    </button>
                  )}
                  {b.kind === "variable" && sync && (
                    <button
                      type="button"
                      data-data-format-open
                      title="Number, currency or date pattern and locale for this field"
                      onClick={() => openFormat(sync)}
                    >
                      Format…
                    </button>
                  )}
                  {formatOpen === b.id && draft && (
                    <div data-data-format-editor style={{ ...row, marginTop: 4 }}>
                      <select
                        data-data-format-kind
                        value={draft.kind}
                        onChange={(e) => {
                          setDraft({ ...draft, kind: e.target.value as FormatPattern["kind"] });
                          refresh();
                        }}
                      >
                        {FORMAT_KINDS.map((k) => (
                          <option key={k.value} value={k.value}>
                            {k.label}
                          </option>
                        ))}
                      </select>
                      {(draft.kind === "number" || draft.kind === "currency" || draft.kind === "percent") && (
                        <label style={note}>
                          decimals{" "}
                          <input
                            data-data-format-decimals
                            type="number"
                            min={0}
                            max={10}
                            value={draft.decimals}
                            style={{ width: "3.5em" }}
                            onChange={(e) => {
                              setDraft({ ...draft, decimals: e.target.value });
                              refresh();
                            }}
                          />
                        </label>
                      )}
                      {draft.kind === "currency" && (
                        <input
                          data-data-format-symbol
                          type="text"
                          value={draft.symbol}
                          placeholder="symbol (locale's)"
                          style={{ width: 90 }}
                          onChange={(e) => {
                            setDraft({ ...draft, symbol: e.target.value });
                            refresh();
                          }}
                        />
                      )}
                      {draft.kind === "date" && (
                        <input
                          data-data-format-date
                          type="text"
                          value={draft.date}
                          placeholder="DD.MM.YYYY (locale's)"
                          style={{ width: 110 }}
                          onChange={(e) => {
                            setDraft({ ...draft, date: e.target.value });
                            refresh();
                          }}
                        />
                      )}
                      <select
                        data-data-format-locale
                        value={draft.locale}
                        title="Format this field for another locale than the session's"
                        onChange={(e) => {
                          setDraft({ ...draft, locale: e.target.value });
                          refresh();
                        }}
                      >
                        <option value="">session locale ({session.getLocale()})</option>
                        {locales.map((l) => (
                          <option key={l.tag} value={l.tag}>
                            {l.tag} — {l.currency} · {l.date}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        data-data-format-apply
                        onClick={() => {
                          void applyFormat(b.id);
                        }}
                      >
                        Apply
                      </button>
                      {formatPreview !== null && (
                        <span data-data-format-preview style={mono}>
                          → {formatPreview}
                        </span>
                      )}
                    </div>
                  )}
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
                );
              })}
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
