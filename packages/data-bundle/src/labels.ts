// ADR 559 — bindings live in the document itself, in labels InDesign keeps.
//
// The `session` container part (persist.ts) is a CACHE: InDesign drops every
// part it does not know on open → save, and renumbers every `Self`. What it
// keeps is a page item's script label (`Properties/Label/KeyValuePair`). So
// each binding whose target is a page item is ALSO written into that item's
// label, self-contained — the binding definition with its target made
// relative ("the element carrying this label"), plus the queries it reads and
// the sources those read:
//
//   x-paged:media.paged.data = {"v":1,"data":{
//     "oid":     "pd-3f9c1a2b",            stable object id (minted once)
//     "bind":    [ <BindingDef>, … ],      targets: "host" / "$host"
//     "queries": [ <Query>, … ],
//     "sources": [ <DataSource>, … ],      descriptors only — never data, never secrets
//     "extra":   { "<binding>": {…} },     host-side facts (visibility kind, image fit, rule target)
//     …the lowered content's own keys (kind, binding, def, session) untouched
//   }}
//
// ONE key per element (the engine's caller gate allows `x-paged:<plugin id>`
// and nothing below it), merged into the element's single `<Label>` by
// core's writer. Values are ASCII (`\uXXXX`), so InDesign returns them
// byte-exact; `<?AID xxxx?>` is decoded on read anyway.
//
// Document-scope state (every source, query, template, data set, the locale)
// rides in the document label (`setDocumentMetadata`, protocol 69) next to
// the session-version pointer. On the published engine (0.69.0) that label is
// written into the container's own model part, NOT into `designmap.xml`, so
// it does not survive an InDesign save yet; the element labels do.
//
// Restore (`restoreFromLabels`) runs when the session part is missing: the
// recipe comes back from the labels (and the document label when it is
// there); only the data bytes are gone, and every file source asks to be
// re-linked.

import type { ElementId, Mutation } from "@paged-media/plugin-api";

import {
  DATA_LABEL_KEY,
  PERSIST_KEYS,
  labelData,
  mergeLabel,
  oidOfSelector,
  oidSelector,
} from "../../data-host-model/src";

/** One binding definition as the engine payload carries it. */
export interface BindingJson {
  id: string;
  kind: string;
  query?: string;
  target?: unknown;
  [k: string]: unknown;
}

/** The engine payload (`DocumentPayload`) as JSON. */
export interface PayloadJson {
  sources?: { id: string; [k: string]: unknown }[];
  queries?: { id: string; [k: string]: unknown }[];
  templates?: unknown[];
  bindings?: BindingJson[];
  variables?: unknown;
  locales?: Record<string, unknown>;
}

/** The session facts only the host knows, by binding id. */
export interface HostFacts {
  /** Property bindings carried by an element: binding → oid. */
  hostOids: ReadonlyMap<string, string>;
  /** …and its element while the session knows it (before its label exists). */
  hostElements?: ReadonlyMap<string, ElementId>;
  visibility: ReadonlyMap<string, { elementId: string; kind?: string }>;
  image: ReadonlyMap<string, { elementId: string; fit?: string }>;
  barcode: ReadonlyMap<string, { elementId: string }>;
  /** Tables / record flows: the frame they were lowered into. */
  lowered: ReadonlyMap<string, ElementId>;
  /** Variables and rules: the text frame their story starts in. */
  storyHosted: ReadonlyMap<string, { frame: string; extra?: unknown }>;
}

/** A page item and our label on it. */
export interface LabelledElement {
  element: ElementId;
  data: Record<string, unknown> | null;
}

/** The engine's cap on one label value is 64 KiB; stay under it. */
export const LABEL_BUDGET = 60 * 1024;

type TreeNode = {
  id?: ElementId | null;
  children?: readonly TreeNode[];
  pluginMetadata?: readonly { key: string; value: string }[];
};

