// The session half of ADR 558 / 559: define a property binding against a
// live target (schema read through `host.objects`), apply property bindings
// as one batch, keep the element labels in step with the recipe, and rebuild
// the recipe from the labels when the session part is gone. `session.ts`
// spreads these methods into the session (like `reviewMethods`); the state
// they touch is the session's own, passed in by reference.

import type { BundleHost, ElementId, PropertySchema } from "@paged-media/plugin-api";

import { DATA_LABEL_KEY, labelData, oidSelector, type PropertyApply } from "../../data-host-model/src";
import type { DataEngineLike } from "./engine";
import {
  labelledElements,
  mintOid,
  planLabels,
  restoreFromLabels,
  sourcesToRelink,
  type HostFacts,
  type PayloadJson,
} from "./labels";
import { commitProperties, NO_OBJECT_MODEL, objectsOf, type PropertyLaneResult } from "./property-lane";

type Diagnostic = {
  level: "error" | "warn" | "info";
  source: "binding" | "restore" | "persist" | "refresh";
  message: string;
  binding?: string;
};

/** The session internals the property lane works on (by reference). */
export interface PropertyContext {
  host: BundleHost;
  ensureEngine(): Promise<DataEngineLike>;
  engineIfUp(): DataEngineLike | null;
  /** Load a recipe as the engine's (boots it). */
  loadRecipe(payload: PayloadJson): Promise<DataEngineLike>;
  report(d: Diagnostic): void;
  markDirty(): void;
  emit(): void;
  bindingKinds: Map<string, string>;
  bindingIds: string[];
  queries: Map<string, { id: string; sql: string }>;
  sourceNames: string[];
  visibilityTargets: Map<string, { elementId: string; kind?: string }>;
  imageTargets: Map<string, { elementId: string; fit?: string }>;
  barcodeTargets: Map<string, { elementId: string }>;
  loweredInto: Map<string, ElementId>;
  ruleTargets: Map<string, { query: string; target: { kind: string; storyId: string; [k: string]: unknown } }>;
  /** Property bindings carried by an element: binding → oid. */
  hostOids: Map<string, string>;
  /** …and the element (raw `Self`) while this session knows it. */
  hostElements: Map<string, ElementId>;
  /** File sources whose bytes must be imported again (restored from labels). */
  relink: string[];
}

/** What defining a property binding needs. */
export interface PropertyBindingSpec {
  /** An address (`rectangle:u12`), a selector (`textFrame[name="Price"]`)
   *  or a plugin address. A single page item is made durable: the binding is
   *  carried by its label and targets it by its oid. */
  target: string;
  path: string;
  query: string;
  expr: string;
  coerce?: "strict" | "lenient";
  missing?: "keepLast" | "clear" | "default" | "error";
  /** The ADR 132 schema row (JSON or object); read from the target when absent. */
  schema?: PropertySchema | string;
}

export interface DefineResult {
  ok: boolean;
  reason?: string;
  /** The durable selector the binding resolves through. */
  selector?: string;
}

/** One property binding, as a reader (the editor's badge) wants it. */
export interface PropertyBindingInfo {
  binding: string;
  path: string;
  selector: string;
  /** The objects it names now. */
  addresses: string[];
  status: string | null;
}

const PAGE_ITEM = /^(textFrame|rectangle|oval|polygon|graphicLine|group):(.+)$/;

/** `rectangle:u12` → its ElementId (page items only). */
export function elementOfAddress(address: string): ElementId | null {
  const m = PAGE_ITEM.exec(address);
  return m ? ({ kind: m[1], id: m[2] } as ElementId) : null;
}

