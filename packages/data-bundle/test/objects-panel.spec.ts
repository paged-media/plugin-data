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

// ADR 323 §4 — the "Data objects" panel declares property rows (fields, not
// widgets) for paged.data's own objects: every row is a row of its kind's
// manifest schema, every schema row of every kind has one, and the address
// forms are well-formed (plugin-sdk validatePanelSchema). [data.object-model]

import { describe, expect, it } from "vitest";

import { propertyRowsOf, validatePanelSchema } from "@paged-media/plugin-sdk";
import type { PropertySchema } from "@paged-media/plugin-api";

import manifest from "../manifest.json";
import { PANEL_FIELDS, schemaOf, type KindName } from "../src/object-model";
import { BIND, DATA_OBJECTS_PANEL, OBJECTS_PANEL_ID } from "../src/panels/objects-panel";

const kindOf = (q: string) => q.slice(q.lastIndexOf("/") + 1) as KindName;
const declared = (manifest.contributes as unknown as { objectModel: { kinds: { kind: string; schema: PropertySchema[] }[] } }).objectModel.kinds;

describe("Data objects panel (property rows) [data.object-model]", () => {
  it("validates against the manifest schemas", () => {
    expect(
      validatePanelSchema(DATA_OBJECTS_PANEL, {
        pluginId: manifest.id,
        schemaOf: (k) => (k.startsWith(`plugin:${manifest.id}/`) ? schemaOf(kindOf(k)) : undefined),
      }),
    ).toEqual([]);
  });

  it("a mistyped path is reported (the check is live)", () => {
    const broken = structuredClone(DATA_OBJECTS_PANEL);
    const row = broken.sections[0]!.rows.find((r) => (r as { field?: string }).field === "property") as { path: string };
    row.path = "nope";
    const issues = validatePanelSchema(broken, { pluginId: manifest.id, schemaOf: (k) => schemaOf(kindOf(k)) });
    expect(issues.length).toBe(1);
  });

  it("covers every schema row of every kind, each through a property row", () => {
    const rows = propertyRowsOf(DATA_OBJECTS_PANEL).map((r) => `${kindOf(r.field.kind!)}.${r.field.path}`);
    const schema = declared.flatMap((k) => k.schema.map((s) => `${k.kind}.${s.path}`));
    expect(schema.length).toBe(23);
    expect([...rows].sort()).toEqual([...schema].sort());
    expect(PANEL_FIELDS.map((f) => `${f.kind}.${f.path}`).sort()).toEqual([...schema].sort());
  });

  it("each kind's rows edit the item picked in that kind's list", () => {
    const binds = Object.values(BIND);
    for (const s of DATA_OBJECTS_PANEL.sections) {
      const list = s.rows[0] as { widget?: string; list?: { selectionBinding?: string } };
      expect(list.widget).toBe("paged.list");
      const select = list.list!.selectionBinding!;
      expect(binds).toContain(select);
      for (const r of s.rows.slice(1)) expect((r as { address?: unknown }).address).toEqual({ bind: select });
    }
  });

  it("is declared in the manifest beside the four React panels", () => {
    expect(manifest.contributes.panels).toEqual([
      "media.paged.data.panel.sources",
      "media.paged.data.panel.bindings",
      "media.paged.data.panel.dataset",
      "media.paged.data.panel.query",
      OBJECTS_PANEL_ID,
    ]);
  });
});
