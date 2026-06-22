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

// Pure translators for the v43 in-text-variable + image-placement + rule lanes
// (D-01 / D-14 / D-13). ZERO binding/expression semantics live here (CLAUDE.md
// hard rule): the Rust engine has ALREADY resolved every display string, image
// reference, fit, and rule-firing decision; this turns those decided values into
// host Mutations. Data in, mutations out.
//
// The shapes are the wire `Mutation` discriminated union (insertField /
// setFieldValue / placeImage / applyStyle / setElementProperty), so the
// type-checker pins us to the real op vocabulary — no FieldKind/StyleScope named
// import needed (the union inlines them).

import type { Mutation, Value } from "@paged-media/plugin-api";

import type { ImageReference, LoweredImage } from "./lowered";
import type { RuleApplication } from "./rule";

// ── D-01 — in-text variable placeholders ────────────────────────────────────

/** The plugin id whose `placeholder` fields paged.data owns. Mirrors the
 *  manifest `id` + the binding-metadata namespace; the host gates a field write
 *  to the calling plugin's own namespace, so a paged.data refresh can only ever
 *  see and re-resolve ITS OWN fields. */
export const FIELD_PLUGIN = "media.paged.data";

/** Insert a tagged placeholder field for a variable binding (D-01). `key` is the
 *  binding id (the refresh loop resolves a `{plugin, key}` back to its binding);
 *  `value` is the engine-resolved display (null ⇒ the field shows its `<key>`
 *  token until refreshed).
 *
 *  CARET-POSITION GAP (honest): the SDK exposes no caret/selection read for a
 *  bundle, so `offset` is caller-supplied — the consumer inserts at a known
 *  story offset (story start, 0) rather than "the user's caret". The field is a
 *  real tagged run either way; only WHERE it lands is coarse until a caret-read
 *  door exists. */
export function insertFieldMutation(
  storyId: string,
  offset: number,
  key: string,
  value: string | null,
): Mutation {
  return {
    op: "insertField",
    args: {
      storyId,
      offset,
      field: { placeholder: { plugin: FIELD_PLUGIN, key, value: value ?? undefined } },
    },
  };
}

/** Re-resolve an existing placeholder field to a new value (D-01). `offset` is a
 *  FRESH-READ address from `placeholders()` (re-enumerate before each write
 *  pass — the host normalises to the run start). `value` null clears the
 *  resolution (the field falls back to its `<key>` token). One undoable step. */
export function setFieldValueMutation(
  storyId: string,
  offset: number,
  value: string | null,
): Mutation {
  return { op: "setFieldValue", args: { storyId, offset, value } };
}

/** A plugin-tagged placeholder as `host.document.placeholders()` returns it
 *  (D-01, protocol v43). Mirrors the SDK `DocumentPlaceholder` shape (not
 *  re-exported from the plugin-api index, so declared here for the pure layer). */
export interface PlaceholderField {
  storyId: string;
  offset: number;
  plugin: string;
  key: string;
  value: string | null;
}

/** The refresh decision for ONE enumerated placeholder: the engine-resolved
 *  display vs. the field's current value. `changed` is false when they already
 *  match (no write emitted — refresh is minimal + idempotent). */
export interface FieldRefresh {
  storyId: string;
  offset: number;
  key: string;
  /** The new engine-resolved display (null ⇒ unresolved). */
  next: string | null;
  changed: boolean;
}

/** Diff a freshly-enumerated set of OUR placeholder fields against the
 *  engine-resolved values (keyed by binding id). Pure: returns one
 *  `FieldRefresh` per field; `changed` drives whether a `setFieldValue` is
 *  emitted. A field whose key has no resolved value is left untouched
 *  (`changed:false`) — the binding may not be wired yet. */
export function diffFields(
  fields: readonly PlaceholderField[],
  resolved: ReadonlyMap<string, string | null>,
): FieldRefresh[] {
  return fields.map((f) => {
    const has = resolved.has(f.key);
    const next = has ? (resolved.get(f.key) ?? null) : f.value;
    return {
      storyId: f.storyId,
      offset: f.offset,
      key: f.key,
      next,
      changed: has && next !== f.value,
    };
  });
}

/** Keep only the fields this plugin owns (defence in depth — the host already
 *  scopes the enumeration, but a pure filter keeps the refresh honest if a
 *  broader read ever lands). */
export function ownFields(fields: readonly PlaceholderField[]): PlaceholderField[] {
  return fields.filter((f) => f.plugin === FIELD_PLUGIN);
}

// ── D-14 — image placement ──────────────────────────────────────────────────

/** The IDML `FittingOnEmptyFrame` vocabulary the `placeImage` op carries
 *  (Rectangle-only). The lowered `ImgFit` (fit/fill/crop) maps onto it. */
export type IdmlFit =
  | "Proportionally"
  | "FillProportionally"
  | "FitContentToFrame"
  | "ContentAwareFit"
  | "";

