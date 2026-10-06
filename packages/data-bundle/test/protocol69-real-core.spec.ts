// The protocol-69 consumers against the REAL engine (whichever canvas-wasm the
// suite boots, see real-core.ts): on protocol 69 the new path, on 68 the
// fallback — and the defects 69 fixes stay pinned against 68.
//
// - deleteRange undo puts the deleted runs and fields back (core ADR 127);
// - a field placed at the caret in the second paragraph lands at the caret
//   (insertField.contentOffset);
// - the session version named in the document label: the label rides the
//   write, an undo takes it back, and a reopened copy restores the labelled
//   version; on 68 nothing is labelled and session.json alone is written.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BundleHost, Mutation } from "@paged-media/plugin-api";
import { defineBundle, type HeadlessHost } from "@paged-media/plugin-sdk";

import manifestJson from "../manifest.json";

import { labelledVersion, sessionVersionPath } from "../src/doc-label";
import { documentLabelDoors, engineHasDocumentLabels } from "../src/doors";
import type { DataEngineLike } from "../src/engine";
import { commitLoweredVariable } from "../src/lower";
import { ENGINE_ANCHOR, ENGINE_PROTOCOL, fixedFrom, openRealHost, REQUIRE_REAL_CORE } from "./real-core";

const run = ENGINE_ANCHOR !== null || REQUIRE_REAL_CORE;
const PLUGIN = "media.paged.data";

/** A text frame on the fixture page holding `text`; returns its story. */
async function storyWith(host: BundleHost, text: string): Promise<string> {
  const o = await host.document.mutate({
    op: "batch",
    args: {
      ops: [
        { op: "insertTextFrame", args: { pageId: "usp", bounds: [100, 100, 300, 400] } },
        { op: "bindCreated", args: { handle: "f" } },
        { op: "insertText", args: { storyId: "$h:f", offset: 0, text } },
      ],
    },
  } as Mutation);
  expect(o.applied).toBe(true);
  return (o as { minted?: { storyId: string | null }[] }).minted![0]!.storyId!;
}

async function storyText(host: BundleHost, storyId: string): Promise<string> {
  const c = await host.document.storyContent(storyId);
  return c ? c.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n") : "";
}

async function ours(host: BundleHost) {
  return (await host.document.placeholders()).filter((p) => p.plugin === PLUGIN);
}

describe.skipIf(!run)(`protocol-69 doors on the real engine (protocol ${ENGINE_PROTOCOL}) [data.lower.v43-consumers]`, () => {
  let h: HeadlessHost | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  fixedFrom(69, it)("DEFECT core <69: undoing a deleteRange over a field puts the field back [data.lower.v43-consumers]", async () => {
    h = await openRealHost();
    const host = h.host;
    const story = await storyWith(host, "ab");
    await host.document.mutate({
      op: "insertField",
      args: { storyId: story, offset: 1, field: { placeholder: { plugin: PLUGIN, key: "k", value: "VALUE" } } },
    });
    expect((await ours(host)).map((f) => f.key)).toEqual(["k"]);
    const before = await storyText(host, story);
    const del = await host.document.mutate({ op: "deleteRange", args: { storyId: story, start: 0, end: before.length } });
    expect(del.applied).toBe(true);
    expect(await ours(host)).toEqual([]);
    await host.document.undo();
    expect(await storyText(host, story)).toBe(before);
    expect((await ours(host)).map((f) => [f.key, f.value])).toEqual([["k", "VALUE"]]);
  });

  fixedFrom(69, it)("DEFECT core <69: a field placed at the caret in the second paragraph lands at the caret [data.lower.v43-consumers]", async () => {
    h = await openRealHost();
    const story = await storyWith(h.host, "abc\ndef");
    // The caret between "de" and "f": 3 bytes + 1 paragraph mark + 2 = 6.
    const caretHost = new Proxy(h.host, {
      get(t, p, r) {
        if (p === "text") return { ...t.text, caret: () => ({ storyId: story, offset: 6 }) };
        if (p === "supports") return (f: string) => f === "text.caret@1" || t.supports(f);
        return Reflect.get(t, p, r);
      },
    });
    const placed = await commitLoweredVariable(caretHost, { kind: "variable", target: "a", text: "X", hidden: false } as never, "k");
    expect(placed).not.toBeNull();
    expect(await storyText(h.host, story)).toBe("abc\ndeXf");
  });

  it("the engine probe agrees with the engine: page handles and labels on 69 only [data.plugin.persistence]", async () => {
    h = await openRealHost();
    const detected = await engineHasDocumentLabels(h.host);
    expect(detected).toBe(ENGINE_PROTOCOL >= 69 && documentLabelDoors(h.host) !== null);
  });
});

