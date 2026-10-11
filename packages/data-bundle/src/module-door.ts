// The module door (plugin-sdk ADR 326): ask the HOST where one of the
// bundle's declared wasm artifacts lives. An editor that wires the door
// answers from its module manifest — in a deployed build the module host
// (https://modules.paged.media/<package>/<version>/<path>: immutable per
// version, brotli, cached a year, shared across sites) with the bytes'
// Subresource Integrity. Every other answer — an older host, a host without
// a module backend, a host that does not serve this artifact, a throwing
// backend — is `null`, and the caller loads the copy in its own `bin/`
// (src/bin-url.ts) exactly as before.
//
// Feature-detected, not imported: plugin-sdk's `resolveWasm` helper exists
// only from 0.2.51, and this bundle's peer floor is older. Importing it would
// be a missing export on an editor that pins an earlier SDK; the probe below
// is the same one, inline (`supports("modules@1")` + the member's presence).

import type { BundleHost } from "@paged-media/plugin-api";

/** Where the host serves a declared artifact. */
export interface HostedWasm {
  url: string;
  /** SRI (`sha384-…`) to fetch it with, or null when nobody vouched. */
  integrity: string | null;
}

/** Resolves a declared `capabilities.wasm` artifact name, or null. */
export type WasmResolver = (name: string) => Promise<HostedWasm | null>;

interface ModulesDoor {
  resolve?(name: string): Promise<{ url: string; integrity: string | null } | null>;
}

/** The host's answer for the declared artifact `name`, or null. Never rejects. */
export async function hostedWasm(
  host: Pick<BundleHost, "supports">,
  name: string,
): Promise<HostedWasm | null> {
  let door: ModulesDoor | undefined;
  try {
    if (!host.supports("modules@1")) return null;
    door = (host as { modules?: ModulesDoor }).modules;
  } catch {
    return null;
  }
  if (typeof door?.resolve !== "function") return null;
  try {
    const hosted = await door.resolve(name);
    if (!hosted || typeof hosted.url !== "string") return null;
    return { url: hosted.url, integrity: hosted.integrity ?? null };
  } catch {
    return null;
  }
}

/** A resolver bound to `host` (what bootEngine / bootDuckDB take). */
export function wasmResolver(host: Pick<BundleHost, "supports">): WasmResolver {
  return (name) => hostedWasm(host, name);
}

/** The manifest's artifact names this bundle resolves through the door. */
export const WASM_ARTIFACTS = {
  engine: "data-engine",
  duckdb: "duckdb-engine",
} as const;
