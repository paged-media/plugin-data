// "Export as InDesign Data Merge template" (ADR 559 point 2). A `.paged`
// is valid IDML; this rewrites a copy of it into the NATIVE Data Merge form
// the 2026-10-06 InDesign 2025 survey verified as the minimal set that
// opens and merges:
//
//   · Stories: every merge field is the literal `<<field>>` wrapped in a
//     `<HyperlinkTextSource>` (a placed paged.data field becomes `<<column>>`;
//     a literal `<<field>>` already in the text is wrapped as it is).
//   · designmap.xml: per field a hidden `HyperlinkURLDestination` whose URL is
//     `DBF_<field>` (that URL is what identifies the field), plus one
//     `Hyperlink` per source, after the last `<idPkg:Story>`; per image field a
//     `<DataMergeImagePlaceholder>` as the last child of `<Document>`
//     (InDesign adds the `IMG_` hyperlink itself on save).
//   · Resources/Preferences.xml: `<DataMerge>` (the data source) right before
//     `<DataMergeOption>`.
//   · The data source: CSV in UTF-16 with a BOM — the only encoding InDesign
//     merges correctly (UTF-8 → Mac Roman mojibake; UTF-8 with a BOM breaks
//     the fields). Image columns are named `@field`.
//   · The container's own parts (`paged/`, `manifest.json`, `data/`) are left
//     out: InDesign drops them anyway.
//
// Data Merge placeholders SHOW `<<field>>`, not a value, so this is an
// explicit export — never what a save writes (the document keeps its baked
// values, ADR 559 point 1). Pure + browser-safe: the zip codec uses
// `CompressionStream("deflate-raw")`.

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/** A placed text field to turn into a Data Merge placeholder. */
export interface TextField {
  /** The story's `Self` as the engine lists it (`Story/u0` or `u0`). */
  storyId: string;
  /** Character offset of the field's value in the story (core's offsets). */
  offset: number;
  /** The value's length (what the field shows now). */
  length: number;
  /** The data column it merges. */
  field: string;
}

export interface ImageField {
  /** The rectangle's `Self`. */
  frame: string;
  field: string;
}

export interface MergeTemplateSpec {
  texts: readonly TextField[];
  images: readonly ImageField[];
  /** What `DataSourceFile` names (InDesign wants an absolute path; a bare
   *  name makes the user re-select the source once). */
  dataSourceFile: string;
}