/** A selector that already names its target durably (name / label based). */
const durable = (s: string) => /\[(name|label)[.=*^!]/.test(s) || s.startsWith("plugin:");

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The oid another surface (the editor) gave an element: `x-paged:oid`. */
function sharedOid(meta: readonly { key: string; value: string }[] | undefined): string | null {
  const entry = meta?.find((m) => m.key === "x-paged:oid");
  if (!entry) return null;
  try {
    const parsed = JSON.parse(entry.value) as { data?: unknown } | string;
    const v = typeof parsed === "string" ? parsed : (parsed as { data?: unknown }).data;
    if (typeof v === "string" && /^[A-Za-z0-9_-]{2,64}$/.test(v)) return v;
    const nested = (v as { oid?: unknown } | null)?.oid;
    return typeof nested === "string" && /^[A-Za-z0-9_-]{2,64}$/.test(nested) ? nested : null;
  } catch {
    return /^[A-Za-z0-9_-]{2,64}$/.test(entry.value) ? entry.value : null;
  }
}

type TreeNode = {
  id?: ElementId | null;
  children?: readonly TreeNode[];
  pluginMetadata?: readonly { key: string; value: string }[];
};

function findNode(tree: readonly TreeNode[], id: string): TreeNode | null {
  for (const n of tree) {
    if (n.id && n.id.id === id) return n;
    const inner = n.children ? findNode(n.children, id) : null;
    if (inner) return inner;
  }
  return null;
}

/** A "Bind to data…" request waiting for its query and expression. */
export interface PropertyDraft {
  selector: string;
  path: string;
  schema: string;
}

export function propertyMethods(ctx: PropertyContext) {
  const { host } = ctx;
  let draft: PropertyDraft | null = null;

  async function tree(): Promise<TreeNode[]> {
    try {
      return (await host.document.tree()) as unknown as TreeNode[];
    } catch {
      return [];
    }
  }

  /** The text frame a story starts in. */
  async function firstFrame(storyId: string): Promise<string | null> {
    try {
      return (await host.document.frameChain(storyId))[0]?.frameId ?? null;
    } catch {
      return null;
    }
  }

  async function storyHosted(payload: PayloadJson): Promise<HostFacts["storyHosted"]> {
    const out = new Map<string, { frame: string; extra?: unknown }>();
    const variables = (payload.bindings ?? []).filter((b) => b.kind === "variable").map((b) => b.id);
    if (variables.length > 0 && host.supports("document.placeholders@1")) {
      try {
        const fields = (await host.document.placeholders()).filter((p) => p.plugin === "media.paged.data");
        for (const id of variables) {
          const f = fields.find((x) => x.key === id);
          const frame = f ? await firstFrame(f.storyId) : null;
          if (frame) out.set(id, { frame });
        }
      } catch {
        // no field read: the variables stay in the document label
      }
    }
    for (const [id, t] of ctx.ruleTargets) {
      const frame = await firstFrame(t.target.storyId);
      if (frame) out.set(id, { frame, extra: { query: t.query, target: { ...t.target, storyId: "$story" } } });
    }
    return out;
  }

  /** Write the element labels the recipe asks for (one mutate, or none). */
  async function syncLabels(): Promise<{ written: number }> {
    const e = ctx.engineIfUp();
    if (!e) return { written: 0 };
    const payload = (e.payload() ?? {}) as PayloadJson;
    const facts: HostFacts = {
      hostOids: ctx.hostOids,
      hostElements: ctx.hostElements,
      visibility: ctx.visibilityTargets,
      image: ctx.imageTargets,
      barcode: ctx.barcodeTargets,
      lowered: ctx.loweredInto,
      storyHosted: await storyHosted(payload),
    };
    const plan = planLabels(payload, facts, labelledElements(await tree()));
    if (plan.ops.length === 0) return { written: 0 };
    const out = await host.document.mutate(
      plan.ops.length === 1 ? plan.ops[0]! : ({ op: "batch", args: { ops: plan.ops } } as never),
    );
    if (!out.applied) {
      ctx.report({ level: "warn", source: "persist", message: `the binding labels were not written: ${errText(out.error)}` });
      return { written: 0 };
    }
    return { written: plan.ops.length };
  }

  /** Rebuild the session from the labels (the part is gone). `true` when
   *  the document carried bindings. */
  async function restoreLabels(): Promise<boolean> {
    const elements = labelledElements(await tree());
    let recipe: PayloadJson | null = null;
    try {
      const doc = (await host.document.getDocumentMetadata?.()) as { data?: { recipe?: PayloadJson } } | null;
      recipe = doc?.data?.recipe ?? null;
    } catch {
      recipe = null;
    }
    const restored = restoreFromLabels(elements, recipe);
    const bindings = restored.payload.bindings ?? [];
    if (bindings.length === 0 && (restored.payload.queries ?? []).length === 0) {
      if (elements.some((x) => x.data !== null)) {
        ctx.report({
          level: "info",
          source: "restore",
          message:
            "this document carries data content but no binding recipe (its session was not saved with it): the content stays as it is, without live bindings",
        });
      }
      return false;
    }
    // Rules point into a story: today's story id of the frame they live in.
    const rules = [...restored.facts.storyHosted].filter(([id]) => bindings.some((b) => b.id === id && b.kind === "rule"));
    const frameStory = new Map<string, string>();
    if (rules.length > 0) {
      try {
        for (const s of await host.document.collection<{ selfId: string }>("stories")) {
          for (const link of await host.document.frameChain(s.selfId)) frameStory.set(link.frameId, s.selfId);
        }
      } catch {
        // no story read: the rules report below
      }
    }
    await ctx.loadRecipe(restored.payload);
    for (const b of bindings) {
      ctx.bindingKinds.set(b.id, b.kind);
      if (!ctx.bindingIds.includes(b.id)) ctx.bindingIds.push(b.id);
    }
    for (const q of restored.payload.queries ?? []) ctx.queries.set(q.id, { id: q.id, sql: String(q.sql ?? "") });
    for (const [id, oid] of restored.facts.hostOids) ctx.hostOids.set(id, oid);
    for (const [id, t] of restored.facts.visibility) ctx.visibilityTargets.set(id, t);
    for (const [id, t] of restored.facts.image) ctx.imageTargets.set(id, t);
    for (const [id, t] of restored.facts.barcode) ctx.barcodeTargets.set(id, t);
    for (const [id, el] of restored.facts.lowered) ctx.loweredInto.set(id, el);
    for (const [id, h] of rules) {
      const extra = h.extra as { query?: string; target?: { kind: string; storyId: string } } | undefined;
      const story = frameStory.get(h.frame);
      if (extra?.query && extra.target && story) {
        ctx.ruleTargets.set(id, { query: extra.query, target: { ...extra.target, storyId: story } });
      } else {
        ctx.report({ level: "warn", source: "restore", binding: id, message: "the rule's target could not be found again — pick it in the Bindings panel" });
      }
    }
    for (const s of sourcesToRelink(restored.payload)) {
      if (!ctx.sourceNames.includes(s.id)) ctx.sourceNames.push(s.id);
      if (!ctx.relink.includes(s.id)) ctx.relink.push(s.id);
      ctx.report({
        level: "warn",
        source: "restore",
        message: s.remote
          ? `re-link data source "${s.id}": the document was saved without its data — load the remote source again`
          : `re-link data source "${s.id}"${s.file ? ` (${s.file})` : ""}: the document was saved without its data (by another application) — import the file again`,
      });
    }
    ctx.report({
      level: "info",
      source: "restore",
      message: `Restored ${bindings.length} binding(s) from the document's labels (${restored.fromElements} from page items); the data itself must be re-linked.`,
    });
    // The part is the cache: write it again.
    ctx.markDirty();
    ctx.emit();
    return true;
  }

  return {
    syncLabels,
    restoreLabels,

    async addPropertyBinding(id: string, spec: PropertyBindingSpec): Promise<DefineResult> {
      const objects = objectsOf(host);
      if (!objects) return { ok: false, reason: NO_OBJECT_MODEL };
      let addresses: string[];
      try {
        addresses = await objects.query(spec.target);
      } catch (err) {
        return { ok: false, reason: `the target ${spec.target} is not an address or a selector (${errText(err)})` };
      }
      if (addresses.length === 0) return { ok: false, reason: `the target ${spec.target} names nothing in this document` };
      // The schema row the value coerces to.
      let row: PropertySchema | null = null;
      if (spec.schema) {
        try {
          row = typeof spec.schema === "string" ? (JSON.parse(spec.schema) as PropertySchema) : spec.schema;
        } catch {
          return { ok: false, reason: "the schema row is not JSON" };
        }
      } else {
        row = (await objects.schema(addresses[0]!)).find((r) => r.path === spec.path) ?? null;
      }
      if (!row || row.path !== spec.path) return { ok: false, reason: `${addresses[0]} has no property "${spec.path}"` };
      if (row.access === "readOnly" || row.access === "derived") return { ok: false, reason: `"${spec.path}" is ${row.access}` };
      // A single page item named by a raw id becomes durable: its label
      // carries the binding and its oid (shared with `x-paged:oid` when
      // another surface already gave it one).
      let selector = spec.target;
      const element = addresses.length === 1 ? elementOfAddress(addresses[0]!) : null;
      if (element && !durable(spec.target)) {
        const node = findNode(await tree(), element.id as string);
        const ours = labelData(node?.pluginMetadata?.find((m) => m.key === DATA_LABEL_KEY)?.value);
        const oid = (typeof ours?.oid === "string" ? ours.oid : null) ?? sharedOid(node?.pluginMetadata) ?? mintOid();
        selector = oidSelector(oid);
        ctx.hostOids.set(id, oid);
        ctx.hostElements.set(id, element);
      } else {
        ctx.hostOids.delete(id);
        ctx.hostElements.delete(id);
      }
      const schema = {
        type: row.type,
        ...(row.nullable ? { nullable: true } : {}),
        ...(row.range ? { range: { min: row.range.min ?? null, max: row.range.max ?? null } } : {}),
        ...(row.default !== undefined ? { default: row.default } : {}),
      };
      const e = await ctx.ensureEngine();
      try {
        e.define_binding({
          id,
          kind: "property",
          target: { selector },
          path: spec.path,
          query: spec.query,
          expr: spec.expr,
          schema,
          coerce: spec.coerce ?? "strict",
          missing: spec.missing ?? "keepLast",
        });
      } catch (err) {
        return { ok: false, reason: `the engine refused the definition: ${errText(err)}` };
      }
      ctx.bindingKinds.set(id, "property");
      if (!ctx.bindingIds.includes(id)) ctx.bindingIds.push(id);
      ctx.markDirty();
      await syncLabels();
      ctx.emit();
      return { ok: true, selector };
    },

    async removeBinding(id: string): Promise<boolean> {
      const e = ctx.engineIfUp();
      const removed = e && typeof e.remove_binding === "function" ? e.remove_binding(id) : false;
      const i = ctx.bindingIds.indexOf(id);
      if (i >= 0) ctx.bindingIds.splice(i, 1);
      ctx.bindingKinds.delete(id);
      for (const m of [ctx.visibilityTargets, ctx.imageTargets, ctx.barcodeTargets, ctx.loweredInto, ctx.ruleTargets, ctx.hostOids, ctx.hostElements]) {
        (m as Map<string, unknown>).delete(id);
      }
      ctx.markDirty();
      await syncLabels();
      ctx.emit();
      return removed || i >= 0;
    },

    /** Apply property bindings (all, or `ids`) over `record` as ONE
     *  `host.objects.batch`; with `withVisibility`, visibility bindings too
     *  (re-expressed as `elementVisible`). */
    async applyProperties(
      opts: { record?: number; ids?: readonly string[]; withVisibility?: boolean } = {},
    ): Promise<PropertyLaneResult> {
      const e = await ctx.ensureEngine();
      if (typeof e.resolve_properties_at !== "function") {
        return { applied: 0, undoSteps: 0, skipped: {}, written: {}, calls: 0 };
      }
      const applies = (e.resolve_properties_at(opts.record ?? 0, opts.withVisibility ?? false, opts.ids ? [...opts.ids] : undefined) ??
        []) as PropertyApply[];
      const result = await commitProperties(host, applies, Object.fromEntries(ctx.hostOids));
      for (const [binding, reason] of Object.entries(result.skipped)) {
        const failed = applies.find((a) => a.binding === binding)?.property.outcome.outcome === "fail";
        ctx.report({ level: failed ? "error" : "info", source: "binding", binding, message: reason });
      }
      return result;
    },

    /** The property bindings on `address` (and `path`), for a badge. */
    async propertyBindings(filter: { address?: string; path?: string } = {}): Promise<PropertyBindingInfo[]> {
      const e = ctx.engineIfUp();
      if (!e) return [];
      const objects = objectsOf(host);
      const payload = (e.payload() ?? {}) as PayloadJson;
      const out: PropertyBindingInfo[] = [];
      for (const b of payload.bindings ?? []) {
        if (b.kind !== "property") continue;
        const path = String(b.path ?? "");
        if (filter.path && filter.path !== path) continue;
        const selector = (b.target as { selector?: string } | null)?.selector ?? "";
        let addresses: string[] = [];
        if (objects && selector) {
          try {
            addresses = await objects.query(selector);
          } catch {
            addresses = [];
          }
        }
        if (filter.address && !addresses.includes(filter.address)) continue;
        let status: string | null = null;
        try {
          status = ((e.sync_state(b.id) as { status?: string } | null)?.status ?? null) as string | null;
        } catch {
          status = null;
        }
        out.push({ binding: b.id, path, selector, addresses, status });
      }
      return out;
    },

    /** Redefine a binding from its whole definition (`{ id, kind, … }`).
     *  A property binding goes through `addPropertyBinding` (its target is
     *  resolved and its schema read again); any other kind replaces its
     *  engine definition and keeps its host-side target. */
    async redefineBinding(def: Record<string, unknown>): Promise<DefineResult> {
      const id = typeof def.id === "string" ? def.id : "";
      if (!id || typeof def.kind !== "string") return { ok: false, reason: "a definition needs an id and a kind" };
      if (def.kind === "property") {
        const target = (def.target as { selector?: string } | null)?.selector;
        if (!target) return { ok: false, reason: "a property binding needs { target: { selector } }" };
        return this.addPropertyBinding(id, {
          target,
          path: String(def.path ?? ""),
          query: String(def.query ?? ""),
          expr: String(def.expr ?? ""),
          ...(def.coerce ? { coerce: def.coerce as "strict" } : {}),
          ...(def.missing ? { missing: def.missing as "keepLast" } : {}),
          ...(def.schema ? { schema: { path: String(def.path ?? ""), ...(def.schema as object) } as PropertySchema } : {}),
        });
      }
      if (!ctx.bindingKinds.has(id)) return { ok: false, reason: `no ${def.kind} binding "${id}" to redefine (define it in the Bindings panel)` };
      const e = await ctx.ensureEngine();
      try {
        e.define_binding(def);
      } catch (err) {
        return { ok: false, reason: `the engine refused the definition: ${errText(err)}` };
      }
      ctx.bindingKinds.set(id, def.kind);
      ctx.markDirty();
      await syncLabels();
      ctx.emit();
      return { ok: true };
    },

    /** One binding's definition (`{ id, kind, … }`), or null. */
    async bindingDefinition(id: string): Promise<Record<string, unknown> | null> {
      const e = ctx.engineIfUp();
      const def = ((e?.payload() ?? {}) as PayloadJson).bindings?.find((b) => b.id === id);
      return def ? { ...def } : null;
    },

    /** "Bind to data…": remember the target until the panel completes it. */
    setPropertyDraft(next: PropertyDraft | null): void {
      draft = next;
      ctx.emit();
    },
    getPropertyDraft(): PropertyDraft | null {
      return draft;
    },

    async recipe(): Promise<PayloadJson> {
      const e = ctx.engineIfUp();
      return (e?.payload() ?? {}) as PayloadJson;
    },
  };
}

export type PropertyMethods = ReturnType<typeof propertyMethods>;
