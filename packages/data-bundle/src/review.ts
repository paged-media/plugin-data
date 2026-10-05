// The session's review and sync-decision methods (wave 7): what the Bindings
// panel shows before it writes, and the per-binding decisions it offers.
//
//   · sync state per binding (linked / stale / pinned / overridden / error),
//     and pin, unpin, accept-source;
//   · the row diff since the document was last written from the data, and
//     which bindings each change reaches;
//   · the rule editor's expression check and firing preview, and the
//     document's styles to choose an action from;
//   · the locale catalog, a per-binding locale and a per-field display pattern.
//
// Every decision about data is the engine's (data-js `review.rs`); this file
// only asks it and writes what it answers. Kept apart from `session.ts` so the
// session's refresh and lowering code is not touched by it.

import type { BundleHost } from "@paged-media/plugin-api";

import type { RuleTarget } from "../../data-host-model/src";
import type { DataEngineLike } from "./engine";
import type { SessionDiagnostic } from "./session";

/** The engine's sync statuses (ADR 553), as the wasm boundary spells them. */
export type SyncStatus = "linked" | "pinned" | "overridden" | "stale" | "error";

/** A field's display pattern (mirrors data-js `FormatPattern`). */
export type FormatPattern =
  | { kind: "plain" }
  | { kind: "number"; decimals: number }
  | { kind: "currency"; decimals: number; symbol?: string }
  | { kind: "percent"; decimals: number }
  | { kind: "date"; pattern?: string };

/** One binding as the sync list shows it. */
export interface BindingSync {
  id: string;
  kind: string;
  /** `null` until the engine holds a state for it. */
  status: SyncStatus | null;
  /** The binding's own locale override, or `null` (the session's applies). */
  locale: string | null;
  /** A variable binding's inner expression and display pattern; `null` for
   *  other kinds. */
  format: { inner: string; pattern: FormatPattern } | null;
}

export interface RowView {
  index: number;
  key: string;
  values: string[];
}
export interface CellChange {
  column: string;
  before: string;
  after: string;
}
export interface RowUpdate {
  index: number;
  key: string;
  changes: CellChange[];
}
export interface AffectedBinding {
  binding: string;
  kind: string;
  reason: string;
}
/** The row diff of one query (data-js `QueryRowDiff`). */
export interface QueryRowDiff {
  query: string;
  key: string[];
  baseline: boolean;
  columns: string[];
  insertedCount: number;
  removedCount: number;
  updatedCount: number;
  unchanged: number;
  inserted: RowView[];
  removed: RowView[];
  updated: RowUpdate[];
  changedColumns: string[];
  affected: AffectedBinding[];
}

export interface ExprCheck {
  ok: boolean;
  error?: string;
  fields: string[];
  unknownFields: string[];
}

export interface ConditionPreview {
  fires: number[];
  total: number;
  error?: string;
}

export interface LocaleInfo {
  tag: string;
  name: string;
  number: string;
  currency: string;
  date: string;
}

/** A document style a rule can apply: its `selfId` is what the host applies. */
export interface StyleOption {
  selfId: string;
  name: string;
}
export type RuleStyleKind = "paragraph" | "character" | "cell";

/** The review + sync-decision half of the session (merged into it). */
export interface ReviewSession {
  /** Every binding with its sync status, locale override and display pattern. */
  bindingSync(): Promise<BindingSync[]>;
  /** Freeze a binding: refreshes leave its content alone (ADR 553). */
  pin(id: string): Promise<void>;
  /** Unfreeze: the binding follows the source again from the next refresh. */
  unpin(id: string): Promise<void>;
  /** Replace a pinned or overridden binding's content with the source's now:
   *  relink, then write it. Returns false when it could not be written. */
  acceptSource(id: string): Promise<boolean>;
  /** The row diff of every query since the document was last written from it. */
  rowDiff(): Promise<QueryRowDiff[]>;
  /** The key fields a query's rows are matched by (null = the engine's
   *  default: the first column unique in both results). */
  setDiffKey(query: string, fields: string[] | null): void;
  /** Record the current results as what the document was written from. */
  markApplied(): Promise<void>;
  checkExpression(src: string, query?: string): Promise<ExprCheck>;
  previewCondition(query: string, when: string): Promise<ConditionPreview>;
  /** The document's styles of a kind, for a rule's action. */
  documentStyles(kind: RuleStyleKind): Promise<StyleOption[]>;
  /** Every locale the engine knows, with formatted samples. */
  locales(): Promise<LocaleInfo[]>;
  /** Format one binding for another locale than the session's (`null` clears). */
  setBindingLocale(id: string, tag: string | null): Promise<void>;
  /** Give a variable binding a display pattern (wraps its expression). Writes
   *  the field now unless it is pinned or overridden. */
  setBindingFormat(id: string, pattern: FormatPattern): Promise<boolean>;
  /** A variable binding's text for a record, without changing its sync state. */
  previewBinding(id: string, record?: number): Promise<string | null>;
}