/** Map the engine's `ImgFit` to the IDML `FittingOnEmptyFrame` vocab (D-14).
 *  `fit` → Proportionally (the classic "fit content proportionally"), `fill` →
 *  FillProportionally (fill the frame, keep aspect, crop overflow), `crop` →
 *  FitContentToFrame (stretch to the frame box). ContentAwareFit + "" (no
 *  fitting) are reachable via the explicit panel choice, not this default map. */
export function idmlFit(fit: LoweredImage["fit"]): IdmlFit {
  switch (fit) {
    case "fit":
      return "Proportionally";
    case "fill":
      return "FillProportionally";
    case "crop":
      return "FitContentToFrame";
  }
}

/** The placeable URI of a classified image reference, or null when the
 *  reference cannot address a host asset by URI (inline bytes / assetId / none
 *  need a different door — honest null, never a fake placement). `uri` and
 *  `path` both place by URI (a local path is a `file:`/relative uri the host
 *  resolves). */
export function placeableUri(reference: ImageReference): string | null {
  switch (reference.ref) {
    case "uri":
      return reference.uri;
    case "path":
      return reference.path;
    case "assetId":
    case "bytes":
    case "none":
      return null;
  }
}

/** The `placeImage` mutation for a lowered image onto a bound rectangle (D-14).
 *  `elementId` is the target frame's raw Self id; `fit` is the explicit IDML
 *  vocab (caller may override the default `idmlFit` mapping with a panel
 *  choice). The op is Rectangle-only (the IDML `<FrameFittingOption>` nests
 *  there). */
export function placeImageMutation(
  elementId: string,
  uri: string,
  fit: IdmlFit,
): Mutation {
  return { op: "placeImage", args: { elementId, uri, fit } };
}

// ── D-13 — data-driven rule application ─────────────────────────────────────

/** A character-range applyStyle for a story (the paragraph/character rule path).
 *  `scope` selects whether the named style is a paragraph or character style. */
function applyStyleMutation(
  storyId: string,
  start: number,
  end: number,
  style: string,
  scope: "paragraph" | "character",
): Mutation {
  return { op: "applyStyle", args: { storyId, start, end, style, scope } };
}

/** A per-cell appliedCellStyle for a lowered-table cell (the table rule path):
 *  `setElementProperty { NodeId::TableCell, appliedCellStyle }` — the S-04
 *  composition (no new wire). The named cell style must already exist (the
 *  caller `createCellStyle`s it once). */
function appliedCellStyleMutation(
  storyId: string,
  tableId: string,
  row: number,
  col: number,
  styleName: string,
): Mutation {
  return {
    op: "setElementProperty",
    args: {
      elementId: { kind: "tableCell", id: { story_id: storyId, table_id: tableId, row, col } },
      path: "appliedCellStyle",
      value: { type: "text", value: styleName } satisfies Value,
    },
  };
}

/** The address a fired rule applies its style to. The engine decided WHICH
 *  records fired (`evaluate_rule`); the host decides WHERE — a story range, or a
 *  table column over the fired rows. Caller-supplied (resolved from the bound
 *  region's lowered geometry), never inferred here. */
export type RuleTarget =
  | { kind: "storyRange"; storyId: string; start: number; end: number }
  | { kind: "tableColumn"; storyId: string; tableId: string; col: number; headerRows: number };

/** Translate a fired rule into host Mutations (D-13). A character/paragraph
 *  StyleAction over a story range emits one `applyStyle`; a table StyleAction
 *  over the fired rows emits one per-cell `appliedCellStyle` (the fired
 *  stabilized record index maps to a table row, offset past header rows). Pure:
 *  the engine's `fires`/`apply` decided everything; this is op shaping. */
export function ruleMutations(rule: RuleApplication, target: RuleTarget): Mutation[] {
  const { apply, fires } = rule;
  if (apply.kind === "character" || apply.kind === "paragraph") {
    if (target.kind !== "storyRange") return [];
    // A range rule fires once over its scope (the firing records are styled by
    // the host's range — the engine's row decision drives the table path).
    return [applyStyleMutation(target.storyId, target.start, target.end, apply.name, apply.kind)];
  }
  // Table style action → per-cell over the fired rows of the target column.
  if (target.kind !== "tableColumn") return [];
  return fires.map((recordIndex) =>
    appliedCellStyleMutation(
      target.storyId,
      target.tableId,
      recordIndex + target.headerRows,
      target.col,
      apply.name,
    ),
  );
}

/** The `createCellStyle` mutation to mint a rule's table style by name once
 *  (idempotent at the host: re-creating an existing self id is a no-op there).
 *  Paragraph/character rules use their named style as-is (assumed to exist). */
export function createRuleCellStyle(styleName: string): Mutation {
  return { op: "createCellStyle", args: { selfId: styleName, name: styleName } };
}
