// ADR 559 — variable bindings as custom TEXT VARIABLES (engine protocol 71).
//
// From protocol 71 core can define a custom text variable, put instances of
// it into text and switch its contents with one `Set` that re-bakes every
// instance (`data-host-model/src/text-variables.ts` has the ops). InDesign
// keeps a text variable on save and shows its contents, where it drops our
// placeholder fields. So a new variable binding `k` is placed as the text
// variable `paged:k`; on an older engine it stays a placeholder field, and a
// document made with placeholder fields keeps being read and refreshed on
// every engine (the field loops see both carriers, `readTextVariableFields`).
//
// Feature detection costs no engine round trip of its own: `objects.kinds()`
// answers from the protocol the object model already probed (one
// `requestQuery`, once per host), and the engine's `textVariable` kind is
// there from protocol 71 on. The answer is kept per `host.objects`.

import type { BundleHost, ObjectsSurface } from "@paged-media/plugin-api";

import {
  keyOfTextVariable,
  OWN_TEXT_VARIABLES,
  TEXT_VARIABLE_SELF,
  textVariableField,
  type PlaceholderField,
} from "../../data-host-model/src";
import { objectsOf } from "./property-lane";

const detected = new WeakMap<object, Promise<boolean>>();

/** `host.objects` as a property read (no door call). */
const objectsProp = (host: BundleHost): ObjectsSurface | undefined => (host as { objects?: ObjectsSurface }).objects;

/** Whether this host's engine has custom text variables (protocol 71) — the
 *  carrier new variable bindings are placed as. Never throws. Once known for
 *  a `host.objects` it costs no call at all (the session asks as it starts,
 *  so no command pays for the first answer). */
export function textVariablesOn(host: BundleHost): Promise<boolean> {
  const known = objectsProp(host);
  const hit = known ? detected.get(known) : undefined;
  if (hit) return hit;
  const objects = objectsOf(host);
  if (!objects || !known) return Promise.resolve(false);
  const p = (async () => {
    try {
      return (await objects.kinds()).some((k) => k.owner === "core" && k.kind === "textVariable");
    } catch {
      return false;
    }
  })();
  detected.set(known, p);
  return p;
}

/** Our text variables: binding key → its `Self`. One query (by name); a
 *  variable whose `Self` is not the one core mints (InDesign re-spelled it on
 *  save) costs one name read. */
export async function ownTextVariables(host: BundleHost): Promise<Map<string, string>> {
  const objects = objectsProp(host);
  const out = new Map<string, string>();
  if (!objects) return out;
  for (const address of await objects.query(OWN_TEXT_VARIABLES)) {
    const id = address.slice("textVariable:".length);
    let key = id.startsWith(`${TEXT_VARIABLE_SELF}paged:`) ? keyOfTextVariable(id) : null;
    if (key === null) {
      const name = (await objects.get(address, "textVariableName")) as { kind?: string; value?: unknown };
      key = name.kind === "value" && typeof name.value === "string" ? keyOfTextVariable(name.value) : null;
    }
    if (key !== null && !out.has(key)) out.set(key, id);
  }
  return out;
}

/** Our text variables as fields (`PlaceholderField` with `variable` set),
 *  each with its current contents: one query plus one read per variable.
 *  Empty when the engine has none (or no text variables at all). */
export async function readTextVariableFields(host: BundleHost, key?: string): Promise<PlaceholderField[]> {
  if (!(await textVariablesOn(host))) return [];
  const objects = objectsProp(host)!;
  const out: PlaceholderField[] = [];
  for (const [k, id] of await ownTextVariables(host)) {
    if (key !== undefined && k !== key) continue;
    const v = (await objects.get(`textVariable:${id}`, "textVariableContents")) as { kind?: string; value?: unknown };
    const contents = v.kind === "value" && typeof v.value === "string" ? v.value : null;
    out.push(textVariableField(id, k, contents));
  }
  return out;
}
