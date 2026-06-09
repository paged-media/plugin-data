// The page lower — the ONLY place the bundle calls host.document.mutate. The
// engine (Rust) resolves + lowers to the IR; the host-model translator (pure)
// shapes the mutations; this drives the host writes. Two-phase for the table
// path (mirrors plugin-sheet S-03 / BREAKAGE D-02): no `insertTable` op, and
// `insertText` keys off a `storyId` that exists only AFTER the frame is created.

import type { BundleHost, ElementId, PageId } from "@paged-media/plugin-api";
import {
  defaultPlacement,
  makeEnvelope,
  tableToMutations,
  type LoweredTable,
  type LoweredVariable,
} from "@paged-media/data-host-model";

/** The frame center, page-local pt, from `[top, left, bottom, right]`. */
function center(bounds: [number, number, number, number]): [number, number] {
  const [top, left, bottom, right] = bounds;
  return [(left + right) / 2, (top + bottom) / 2];
}

/** The active page id (meta first, else the first page). */
async function activePageId(host: BundleHost): Promise<PageId | null> {
  const meta = await host.document.meta();
  if (meta.activePage) return meta.activePage;
  const pages = await host.document.collection<{ selfId: string }>("pages");
  return pages.length > 0 ? (pages[0].selfId as unknown as PageId) : null;
}

/** Raw frame id from a created ElementId. */
function frameIdOf(id: ElementId): string | null {
  if (id.kind === "textFrame" || id.kind === "rectangle") return id.id as string;
  return null;
}

/** Commit a lowered dynamic table to a fresh page frame (the degraded tab-text +
 *  rules path, D-02). Returns the created frame's id, or null on any failure
 *  (mutate-never-throws: outcomes are checked, not caught). */
export async function commitLoweredTable(
  host: BundleHost,
  table: LoweredTable,
): Promise<string | null> {
  const pageId = await activePageId(host);
  if (!pageId) {
    host.log.warn("lower: no page to place the data table into");
    return null;
  }
  const placement = defaultPlacement(pageId, table.bounds);
  const envelope = makeEnvelope({ kind: "table", region: table.region });
  const { batch, text } = tableToMutations(table, placement, envelope);

  // Phase 1 — frame + rules + binding, one undoable batch.
  const outcome = await host.document.mutate(batch);
  if (!outcome.applied || !outcome.createdId) {
    host.log.warn("lower: phase-1 batch rejected");
    return null;
  }
  const frameId = frameIdOf(outcome.createdId);
  if (!frameId) {
    host.log.warn("lower: created element is not a frame target");
    return null;
  }

  // Phase 2 — resolve the new frame's story via the hitTest read door, then
  // pour the tab/newline text.
  if (text.length > 0) {
    const hit = await host.document.hitTest(pageId, center(placement.bounds));
    const storyId = hit?.storyId ?? null;
    if (!storyId) {
      host.log.warn("lower: could not resolve the created frame's story (D-02 phase-2 gap)");
      return frameId;
    }
    const pour = await host.document.mutate({
      op: "insertText",
      args: { storyId, offset: 0, text },
    });
    if (!pour.applied) host.log.warn("lower: phase-2 insertText rejected");
  }

  await host.selection.set([outcome.createdId]);
  return frameId;
}

/** "Commit" a lowered variable. At M0 there is no tagged-placeholder content
 *  model (BREAKAGE D-01), so in-text replacement is not yet expressible — the
 *  value resolves (the panel shows it) but placement is honestly deferred,
 *  never faked. */
export async function commitLoweredVariable(
  host: BundleHost,
  variable: LoweredVariable,
): Promise<void> {
  host.log.info(
    `variable "${variable.target}" resolved to "${variable.text}"; in-text ` +
      "placement awaits the tagged-placeholder content model (D-01)",
  );
}
