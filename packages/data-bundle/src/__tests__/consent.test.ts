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

// D-03 — the session's network-consent gate (host.network consumption). The
// gate a remote/governed source crosses before DuckDB httpfs reaches an origin:
// it requests per-origin consent through the host and returns the granted set.
// Tested against a fake host implementing the plugin-api NetworkSurface (the
// real host-impl is tested in plugin-sdk).

import { describe, expect, it } from "vitest";

import type { BundleHost, ConsentResult } from "@paged-media/plugin-api";

import { createSession } from "../session";

function fakeHost(grant: string[], wired = true): BundleHost {
  const consented = new Set<string>();
  return {
    manifest: { id: "media.paged.data", name: "d", version: "0.0.1", apiVersion: "^0.2" },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    supports: (f: string) => wired && f === "network.consent@1",
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

describe("session.requestNetworkConsent (D-03)", () => {
  it("returns the origins the host granted", async () => {
    const session = createSession(fakeHost(["https://api.test"]), 0);
    const granted = await session.requestNetworkConsent(
      ["https://api.test", "https://other.test"],
      "bind to a dataset",
    );
    expect(granted).toEqual(["https://api.test"]);
  });

  it("returns [] when the host door throws (network undeclared, the M0 posture)", async () => {
    const throwing = {
      manifest: { id: "media.paged.data", name: "d", version: "0.0.1", apiVersion: "^0.2" },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      supports: () => false,
      network: {
        async requestConsent(): Promise<ConsentResult> {
          throw new Error("capabilities.network not declared");
        },
        consentedOrigins: () => [],
      },
    } as unknown as BundleHost;
    const session = createSession(throwing, 0);
    expect(await session.requestNetworkConsent(["https://api.test"], "x")).toEqual([]);
  });
});
