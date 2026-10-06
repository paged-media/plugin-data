// The session's version, named in the document's own label (engine protocol
// 69, `setDocumentMetadata`), so the saved session follows undo.
//
// Container parts take no part in undo. So each version of the session is
// written ONCE as a content-addressed part (`sessions/<hash>.json`), and the
// document label, which IS undoable, names the version that is live. The label
// rides the batch of the document write that made the session change (a
// lower, a field refresh, a merge), so that write and the session it was made
// under are one undo step. A session change no document write carries (a
// binding defined, a source imported) is labelled on save.
//
// Undoing a write takes the label back with it. The session sees the label
// change and reloads the version it names; a reopened document restores the
// version its label names. `session.json` is still written with every change:
// it is what a host without document labels (and this plugin before them)
// reads.

import type { BundleHost, Mutation, MutationOutcome } from "@paged-media/plugin-api";

import { BINDING_KEY, asciiJson } from "../../data-host-model/src";

/** The folder session versions are written to (under `paged/media.paged.data/`). */
export const SESSION_VERSION_DIR = "sessions/";

/** The label envelope's version. */
export const LABEL_VERSION = 1;

/** The part one session version is written to. */
export function sessionVersionPath(hash: string): string {
  return `${SESSION_VERSION_DIR}${hash}.json`;
}

/** The label that names session version `hash`. */
export function labelEnvelope(hash: string, recipe?: unknown): { v: number; data: { session: string; recipe?: unknown } } {
  return { v: LABEL_VERSION, data: { session: hash, ...(recipe ? { recipe } : {}) } };
}

/** The document label's room for the recipe (ADR 559 point 4): the engine
 *  caps a label value at 64 KiB. A recipe over it drops its captured data
 *  sets first, then rides without a recipe (the part still has it). */
export const RECIPE_BUDGET = 56 * 1024;

/** The recipe the document label carries, fitted to the budget, or null. */
export function fitRecipe(payload: unknown): unknown | null {
  if (!payload || typeof payload !== "object") return null;
  if (asciiJson(payload).length <= RECIPE_BUDGET) return payload;
  const p = payload as { variables?: { dataSets?: unknown[] } };
  const lean = p.variables ? { ...p, variables: { ...p.variables, dataSets: [] } } : p;
  return asciiJson(lean).length <= RECIPE_BUDGET ? lean : null;
}

/** The raw op that writes the label. The key is the calling plugin's own
 *  (`x-paged:<manifest id>`, the key `getDocumentMetadata` reads); the SDK
 *  refuses any other. */
export function labelMutation(hash: string, key: string = BINDING_KEY, recipe?: unknown): Mutation {
  return {
    op: "setDocumentMetadata",
    args: { key, value: asciiJson(labelEnvelope(hash, recipe)) },
  } as unknown as Mutation;
}

/** The label key of `host`'s plugin. */
export function labelKey(host: BundleHost): string {
  const id = (host as { manifest?: { id?: string } }).manifest?.id;
  return id ? `x-paged:${id}` : BINDING_KEY;
}

/** The session version a label envelope names, or null. */
export function labelledVersion(envelope: unknown): string | null {
  const data = (envelope as { data?: { session?: unknown } } | null)?.data;
  return typeof data?.session === "string" && /^[0-9a-f]{8,64}$/.test(data.session) ? data.session : null;
}

/** The session part with the label it extends: `session.json` records the
 *  version the document's label named when the part was written (`base`).
 *  A reopen whose label still names `base` reads the part (it holds the
 *  changes made since); one whose label names another version (an undo or
 *  redo moved it) reads that version. So a change no document write carried
 *  needs no label step of its own. */
export function withBase(versionJson: string, base: string | null): string {
  return base === null ? versionJson : `${versionJson.slice(0, -1)},"base":${JSON.stringify(base)}}`;
}

/** The `base` a session part records, and the version bytes without it. */
export function splitBase(bytes: Uint8Array): { base: string | null; version: Uint8Array } {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || !("base" in parsed)) return { base: null, version: bytes };
    const base = typeof parsed.base === "string" ? parsed.base : null;
    delete parsed.base;
    return { base, version: new TextEncoder().encode(JSON.stringify(parsed)) };
  } catch {
    return { base: null, version: bytes };
  }
}

/** Where the rider reads the label to carry and reports what it wrote. */
export interface LabelRiderState {
  /** The version to label with the next document write, or null. */
  pending(): string | null;
  /** The write carrying `hash` was applied. */
  written(hash: string): void;
  /** The engine refused the label op itself: stop riding. */
  refused(): void;
  /** The document-scope recipe to carry with the label (ADR 559), or null. */
  recipe?(): unknown;
}

const BATCH_CHILD = /Batch child (\d+)/;

/** Single ops the rider may wrap in a batch with the label: field writes,
 *  whose callers read nothing but `applied` (a one-field refresh, a field
 *  placed at the caret, a text variable's contents `set` — protocol 71). Any
 *  other single op is sent as it is. */
const WRAPPABLE = new Set(["setFieldValue", "insertField", "set"]);

/**
 * The host the session uses: `host` with `document.mutate` carrying the
 * pending label as the last child of every batch (and of a single field
 * write, wrapped). A write refused with the label is sent again without it:
 * if it then applies, the label was what was refused and the rider stops;
 * if not, the caller gets the write's own error and the label stays pending.
 */
export function labelRider(host: BundleHost, state: LabelRiderState): BundleHost {
  const doc = host.document;
  const key = labelKey(host);
  const mutate = async (m: Mutation): Promise<MutationOutcome> => {
    const hash = state.pending();
    const single = m.op !== "batch";
    if (!hash || (single && !WRAPPABLE.has(m.op))) return doc.mutate(m);
    const ops = single ? [m] : (m.args as { ops: Mutation[] }).ops;
    const outcome = await doc.mutate({ op: "batch", args: { ops: [...ops, labelMutation(hash, key, state.recipe?.() ?? undefined)] } } as Mutation);
    if (outcome.applied) {
      state.written(hash);
      return outcome;
    }
    // A batch the engine rolled back at an earlier child failed on its own.
    const child = BATCH_CHILD.exec(errorText(outcome.error));
    if (!single && child && Number(child[1]) < ops.length) return outcome;
    const bare = await doc.mutate(m);
    if (bare.applied) state.refused();
    return bare;
  };
  // A host without a document surface (a headless or partial one) is used
  // as it is.
  if (!doc || typeof doc !== "object") return host;
  const document = new Proxy(doc, {
    get(target, prop, receiver) {
      if (prop === "mutate") return mutate;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return new Proxy(host, {
    get(target, prop, receiver) {
      if (prop === "document") return document;
      return Reflect.get(target, prop, receiver);
    },
  });
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error) ?? "";
  } catch {
    return String(error);
  }
}
