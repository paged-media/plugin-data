// paged.data's OWN object model (ADR 323; the object-model program, Wave 4):
// its sources, queries, bindings, data sets and variables are addressable
// (`plugin:media.paged.data/<kind>/<id>`), readable and settable through
// `host.objects`, so a Boa script, the Node CLI and the editor drive the data
// plugin the way they drive a frame. Plus the typed commands (refresh,
// apply, data sets, "Bind to data…", the Data Merge template export).
//
// The schema rows are the manifest's (`contributes.objectModel`): one
// source, so the runtime registration and the declaration cannot drift.
//
// What a write is: session state, not document content. A `set` changes the
// session (define / redefine via the session — the same paths the panels
// use) and returns no mutations: zero undo steps. What a binding then
// WRITES into the document is undoable as always (`apply`, one step).
// One exception, by design: a binding's definition rides its target's
// element label (ADR 559), so a binding write (create / set / delete)
// returns that label change, plus the document label naming the new session
// version, as its ObjectWrite: ONE undo step host.objects reports, and
// undoing it takes the session back with the labels (the session follows
// the document label, whose version holds the old definition).

import type {
  BundleHost,
  Disposable,
  ObjectKindContribution,
  ObjectModelContribution,
  ObjectOp,
  ObjectValue,
  ObjectWrite,
  PropertySchema,
  TypedCommandContribution,
  ValueType,
} from "@paged-media/plugin-api";

import manifest from "../manifest.json";
import { objectsOf } from "./property-lane";
import type { PropertyBindingSpec } from "./property-session";
import type { DataSourceSession } from "./session";

export const PLUGIN_ID = "media.paged.data";

export type KindName = "source" | "query" | "binding" | "dataSet" | "variable";

/** The schema-driven panel fields (ADR 323 §4): the rows the "Data objects"
 *  panel shows for the picked item of each kind, in panel order, rendered by
 *  the host's shared `PropertyField` over `host.objects`. Every schema row of
 *  every kind is here (a spec holds it to that); read-only and derived rows
 *  render read-only from the schema. */
export const PANEL_FIELDS: ReadonlyArray<{ kind: KindName; path: string; group: string }> = [
  { kind: "source", path: "name", group: "Sources" },
  { kind: "source", path: "type", group: "Sources" },
  { kind: "source", path: "fileName", group: "Sources" },
  { kind: "source", path: "url", group: "Sources" },
  { kind: "source", path: "refresh", group: "Sources" },
  { kind: "source", path: "relink", group: "Sources" },
  { kind: "query", path: "sql", group: "Queries" },
  { kind: "query", path: "shape", group: "Queries" },
  { kind: "query", path: "recordCount", group: "Queries" },
  { kind: "binding", path: "kind", group: "Bindings" },
  { kind: "binding", path: "query", group: "Bindings" },
  { kind: "binding", path: "target", group: "Bindings" },
  { kind: "binding", path: "path", group: "Bindings" },
  { kind: "binding", path: "expr", group: "Bindings" },
  { kind: "binding", path: "coerce", group: "Bindings" },
  { kind: "binding", path: "missing", group: "Bindings" },
  { kind: "binding", path: "status", group: "Bindings" },
  { kind: "binding", path: "definition", group: "Bindings" },
  { kind: "dataSet", path: "name", group: "Data sets" },
  { kind: "dataSet", path: "values", group: "Data sets" },
  { kind: "variable", path: "name", group: "Variables" },
  { kind: "variable", path: "trait", group: "Variables" },
  { kind: "variable", path: "bound", group: "Variables" },
];

/** The manifest schema rows of one kind (for validatePanelSchema). */
export function schemaOf(kind: KindName): PropertySchema[] | undefined {
  return declared.kinds.find((x) => x.kind === kind)?.schema;
}

const declared = (manifest.contributes as unknown as {
  objectModel: {
    kinds: { kind: KindName; title: string; schema: PropertySchema[] }[];
    commands: { id: string; title: string; args: ValueType }[];
  };
}).objectModel;

