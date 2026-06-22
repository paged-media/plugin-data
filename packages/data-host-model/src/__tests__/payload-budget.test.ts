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

// D-08 verification (RFI: document-data payload size budget). The engine
// gates every `setPluginMetadata` VALUE at 64 KiB
// (core `PLUGIN_METADATA_MAX_BYTES = 64 * 1024`, apply/layer.rs). The open
// question was whether realistic binding definitions + source manifests FIT.
// This test MEASURES a deliberately heavy catalog document and pins the
// verdict: a document-level manifest envelope (sources + queries + the
// record-flow template) and per-element binding recipes each sit far below
// the cap — the budget holds for T1 without a new door, PROVIDED the payload
// stays split per element (the architecture already does this: recipes are
// stamped on their carrier elements, the manifest on the document spine).
// If product reality ever pushes past these shapes, this test is the alarm
// that re-opens D-08.

import { describe, expect, it } from "vitest";

import { makeEnvelope } from "../index";

const CAP = 64 * 1024;

/** A heavy-but-realistic catalog manifest: more sources, queries and
 *  expression text than the EasyCatalog-class documents the base idea
 *  targets (§6, §9). Credentials are NEVER part of this payload (hard
 *  gate) — sources carry redacted descriptors only. */
function heavyManifest(): unknown {
  const sources = Array.from({ length: 6 }, (_, i) => ({
    id: `src-${i}`,
    kind: i < 3 ? "file" : "remote",
    label: `Catalog source ${i} (supplier feed, weekly drop)`,
    uri:
      i < 3
        ? `opfs://imports/catalog-source-${i}.parquet`
        : `https://data.example-supplier-${i}.com/api/v2/products/export`,
    format: i % 2 ? "csv" : "parquet",
    options: { delimiter: ";", header: true, encoding: "utf-8" },
    credentialRef: i < 3 ? null : `keychain:source-${i}`, // ref, never the secret
    contentHash: "b3-256:".padEnd(71, "f"),
  }));
  const queries = Array.from({ length: 12 }, (_, i) => ({
    id: `q-${i}`,
    source: `src-${i % 6}`,
    label: `Products by family ${i}`,
    sql:
      `SELECT p.sku, p.name, p.description_de, p.description_en, p.price_eur, ` +
      `p.uvp_eur, p.weight_g, p.ean, f.family_name, f.family_order, i.image_uri ` +
      `FROM products p JOIN families f ON f.id = p.family_id ` +
      `LEFT JOIN images i ON i.sku = p.sku ` +
      `WHERE f.season = $season AND p.active = TRUE AND p.price_eur > $min_price ` +
      `ORDER BY f.family_order, p.sku -- query ${i}, deterministic order injected`,
    params: { season: "FS26", min_price: 0 },
    shape: "recordStream",
  }));
  const recordFlow = {
    template: {
      frames: Array.from({ length: 8 }, (_, i) => ({
        role: `cell-${i}`,
        bounds: [i * 60, 0, 56, 120],
        bindings: [`b-name-${i}`, `b-price-${i}`, `b-img-${i}`],
      })),
    },
    grouping: [
      { by: "family_name", footer: { expression: 'CONCAT("Familie: ", COUNT())' } },
      { by: "sku", footer: null },
    ],
    pagination: { repeatHeaders: true, orphanMin: 2 },
  };
  return { v: 1, sources, queries, recordFlow };
}

/** One element's binding recipe — what actually rides on a frame. */
function elementRecipe(i: number): unknown {
  return {
    binding: {
      id: `b-${i}`,
      kind: i % 4 === 0 ? "image" : "variable",
      query: `q-${i % 12}`,
      expression:
        'FORMAT(IF(price_eur >= uvp_eur, price_eur, uvp_eur), "#.##0,00 €") ' +
        '& " statt " & FORMAT(uvp_eur, "#.##0,00 €")',
      locale: "de-DE",
      sync: "linked",
      fit: i % 4 === 0 ? { mode: "proportional", crop: "center" } : null,
    },
  };
}

describe("D-08 — document payload vs the 64 KiB metadata cap", () => {
  it("a heavy catalog manifest envelope fits with >3x headroom", () => {
    const bytes = new TextEncoder().encode(makeEnvelope(heavyManifest())).length;
    expect(bytes).toBeLessThan(CAP / 3);
  });

  it("per-element binding recipes are two orders of magnitude under the cap", () => {
    for (let i = 0; i < 16; i++) {
      const bytes = new TextEncoder().encode(makeEnvelope(elementRecipe(i))).length;
      expect(bytes).toBeLessThan(CAP / 100);
    }
  });

  it("pins WHERE the budget would break: a single envelope holding every recipe", () => {
    // The anti-pattern (one document-level envelope carrying ALL recipes)
    // breaks somewhere in the low thousands of bindings — far beyond the
    // per-element architecture, but pinned so the trade-off stays visible.
    const all = Array.from({ length: 400 }, (_, i) => elementRecipe(i));
    const bytes = new TextEncoder().encode(makeEnvelope(all)).length;
    expect(bytes).toBeGreaterThan(CAP); // 400 recipes in ONE value would not fit
  });
});
