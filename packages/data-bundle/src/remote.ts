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

// Remote-source fetch-lane glue (spec §6.2 / D-03 — the M1 slice). TRANSPORT
// ONLY: descriptor checks mirror the authoritative Rust validation
// (data-sources/src/remote.rs — the engine re-validates before keying), URL
// composition is deterministic, and NOTHING here fetches — the session does,
// edit-time, strictly after the per-origin consent gate. No binding/expression
// semantics live here (CLAUDE.md hard rule).

/** The remote formats the M1 fetch lane hands to DuckDB. */
export type RemoteFormat = "csv" | "tsv" | "json" | "parquet";

/** One remote source's panel-visible state. INERT until its origin is
 *  consented; `contentKey` is the engine-computed content-hash invalidation
 *  key recorded after a successful load. */
export interface RemoteSourceState {
  name: string;
  url: string;
  origin: string;
  format: RemoteFormat;
  params: Record<string, string>;
  /** A host-credential-store reference (D-11) — a ref STRING only; secret
   *  material never enters the descriptor, the payload, or this state. */
  credentialRef?: string;
  consent: "granted" | "required";
  status: "inert" | "loaded" | "error";
  message: string;
  contentKey: string | null;
}

/** `scheme://host[:port]` of a remote URL, or `null` if unparseable. */
export function remoteOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Mirror of the Rust descriptor validation (authoritative: data-sources):
 *  http(s) only, a real host, and NO embedded `user:pass@` credentials —
 *  authenticated sources carry a `credentialRef` instead (D-11). Returns an
 *  error message, or `null` when valid. */
export function validateRemoteUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `not a valid URL: ${url}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `remote url must be http(s), got ${parsed.protocol}//`;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "remote url embeds credentials (user:pass@) — use a credentialRef (D-11)";
  }
  if (parsed.hostname === "") {
    return "remote url has no host";
  }
  return null;
}

/** Compose the request URL: descriptor params appended as query parameters in
 *  sorted key order (deterministic — matches the BTreeMap descriptor). */
export function buildRemoteUrl(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const key of Object.keys(params).sort()) {
    u.searchParams.set(key, params[key]);
  }
  return u.toString();
}