export const addressOf = (kind: KindName, id: string) => `plugin:${PLUGIN_ID}/${kind}/${id}`;

function idOf(address: string, kind: KindName): string | null {
  const prefix = `plugin:${PLUGIN_ID}/${kind}/`;
  return address.startsWith(prefix) ? address.slice(prefix.length) : null;
}

const val = (value: unknown): ObjectValue => ({ kind: "value", value });
const unknown = (address: string): ObjectValue => ({ kind: "refused", code: "unknownAddress", reason: `no ${address}` });
const none: ObjectWrite = { kind: "mutations", mutations: [] };
const no = (reason: string): ObjectWrite => ({ kind: "rejected", reason });

const SHAPES = ["recordStream", "singleRecord", "scalar"] as const;

/** Read the engine's recipe (sources, queries, bindings, data sets). */
async function recipe(session: DataSourceSession) {
  return (await session.recipe()) as {
    sources?: { id: string; kind?: { kind?: string; format?: string; name?: string; url?: string } }[];
    queries?: { id: string; sql?: string; shape?: { shape?: string } }[];
    bindings?: { id: string; kind: string; [k: string]: unknown }[];
    variables?: {
      variables?: { name: string; trait: string }[];
      dataSets?: { name: string; values: Record<string, Record<string, unknown>> }[];
    };
  };
}

function displayOf(v: Record<string, unknown>): string {
  for (const k of ["text", "href", "visible", "value", "raw"]) {
    if (k in v) return typeof v[k] === "string" ? (v[k] as string) : JSON.stringify(v[k]);
  }
  return "";
}

