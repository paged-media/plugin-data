// "Export as InDesign Data Merge template" (ADR 559 point 2).
//
//   · the writer, against the InDesign oracle: rewriting InDesign's own
//     `dm-base.idml` gives `dm-minimal.idml` — the minimal native form InDesign
//     2025 opened and merged — modulo `Self` ids;
//   · the data source is UTF-16 with a BOM (the only encoding InDesign merges);
//   · the session command on the real stack: a placed paged.data field and a
//     literal `<<field>>` become placeholders, the IDML loads back in core.

import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { dataMergeTemplate, readZip, utf16Csv, writeZip, type ZipEntry } from "../src/datamerge-export";
import { ENGINE_ANCHOR, openRealHost, REQUIRE_REAL_CORE } from "./real-core";
import { bootRealDuckDB, bootRealEngine, DATA_JS_WASM, REQUIRE_REAL_DUCKDB } from "./real-duckdb";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/indesign-datamerge/${name}`, import.meta.url))));
const text = (entries: readonly ZipEntry[], name: string) =>
  new TextDecoder().decode(entries.find((e) => e.name === name)?.bytes ?? new Uint8Array());

/** The Data Merge vocabulary of a package, `Self` ids replaced by their role. */
function dataMergeFacts(entries: readonly ZipEntry[]) {
  const story = entries
    .filter((e) => e.name.startsWith("Stories/"))
    .map((e) => new TextDecoder().decode(e.bytes))
    .join("\n");
  const sources = [...story.matchAll(/<HyperlinkTextSource Self="([^"]+)"[^>]*><Content>([^<]*)<\/Content><\/HyperlinkTextSource>/g)];
  const selfToField = new Map(sources.map((m) => [m[1]!, m[2]!]));
  const dm = text(entries, "designmap.xml");
  return {
    // The story's text, placeholders marked.
    story: story
      .replace(/<HyperlinkTextSource [^>]*>/g, "[")
      .replace(/<\/HyperlinkTextSource>/g, "]")
      .replace(/<\/?Content>/g, "")
      .replace(/\s+/g, " ")
      .match(/<CharacterStyleRange[^>]*>.*<\/CharacterStyleRange>/g)
      ?.map((r) => r.replace(/<\/?CharacterStyleRange[^>]*>/g, "|"))
      .join(""),
    destinations: [...dm.matchAll(/<HyperlinkURLDestination [^>]*Name="([^"]+)" DestinationURL="([^"]+)" Hidden="true"/g)].map((m) => [m[1], m[2]]),
    hyperlinks: [...dm.matchAll(/<Hyperlink Self="[^"]+" Name="([^"]+)" Source="([^"]+)"[^>]*>.*?<Destination type="object">([^<]+)<\/Destination>/gs)].map(
      (m) => [m[1], selfToField.get(m[2]!), m[3]],
    ),
    images: [...dm.matchAll(/<DataMergeImagePlaceholder [^>]*Field="([^"]+)" PlaceholderPageItem="([^"]+)"/g)].map((m) => [m[1], m[2]]),
    source: text(entries, "Resources/Preferences.xml").match(/<DataMerge [^>]*\/>\s*<DataMergeOption/)?.[0].replace(/\s+/g, " "),
  };
}

describe("the Data Merge template writer against InDesign's oracle [data.export.datamerge]", () => {
  it("dm-base rewritten is dm-minimal, modulo Self ids [data.export.datamerge]", async () => {
    const base = await readZip(fixture("dm-base.idml"));
    const want = await readZip(fixture("dm-minimal.idml"));
    const out = dataMergeTemplate(base, {
      texts: [],
      images: [{ frame: "uf5", field: "photo" }],
      dataSourceFile: "/tmp/paged-om-idrt-stage/dm.csv",
    });
    expect(out.skipped).toEqual([]);
    expect(out.fields).toEqual(["name", "sku", "@photo"]);
    const got = dataMergeFacts(out.entries);
    expect(got).toEqual(dataMergeFacts(want));
    expect(got.destinations).toEqual([
      ["DBF_name", "DBF_name"],
      ["DBF_sku", "DBF_sku"],
    ]);
    expect(got.images).toEqual([["photo", "uf5"]]);
    // Every Hyperlink names a source that exists, and Self ids are unique.
    const all = out.entries.map((e) => new TextDecoder().decode(e.bytes)).join("\n");
    const selfs = [...all.matchAll(/ Self="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(selfs).size).toBe(selfs.length);
    // The package is still a zip InDesign reads: mimetype first, stored.
    const zip = await writeZip(out.entries);
    expect(new TextDecoder().decode(zip.subarray(30, 38))).toBe("mimetype");
    expect((await readZip(zip)).map((e) => e.name)).toEqual(out.entries.map((e) => e.name));
  });

  it("the data source is UTF-16 LE with a BOM, image columns named @field [data.export.datamerge]", () => {
    const csv = utf16Csv(["name", "@photo"], [["Grüne, \"Äpfel\"", "red.png"]]);
    expect([...csv.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(new TextDecoder("utf-16le").decode(csv.subarray(2))).toBe('name,@photo\r\n"Grüne, ""Äpfel""",red.png\r\n');
  });
});

const probe = await bootRealDuckDB();
const ready = ENGINE_ANCHOR !== null && probe.handle !== undefined && existsSync(DATA_JS_WASM);

describe.skipIf(!ready && !(REQUIRE_REAL_CORE || REQUIRE_REAL_DUCKDB))("Export as InDesign Data Merge template, real stack [data.export.datamerge]", () => {
  it("a placed field and a literal <<field>> become native placeholders; core reads the result [data.export.datamerge]", async () => {
    vi.resetModules();
    vi.doMock("../src/engine", async (orig) => ({ ...(await orig<typeof import("../src/engine")>()), bootEngine: (t: number) => bootRealEngine(t) }));
    vi.doMock("../src/query/duckdb", async (orig) => ({
      ...(await orig<typeof import("../src/query/duckdb")>()),
      bootDuckDB: async () => (await bootRealDuckDB()).handle!,
    }));
    const mod = await import("../src/index");
    const h = await openRealHost();
    try {
      let host!: import("@paged-media/plugin-api").BundleHost;
      h.loadBundle({ ...mod.dataBundle, activate: (bh) => ((host = bh), mod.dataBundle.activate(bh)) } as typeof mod.dataBundle);
      const s = mod.sessionFor(host)!;
      await s.whenRestored();
      await s.registerCsvSource("products", "name,sku,photo\nGrüne Äpfel,A-1,red.png\nZeta Blue,B-2,blue.png\n");
      s.addQuery("q", "SELECT * FROM products", "recordStream");
      await s.refreshData();
      // A text frame: "SKU: <<sku>> / " then the placed variable field.
      const tf = await host.document.mutate({ op: "insertTextFrame", args: { pageId: "usp", bounds: [40, 40, 90, 400] } } as never);
      expect(tf.applied).toBe(true);
      const story = (await host.document.collection<{ selfId: string }>("stories"))[0]!.selfId;
      await host.document.mutate({ op: "insertText", args: { storyId: story, offset: 0, text: "SKU: <<sku>> / " } } as never);
      s.addVariableBinding("v_name", "v_name", "q", "name");
      s.addImageBinding("photo", "urect", "q", "photo");
      await s.lowerAll();
      expect((await host.document.placeholders()).map((p) => p.value)).toEqual(["Grüne Äpfel"]);

      const out = await s.exportDataMergeTemplate();
      expect(out.ok, out.reason).toBe(true);
      expect(out.skipped).toEqual([]);
      expect(out.fields).toEqual(["sku", "name", "@photo"]);
      const entries = await readZip(out.idml!);
      expect(entries.some((e) => e.name.startsWith("paged/") || e.name === "manifest.json")).toBe(false);
      const facts = dataMergeFacts(entries);
      expect(facts.story).toContain("SKU: [&lt;&lt;sku&gt;&gt;] / ");
      expect(facts.story).toContain("[&lt;&lt;name&gt;&gt;]");
      expect(facts.story).not.toContain("Grüne");
      expect(facts.destinations).toEqual([
        ["DBF_sku", "DBF_sku"],
        ["DBF_name", "DBF_name"],
      ]);
      expect(facts.hyperlinks.map((x) => x[1])).toEqual(["&lt;&lt;sku&gt;&gt;", "&lt;&lt;name&gt;&gt;"]);
      expect(facts.images).toEqual([["photo", "urect"]]);
      expect(facts.source).toContain('DataSourceFile="q.csv"');
      const csv = new TextDecoder("utf-16le").decode(out.csv!.subarray(2));
      expect(csv).toBe("sku,name,@photo\r\nA-1,Grüne Äpfel,red.png\r\nB-2,Zeta Blue,blue.png\r\n");
      // Core reads the template back (it is IDML).
      const back = await openRealHost();
      try {
        await back.load(out.idml!);
      } finally {
        back.dispose();
      }
    } finally {
      h.dispose();
    }
  });
});
