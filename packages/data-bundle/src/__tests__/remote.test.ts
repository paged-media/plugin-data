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

// M1 remote sources (§6.2 / §11 / D-03) — the fetch lane's security posture:
// a remote source is INERT until its origin is consented (a document carrying
// one loads cold — NO fetch on open, NO fetch on an unconsented load), the
// edit-time fetch happens exactly once post-consent and hands the bytes to the
// DuckDB query lane like an imported file, and descriptors carry credentialRef
// STRINGS only (rfc-credential-store — embedded user:pass@ is rejected).
// Engine + DuckDB are mocked (the real-engine join is covered by the Rust
// conformance suite + the e2e harness).

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import type { BundleHost, ConsentResult } from "@paged-media/plugin-api";

import { createSession } from "../session";
import { buildRemoteUrl, validateRemoteUrl } from "../remote";

const defineSourceCalls: unknown[] = [];
const keyCalls: { source: string; byteLen: number }[] = [];
const registerCsvCalls: { name: string; text: string }[] = [];
const registerBufferCalls: string[] = [];

vi.mock("../engine", () => ({
  ENGINE_NOT_BUILT: "engine not built",
  bootEngine: async () => ({
    set_locale() {},
    define_source(s: unknown) {
      defineSourceCalls.push(s);
    },
    remote_invalidation_key(source: string, bytes: Uint8Array) {
      keyCalls.push({ source, byteLen: bytes.length });
      return "00000000deadbeef";
    },
    free() {},
  }),
}));

vi.mock("../query/duckdb", () => ({
  DUCKDB_NOT_VENDORED: "duckdb not vendored",
  bootDuckDB: async () => ({
    async registerCsv(name: string, text: string) {
      registerCsvCalls.push({ name, text });
    },
    async registerFileBuffer(name: string) {
      registerBufferCalls.push(name);
    },
    async query() {
      throw new Error("unused in this suite");
    },
    async close() {},
  }),
}));

function fakeHost(grant: string[]): BundleHost {
  const consented = new Set<string>();
  return {
    manifest: { id: "media.paged.data", name: "d", version: "0.0.1", apiVersion: "^0.2" },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    supports: (f: string) => f === "network.consent@1",
    network: {
      async requestConsent(origins: readonly string[]): Promise<ConsentResult> {
        const granted = origins.filter((o) => grant.includes(o));
        granted.forEach((o) => consented.add(o));
        return {
          granted,
          denied: origins.filter((o) => !grant.includes(o)),
          remembered: false,
        };
      },
      consentedOrigins: () => [...consented],
    },
  } as unknown as BundleHost;
}

const fetchSpy = vi.fn(
  async () =>
    new Response("sku,price\nA,1\n", { status: 200, headers: { "content-type": "text/csv" } }),
);

beforeEach(() => {
  defineSourceCalls.length = 0;
  keyCalls.length = 0;
  registerCsvCalls.length = 0;
  registerBufferCalls.length = 0;
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remote sources — inert until consent (data.source.remote / data.security.no-network-pre-consent)", () => {
  it("defining a remote source fetches NOTHING (a document loads cold)", () => {
    const session = createSession(fakeHost([]), 0);
    const err = session.addRemoteSource("feed", "https://api.test/feed.csv", "csv");
    expect(err).toBeNull();
    const remote = session.getState().remote;
    expect(remote).toHaveLength(1);
    expect(remote[0]).toMatchObject({
      name: "feed",
      origin: "https://api.test",
      consent: "required",
      status: "inert",
      contentKey: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(defineSourceCalls).toHaveLength(0); // not even an engine boot
  });

  it("loading without consent performs NO fetch and stays inert", async () => {
    const session = createSession(fakeHost([]), 0);
    session.addRemoteSource("feed", "https://api.test/feed.csv", "csv");
    await session.loadRemoteSource("feed");
    const r = session.getState().remote[0];
    expect(r.status).toBe("inert");
    expect(r.consent).toBe("required");
    expect(r.message).toContain("no fetch performed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("consent → load: fetches once, hands bytes to the query lane, records the content key", async () => {
    const session = createSession(fakeHost(["https://api.test"]), 0);
    session.addRemoteSource("feed", "https://api.test/feed.csv", "csv", {
      params: { region: "eu" },
    });
    expect(await session.requestConsentForRemote("feed")).toBe(true);
    await session.loadRemoteSource("feed");

    // Exactly one edit-time fetch, with deterministically composed params.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("https://api.test/feed.csv?region=eu");

    // Bytes entered the DuckDB lane exactly like an imported file.
    expect(registerCsvCalls).toEqual([{ name: "feed", text: "sku,price\nA,1\n" }]);

    // The engine got the transport-agnostic descriptor + computed the key.
    expect(defineSourceCalls[0]).toMatchObject({
      id: "feed",
      kind: { kind: "remote", url: "https://api.test/feed.csv", format: "csv" },
    });
    expect(keyCalls).toEqual([{ source: "feed", byteLen: "sku,price\nA,1\n".length }]);

    const state = session.getState();
    expect(state.remote[0]).toMatchObject({
      consent: "granted",
      status: "loaded",
      contentKey: "00000000deadbeef",
    });
    expect(state.sources).toContain("feed");
  });

  it("non-CSV formats register as file buffers (the imported-file seam)", async () => {
    const session = createSession(fakeHost(["https://api.test"]), 0);
    session.addRemoteSource("feed", "https://api.test/feed.parquet", "parquet");
    await session.requestConsentForRemote("feed");
    await session.loadRemoteSource("feed");
    expect(registerBufferCalls).toEqual(["feed.parquet"]);
    expect(registerCsvCalls).toHaveLength(0);
  });
});

describe("remote descriptors — credentialRef strings only (data.security.credentials-absent)", () => {
  it("rejects URLs with embedded credentials", () => {
    const session = createSession(fakeHost([]), 0);
    const err = session.addRemoteSource("bad", "https://user:secret@api.test/x.csv", "csv");
    expect(err).toContain("credentialRef");
    expect(session.getState().remote).toHaveLength(0);
    expect(validateRemoteUrl("https://user:secret@api.test/x.csv")).toContain("credentials");
  });

  it("carries a credentialRef as a ref STRING only", async () => {
    const session = createSession(fakeHost(["https://api.test"]), 0);
    session.addRemoteSource("feed", "https://api.test/feed.csv", "csv", {
      credentialRef: "keychain:source-feed",
    });
    await session.requestConsentForRemote("feed");
    await session.loadRemoteSource("feed");
    expect(defineSourceCalls[0]).toMatchObject({
      kind: { credential_ref: "keychain:source-feed" },
    });
  });

  it("composes request URLs deterministically (sorted param order)", () => {
    expect(buildRemoteUrl("https://api.test/d.csv", { b: "2", a: "1" })).toBe(
      buildRemoteUrl("https://api.test/d.csv", { a: "1", b: "2" }),
    );
    expect(buildRemoteUrl("https://api.test/d.csv", { b: "2", a: "1" })).toBe(
      "https://api.test/d.csv?a=1&b=2",
    );
  });
});