function kinds(host: BundleHost, session: DataSourceSession): ObjectKindContribution[] {
  const rows = (k: KindName) => declared.kinds.find((x) => x.kind === k)!.schema;
  const base = (k: KindName) => ({
    kind: k,
    title: declared.kinds.find((x) => x.kind === k)!.title,
    schema: rows(k),
    hostOf: () => null,
  });

  const source: ObjectKindContribution = {
    ...base("source"),
    async list() {
      const st = session.getState();
      return st.sources.map((s) => addressOf("source", s));
    },
    async get(address, path) {
      const id = idOf(address, "source");
      const st = session.getState();
      if (!id || !st.sources.includes(id)) return unknown(address);
      const def = (await recipe(session)).sources?.find((s) => s.id === id);
      const file = st.files.find((f) => f.source === id) as { fileName?: string; format?: string } | undefined;
      const remote = st.remote.find((r) => r.name === id);
      switch (path) {
        case "name":
          return val(id);
        case "type": {
          const t = remote ? "remote" : (file?.format ?? def?.kind?.format ?? "csv");
          return val(["csv", "tsv", "json", "parquet", "xlsx", "remote"].includes(t) ? t : "other");
        }
        case "fileName":
          return val(file?.fileName ?? def?.kind?.name ?? null);
        case "url":
          return val(remote?.url ?? def?.kind?.url ?? null);
        case "refresh":
          return val(session.getRefreshPolicy(id).policy);
        case "relink":
          return val((st.relink ?? []).includes(id));
        default:
          return { kind: "absent" };
      }
    },
    async set(address, path, value) {
      const id = idOf(address, "source");
      if (!id || !session.getState().sources.includes(id)) return no(`no source ${address}`);
      if (path !== "refresh") return no(`${path} is read-only`);
      const policy = value === "interval" ? { policy: "interval" as const, secs: 300 } : { policy: value as "manual" | "onOpen" };
      const refused = session.setRefreshPolicy(id, policy);
      return refused ? no(refused) : none;
    },
  };

  const query: ObjectKindContribution = {
    ...base("query"),
    async list() {
      return session.listQueries().map((q) => addressOf("query", q.id));
    },
    async get(address, path) {
      const id = idOf(address, "query");
      const def = (await recipe(session)).queries?.find((q) => q.id === id);
      if (!id || !def) return unknown(address);
      if (path === "sql") return val(def.sql ?? "");
      if (path === "shape") return val(def.shape?.shape ?? "recordStream");
      if (path === "recordCount") return val(await session.recordCount(id));
      return { kind: "absent" };
    },
    async batch(ops) {
      for (const op of ops) {
        if (op.op === "create") {
          const p = (op.props ?? {}) as { sql?: string; shape?: string };
          const id = op.handle ?? (op.props as { id?: string } | undefined)?.id;
          if (!id || typeof p.sql !== "string") return no("create query: props { sql } and a handle (the query id)");
          session.addQuery(id, p.sql, (p.shape as (typeof SHAPES)[number]) ?? "recordStream");
          continue;
        }
        if (op.op !== "set") return no(`${op.op} is not supported on queries`);
        const id = idOf(op.address, "query");
        const def = (await recipe(session)).queries?.find((q) => q.id === id);
        if (!id || !def) return no(`no query ${op.address}`);
        const sql = op.path === "sql" ? String(op.value) : (def.sql ?? "");
        const shape = (op.path === "shape" ? op.value : (def.shape?.shape ?? "recordStream")) as (typeof SHAPES)[number];
        if (op.path !== "sql" && op.path !== "shape") return no(`${op.path} is read-only`);
        session.addQuery(id, sql, shape);
      }
      return none;
    },
  };

  const binding: ObjectKindContribution = {
    ...base("binding"),
    async list() {
      return session.listBindings().map((b) => addressOf("binding", b.id));
    },
    async get(address, path) {
      const id = idOf(address, "binding");
      const def = id ? await session.bindingDefinition(id) : null;
      if (!id || !def) return unknown(address);
      switch (path) {
        case "kind":
          return val(def.kind);
        case "query":
          return def.query ? val(addressOf("query", String(def.query))) : { kind: "absent" };
        case "expr":
          return typeof def.expr === "string" ? val(def.expr) : typeof def.when === "string" ? val(def.when) : { kind: "absent" };
        case "target": {
          const sel = (def.target as { selector?: string } | null)?.selector;
          return def.kind === "property" && sel ? val(sel) : { kind: "absent" };
        }
        case "path":
          return def.kind === "property" ? val(def.path) : def.kind === "visibility" ? val("elementVisible") : { kind: "absent" };
        case "coerce":
          return def.kind === "property" ? val(def.coerce ?? "strict") : { kind: "absent" };
        case "missing":
          return def.kind === "property" ? val(def.missing ?? "keepLast") : { kind: "absent" };
        case "status":
          return val(session.syncStatusOf(id) ?? "linked");
        case "definition":
          return val(JSON.stringify(def));
        default:
          return { kind: "absent" };
      }
    },
    async batch(ops: readonly ObjectOp[]) {
      // The labels are planned once, after every op: one write for the batch.
      const defer = { labels: "defer" as const };
      await session.beforeObjectWrite();
      for (const op of ops) {
        if (op.op === "delete") {
          const id = idOf(op.address, "binding");
          if (!id || !(await session.removeBinding(id, defer))) return no(`no binding ${op.address}`);
          continue;
        }
        if (op.op === "create") {
          const p = (op.props ?? {}) as Record<string, unknown>;
          const def = typeof p.definition === "string" ? (JSON.parse(p.definition) as Record<string, unknown>) : null;
          const id = op.handle ?? (def?.id as string | undefined);
          if (!id) return no("create binding: a handle (the binding id) or a definition with an id");
          const r = def
            ? await session.redefineBinding({ ...def, id }, defer)
            : await session.addPropertyBinding(
                id,
                {
                  target: String(p.target ?? ""),
                  path: String(p.path ?? ""),
                  query: String(p.query ?? "").replace(`plugin:${PLUGIN_ID}/query/`, ""),
                  expr: String(p.expr ?? ""),
                  ...(p.coerce ? { coerce: p.coerce as "strict" } : {}),
                  ...(p.missing ? { missing: p.missing as "keepLast" } : {}),
                },
                defer,
              );
          if (!r.ok) return no(r.reason ?? "refused");
          continue;
        }
        if (op.op !== "set") return no(`${op.op} is not supported on bindings`);
        const id = idOf(op.address, "binding");
        const def = id ? await session.bindingDefinition(id) : null;
        if (!id || !def) return no(`no binding ${op.address}`);
        if (op.path === "status") {
          if (op.value === "pinned") session.setPinned(id, true);
          else if (op.value === "linked") session.setPinned(id, false);
          else return no(`status can be set to pinned or linked, not ${String(op.value)}`);
          continue;
        }
        let next: Record<string, unknown>;
        if (op.path === "definition") {
          try {
            next = { ...(JSON.parse(String(op.value)) as Record<string, unknown>), id };
          } catch {
            return no("the definition is not JSON");
          }
        } else if (op.path === "query") {
          next = { ...def, query: String(op.value).replace(`plugin:${PLUGIN_ID}/query/`, "") };
        } else if (op.path === "expr") {
          next = def.kind === "rule" ? { ...def, when: op.value } : { ...def, expr: op.value };
        } else if (op.path === "target") {
          if (def.kind !== "property") return no("only a property binding has a selector target");
          next = { ...def, target: { selector: String(op.value) } };
        } else if (["path", "coerce", "missing"].includes(op.path)) {
          if (def.kind !== "property") return no(`${op.path} applies to property bindings`);
          next = { ...def, [op.path]: op.value };
          if (op.path === "path") delete next.schema; // read again for the new path
        } else {
          return no(`${op.path} is read-only`);
        }
        const r = await session.redefineBinding(next, defer);
        if (!r.ok) return no(r.reason ?? "refused");
      }
      const mutations = await session.labelOpsForObjects();
      return mutations.length > 0 ? { kind: "mutations", mutations } : none;
    },
  };

  const dataSet: ObjectKindContribution = {
    ...base("dataSet"),
    async list() {
      return (await session.listDataSets()).map((n) => addressOf("dataSet", n));
    },
    async get(address, path) {
      const id = idOf(address, "dataSet");
      const set = (await recipe(session)).variables?.dataSets?.find((d) => d.name === id);
      if (!id || !set) return unknown(address);
      if (path === "name") return val(set.name);
      if (path === "values") {
        return val(Object.fromEntries(Object.entries(set.values).map(([k, v]) => [k, displayOf(v)])));
      }
      return { kind: "absent" };
    },
    async batch(ops) {
      for (const op of ops) {
        if (op.op === "delete") {
          const id = idOf(op.address, "dataSet");
          if (!id || !(await session.deleteDataSet(id))) return no(`no data set ${op.address}`);
          continue;
        }
        if (op.op === "create") {
          const name = op.handle ?? (op.props as { name?: string } | undefined)?.name;
          if (!name) return no("create dataSet: a handle (the data set name)");
          await session.captureDataSet(name, 0);
          continue;
        }
        return no(`${op.op} is not supported on data sets (apply one with media.paged.data.applyDataSet)`);
      }
      return none;
    },
  };

  const variable: ObjectKindContribution = {
    ...base("variable"),
    async list() {
      return (await session.variables()).map((v) => addressOf("variable", v.name));
    },
    async get(address, path) {
      const id = idOf(address, "variable");
      const v = (await session.variables()).find((x) => x.name === id);
      if (!id || !v) return unknown(address);
      if (path === "name") return val(v.name);
      if (path === "trait") return val(v.trait);
      if (path === "bound") return val(v.bound);
      return { kind: "absent" };
    },
  };

  void host;
  return [source, query, binding, dataSet, variable];
}