export interface MergeTemplateResult {
  entries: ZipEntry[];
  /** Every field the template merges (text first, then `@image`). */
  fields: string[];
  /** Fields the spec named that could not be placed, with the reason. */
  skipped: string[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescText = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

/** The story part a story id lives in (`Story/u0` → `Stories/Story_Story_u0.xml`
 *  on paged's writer, `Stories/Story_u0.xml` on InDesign's). */
function storyPart(entries: readonly ZipEntry[], storyId: string): ZipEntry | undefined {
  const flat = storyId.replace(/\//g, "_");
  const bare = storyId.replace(/^Story\//, "");
  return (
    entries.find((e) => e.name === `Stories/Story_${flat}.xml`) ??
    entries.find((e) => e.name === `Stories/Story_${bare}.xml`) ??
    entries.find((e) => e.name.startsWith("Stories/") && dec.decode(e.bytes).includes(`Self="${flat}"`))
  );
}

/** One `<HyperlinkTextSource>` around a literal `<<field>>`. */
const source = (self: string, field: string) =>
  `<HyperlinkTextSource Self="${self}" Name="Source" Hidden="false" AppliedCharacterStyle="n"><Content>${escText(`<<${field}>>`)}</Content></HyperlinkTextSource>`;

/** Rewrite one story: wrap literal `<<field>>`s, then turn each placed field
 *  (offset/length) into a placeholder. Returns the XML and the sources made. */
function rewriteStory(
  xml: string,
  fields: readonly TextField[],
  nextSelf: () => string,
  skipped: string[],
): { xml: string; sources: { self: string; field: string }[] } {
  const sources: { self: string; field: string }[] = [];
  // 1. literal <<field>> in a Content node (not already a source).
  let out = xml.replace(/<Content>([^<]*)<\/Content>/g, (whole, body: string, at: number) => {
    const before = xml.slice(Math.max(0, at - 200), at);
    if (/<HyperlinkTextSource[^>]*>\s*$/.test(before)) return whole;
    if (!/&lt;&lt;[^&<]+?&gt;&gt;/.test(body)) return whole;
    const parts: string[] = [];
    let last = 0;
    for (const m of body.matchAll(/&lt;&lt;([^&<]+?)&gt;&gt;/g)) {
      const pre = body.slice(last, m.index);
      if (pre) parts.push(`<Content>${pre}</Content>`);
      const self = nextSelf();
      const field = unescText(m[1]!).trim();
      sources.push({ self, field });
      parts.push(source(self, field));
      last = m.index! + m[0].length;
    }
    const rest = body.slice(last);
    if (rest) parts.push(`<Content>${rest}</Content>`);
    return parts.join("");
  });
  // 2. placed fields by offset, last first so earlier offsets stay valid.
  for (const f of [...fields].sort((a, b) => b.offset - a.offset)) {
    let pos = 0;
    let done = false;
    out = out.replace(/<Content>([^<]*)<\/Content>/g, (whole, body: string) => {
      if (done) return whole;
      const text = unescText(body);
      const start = pos;
      pos += [...text].length;
      if (f.offset < start || f.offset + f.length > pos) return whole;
      const chars = [...text];
      const a = f.offset - start;
      const pre = chars.slice(0, a).join("");
      const post = chars.slice(a + f.length).join("");
      const self = nextSelf();
      sources.push({ self, field: f.field });
      done = true;
      return `${pre ? `<Content>${escText(pre)}</Content>` : ""}${source(self, f.field)}${post ? `<Content>${escText(post)}</Content>` : ""}`;
    });
    if (!done) skipped.push(`${f.field}: no text at ${f.storyId}@${f.offset} in the exported story`);
  }
  return { xml: out, sources };
}

/** Rewrite an IDML package (as entries) into a Data Merge template. */
export function dataMergeTemplate(entries: readonly ZipEntry[], spec: MergeTemplateSpec): MergeTemplateResult {
  const skipped: string[] = [];
  const kept = entries.filter(
    (e) => !e.name.startsWith("paged/") && !e.name.startsWith("data/") && e.name !== "manifest.json",
  );
  const all = kept.map((e) => dec.decode(e.bytes)).join("\n");
  let n = 0;
  const nextSelf = () => {
    let self: string;
    do self = `udm${(++n).toString(36)}`;
    while (all.includes(`Self="${self}"`));
    return self;
  };
  const sources: { self: string; field: string }[] = [];
  const byStory = new Map<ZipEntry, TextField[]>();
  for (const f of spec.texts) {
    const part = storyPart(kept, f.storyId);
    if (!part) {
      skipped.push(`${f.field}: no story part for ${f.storyId}`);
      continue;
    }
    byStory.set(part, [...(byStory.get(part) ?? []), f]);
  }
  const out: ZipEntry[] = kept.map((e) => {
    if (!e.name.startsWith("Stories/")) return e;
    const xml = dec.decode(e.bytes);
    const r = rewriteStory(xml, byStory.get(e) ?? [], nextSelf, skipped);
    sources.push(...r.sources);
    return r.xml === xml ? e : { name: e.name, bytes: enc.encode(r.xml) };
  });
  const textFields = [...new Set(sources.map((s) => s.field))];
  const imageFields = spec.images.filter((i) => !textFields.includes(i.field));
  // designmap: destinations + hyperlinks after the last story ref; image
  // placeholders as the last children of <Document>.
  const dm = out.findIndex((e) => e.name === "designmap.xml");
  if (dm >= 0) {
    let xml = dec.decode(out[dm]!.bytes);
    const key = new Map(textFields.map((f, i) => [f, i + 1]));
    const links = [
      ...textFields.map(
        (f) =>
          `<HyperlinkURLDestination Self="HyperlinkURLDestination/DBF_${escAttr(f)}" Name="DBF_${escAttr(f)}" DestinationURL="DBF_${escAttr(f)}" Hidden="true" DestinationUniqueKey="${key.get(f)}" />`,
      ),
      ...sources.map(
        (s) =>
          `<Hyperlink Self="${nextSelf()}" Name="paged ${escAttr(s.field)}" Source="${s.self}" Visible="false" Highlight="None" Width="Thin" BorderStyle="Solid" Hidden="false" DestinationUniqueKey="${key.get(s.field)}"><Properties><BorderColor type="enumeration">Black</BorderColor><Destination type="object">HyperlinkURLDestination/DBF_${escAttr(s.field)}</Destination></Properties></Hyperlink>`,
      ),
    ].join("\n");
    const lastStory = [...xml.matchAll(/<idPkg:Story [^>]*\/>/g)].pop();
    const at = lastStory ? lastStory.index! + lastStory[0].length : xml.lastIndexOf("</Document>");
    xml = `${xml.slice(0, at)}\n${links}${xml.slice(at)}`;
    const images = imageFields
      .map(
        (img, i) =>
          `<DataMergeImagePlaceholder Self="dDataMergeImagePlaceholder${i}" Field="${escAttr(img.field)}" PlaceholderPageItem="${escAttr(img.frame)}" />`,
      )
      .join("\n");
    if (images) {
      const end = xml.lastIndexOf("</Document>");
      xml = `${xml.slice(0, end)}${images}\n${xml.slice(end)}`;
    }
    out[dm] = { name: "designmap.xml", bytes: enc.encode(xml) };
  }
  const pf = out.findIndex((e) => e.name === "Resources/Preferences.xml");
  if (pf >= 0) {
    let xml = dec.decode(out[pf]!.bytes).replace(/<DataMerge [^>]*\/>\s*/g, "");
    const source = `<DataMerge DataSourceFileType="CommaSeparated" DataSourceFile="${escAttr(spec.dataSourceFile)}" />`;
    const option = /<DataMergeOption /.exec(xml);
    if (option) {
      xml = `${xml.slice(0, option.index)}${source}\n${xml.slice(option.index)}`;
    } else {
      const end = xml.lastIndexOf("</idPkg:Preferences>");
      xml = `${xml.slice(0, end)}${source}<DataMergeOption FittingOption="Proportional" CenterImage="true" LinkImages="true" RemoveBlankLines="true" CreateNewDocument="false" DocumentSize="50" />${xml.slice(end)}`;
    }
    out[pf] = { name: "Resources/Preferences.xml", bytes: enc.encode(xml) };
  }
  return { entries: out, fields: [...textFields, ...imageFields.map((i) => `@${i.field}`)], skipped };
}

/** The data source InDesign merges: CSV, UTF-16LE with a BOM. `header`
 *  names image columns `@field`. */
export function utf16Csv(header: readonly string[], rows: readonly (readonly (string | null)[])[]): Uint8Array {
  const cell = (v: string | null) => {
    const s = v ?? "";
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[2 + i * 2] = c & 0xff;
    out[3 + i * 2] = c >> 8;
  }
  return out;
}

// ── zip (stored + deflate), browser-safe ────────────────────────────────────

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipe(bytes: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> }): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream as unknown as TransformStream<Uint8Array, Uint8Array>));
  return new Uint8Array(await out.arrayBuffer());
}

/** Read every entry of a zip (stored or deflated; no zip64). */
export async function readZip(zip: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extra = view.getUint16(p + 30, true);
    const comment = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = zip.subarray(start, start + size);
    out.push({
      name,
      bytes: method === 0 ? raw.slice() : await pipe(raw, new DecompressionStream("deflate-raw" as CompressionFormat)),
    });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

/** Write a zip: `mimetype` first and stored (IDML requires it), the rest deflated. */
export async function writeZip(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  const ordered = [...entries].sort((a, b) => (a.name === "mimetype" ? -1 : b.name === "mimetype" ? 1 : 0));
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of ordered) {
    const name = enc.encode(e.name);
    const store = e.name === "mimetype";
    const data = store ? e.bytes : await pipe(e.bytes, new CompressionStream("deflate-raw" as CompressionFormat));
    const crc = crc32(e.bytes);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(8, store ? 0 : 8, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, e.bytes.length, true);
    h.setUint16(26, name.length, true);
    local.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(10, store ? 0 : 8, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, e.bytes.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, ordered.length, true);
  end.setUint16(10, ordered.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((s, b) => s + b.length, 0));
  let at = 0;
  for (const b of parts) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}
