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

// Update in place (campaign Wave 5): what a re-lower must remove or reuse so
// it REPLACES the content an earlier lowering made instead of minting a
// duplicate beside it. Pure: the scene tree (with every item's plugin
// metadata, one read) and what the session remembers go in; the mutations
// that clear the old content and the frame to write into come out.
//
// Content is found two ways, and both count:
//
// - its LABEL — the binding envelope (`x-paged:media.paged.data`) a lowering
//   writes onto what it creates: a table's frame, a merge's frames, the last
//   module of a barcode;
// - the session's record of what a lowering MINTED (`MutationOutcome.minted`),
//   which names every module of a barcode, not only the labelled one.
//
// A table's frame is REUSED (the new table goes into the same story, where the
// user may have moved or resized it); every further labelled frame of the same
// binding is a duplicate from an older lowering and is removed. Barcode
// modules, record-flow frames and merged frames are removed and drawn again.
// Pages a merge added are removed when nothing else is left on them.

import type { ElementId, Mutation, PageId } from "@paged-media/plugin-api";

import { BINDING_KEY, parseEnvelope } from "../../data-host-model/src";

type TreeNode = {
  kind: string;
  id?: ElementId | null;
  children?: readonly TreeNode[];
  pluginMetadata?: readonly { key: string; value: string }[];
};

/** One page item, with the page it sits on (document order) and its label. */
export interface RecordedElement {
  element: ElementId;
  page: number;
  /** The envelope's `data`, or null when the item carries no label of ours. */
  data: Record<string, unknown> | null;
}

/** Every page item of the document in page order, with our label decoded. */
export function documentElements(tree: readonly TreeNode[], key: string = BINDING_KEY): RecordedElement[] {
  const out: RecordedElement[] = [];
  let page = -1;
  const items = (nodes: readonly TreeNode[]) => {
    for (const n of nodes) {
      if (n.id) {
        const entry = n.pluginMetadata?.find((m) => m.key === key);
        const env = entry ? parseEnvelope(entry.value) : null;
        const data = env && env.data && typeof env.data === "object" ? (env.data as Record<string, unknown>) : null;
        out.push({ element: n.id, page, data });
      }
      if (n.children) items(n.children);
    }
  };
  const walk = (nodes: readonly TreeNode[]) => {
    for (const n of nodes) {
      if (n.kind === "Page") {
        page += 1;
        items(n.children ?? []);
      } else if (n.children) {
        walk(n.children);
      }
    }
  };
  walk(tree);
  return out;
}

/** What is being lowered again. */
export interface RelowerTarget {
  kind: "table" | "barcode" | "recordFlow" | "merge";
  /** The binding id (tables, barcodes, record flows). */
  binding?: string;
  /** The merge id (merges). */
  merge?: string;
}

export interface RelowerMemory {
  /** The document's pages in order (to address `deletePage`). */
  pages: readonly PageId[];
  /** Every element the previous lowering minted, when the session kept it. */
  minted?: readonly ElementId[];
  /** Pages the previous lowering added. */
  createdPages?: readonly PageId[];
}

export interface RelowerPlan {
  /** Clears the old content; run it in the same batch as the new content so
   *  the replacement is one undo step. Empty when there is nothing to clear. */
  remove: Mutation[];
  /** The frame to write the new content into (tables), or null. */
  reuse: ElementId | null;
  /** The elements `remove` deletes. */
  removed: ElementId[];
  /** The pages `remove` deletes. */
  removedPages: PageId[];
}

function sameElement(a: ElementId, b: ElementId): boolean {
  return a.kind === b.kind && JSON.stringify(a.id) === JSON.stringify(b.id);
}

function matches(data: Record<string, unknown> | null, t: RelowerTarget): boolean {
  if (!data || data.kind !== t.kind) return false;
  if (t.kind === "merge") return t.merge !== undefined && data.merge === t.merge;
  return t.binding !== undefined && data.binding === t.binding;
}

/** Only frame-like page items can be deleted with `deleteFrame`. */
function deletable(e: ElementId): boolean {
  return typeof e.id === "string" && e.kind !== "storyRange" && e.kind !== "table" && e.kind !== "tableCell";
}

/**
 * Plan the update in place of `target`: the old content to remove (labelled
 * or remembered as minted), the frame to reuse (a table's), and the pages a
 * merge added that are left empty.
 */
export function planRelower(
  elements: readonly RecordedElement[],
  target: RelowerTarget,
  memory: RelowerMemory,
): RelowerPlan {
  const labelled = elements.filter((e) => matches(e.data, target));
  let reuse: ElementId | null = null;
  let old: ElementId[] = labelled.map((e) => e.element);
  if (target.kind === "table") {
    const frame = labelled.find((e) => e.element.kind === "textFrame");
    reuse = frame?.element ?? null;
    old = old.filter((e) => !reuse || !sameElement(e, reuse));
  }
  for (const m of memory.minted ?? []) {
    if (reuse && sameElement(m, reuse)) continue;
    // Only what is still in the document: an undone lowering left nothing.
    if (!elements.some((e) => sameElement(e.element, m))) continue;
    if (!old.some((o) => sameElement(o, m))) old.push(m);
  }
  const removed = old.filter(deletable);
  const remove: Mutation[] = removed.map((e) => ({ op: "deleteFrame", args: { frameId: e.id as string } }));

  // Pages the previous lowering added that hold nothing else once it is gone.
  const removedPages: PageId[] = [];
  for (const pageId of memory.createdPages ?? []) {
    const index = memory.pages.indexOf(pageId);
    if (index < 0) continue;
    const left = elements.filter(
      (e) => e.page === index && !removed.some((r) => sameElement(r, e.element)),
    );
    if (left.length === 0) removedPages.push(pageId);
  }
  for (const pageId of removedPages) remove.push({ op: "deletePage", args: { pageId } });
  return { remove, reuse, removed, removedPages };
}