/** Define (or redefine) a property binding the way host.objects does: a
 *  `create` op on the binding kind, so the definition's labels and the
 *  session version land as ONE undo step the session follows. The Bindings
 *  panel's "Bind" uses it. Without host.objects (or the data kinds), the
 *  session defines it directly (its labels then ride their own write, which
 *  carries the session label too). */
export async function defineBinding(
  host: BundleHost,
  session: DataSourceSession,
  id: string,
  spec: PropertyBindingSpec,
): Promise<{ ok: boolean; reason?: string }> {
  const objects = objectsOf(host);
  const kind = `plugin:${PLUGIN_ID}/binding`;
  let registered = false;
  try {
    registered = !!objects && typeof objects.batch === "function" && (await objects.kinds()).some((k) => k.kind === kind);
  } catch {
    registered = false;
  }
  if (!objects || !registered) return session.addPropertyBinding(id, spec);
  let schema: unknown;
  try {
    schema = typeof spec.schema === "string" ? JSON.parse(spec.schema) : spec.schema;
  } catch {
    return { ok: false, reason: "the schema row is not JSON" };
  }
  const definition = {
    id,
    kind: "property",
    target: { selector: spec.target },
    path: spec.path,
    query: spec.query,
    expr: spec.expr,
    ...(spec.coerce ? { coerce: spec.coerce } : {}),
    ...(spec.missing ? { missing: spec.missing } : {}),
    ...(schema && typeof schema === "object" ? { schema } : {}),
  };
  const out = await objects.batch([{ op: "create", kind, handle: id, props: { definition: JSON.stringify(definition) } }]);
  return out.applied ? { ok: true } : { ok: false, reason: out.reason ?? "refused" };
}

