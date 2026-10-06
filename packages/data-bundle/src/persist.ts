// The data session as a `.paged` container part — the ONE schema, reader and
// writer. Everything a user defines in the panels lives in the session, and
// none of it is document content, so it persists as this plugin's own part
// (`paged/media.paged.data/session.json`, declared in the manifest as the
// `session` part type) and travels with the file.
//
// What the part holds (`PersistedSession`, v1):
//   · `engine`  — the engine's recipe exactly as `DataEngine.payload()` returns
//                 it: sources, queries, templates, bindings, the §9.9 variable
//                 set (declarations + captured data sets). Credentials are
//                 redacted by the engine before it gets here (§11/D-11).
//                 Restored with `DataEngine.load_payload`.
//   · `locale`  — the session formatting locale, a BCP 47 tag from the engine's
//                 locale table (not part of the engine recipe; per-binding
//                 overrides ARE in the recipe, as `engine.locales`).
//   · `sync`    — the user's sync decisions (pinned / overridden bindings);
//                 linked/stale/error are derived and are not saved.
//   · `targets` — what only the host knows: the rectangle an image or barcode
//                 binding fills, a visibility binding's element and kind, a
//                 rule's query and host target, and the element a table was
//                 lowered into (`lowered`), so a reopen can tell whether that
//                 element is still there and still carries this binding.
//   · `data`    — the imported file per source: CSV/TSV as text, JSON,
//                 Parquet and XLSX as bytes (base64 when inline). A small file
//                 is inline; a large one (over INLINE_DATA_MAX_BYTES) is its
//                 own content-addressed part `data/<hash>.<ext>` and the
//                 session names it by `{ hash, bytes }`, so a session rewrite
//                 never rewrites the data and two sessions with the same file
//                 share one part. An XLSX entry also names the worksheet read.
//   · `refresh` — the refresh policy per source (data-core `RefreshPolicy`),
//                 absent = manual.
//   · `remote`  — remote source descriptors (url, format, params, credential
//                 REF). They restore INERT: nothing is fetched on open (§11).
//
// Undo: `host.parts` writes are not undoable, and the session is not document
// content, so defining a binding is not an undo step either. What IS undoable
// is everything the session writes INTO the document (placed fields, tables,
// barcodes, styles, visibility) — those go through `mutate`, and the content
// they create carries this plugin's metadata label naming the binding and the
// hash of the session it was lowered under. A restore checks those labels
// against the session (see `session.ts` `restore`).

import type { ElementId } from "@paged-media/plugin-api";

import type { IdmlFit, RuleTarget, VisibilityTargetKind } from "../../data-host-model/src";
import type { ImportFormat } from "./query/import";
import type { RefreshPolicy } from "./refresh";
import type { RemoteFormat } from "./remote";

/** The part the session is written to (relative to `paged/media.paged.data/`). */
export const SESSION_PART = "session.json";
/** The folder large imported data files are written to. */
export const DATA_PART_DIR = "data/";
/** Imported text up to this many UTF-8 bytes rides inline in the session part. */
export const INLINE_DATA_MAX_BYTES = 64 * 1024;
export const SESSION_VERSION = 1;

/** A stored CSV entry. */
export type CsvData = Extract<PersistedData, { format: "csv" }>;

/** The imported formats stored as bytes (CSV and TSV are stored as text). */
export type BinaryFormat = Exclude<ImportFormat, "csv" | "tsv">;

/** The file a delimited source was imported from (shown in the Sources panel).
 *  Optional: sessions saved before it was recorded restore without a label. */
export interface CsvLabel {
  fileName?: string;
  delimiter?: "csv" | "tsv";
}

/** One imported source's data: inline, or a pointer to its own part. */
export type PersistedData =
  | ({ source: string; format: "csv"; text: string } & CsvLabel)
  | ({ source: string; format: "csv"; ref: { hash: string; bytes: number } } & CsvLabel)
  | {
      source: string;
      format: BinaryFormat;
      fileName: string;
      sheet?: string;
      base64: string;
    }
  | {
      source: string;
      format: BinaryFormat;
      fileName: string;
      sheet?: string;
      ref: { hash: string; bytes: number };
    };

export interface PersistedRemote {
  name: string;
  url: string;
  format: RemoteFormat;
  params: Record<string, string>;
  credentialRef?: string;
}

export interface PersistedTargets {
  image: Record<string, { elementId: string; fit?: IdmlFit }>;
  barcode: Record<string, { elementId: string }>;
  visibility: Record<string, { elementId: string; kind?: VisibilityTargetKind }>;
  rule: Record<string, { query: string; target: RuleTarget }>;
  /** The element each table / record-flow binding was last lowered into. */
  lowered: Record<string, ElementId>;
}

