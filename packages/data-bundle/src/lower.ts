// The page lower — the ONLY place the bundle calls host.document.mutate. The
// engine (Rust) resolves + lowers to the IR; the host-model translator (pure)
// shapes the mutations; this drives the host writes. The table path lowers to a
// NATIVE table via the `insertTable` op (D-02 retired); if the host is too old
// to support it, it degrades to the spec §2.2 fallback (tab-aligned text +
// drawn rules) into the same frame.

import type { BundleHost, ElementId, Mutation, PageId } from "@paged-media/plugin-api";
import {
  bindingMetadata,
  defaultPlacement,
  makeEnvelope,
  tableCellInserts,
  tableInsertMutation,
  tableInsertSpec,
  type ImageReference,
  type LoweredImage,
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

/** The string table id from an `insertTable` outcome's created element. The
 *  platform's ElementId/table-address shape is in flight (the table-content
 *  rework), so the id may be a plain string or a `{ table_id }` locator —
 *  handle both until it settles. Returns "" when neither shape is present. */
function tableIdOf(created: ElementId): string {
  const id = created.id as unknown;
  if (typeof id === "string") return id;
  if (id && typeof id === "object" && "table_id" in id) {
    return String((id as { table_id: unknown }).table_id);
  }
  return "";
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
  const [top, left] = placement.bounds;

  // Phase 1 — the frame (both the native + degraded paths attach to its story).
  const frameOutcome = await host.document.mutate({
    op: "insertTextFrame",
    args: { pageId, bounds: placement.bounds },
  });
  if (!frameOutcome.applied || !frameOutcome.createdId) {
    host.log.warn("lower: insertTextFrame rejected");
    return null;
  }
  const createdFrame = frameOutcome.createdId;
  const frameId = frameIdOf(createdFrame);
  if (!frameId) {
    host.log.warn("lower: created element is not a frame target");
    return null;
  }

  // Resolve the new frame's story via the hitTest read door.
  const hit = await host.document.hitTest(pageId, center(placement.bounds));
  const storyId = hit?.storyId ?? null;
  if (!storyId) {
    host.log.warn("lower: could not resolve the created frame's story");
    return frameId;
  }

  // Phase 2 — NATIVE: insert the table, then fill its cells by (tableId,row,col).
  const tableOutcome = await host.document.mutate(tableInsertMutation(storyId, tableInsertSpec(table)));
  const tableId = tableOutcome.applied && tableOutcome.createdId ? tableIdOf(tableOutcome.createdId) : "";
  if (tableId) {
    const cells = tableCellInserts(table, storyId, tableId);
    if (cells.length > 0) {
      const filled = await host.document.mutate({ op: "batch", args: { ops: cells } });
      if (!filled.applied) host.log.warn("lower: native table cell fill rejected");
    }
    await host.document.mutate(bindingMetadata(createdFrame, envelope));
    await host.selection.set([createdFrame]);
    return frameId;
  }

  // FALLBACK — the host has no `insertTable`: the §2.2 degradation (tab-aligned
  // text + drawn rules) poured into the SAME frame (D-02 fallback).
  host.log.info("lower: insertTable unsupported — degrading to tab-text + drawn rules (D-02)");
  const ruleOps: Mutation[] = table.rules.map((r) => ({
    op: "insertLine",
    args: {
      pageId,
      start: [left + r.x1Pt, top + r.y1Pt] as [number, number],
      end: [left + r.x2Pt, top + r.y2Pt] as [number, number],
    },
  }));
  if (ruleOps.length > 0) await host.document.mutate({ op: "batch", args: { ops: ruleOps } });
  if (table.text.length > 0) {
    await host.document.mutate({ op: "insertText", args: { storyId, offset: 0, text: table.text } });
  }
  await host.document.mutate(bindingMetadata(createdFrame, envelope));
  await host.selection.set([createdFrame]);
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

/** A short human description of a resolved image reference. */
function describeRef(r: ImageReference): string {
  switch (r.ref) {
    case "uri":
      return r.uri;
    case "path":
      return r.path;
    case "assetId":
      return `asset:${r.id}`;
    case "bytes":
      return `<${r.bytes.length} bytes>`;
    case "none":
      return "(none)";
  }
}

/** "Commit" a lowered image (§9.2). The engine resolved + classified the
 *  reference and applied the missing policy; the actual placement into the
 *  target frame goes through the core asset mechanism — but there is no
 *  asset-placement Mutation yet (BREAKAGE D-14), so M0 records the binding
 *  honestly and defers placement (never faked, never routed through
 *  plugin-image, §2.1). */
export async function commitLoweredImage(
  host: BundleHost,
  image: LoweredImage,
): Promise<void> {
  if (image.status !== "present") {
    host.log.info(`image "${image.target}": ${image.status} (missing policy applied)`);
    return;
  }
  host.log.info(
    `image "${image.target}" resolved to ${describeRef(image.reference)} ` +
      `(fit: ${image.fit}); placement into the target frame awaits the ` +
      "asset-placement op (D-14)",
  );
}