function commands(host: BundleHost, session: DataSourceSession, panels: { bindings: string }): TypedCommandContribution[] {
  const spec = (id: string) => declared.commands.find((c) => c.id === id)!;
  const cmd = <A>(id: string, handler: (args: A) => unknown): TypedCommandContribution =>
    ({ id, title: spec(id).title, args: spec(id).args, handler: (_ctx: unknown, args: A) => handler(args) }) as TypedCommandContribution;
  return [
    cmd<{ selector: string; path: string; schema: string }>("media.paged.data.bindProperty", async (a) => {
      // "Bind to data…" on a schema-driven field: remember the target and
      // open the Bindings panel, which asks for the query and the expression.
      session.setPropertyDraft({ selector: a.selector, path: a.path, schema: a.schema });
      let opened = false;
      try {
        host.shell.openPanel(panels.bindings);
        opened = true;
      } catch {
        opened = false; // headless: define it with media.paged.data.defineProperty
      }
      return { status: "draft", opened };
    }),
    cmd<{ id: string; selector: string; path: string; query: string; expr: string }>(
      "media.paged.data.defineProperty",
      async (a) => session.addPropertyBinding(a.id, { target: a.selector, path: a.path, query: a.query, expr: a.expr }),
    ),
    cmd<{ address: string; path: string }>("media.paged.data.propertyBindings", (a) =>
      session.propertyBindings({ ...(a.address ? { address: a.address } : {}), ...(a.path ? { path: a.path } : {}) }),
    ),
    cmd<Record<string, never>>("media.paged.data.refresh", async () => {
      await session.refreshData();
      return session.getState().message;
    }),
    cmd<{ record: number }>("media.paged.data.apply", async (a) => {
      await session.refreshData();
      if (a.record > 0) {
        for (const b of session.listBindings()) await session.previewRecord(b.id, a.record);
      } else {
        await session.lowerAll();
      }
      return session.getState().message;
    }),
    cmd<{ name: string; csv: string }>("media.paged.data.defineSource", async (a) => {
      await session.registerCsvSource(a.name, a.csv);
      return session.getState().sources;
    }),
    cmd<{ name: string; record: number }>("media.paged.data.captureDataSet", (a) => session.captureDataSet(a.name, a.record)),
    cmd<{ name: string }>("media.paged.data.applyDataSet", (a) => session.applyDataSet(a.name)),
    cmd<{ save: boolean }>("media.paged.data.exportDataMergeTemplate", (a) => session.exportDataMergeTemplate({ save: a.save })),
  ];
}

/** Register the object model; a no-op on a host without the door. */
export function contributeObjectModel(
  host: BundleHost,
  session: DataSourceSession,
  panels: { bindings: string },
): Disposable | null {
  const contribute = host.contribute as { objectModel?: (m: ObjectModelContribution) => Disposable };
  if (typeof contribute.objectModel !== "function" || !host.supports("contribute.objectModel@1")) return null;
  void objectsOf;
  return contribute.objectModel({ kinds: kinds(host, session), commands: commands(host, session, panels) });
}