export interface PersistedSession {
  v: typeof SESSION_VERSION;
  engine: unknown;
  locale: string;
  sync: { binding: string; status: "pinned" | "overridden" }[];
  targets: PersistedTargets;
  data: PersistedData[];
  remote: PersistedRemote[];
  /** Refresh policy per source; a source not named here is manual. Absent
   *  in a part written before wave 6 (decodeSession fills it). */
  refresh?: Record<string, RefreshPolicy>;
}

export function emptyTargets(): PersistedTargets {
  return { image: {}, barcode: {}, visibility: {}, rule: {}, lowered: {} };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Hex SHA-256 of `bytes`, shortened to 32 hex chars (128 bits) — a content
 *  address, not a security boundary. */
export async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** The part a stored file is written to (`data/<hash>.<ext>`). */
export function dataPartPath(hash: string, format: "csv" | BinaryFormat = "csv"): string {
  return `${DATA_PART_DIR}${hash}.${format}`;
}

/** The part path a persisted entry points at, or null when it is inline. */
export function dataPartOf(d: PersistedData): string | null {
  return "ref" in d ? dataPartPath(d.ref.hash, d.format) : null;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Store one imported binary file (JSON, Parquet, XLSX): inline as base64
 *  when small, else as a content-addressed part written once. */
export async function storeFile(
  source: string,
  format: BinaryFormat,
  fileName: string,
  bytes: Uint8Array,
  sheet: string | undefined,
  writePart: (path: string, bytes: Uint8Array) => Promise<void>,
  known: Set<string>,
): Promise<PersistedData> {
  const head = { source, format, fileName, ...(sheet !== undefined ? { sheet } : {}) };
  if (bytes.length <= INLINE_DATA_MAX_BYTES) return { ...head, base64: toBase64(bytes) };
  const hash = await contentHash(bytes);
  const path = dataPartPath(hash, format);
  if (!known.has(path)) {
    await writePart(path, bytes);
    known.add(path);
  }
  return { ...head, ref: { hash, bytes: bytes.length } };
}

/** Read one stored binary file back, or `null` when its part is missing. */
export async function loadFile(
  d: PersistedData,
  readPart: (path: string) => Promise<Uint8Array | null>,
): Promise<Uint8Array | null> {
  if ("base64" in d) return fromBase64(d.base64);
  if ("text" in d) return encoder.encode(d.text);
  return readPart(dataPartPath(d.ref.hash, d.format));
}

/** Decide how one imported text is stored: inline when small, else as a
 *  content-addressed part (`write` is only called for a part not yet known). */
export async function storeData(
  source: string,
  text: string,
  writePart: (path: string, bytes: Uint8Array) => Promise<void>,
  known: Set<string>,
): Promise<CsvData> {
  const bytes = encoder.encode(text);
  if (bytes.length <= INLINE_DATA_MAX_BYTES) return { source, format: "csv", text };
  const hash = await contentHash(bytes);
  const path = dataPartPath(hash);
  if (!known.has(path)) {
    await writePart(path, bytes);
    known.add(path);
  }
  return { source, format: "csv", ref: { hash, bytes: bytes.length } };
}

/** Read one stored source's text back, or `null` when its part is missing. */
export async function loadData(
  d: CsvData,
  readPart: (path: string) => Promise<Uint8Array | null>,
): Promise<string | null> {
  if ("text" in d) return d.text;
  const bytes = await readPart(dataPartPath(d.ref.hash));
  return bytes ? decoder.decode(bytes) : null;
}

export function encodeSession(s: PersistedSession): Uint8Array {
  return encoder.encode(JSON.stringify(s));
}

/** Parse a session part. Returns the session, or a reason it cannot be used. */
export function decodeSession(bytes: Uint8Array): PersistedSession | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch (err) {
    return { error: `the saved data session is not valid JSON (${String(err)})` };
  }
  if (!parsed || typeof parsed !== "object") return { error: "the saved data session is empty" };
  const v = (parsed as { v?: unknown }).v;
  if (v !== SESSION_VERSION) {
    return {
      error:
        typeof v === "number" && v > SESSION_VERSION
          ? `the saved data session is version ${v}; this plugin reads version ${SESSION_VERSION} — update the plugin`
          : "the saved data session has no version",
    };
  }
  const p = parsed as Partial<PersistedSession>;
  return {
    v: SESSION_VERSION,
    engine: p.engine ?? null,
    // Any tag: the engine knows its locale table, and refuses a tag it lacks
    // when the session applies it (reported then, not silently changed here).
    locale: typeof p.locale === "string" && p.locale !== "" ? p.locale : "en",
    sync: Array.isArray(p.sync) ? p.sync : [],
    targets: { ...emptyTargets(), ...(p.targets ?? {}) },
    data: Array.isArray(p.data) ? p.data : [],
    remote: Array.isArray(p.remote) ? p.remote : [],
    refresh: p.refresh && typeof p.refresh === "object" ? p.refresh : {},
  };
}