/** Every page item with our label decoded (one tree read). */
export function labelledElements(tree: readonly TreeNode[]): LabelledElement[] {
  const out: LabelledElement[] = [];
  const walk = (nodes: readonly TreeNode[]) => {
    for (const n of nodes) {
      if (n.id && typeof n.id.id === "string") {
        const entry = n.pluginMetadata?.find((m) => m.key === DATA_LABEL_KEY);
        out.push({ element: n.id, data: labelData(entry?.value) });
      }
      if (n.children) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/** A fresh stable object id. */
export function mintOid(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return `pd-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const HOST = "$host";

/** The binding as its element's label carries it: targets relative. */
function relative(b: BindingJson, oid: string | null): BindingJson {
  if (b.kind === "property") {
    const sel = (b.target as { selector?: string } | null)?.selector;
    return sel && oid && oidOfSelector(sel) === oid ? { ...b, target: "host" } : b;
  }
  if (b.kind === "visibility" || b.kind === "barcode") return { ...b, target: HOST };
  if (b.kind === "table") return { ...b, region: HOST };
  return b;
}

/** The element a binding is carried by (its raw `Self`), or null (document scope). */
function hostElementOf(b: BindingJson, facts: HostFacts, byOid: ReadonlyMap<string, LabelledElement>): ElementId | null {
  switch (b.kind) {
    case "property": {
      const oid = facts.hostOids.get(b.id);
      return (oid ? byOid.get(oid)?.element : undefined) ?? facts.hostElements?.get(b.id) ?? null;
    }
    case "visibility": {
      const t = facts.visibility.get(b.id);
      return t ? ({ kind: t.kind ?? "rectangle", id: t.elementId } as ElementId) : null;
    }
    case "image": {
      const t = facts.image.get(b.id);
      return t ? ({ kind: "rectangle", id: t.elementId } as ElementId) : null;
    }
    case "barcode": {
      const t = facts.barcode.get(b.id);
      return t ? ({ kind: "rectangle", id: t.elementId } as ElementId) : null;
    }
    case "table":
    case "recordFlow":
      return facts.lowered.get(b.id) ?? null;
    case "variable":
    case "rule": {
      const t = facts.storyHosted.get(b.id);
      return t ? ({ kind: "textFrame", id: t.frame } as ElementId) : null;
    }
    default:
      return null;
  }
}

function extraOf(b: BindingJson, facts: HostFacts): unknown {
  switch (b.kind) {
    case "visibility":
      return facts.visibility.get(b.id)?.kind ? { kind: facts.visibility.get(b.id)!.kind } : undefined;
    case "image":
      return facts.image.get(b.id)?.fit ? { fit: facts.image.get(b.id)!.fit } : undefined;
    case "variable":
    case "rule":
      return facts.storyHosted.get(b.id)?.extra;
    default:
      return undefined;
  }
}

const sameId = (a: ElementId, b: ElementId) => a.id === b.id;

/** What a label sync writes: the ops, and what did not fit. */
export interface LabelPlan {
  ops: Mutation[];
  /** `binding → reason` it is carried by the document label only. */
  documentOnly: Record<string, string>;
  /** Elements (raw ids) whose oid was minted now, by binding. */
  oids: Record<string, string>;
}

/**
 * The label writes that make the document carry `payload`: each page-item
 * hosted binding in its element's label (with the queries and sources it
 * reads), stale entries removed. Pure — `elements` is one tree read.
 */
export function planLabels(
  payload: PayloadJson,
  facts: HostFacts,
  elements: readonly LabelledElement[],
): LabelPlan {
  const plan: LabelPlan = { ops: [], documentOnly: {}, oids: {} };
  const byOid = new Map<string, LabelledElement>();
  for (const e of elements) {
    const oid = e.data?.oid;
    if (typeof oid === "string") byOid.set(oid, e);
  }
  const queries = new Map((payload.queries ?? []).map((q) => [q.id, q]));
  const sources = payload.sources ?? [];
  // element raw id → its patch
  const patches = new Map<string, { element: ElementId; patch: Record<string, unknown> }>();
  for (const b of payload.bindings ?? []) {
    const el = hostElementOf(b, facts, byOid);
    if (!el || typeof el.id !== "string") {
      plan.documentOnly[b.id] = "its target is not a page item";
      continue;
    }
    const current = elements.find((e) => sameId(e.element, el));
    if (!current) {
      plan.documentOnly[b.id] = `its element ${el.id} is not in the document`;
      continue;
    }
    let entry = patches.get(el.id);
    if (!entry) {
      const oid =
        typeof current.data?.oid === "string"
          ? (current.data.oid as string)
          : (b.kind === "property" ? facts.hostOids.get(b.id) : undefined) ?? mintOid();
      entry = { element: current.element, patch: { oid, bind: [], queries: [], sources: [], extra: {} } };
      patches.set(el.id, entry);
    }
    const p = entry.patch as { oid: string; bind: BindingJson[]; queries: unknown[]; sources: unknown[]; extra: Record<string, unknown> };
    p.bind.push(relative(b, p.oid));
    const q = b.query ? queries.get(b.query) : undefined;
    if (q && !p.queries.includes(q)) p.queries.push(q);
    // The sources a query reads: every source whose name its SQL mentions.
    const sql = typeof q?.sql === "string" ? q.sql : "";
    for (const s of sources) {
      if (!p.sources.includes(s) && new RegExp(`\\b${s.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(sql)) {
        p.sources.push(s);
      }
    }
    const extra = extraOf(b, facts);
    if (extra !== undefined) p.extra[b.id] = extra;
  }
  for (const e of elements) {
    if (typeof e.element.id !== "string") continue;
    const entry = patches.get(e.element.id);
    let patch = entry?.patch ?? null;
    if (patch) {
      if (Object.keys(patch.extra as object).length === 0) delete patch.extra;
      // Over budget: the queries and sources stay in the document label.
      if ((mergeLabel(e.data, patch) ?? "").length > LABEL_BUDGET) {
        patch = { ...patch, queries: [], sources: [] };
      }
      if ((mergeLabel(e.data, patch) ?? "").length > LABEL_BUDGET) {
        for (const b of patch.bind as BindingJson[]) plan.documentOnly[b.id] = "its label would pass the 64 KiB cap";
        patch = null;
      }
    }
    const hadOurs = e.data !== null && PERSIST_KEYS.some((k) => k in e.data!);
    if (!patch && !hadOurs) continue;
    const before = e.data ? Object.fromEntries(PERSIST_KEYS.filter((k) => k in e.data!).map((k) => [k, e.data![k]])) : {};
    if (patch && JSON.stringify(before) === JSON.stringify(patch)) continue;
    const value = mergeLabel(e.data, patch);
    plan.ops.push({
      op: "setPluginMetadata",
      args: { elementId: e.element, key: DATA_LABEL_KEY, value },
    } as Mutation);
    if (patch) for (const b of patch.bind as BindingJson[]) plan.oids[b.id] = patch.oid as string;
  }
  return plan;
}

/** What the labels give back. */
export interface RestoredRecipe {
  payload: PayloadJson;
  /** The host facts, with every target pointing at today's ids. */
  facts: {
    hostOids: Map<string, string>;
    visibility: Map<string, { elementId: string; kind?: string }>;
    image: Map<string, { elementId: string; fit?: string }>;
    barcode: Map<string, { elementId: string }>;
    lowered: Map<string, ElementId>;
    /** Variables and rules: the frame their story starts in, and the extra. */
    storyHosted: Map<string, { frame: string; extra?: unknown }>;
  };
  /** How many bindings came from element labels. */
  fromElements: number;
}

/**
 * Rebuild the recipe from the document: the document label's recipe (when
 * present), then every element label (the element's copy of a binding wins:
 * it is the one whose target is known today).
 */
export function restoreFromLabels(
  elements: readonly LabelledElement[],
  documentRecipe: PayloadJson | null,
): RestoredRecipe {
  const payload: PayloadJson = {
    sources: [...(documentRecipe?.sources ?? [])],
    queries: [...(documentRecipe?.queries ?? [])],
    templates: [...(documentRecipe?.templates ?? [])],
    bindings: [...(documentRecipe?.bindings ?? [])],
    ...(documentRecipe?.variables ? { variables: documentRecipe.variables } : {}),
    ...(documentRecipe?.locales ? { locales: documentRecipe.locales } : {}),
  };
  const facts: RestoredRecipe["facts"] = {
    hostOids: new Map(),
    visibility: new Map(),
    image: new Map(),
    barcode: new Map(),
    lowered: new Map(),
    storyHosted: new Map(),
  };
  const upsert = <T extends { id: string }>(list: T[], item: T) => {
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) list[i] = item;
    else list.push(item);
  };
  let fromElements = 0;
  for (const e of elements) {
    const d = e.data;
    if (!d || !Array.isArray(d.bind) || typeof e.element.id !== "string") continue;
    const raw = e.element.id;
    const oid = typeof d.oid === "string" ? d.oid : null;
    const extra = (d.extra && typeof d.extra === "object" ? d.extra : {}) as Record<string, Record<string, unknown> | undefined>;
    for (const s of (Array.isArray(d.sources) ? d.sources : []) as { id: string }[]) {
      if (!payload.sources!.some((x) => x.id === s.id)) payload.sources!.push(s);
    }
    for (const q of (Array.isArray(d.queries) ? d.queries : []) as { id: string }[]) {
      if (!payload.queries!.some((x) => x.id === q.id)) payload.queries!.push(q);
    }
    for (const b0 of d.bind as BindingJson[]) {
      let b: BindingJson = b0;
      if (b.kind === "property" && b.target === "host" && oid) {
        b = { ...b, target: { selector: oidSelector(oid) } };
        facts.hostOids.set(b.id, oid);
      } else if (b.kind === "visibility" || b.kind === "barcode") {
        b = { ...b, target: raw };
        if (b.kind === "visibility") {
          const kind = extra[b.id]?.kind;
          facts.visibility.set(b.id, { elementId: raw, kind: typeof kind === "string" ? kind : e.element.kind });
        } else {
          facts.barcode.set(b.id, { elementId: raw });
        }
      } else if (b.kind === "image") {
        const fit = extra[b.id]?.fit;
        facts.image.set(b.id, { elementId: raw, ...(typeof fit === "string" ? { fit } : {}) });
      } else if (b.kind === "table") {
        b = { ...b, region: raw };
        facts.lowered.set(b.id, e.element);
      } else if (b.kind === "recordFlow") {
        facts.lowered.set(b.id, e.element);
      } else if (b.kind === "variable" || b.kind === "rule") {
        facts.storyHosted.set(b.id, { frame: raw, extra: extra[b.id] });
      }
      upsert(payload.bindings!, b);
      fromElements++;
    }
  }
  return { payload, facts, fromElements };
}

/** The file sources of a restored recipe (whose bytes must be re-linked). */
export function sourcesToRelink(payload: PayloadJson): { id: string; file: string | null; remote: boolean }[] {
  return (payload.sources ?? []).map((s) => {
    const kind = s.kind as { kind?: string; name?: string; url?: string } | undefined;
    return {
      id: s.id,
      file: kind?.kind === "file" ? (kind.name ?? null) : null,
      remote: kind?.kind === "remote",
    };
  });
}
