// A record flow paginated over a frame chain re-splits when a chain frame is
// resized by its HANDLES: a canvas gesture (begin, update, commit), which the
// engine commits as a `gestureCommitted`, not a `resizeFrame` mutation. Core
// v0.71.13 reports that gesture's reflow on the reply (core ADR 159),
// plugin-sdk 0.2.58 passes it through `document.onDidChange`, and
// `subscribeChainReflow` re-paginates on any change that carries one. Before,
// only a `resizeFrame` carried it, and a handle resize left the split where
// it was. A move by the same gesture kit carries none and re-paginates
// nothing (display geometry only, §8.5).
//
// The REAL stack: real core (headless canvas-wasm), the real data-js wasm,
// real DuckDB. Gate: skips without the pieces, EXCEPT under
// REQUIRE_REAL_CORE=1 / REQUIRE_REAL_ENGINE=1 / REQUIRE_REAL_DUCKDB=1, where
// a missing piece fails.

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  BUDGET_TIMEOUT_MS,
  bootCountedDuck,
  bootCountedEngine,
  openDataHost,
  productCsv,
  RUN_BUDGETS,
  sessionOver,
  type CountedDuck,
} from "./perf/harness";

vi.setConfig({ testTimeout: BUDGET_TIMEOUT_MS });

interface Flow {
  frames: { frame: string; blocks: unknown[] }[];
  placed: number;
  total: number;
  overflow: boolean;
}

type Reply = { kind: string; payload: Record<string, unknown> };

/** The engine client under the headless host (the canvas's own channel). */
function client(h: HeadlessHost): { send(m: unknown): Promise<Reply> } {
  return (h.host as unknown as { editor: { client: { send(m: unknown): Promise<Reply> } } }).editor.client;
}

/** Run one gesture on `frameId` the way the canvas does: begun, moved by
 *  `delta` (pt, snapping off), committed. Returns the commit's reply. */
async function gesture(h: HeadlessHost, frameId: string, kind: unknown, delta: [number, number]): Promise<Reply> {
  const c = client(h);
  const begun = await c.send({ kind: "beginGesture", payload: { nodes: [{ kind: "textFrame", id: frameId }], gesture: kind } });
  expect(begun.kind).toBe("gestureBegun");
  const moved = await c.send({
    kind: "updateGesture",
    payload: { handle: begun.payload.handle, delta, modifiers: { shift: false, alt: false, disableSnap: true } },
  });
  expect(moved.kind).toBe("gestureUpdated");
  const committed = await c.send({ kind: "commitGesture", payload: { handle: begun.payload.handle } });
  expect(committed.kind).toBe("gestureCommitted");
  return committed;
}

/** Let the subscription's debounce (16 ms) and the pass behind it run. */
async function quiet(): Promise<void> {
  await new Promise((r) => setTimeout(r, 60));
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe.skipIf(!RUN_BUDGETS)("a record flow follows a handle resize, real core [data.lower.v43-consumers]", () => {
  let h: HeadlessHost | null = null;
  let duck: CountedDuck | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });
  afterAll(async () => {
    await duck?.handle.close();
  });

  /** A 40-record flow paginated over two threaded frames; the first frame's
   *  id, the chain's story, the flows the subscription reported, and the
   *  split before any resize. */
  async function paginatedChain() {
    h = await openDataHost();
    const engine = await bootCountedEngine();
    duck ??= await bootCountedDuck();
    const s = await sessionOver(h.host, engine, duck);
    const name = `p${Math.random().toString(36).slice(2, 8)}`;
    await s.registerCsvSource(name, productCsv(40));
    s.addQuery("q", `SELECT sku, name FROM ${name}`, "recordStream");
    await s.refreshData();
    s.defineRecordFlow("rf", "q", [{ expr: "sku" }], { lineHeightPt: 12 });

    const frame = async (bounds: [number, number, number, number]) => {
      const o = await h!.host.document.mutate({ op: "insertTextFrame", args: { pageId: "usp" as never, bounds } });
      expect(o.applied).toBe(true);
      return (o as { createdId: { id: string } }).createdId.id;
    };
    const fa = await frame([50, 50, 350, 250]);
    const fb = await frame([50, 300, 700, 500]);
    expect((await h.host.document.mutate({ op: "linkFrames", args: { from: fa, to: fb } })).applied).toBe(true);
    const story = (await h.host.document.hitTest("usp" as never, [150, 200]))!.storyId as string;
    expect(await h.host.document.frameChain(story)).toHaveLength(2);

    const split = (f: Flow) => f.frames.map((x) => x.blocks.length);
    const first = (await s.paginateChain("rf", story)) as Flow;
    expect(first.placed).toBe(40);
    const flows: Flow[] = [];
    const sub = s.subscribeChainReflow("rf", story, (f) => flows.push(f as Flow));
    return { fa, story, flows, sub, split, before: split(first) };
  }

  it("records move into the second frame when the first is shortened by its handle", async () => {
    const { fa, flows, sub, split, before } = await paginatedChain();
    expect(before).toHaveLength(2);
    expect(before[1]).toBeGreaterThan(0);

    // The first frame's bottom edge up by 150 pt, dragged by its handle.
    await gesture(h!, fa, { kind: "resize", handle: "south" }, [0, -150]);
    await quiet();
    sub.dispose();

    expect(flows.length, "the handle resize re-paginated the flow").toBeGreaterThan(0);
    const last = flows[flows.length - 1];
    const after = split(last);
    expect(last.placed).toBe(40);
    expect(after[0], "the first frame holds fewer records").toBeLessThan(before[0]);
    expect(after[1], "the records it lost moved into the second").toBeGreaterThan(before[1]);
    expect(after[0] + after[1]).toBe(before[0] + before[1]);
  });

  it("a move by the gesture kit re-paginates nothing", async () => {
    const { fa, flows, sub } = await paginatedChain();
    const committed = await gesture(h!, fa, { kind: "translate" }, [0, 40]);
    expect(committed.payload.reflow ?? null, "a move reports no reflow").toBeNull();
    await quiet();
    sub.dispose();
    expect(flows).toEqual([]);
  });
});
