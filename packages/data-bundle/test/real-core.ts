// Shared boot for the specs that prove a defect against the REAL core engine
// (the published @paged-media/canvas-wasm, booted in Node by plugin-sdk's
// createHeadlessHost). The same pattern plugin-draw's conformance specs use.
//
// canvas-wasm is a devDependency of this package; the engine is found by
// probing: PAGED_ENGINE_FROM first (a directory whose node_modules holds a
// canvas-wasm build, e.g. a local sync-wasm build), then this package, then an editor
// checkout above this repo (`~/paged/editor/packages/client` in the local
// workspace layout, `../editor/packages/client` in the sibling CI layout).
// When nothing is found the suite SKIPS — unless REQUIRE_REAL_CORE=1, under
// which it fails instead, so a CI lane that opts in can never silently drop it.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

import { minimalIdml } from "./fixtures/minimal-idml";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = "node_modules/@paged-media/canvas-wasm/package.json";

/** The directory to hand `createHeadlessHost({ resolveFrom })`, or null. */
export function findEngineAnchor(): string | null {
  const local = process.env.PAGED_ENGINE_FROM;
  if (local) return existsSync(join(local, PKG)) ? local : null;
  const own = resolve(HERE, "..");
  if (existsSync(join(own, PKG))) return own;
  // Walk up from this package looking for an editor checkout beside a parent.
  let dir = own;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "editor/packages/client");
    if (existsSync(join(candidate, PKG))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export const ENGINE_ANCHOR = findEngineAnchor();
export const REQUIRE_REAL_CORE = process.env.REQUIRE_REAL_CORE === "1";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Boot a headless host over the real engine and load the minimal fixture
 *  (one page, Self="usp"). */
export async function openRealHost(): Promise<HeadlessHost> {
  if (!ENGINE_ANCHOR) {
    throw new Error(
      "REQUIRE_REAL_CORE=1 but no @paged-media/canvas-wasm was found " +
        "(set PAGED_ENGINE_FROM, or install an editor checkout beside this repo)",
    );
  }
  const h = await createHeadlessHost({
    console: silent,
    resolveFrom: ENGINE_ANCHOR,
  } as Parameters<typeof createHeadlessHost>[0]);
  await h.load(minimalIdml());
  return h;
}