/** What the review methods need from the session that owns them. */
export interface ReviewContext {
  host: BundleHost;
  ensureEngine(): Promise<DataEngineLike>;
  listBindings(): { id: string; kind: string }[];
  ruleTargets: ReadonlyMap<string, { query: string; target: RuleTarget }>;
  setPinned(id: string, pinned: boolean): void;
  /** Re-lower one binding (the session's own lane). */
  lowerBinding(id: string): Promise<void>;
  /** Re-resolve and write one variable binding's placed field(s); the number
   *  written, or null when the fields could not be read. */
  writeVariable(id: string): Promise<number | null>;
  markDirty(): void;
  report(d: SessionDiagnostic): void;
  emit(): void;
}

const COLLECTION: Record<RuleStyleKind, "paragraphStyles" | "characterStyles" | "cellStyles"> = {
  paragraph: "paragraphStyles",
  character: "characterStyles",
  cell: "cellStyles",
};

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The review methods, closed over the owning session's context. */
export function reviewMethods(ctx: ReviewContext): ReviewSession {
  const diffKeys = new Map<string, string[]>();

  /** The engine when it is up and has the lane; otherwise null (reported once
   *  per call by the caller's fallback). */
  async function engineWith<K extends keyof DataEngineLike>(
    method: K,
  ): Promise<DataEngineLike | null> {
    let e: DataEngineLike;
    try {
      e = await ctx.ensureEngine();
    } catch (err) {
      ctx.report({ level: "error", source: "binding", message: `engine unavailable: ${errText(err)}` });
      return null;
    }
    if (typeof e[method] !== "function") {
      ctx.report({
        level: "warn",
        source: "binding",
        message: `this engine build predates ${String(method)} — rebuild the data-js wasm`,
      });
      return null;
    }
    return e;
  }

  function statusOf(e: DataEngineLike, id: string): SyncStatus | null {
    try {
      const st = e.sync_state(id) as { status?: unknown } | null;
      return st && typeof st.status === "string" ? (st.status as SyncStatus) : null;
    } catch {
      return null;
    }
  }

  /** The engine's recipe for one binding (the payload's flattened def). */
  function bindingDef(e: DataEngineLike, id: string): Record<string, unknown> | null {
    const payload = (e.payload() ?? {}) as { bindings?: Record<string, unknown>[] };
    return payload.bindings?.find((b) => b.id === id) ?? null;
  }

  /** Write a binding's current resolution into the document by its kind. */
  async function writeNow(id: string, kind: string): Promise<boolean> {
    if (kind === "variable") return (await ctx.writeVariable(id)) !== null;
    if (kind === "table" || kind === "recordFlow") {
      // A table re-lowered is inserted again as a whole (ADR 551); the user
      // re-lowers it deliberately.
      ctx.report({
        level: "info",
        source: "binding",
        binding: id,
        message: "follows the source again — lower it to replace the table",
      });
      return true;
    }
    await ctx.lowerBinding(id);
    return true;
  }

  return {
    async bindingSync() {
      const list = ctx.listBindings();
      let e: DataEngineLike;
      try {
        e = await ctx.ensureEngine();
      } catch {
        return list.map((b) => ({ ...b, status: null, locale: null, format: null }));
      }
      let locales: Record<string, string> = {};
      try {
        locales = (e.binding_locales?.() as Record<string, string> | null) ?? {};
      } catch {
        locales = {};
      }
      const payload = (e.payload() ?? {}) as { bindings?: { id: string; expr?: unknown }[] };
      const exprs = new Map((payload.bindings ?? []).map((b) => [b.id, b.expr]));
      return list.map((b) => {
        let format: BindingSync["format"] = null;
        const expr = exprs.get(b.id);
        if (b.kind === "variable" && typeof expr === "string" && e.split_expression) {
          try {
            format = e.split_expression(expr) as BindingSync["format"];
          } catch {
            format = null;
          }
        }
        return {
          id: b.id,
          kind: b.kind,
          status: statusOf(e, b.id),
          locale: locales[b.id] ?? null,
          format,
        };
      });
    },

    async pin(id) {
      ctx.setPinned(id, true);
      ctx.emit();
    },

    async unpin(id) {
      ctx.setPinned(id, false);
      ctx.emit();
    },

    async acceptSource(id) {
      const e = await engineWith("relink");
      if (!e) return false;
      const kind = ctx.listBindings().find((b) => b.id === id)?.kind;
      if (!kind) return false;
      e.relink(id);
      ctx.markDirty();
      const ok = await writeNow(id, kind);
      ctx.emit();
      return ok;
    },

    async rowDiff() {
      const e = await engineWith("row_diff");
      if (!e) return [];
      const ruleQueries: Record<string, string> = {};
      for (const [id, t] of ctx.ruleTargets) ruleQueries[id] = t.query;
      try {
        return (
          (e.row_diff!({ keys: Object.fromEntries(diffKeys), ruleQueries }) as QueryRowDiff[] | null) ??
          []
        );
      } catch (err) {
        ctx.report({ level: "error", source: "refresh", message: `row diff failed: ${errText(err)}` });
        return [];
      }
    },

    setDiffKey(query, fields) {
      if (fields && fields.length > 0) diffKeys.set(query, fields);
      else diffKeys.delete(query);
    },

    async markApplied() {
      try {
        const e = await ctx.ensureEngine();
        e.mark_rows_applied?.();
      } catch {
        // no engine: nothing was written from data either
      }
    },

    async checkExpression(src, query) {
      const e = await engineWith("check_expression");
      if (!e) return { ok: false, error: "the engine cannot check expressions", fields: [], unknownFields: [] };
      return e.check_expression!(src, query ?? null) as ExprCheck;
    },

    async previewCondition(query, when) {
      const e = await engineWith("preview_condition");
      if (!e) return { fires: [], total: 0, error: "the engine cannot preview conditions" };
      try {
        return e.preview_condition!(query, when) as ConditionPreview;
      } catch (err) {
        return { fires: [], total: 0, error: errText(err) };
      }
    },

    async documentStyles(kind) {
      try {
        const rows = await ctx.host.document.collection<{ selfId: string; name: string }>(
          COLLECTION[kind],
        );
        return rows.map((r) => ({ selfId: r.selfId, name: r.name }));
      } catch (err) {
        ctx.report({
          level: "warn",
          source: "binding",
          message: `the document's ${COLLECTION[kind]} could not be read: ${errText(err)}`,
        });
        return [];
      }
    },

    async locales() {
      try {
        const e = await ctx.ensureEngine();
        return (e.locales?.() as LocaleInfo[] | null) ?? [];
      } catch {
        return [];
      }
    },

    async setBindingLocale(id, tag) {
      const e = await engineWith("set_binding_locale");
      if (!e) return;
      try {
        e.set_binding_locale!(id, tag);
      } catch (err) {
        ctx.report({ level: "error", source: "binding", binding: id, message: `locale: ${errText(err)}` });
        return;
      }
      ctx.markDirty();
      const status = statusOf(e, id);
      if (status !== "pinned" && status !== "overridden") {
        const kind = ctx.listBindings().find((b) => b.id === id)?.kind;
        if (kind === "variable") await ctx.writeVariable(id);
      }
      ctx.emit();
    },

    async setBindingFormat(id, pattern) {
      const e = await engineWith("format_expression");
      if (!e || !e.split_expression) return false;
      const def = bindingDef(e, id);
      if (!def || def.kind !== "variable" || typeof def.expr !== "string") {
        ctx.report({
          level: "warn",
          source: "binding",
          binding: id,
          message: "a display pattern applies to a variable field",
        });
        return false;
      }
      const { inner } = e.split_expression(def.expr) as { inner: string };
      const expr = e.format_expression!(inner, pattern);
      try {
        e.define_binding({ ...def, expr });
      } catch (err) {
        ctx.report({ level: "error", source: "binding", binding: id, message: errText(err) });
        return false;
      }
      ctx.markDirty();
      const status = statusOf(e, id);
      if (status !== "pinned" && status !== "overridden") await ctx.writeVariable(id);
      ctx.emit();
      return true;
    },

    async previewBinding(id, record = 0) {
      const e = await engineWith("preview_display");
      if (!e) return null;
      try {
        return (e.preview_display!(id, record) as string | null) ?? null;
      } catch (err) {
        ctx.report({ level: "warn", source: "preview", binding: id, message: errText(err) });
        return null;
      }
    },
  };
}
