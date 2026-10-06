// A minimal ZIP reader/writer for the persistence specs (Node only): read
// every entry of a saved `.paged`, and write one back without some entries —
// what InDesign does to a container on open → save (it drops every part it
// does not know). Stored + deflate, no zip64.

import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

export function readZip(zip: Uint8Array): ZipEntry[] {
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
  for (let n = 0; n < count; n++) {
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = view.getUint16(local + 26, true);
    const lExtraLen = view.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = zip.subarray(start, start + csize);
    const bytes = method === 0 ? raw.slice() : new Uint8Array(inflateRawSync(raw));
    out.push({ name, bytes });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    // `mimetype` first and STORED, as IDML requires.
    const store = e.name === "mimetype";
    const data = store ? e.bytes : new Uint8Array(deflateRawSync(e.bytes));
    const crc = crc32(e.bytes) >>> 0;
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(8, store ? 0 : 8, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, data.length, true);
    head.setUint32(22, e.bytes.length, true);
    head.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(head.buffer), name, data);
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
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of all) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/** What InDesign keeps of a container: the IDML parts only. */
export function stripContainerParts(zip: Uint8Array): Uint8Array {
  return writeZip(
    readZip(zip).filter(
      (e) =>
        !e.name.startsWith("paged/") &&
        e.name !== "manifest.json" &&
        !e.name.startsWith("data/") &&
        !(e.name.startsWith("META-INF/") && e.name !== "META-INF/container.xml" && e.name !== "META-INF/metadata.xml"),
    ),
  );
}

export const text = (e: ZipEntry | undefined): string => (e ? new TextDecoder().decode(e.bytes) : "");
