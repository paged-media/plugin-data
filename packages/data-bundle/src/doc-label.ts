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

import { BINDING_KEY } from "../../data-host-model/src";

/** The folder session versions are written to (under `paged/media.paged.data/`). */
export const SESSION_VERSION_DIR = "sessions/";

/** The label envelope's version. */
export const LABEL_VERSION = 1;

/** The part one session version is written to. */
export function sessionVersionPath(hash: string): string {
  return `${SESSION_VERSION_DIR}${hash}.json`;
}

/** The label that names session version `hash`. */
export function labelEnvelope(hash: string): { v: number; data: { session: string } } {
  return { v: LABEL_VERSION, data: { session: hash } };
}

/** The raw op that writes the label (the SDK gates the key to this plugin). */
export function labelMutation(hash: string): Mutation {
  return {
    op: "setDocumentMetadata",
    args: { key: BINDING_KEY, value: JSON.stringify(labelEnvelope(hash)) },
  } as unknown as Mutation;
}

/** The session version a label envelope names, or null. */
export function labelledVersion(envelope: unknown): string | null {
  const data = (envelope as { data?: { session?: unknown } } | null)?.data;
  return typeof data?.session === "string" && /^[0-9a-f]{8,64}$/.test(data.session) ? data.session : null;
}

/** Where the rider reads the label to carry and reports what it wrote. */
export interface LabelRiderState {
  /** The version to label with the next document write, or null. */
  pending(): string | null;
  /** The write carrying `hash` was applied. */
  written(hash: string): void;
  /** The engine refused the label op itself: stop riding. */
  refused(): void;
}

const BATCH_CHILD = /Batch child (\d+)/;

/** Single ops the rider may wrap in a batch with the label: field writes,
 *  whose callers read nothing but `applied` (a one-field refresh, a field
 *  placed at the caret). Any other single op is sent as it is. */
const WRAPPABLE = new Set(["setFieldValue", "insertField"]);

/**
 * The host the session uses: `host` with `document.mutate` carrying the
 * pending label as the last child of every batch (and of a single field
 * write, wrapped). A batch refused at the label child is sent again without
 * it, and the rider stops. A wrapped single op refused for its own reason is
 * sent again alone, so its caller sees the op's own error.
 */
export function labelRider(host: BundleHost, state: LabelRiderState): BundleHost {
  const doc = host.document;
  const mutate = async (m: Mutation): Promise<MutationOutcome> => {
    const hash = state.pending();
    const single = m.op !== "batch";
    if (!hash || (single && !WRAPPABLE.has(m.op))) return doc.mutate(m);
    const ops = single ? [m] : (m.args as { ops: Mutation[] }).ops;
    const outcome = await doc.mutate({ op: "batch", args: { ops: [...ops, labelMutation(hash)] } } as Mutation);
    if (outcome.applied) {
      state.written(hash);
      return outcome;
    }
    const child = BATCH_CHILD.exec(errorText(outcome.error));
    const atLabel = !!child && Number(child[1]) === ops.length;
    if (atLabel) state.refused();
    return atLabel || single ? doc.mutate(m) : outcome;
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