// ── the session label on the real engine ────────────────────────────────────

/** This plugin's own host over a headless engine (its metadata key, its
 *  parts), as the editor hands it to the bundle. */
function bundleHost(h: HeadlessHost): BundleHost {
  let captured: BundleHost | null = null;
  h.loadBundle(
    defineBundle({
      manifest: manifestJson as never,
      activate(host) {
        captured = host;
        return { dispose() {} };
      },
    }),
  );
  return captured!;
}

function fakeEngine(over: Partial<DataEngineLike> = {}): DataEngineLike {
  const bindings: { id: string; kind: string }[] = [];
  return {
    define_source() {},
    define_query() {},
    define_binding(def: unknown) {
      bindings.push({ id: String((def as { id: string }).id), kind: "variable" });
    },
    define_placeholder() {},
    set_param() {},
    set_locale() {},
    ingest_result() {},
    resolve_lowered: (id: string) => ({ kind: "variable", target: id, text: `${id}-value`, hidden: false }),
    sync_state: () => null,
    sync_report: () => [],
    pin() {},
    mark_overridden() {},
    relink() {},
    payload: () => ({ bindings: [...bindings], queries: [] }),
    load_payload() {},
    metadata: () => ({}),
    free() {},
    ...over,
  } as unknown as DataEngineLike;
}

async function sessionOver(host: BundleHost, engine: DataEngineLike) {
  vi.resetModules();
  vi.doMock("../src/engine", async (orig) => ({
    ...(await orig<typeof import("../src/engine")>()),
    bootEngine: async () => engine,
  }));
  vi.doMock("../src/query/duckdb", async (orig) => ({
    ...(await orig<typeof import("../src/query/duckdb")>()),
    bootDuckDB: async () => ({
      registerCsv: async () => {},
      registerFileBuffer: async () => {},
      query: async () => ({}),
      close: async () => {},
    }),
  }));
  const { createSession } = await import("../src/session");
  return createSession(host, 20613);
}

describe.skipIf(!run)(`the session label on the real engine (protocol ${ENGINE_PROTOCOL}) [data.plugin.persistence]`, () => {
  let h: HeadlessHost | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  it("names the live version in the document label on 69, writes session.json alone before [data.plugin.persistence]", async () => {
    h = await openRealHost();
    const host = bundleHost(h);
    const labels = (await engineHasDocumentLabels(host)) ? documentLabelDoors(host) : null;
    const s = await sessionOver(host, fakeEngine());
    // A placed field for the refresh to rewrite.
    const story = await storyWith(host, "");
    await host.document.mutate({
      op: "insertField",
      args: { storyId: story, offset: 0, field: { placeholder: { plugin: PLUGIN, key: "v", value: "old" } } },
    });
    s.addVariableBinding("v", "anchor", "q", "a");
    expect(await s.refreshFields()).toBe(1);
    await s.flushPersist();
    const parts = await host.parts.list("");
    if (!labels) {
      expect(parts.some((p) => p.includes("sessions/"))).toBe(false);
      expect(parts.some((p) => p.endsWith("session.json"))).toBe(true);
      return;
    }
    // The refresh's write carried the label naming the version it wrote.
    const first = labelledVersion(await labels.getDocumentMetadata());
    expect(first).not.toBeNull();
    expect(await host.parts.read(sessionVersionPath(first!))).not.toBeNull();

    // A second binding and refresh: a new version, labelled by its write.
    await host.document.mutate({
      op: "insertField",
      args: { storyId: story, offset: 0, field: { placeholder: { plugin: PLUGIN, key: "w", value: "old" } } },
    });
    s.addVariableBinding("w", "anchor", "q", "b");
    await s.refreshFields();
    const second = labelledVersion(await labels.getDocumentMetadata());
    expect(second).not.toBe(first);

    // Undo the second refresh: values and label go back together.
    await host.document.undo();
    expect(labelledVersion(await labels.getDocumentMetadata())).toBe(first);
    expect((await ours(host)).find((f) => f.key === "w")?.value).toBe("old");

    // A copy of the document restores the labelled version.
    const bytes = await (host as unknown as { documents: { exportPaged(): Promise<Uint8Array> } }).documents.exportPaged();
    const copy = await openRealHost();
    try {
      await copy.load(bytes);
      const copyHost = bundleHost(copy);
      const doors = documentLabelDoors(copyHost)!;
      expect(labelledVersion(await doors.getDocumentMetadata())).toBe(first);
      expect(await copyHost.parts.read(sessionVersionPath(first!))).not.toBeNull();
    } finally {
      copy.dispose();
    }
  });
});
