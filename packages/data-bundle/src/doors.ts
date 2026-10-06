// The engine-protocol-69 doors this bundle uses when the host has them, and
// the checks that say whether it does. The types come from the contract
// (plugin-api 0.2.41); the checks stay, because a host or engine older than
// protocol 69 still loads this bundle.
//
// Every consumer works on both sides: with the door, the protocol-69 path;
// without it, what the bundle did before. A check never costs a host call when
// the SDK lacks the door (it looks at the surface with `typeof` first), so the
// count budgets measured on the published host do not move.
//
// | Door                                   | Detected by                                   | Without it                         |
// |----------------------------------------|-----------------------------------------------|------------------------------------|
// | document label (`setDocumentMetadata`) | `typeof` + `document.documentMetadata@1` + a  | the session part alone (no undo)   |
// |                                        | v69 engine (`DocumentMeta.pluginMetadata`)    |                                    |
// | `insertField.contentOffset`            | nothing: an older engine ignores the field    | the caret offset as a char offset  |
// | `documents.exportPaged` / `open`       | `typeof` + `documents.open@1` + `.exportPaged@1` | "merge to a new document" refused |
// | `text.measureStrings`                  | `typeof` + `text.measureStrings@1`            | one `measureString` per word       |
// | in-batch page handles (`$h:` page ids) | a v69 engine (as the document label)          | pages, then content: 2 undo steps  |

import type { BundleHost, DocumentsSurface, TextMetrics } from "@paged-media/plugin-api";

/** `host.document` with the protocol-69 label doors. */
export type DocumentLabelDoors = Pick<BundleHost["document"], "getDocumentMetadata" | "setDocumentMetadata">;

/** `host.documents` (D-26). */
export type DocumentsDoors = Pick<DocumentsSurface, "exportPaged" | "open">;

/** One measured string (the `TextMetrics` the host answers). */
export type MeasuredText = TextMetrics;

/** `host.text.measureStrings` (D-27). */
export type MeasureStrings = BundleHost["text"]["measureStrings"];

function supports(host: BundleHost, feature: string): boolean {
  try {
    return host.supports(feature);
  } catch {
    return false;
  }
}

/** The label doors, when the SDK forwards them. The engine may still be
 *  older than 69 — see [`engineHasDocumentLabels`]. */
export function documentLabelDoors(host: BundleHost): DocumentLabelDoors | null {
  const doc = host.document as unknown as Partial<DocumentLabelDoors> | undefined;
  if (typeof doc?.getDocumentMetadata !== "function" || typeof doc?.setDocumentMetadata !== "function") {
    return null;
  }
  if (!supports(host, "document.documentMetadata@1")) return null;
  return doc as DocumentLabelDoors;
}

/** Whether the ENGINE has document labels (protocol 69): a v69 worker always
 *  sends `DocumentMeta.pluginMetadata` (possibly empty), an older one never
 *  does. One `meta` read; only asked when the SDK has the label doors. The
 *  same engine places pages by in-batch handle. */
export async function engineHasDocumentLabels(host: BundleHost): Promise<boolean> {
  if (!documentLabelDoors(host)) return false;
  try {
    const meta = (await host.document.meta()) as { pluginMetadata?: unknown };
    return Array.isArray(meta.pluginMetadata);
  } catch {
    return false;
  }
}

/** The documents doors (D-26), when the host wired a backend. */
export function documentsDoors(host: BundleHost): DocumentsDoors | null {
  const docs = (host as unknown as { documents?: Partial<DocumentsDoors> }).documents;
  if (typeof docs?.exportPaged !== "function" || typeof docs?.open !== "function") return null;
  if (!supports(host, "documents.open@1") || !supports(host, "documents.exportPaged@1")) return null;
  return docs as DocumentsDoors;
}

/** The batch measure (D-27), when the host serves it in one round trip. */
export function measureStringsDoor(host: BundleHost): MeasureStrings | null {
  const text = host.text as unknown as { measureStrings?: MeasureStrings } | undefined;
  if (typeof text?.measureStrings !== "function") return null;
  if (!supports(host, "text.measureStrings@1")) return null;
  return text.measureStrings.bind(text);
}
