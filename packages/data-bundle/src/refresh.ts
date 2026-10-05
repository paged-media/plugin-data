// Acting on a source's refresh policy (wave 6). The policy is data-core's
// `RefreshPolicy` (serde `{ policy: "manual" | "onOpen" | "interval" |
// "never", secs? }`); this file decides what the editor can honour for which
// kind of source, and keeps the interval timers.
//
// What each policy does in the editor:
//   manual    nothing automatic; Refresh data / Load re-run on request.
//   onOpen    once when the document opens: a file source re-runs its
//             queries over the data saved with the document; a remote source
//             is fetched again ONLY when its origin is already consented
//             (a remembered grant) — never a silent first fetch (§11).
//   interval  remote sources only, and only while the origin is consented:
//             fetched every `secs` (at least MIN_INTERVAL_SECS) while the
//             document is open; the queries re-run when the content key
//             changed. A local file cannot be watched from a browser page —
//             there is no file handle to poll after the import — so a file
//             source refuses the policy and says so.
//   never     a frozen snapshot: nothing refreshes it automatically.

export type RefreshPolicy =
  | { policy: "manual" }
  | { policy: "onOpen" }
  | { policy: "interval"; secs: number }
  | { policy: "never" };

export const MANUAL: RefreshPolicy = { policy: "manual" };

/** The shortest polling interval the editor runs. */
export const MIN_INTERVAL_SECS = 15;

/** Can a source of this kind take this policy? Returns why not, or null. */
export function refusePolicy(kind: "file" | "remote", p: RefreshPolicy): string | null {
  if (p.policy === "interval") {
    if (kind === "file") {
      return "a local file cannot be watched from the browser — import it again to update it, or refresh on open";
    }
    if (!Number.isFinite(p.secs) || p.secs < MIN_INTERVAL_SECS) {
      return `the interval must be at least ${MIN_INTERVAL_SECS} seconds`;
    }
  }
  return null;
}

/** Parse a policy read from a saved session; anything unknown is manual. */
export function readPolicy(v: unknown): RefreshPolicy {
  const p = v as { policy?: unknown; secs?: unknown } | null;
  switch (p?.policy) {
    case "onOpen":
      return { policy: "onOpen" };
    case "never":
      return { policy: "never" };
    case "interval":
      return typeof p.secs === "number" && p.secs >= MIN_INTERVAL_SECS
        ? { policy: "interval", secs: p.secs }
        : MANUAL;
    default:
      return MANUAL;
  }
}

/** Short label for the panel. */
export function policyLabel(p: RefreshPolicy): string {
  switch (p.policy) {
    case "manual":
      return "manual";
    case "onOpen":
      return "on open";
    case "interval":
      return `every ${p.secs} s`;
    case "never":
      return "never (snapshot)";
  }
}

export interface TimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: TimerApi = {
  set: (fn, ms) => setInterval(fn, ms),
  clear: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/** One interval timer per polled source. `sync` makes the running set match
 *  the wanted set; a tick that is still running when the next one is due is
 *  skipped, so a slow source never stacks fetches. */
export class IntervalScheduler {
  private readonly timers = new Map<string, { handle: unknown; secs: number }>();
  private readonly busy = new Set<string>();

  constructor(
    private readonly tick: (source: string) => Promise<void>,
    private readonly timers_: TimerApi = realTimers,
  ) {}

  /** Start, restart or stop timers so exactly `wanted` (source → secs) run. */
  sync(wanted: ReadonlyMap<string, number>): void {
    for (const [name, t] of [...this.timers]) {
      if (wanted.get(name) !== t.secs) {
        this.timers_.clear(t.handle);
        this.timers.delete(name);
      }
    }
    for (const [name, secs] of wanted) {
      if (this.timers.has(name)) continue;
      const handle = this.timers_.set(() => void this.run(name), secs * 1000);
      this.timers.set(name, { handle, secs });
    }
  }

  /** The sources being polled, by name → secs. */
  running(): Map<string, number> {
    return new Map([...this.timers].map(([n, t]) => [n, t.secs]));
  }

  stopAll(): void {
    for (const t of this.timers.values()) this.timers_.clear(t.handle);
    this.timers.clear();
  }

  private async run(name: string): Promise<void> {
    if (this.busy.has(name)) return;
    this.busy.add(name);
    try {
      await this.tick(name);
    } finally {
      this.busy.delete(name);
    }
  }
}
