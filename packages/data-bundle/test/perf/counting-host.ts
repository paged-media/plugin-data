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

// The host-side work counter the paged.data perf budgets stand on — copied
// from plugin-draw (packages/draw-bundle/test/perf/counting-host.ts) and
// trimmed to the doors this bundle goes through.
//
// A data command's cost is not its arithmetic — the binding semantics live in
// the Rust engine. It is the DOORS it goes through: every `host.document.*`
// call is a request/reply to the engine worker in the editor, and every
// `mutate` is a document rebuild and, unless the host coalesces, an undo step.
// So the budgets count door calls, not milliseconds: a count is the same on a
// laptop and a CI runner, and a fix that halves it halves it everywhere.
//
// `countingHost(h.host)` wraps a real `BundleHost` in a Proxy that counts
// every function call by its dotted door name (`document.placeholders`,
// `document.mutate`, …) and forwards it untouched. Nothing is mocked: the
// engine still answers, so a budget and a behaviour assertion share one run.
//
// Hand the WRAPPED host to the session under test; keep the raw `h.host` for
// fixture setup and the undo probe, so neither is counted.

import type { BundleHost } from "@paged-media/plugin-api";

/** One `document.mutate` as the engine saw it. */
export interface CountedMutation {
  /** The op name; `"batch"` for a batch. */
  op: string;
  /** How many ops it carried — 1 unless it is a batch. */
  ops: number;
}

export interface WorkLog {
  /** Calls per door, keyed by dotted path from the host root. */
  readonly calls: Readonly<Record<string, number>>;
  /** Every `document.mutate`, in order. */
  readonly mutations: readonly CountedMutation[];
  /** Total fields the host handed BACK across every `document.placeholders`
   *  reply. A call count cannot tell a 3-field read from a 3 000-field one;
   *  this can. Counted when the reply lands. */
  readonly placeholdersRead: number;
  /** Total nodes the host handed back across every `document.tree` reply
   *  (counted recursively) — the price of a tree walk. */
  readonly treeNodesRead: number;
  /** Total element ids ASKED of `document.elementGeometry`. */
  readonly geometryIdsAsked: number;
  /** Calls to one door (0 when it was never called). */
  count(door: string): number;
  /** Every `document.*` call that is not a write, a history step or a
   *  subscription — i.e. the engine round trips spent READING. */
  reads(): number;
  /** Every counted call, all doors. */
  total(): number;
  /** Mutation ops across every mutate (a batch counts its ops). */
  ops(): number;
  /** Forget everything counted so far. */
  reset(): void;
  /** A frozen copy of the counts as they stand. */
  snapshot(): WorkLog;
}

const NOT_A_READ = new Set([
  "document.mutate",
  "document.undo",
  "document.redo",
  "document.onDidChange",
]);

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const countNodes = (nodes: unknown): number => {
  if (!Array.isArray(nodes)) return 0;
  let n = 0;
  for (const node of nodes) {
    n += 1;
    n += countNodes((node as { children?: unknown } | null)?.children);
  }
  return n;
};

interface State {
  calls: Record<string, number>;
  mutations: CountedMutation[];
  placeholdersRead: number;
  treeNodesRead: number;
  geometryIdsAsked: number;
}

const empty = (): State => ({
  calls: {},
  mutations: [],
  placeholdersRead: 0,
  treeNodesRead: 0,
  geometryIdsAsked: 0,
});

export function countingHost(host: BundleHost): {
  host: BundleHost;
  work: WorkLog;
} {
  let s = empty();
  const wrapped = new WeakMap<object, object>();

  /** Count what a reply CARRIED, without touching what the caller sees. */
  const observe = (door: string, result: unknown): void => {
    if (door !== "document.placeholders" && door !== "document.tree") return;
    if (!result || typeof (result as PromiseLike<unknown>).then !== "function") return;
    const into = s;
    (result as PromiseLike<unknown>).then(
      (reply) => {
        if (door === "document.placeholders" && Array.isArray(reply)) {
          into.placeholdersRead += reply.length;
        } else if (door === "document.tree") {
          into.treeNodesRead += countNodes(reply);
        }
      },
      () => {
        /* a refused read carried nothing */
      },
    );
  };

  const note = (door: string, args: unknown[]): void => {
    s.calls[door] = (s.calls[door] ?? 0) + 1;
    if (door === "document.elementGeometry") {
      if (Array.isArray(args[0])) s.geometryIdsAsked += args[0].length;
    } else if (door === "document.mutate") {
      const m = args[0] as { op?: string; args?: { ops?: unknown[] } };
      s.mutations.push({
        op: m?.op ?? "?",
        ops: m?.op === "batch" ? (m.args?.ops?.length ?? 0) : 1,
      });
    }
  };

  const wrap = <T extends object>(target: T, path: string): T => {
    const hit = wrapped.get(target);
    if (hit) return hit as T;
    const proxy = new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver) as unknown;
        if (typeof prop !== "string") return value;
        const door = path ? `${path}.${prop}` : prop;
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            note(door, args);
            const result = Reflect.apply(value, obj, args) as unknown;
            observe(door, result);
            return result;
          };
        }
        return isPlainObject(value) ? wrap(value, door) : value;
      },
    });
    wrapped.set(target, proxy);
    return proxy;
  };

  const logOver = (get: () => State, reset: () => void): WorkLog => ({
    get calls() {
      return get().calls;
    },
    get mutations() {
      return get().mutations;
    },
    get placeholdersRead() {
      return get().placeholdersRead;
    },
    get treeNodesRead() {
      return get().treeNodesRead;
    },
    get geometryIdsAsked() {
      return get().geometryIdsAsked;
    },
    count: (door) => get().calls[door] ?? 0,
    reads: () =>
      Object.entries(get().calls)
        .filter(([k]) => k.startsWith("document.") && !NOT_A_READ.has(k))
        .reduce((n, [, v]) => n + v, 0),
    total: () => Object.values(get().calls).reduce((n, v) => n + v, 0),
    ops: () => get().mutations.reduce((n, m) => n + m.ops, 0),
    reset,
    snapshot: () => {
      const cur = get();
      const frozen: State = {
        calls: { ...cur.calls },
        mutations: [...cur.mutations],
        placeholdersRead: cur.placeholdersRead,
        treeNodesRead: cur.treeNodesRead,
        geometryIdsAsked: cur.geometryIdsAsked,
      };
      return logOver(
        () => frozen,
        () => {
          /* a snapshot is frozen */
        },
      );
    },
  });

  const work = logOver(
    () => s,
    () => {
      s = empty();
    },
  );

  return { host: wrap(host as unknown as object, "") as BundleHost, work };
}

/** The whole log as one plain object — every door, not only the ones a
 *  budget names. */
export function workSummary(work: WorkLog): Record<string, unknown> {
  const calls: Record<string, number> = {};
  for (const door of Object.keys(work.calls).sort()) calls[door] = work.calls[door]!;
  return {
    calls,
    reads: work.reads(),
    placeholdersRead: work.placeholdersRead,
    treeNodesRead: work.treeNodesRead,
    geometryIdsAsked: work.geometryIdsAsked,
    mutations: work.mutations.map((m) => (m.op === "batch" ? `batch(${m.ops})` : m.op)),
  };
}
