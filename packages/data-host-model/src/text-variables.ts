// ADR 559 — a variable binding's native InDesign form: a CUSTOM TEXT VARIABLE
// (engine protocol 71). InDesign drops a plugin placeholder field on save and
// keeps a text variable, showing its contents; so from protocol 71 on a
// variable binding `k` is the text variable `paged:k`, whose contents is the
// last resolved value. One `Set` on `textVariableContents` re-bakes every
// instance of it (one undo step). Older engines keep the placeholder field
// (`fields.ts`), and documents made with one keep being read and refreshed.
//
// Also here: the address spellings the binding writes need (core 71's
// grammar, ADR 131). Pure: data in, ops out.

import type { Mutation, ObjectOp } from "@paged-media/plugin-api";

import type { PlaceholderField } from "./fields";

/** The prefix of every text variable a variable binding owns. */
export const TEXT_VARIABLE_PREFIX = "paged:";

/** InDesign's `Self` for a text variable: this prefix plus its name (core
 *  mints the same, so the address is known before the create lands). An
 *  InDesign SAVE re-spells it: `dTextVariablenpaged-v_name` for the variable
 *  named `paged:v_name` (measured, InDesign 2025, `conformance/indesign-
 *  binding/recorded/bound71.rt.idml`), so a variable is ours by its NAME, and
 *  its `Self` is read, never derived, once a document has been through
 *  InDesign. */
export const TEXT_VARIABLE_SELF = "dTextVariablen";

/** The selector of every text variable our bindings own (by name). */
export const OWN_TEXT_VARIABLES = `textVariable[name^="${"paged:"}"]`;

/** The text variable name of variable binding `key`. */
export function textVariableName(key: string): string {
  return `${TEXT_VARIABLE_PREFIX}${key}`;
}

/** The `Self` of variable binding `key`'s text variable. */
export function textVariableId(key: string): string {
  return `${TEXT_VARIABLE_SELF}${textVariableName(key)}`;
}

/** `textVariable:<id>`. The id runs to the end of the address, so nothing in
 *  it is escaped (core 71's grammar: `%` escapes only where an id stops at a
 *  delimiter). */
export function textVariableAddress(id: string): string {
  return `textVariable:${id}`;
}

/** The binding key a text variable name — or the id/address core minted for
 *  it (`dTextVariablenpaged:<key>`) — belongs to, or null when it is not one
 *  of ours. An id InDesign re-spelled is not recognised: read its name. */
export function keyOfTextVariable(idNameOrAddress: string): string | null {
  let s = idNameOrAddress;
  if (s.startsWith("textVariable:")) s = s.slice("textVariable:".length);
  if (s.startsWith(TEXT_VARIABLE_SELF)) s = s.slice(TEXT_VARIABLE_SELF.length);
  if (!s.startsWith(TEXT_VARIABLE_PREFIX)) return null;
  const key = s.slice(TEXT_VARIABLE_PREFIX.length);
  return key.length > 0 ? key : null;
}

/** The text a text variable shows for a resolved value: a value that did not
 *  resolve (null) shows `<key>`, as the placeholder field does. */
export function textVariableContents(key: string, value: string | null): string {
  return value ?? `<${key}>`;
}

/** The value a text variable's contents stands for (inverse of
 *  {@link textVariableContents}). */
export function valueOfContents(key: string, contents: string | null): string | null {
  return contents === null || contents === `<${key}>` ? null : contents;
}

/** Define binding `key`'s custom text variable with its first value. */
export function createTextVariableMutation(key: string, value: string | null): Mutation {
  return {
    op: "createTextVariable",
    args: { name: textVariableName(key), contents: textVariableContents(key, value) },
  } as Mutation;
}

/** Insert an instance of text variable `id` (its `Self`) into a story. The
 *  offsets follow `insertFieldMutation` (`contentOffset` is the caret unit). */
export function insertTextVariableMutation(
  storyId: string,
  offset: number,
  id: string,
  contentOffset?: number,
): Mutation {
  return {
    op: "insertField",
    args: {
      storyId,
      offset,
      field: { textVariable: { variableId: id } },
      ...(contentOffset !== undefined ? { contentOffset } : {}),
    },
  } as Mutation;
}

/** Switch the value of a text variable (`id`, its `Self`): one wire `Set` on
 *  `textVariableContents`, which re-bakes every instance. */
export function setTextVariableMutation(id: string, key: string, value: string | null): Mutation {
  return {
    op: "set",
    args: {
      address: textVariableAddress(id),
      path: "textVariableContents",
      value: { type: "text", value: textVariableContents(key, value) },
    },
  } as Mutation;
}

/** One of our text variables as the field loops see it: a pseudo field whose
 *  `storyId` is its address (unique per variable, so `backToFront` leaves it
 *  alone) and whose `variable` names the text variable. */
export function textVariableField(id: string, key: string, contents: string | null): PlaceholderField {
  return {
    storyId: textVariableAddress(id),
    offset: 0,
    plugin: "media.paged.data",
    key,
    value: valueOfContents(key, contents),
    variable: id,
  };
}

/** The write a refresh makes for one field: `setFieldValue` on a placeholder
 *  field, a `Set` on a text variable. */
export function fieldWriteMutation(
  w: { storyId: string; offset: number; key: string; variable?: string },
  value: string | null,
): Mutation {
  return w.variable
    ? setTextVariableMutation(w.variable, w.key, value)
    : ({ op: "setFieldValue", args: { storyId: w.storyId, offset: w.offset, value } } as Mutation);
}

// ── addresses (core 71, ADR 131) ────────────────────────────────────────────

/** Core's `enc`: `%` and the delimiters as `%XX` (UTF-8 bytes). */
export function encodeAddressPart(id: string, delimiters: string): string {
  let out = "";
  for (const ch of id) {
    if (ch === "%" || delimiters.includes(ch)) {
      for (const b of new TextEncoder().encode(ch)) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** `cell:<table>/<row>,<col>` (zero-based); the table id stops at `/`, so a
 *  `/` or `%` in it is escaped. */
export function cellAddress(tableId: string, row: number, col: number): string {
  return `cell:${encodeAddressPart(tableId, "/")}/${row},${col}`;
}

/** The style ref a cell style is applied by: its `Self`. */
export function cellStyleSelf(name: string): string {
  return name.startsWith("CellStyle/") ? name : `CellStyle/${name}`;
}

/** The ops a fired table rule writes on protocol 71 (ADR 558: the rule is a
 *  property binding over `appliedCellStyle`): the cell style created in the
 *  same batch when the document has none by that name (one undo step), then
 *  one `set` per fired record's cell. `existing` is the style's `Self` when the
 *  document has it. */
export function ruleCellOps(
  tableId: string,
  col: number,
  headerRows: number,
  fires: readonly number[],
  styleName: string,
  existing: string | null,
): ObjectOp[] {
  if (fires.length === 0) return [];
  const ops: ObjectOp[] = [];
  const self = existing ?? cellStyleSelf(styleName);
  if (!existing) ops.push({ op: "create", kind: "style", props: { family: "cell", name: styleName.replace(/^CellStyle\//, "") } });
  for (const r of fires) {
    ops.push({ op: "set", address: cellAddress(tableId, r + headerRows, col), path: "appliedCellStyle", value: self });
  }
  return ops;
}
