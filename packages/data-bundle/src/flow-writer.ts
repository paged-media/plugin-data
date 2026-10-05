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

// The record-flow writer (campaign Wave 5): the paginator's IR becomes real
// frames on real pages. The engine paginates the flow over a chain of
// margin-box frames, one per page (`lower_record_flow`); this places one text
// frame per paginated frame, the first on the start page and the rest on pages
// added after it. Each frame holds exactly the blocks the paginator put there
// (headers, records, footers), so its breaks — atomic records, repeated and
// continued headers — are the engine's, not the host's text flow. The frames
// are therefore NOT threaded: a thread would let the host re-break the text.
//
// Every frame is labelled `{kind: "recordFlow", binding, frame}` (with
// `createdPage` on the pages it added), so lowering the flow again removes
// the previous frames and pages first, in the same batch (`relower.ts`).
// Pages first, then content: two undo steps when pages are added (a page
// minted in a batch cannot be named — Wave 8), one otherwise.

import type { BundleHost, ElementId, Mutation, PageId } from "@paged-media/plugin-api";

import { BINDING_KEY, makeEnvelope } from "../../data-host-model/src";
import type { Bounds } from "./merge";

type Block =
  | { block: "groupHeader"; text: string; level: number; continued: boolean }
  | { block: "record"; cells: string[]; heightPt: number }
  | { block: "groupFooter"; cells: string[]; heightPt: number };

interface PaginatedFlow {
  frames: { frame: string; page: string; blocks: Block[]; usedPt: number }[];
  overflow: boolean;
  placed: number;
  total: number;
}

export interface FlowEngine {
  lower_record_flow(binding: string, chain: unknown, opts: unknown): unknown;
}

/** A paginated frame's text: one paragraph per header, record field line and
 *  footer. A re-emitted header is marked as continued. */
export function flowFrameText(blocks: readonly Block[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.block === "groupHeader") lines.push(b.continued ? `${b.text} (continued)` : b.text);
    else if (b.block === "record") lines.push(...b.cells);
    else lines.push(b.cells.join("\t"));
  }
  return lines.join("\n");
}

export interface FlowWriteResult {
  ok: boolean;
  frames: ElementId[];
  pages: PageId[];
  mutateCalls: number;
  overflow: boolean;
  diagnostics: string[];
}

/**
 * Lower a record-flow binding into frames: paginate over margin-box frames,
 * add the pages it needs after `pageId`, place one labelled text frame per
 * paginated frame. `clear` (the previous run's removal, `relower.ts`) rides
 * the first batch.
 */
export async function commitRecordFlow(
  host: BundleHost,
  engine: FlowEngine,
  binding: string,
  pageId: PageId,
  clear: Mutation[] = [],
): Promise<FlowWriteResult> {
  const diagnostics: string[] = [];
  const pages = await host.document.collection<{
    selfId: string;
    sizePt: [number, number];
    marginTopPt: number;
    marginLeftPt: number;
    marginBottomPt: number;
    marginRightPt: number;
  }>("pages");
  const page = pages.find((p) => p.selfId === pageId);
  if (!page) return { ok: false, frames: [], pages: [], mutateCalls: 0, overflow: false, diagnostics: ["flow: no start page"] };
  const [pw, ph] = page.sizePt;
  const box: Bounds = [page.marginTopPt, page.marginLeftPt, ph - page.marginBottomPt, pw - page.marginRightPt];
  const height = box[2] - box[0];

  // A chain long enough for every block to take a frame of its own.
  const probe = engine.lower_record_flow(binding, [{ frame: "all", page: "all", heightPt: Number.MAX_SAFE_INTEGER }], undefined) as PaginatedFlow;
  const blocks = probe.frames.reduce((n, f) => n + f.blocks.length, 0);
  const chain = Array.from({ length: Math.max(1, blocks) }, (_, i) => ({ frame: `f${i}`, page: `p${i}`, heightPt: height }));
  const flow = engine.lower_record_flow(binding, chain, undefined) as PaginatedFlow;
  if (flow.overflow) diagnostics.push(`flow: ${flow.total - flow.placed} record(s) did not fit`);
  const used = flow.frames.length;
  if (used === 0) return { ok: true, frames: [], pages: [], mutateCalls: 0, overflow: flow.overflow, diagnostics };

  let mutateCalls = 0;
  const before = pages.map((p) => p.selfId);
  let pending = [...clear];
  if (used > 1) {
    const ops: Mutation[] = [...pending];
    for (let i = 1; i < used; i++) ops.push({ op: "insertPage", args: { afterPageId: pageId, masterId: null } });
    pending = [];
    mutateCalls += 1;
    const o = await host.document.mutate({ op: "batch", args: { ops } });
    if (!o.applied) {
      return { ok: false, frames: [], pages: [], mutateCalls, overflow: flow.overflow, diagnostics: [...diagnostics, `flow: adding pages was refused`] };
    }
  }
  const after = (await host.document.collection<{ selfId: string }>("pages")).map((p) => p.selfId);
  const at = after.indexOf(pageId);
  const out = after.slice(at, at + used) as PageId[];
  if (out.length !== used || out.slice(1).some((p) => before.includes(p))) {
    return { ok: false, frames: [], pages: out, mutateCalls, overflow: flow.overflow, diagnostics: [...diagnostics, "flow: the added pages are not where expected"] };
  }

  const ops: Mutation[] = [...pending];
  flow.frames.forEach((f, i) => {
    const h = `flow${i}`;
    const text = flowFrameText(f.blocks);
    ops.push({ op: "insertTextFrame", args: { pageId: out[i], bounds: box } });
    ops.push({ op: "bindCreated", args: { handle: h } });
    if (text) ops.push({ op: "insertText", args: { storyId: `$h:${h}`, offset: 0, text } });
    ops.push({
      op: "setPluginMetadata",
      args: {
        elementId: { kind: "textFrame", id: `$h:${h}` } as ElementId,
        key: BINDING_KEY,
        value: makeEnvelope({ kind: "recordFlow", binding, frame: i, ...(i > 0 ? { createdPage: true } : {}) }),
      },
    });
  });
  mutateCalls += 1;
  const o = await host.document.mutate({ op: "batch", args: { ops } });
  if (!o.applied) {
    return { ok: false, frames: [], pages: out, mutateCalls, overflow: flow.overflow, diagnostics: [...diagnostics, "flow: the frame batch was refused"] };
  }
  const frames = (o.minted ?? []).filter((m) => m.element.kind === "textFrame").map((m) => m.element);
  return { ok: true, frames, pages: out, mutateCalls, overflow: flow.overflow, diagnostics };
}
