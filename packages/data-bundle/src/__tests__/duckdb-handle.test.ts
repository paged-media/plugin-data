// The DuckDB handle over a database that TRANSFERS what it is given, as the
// browser AsyncDuckDB does (registerFileBuffer posts the bytes to its worker
// with the buffer in the transfer list). The session keeps the imported bytes
// to save them with the document (the `session` part), so the handle must
// not hand over the caller's buffer: a detached buffer saves as an empty file
// and a reopened Parquet/JSON/XLSX source no longer loads.

import { describe, expect, it } from "vitest";

import { duckdbHandle } from "../query/duckdb";

describe("duckdbHandle over a transferring database [data.plugin.persistence]", () => {
  it("registerFileBuffer leaves the caller's bytes intact", async () => {
    const received: number[][] = [];
    const db = {
      registerFileText() {},
      registerFileBuffer(_name: string, bytes: Uint8Array) {
        received.push([...bytes]);
        // What postMessage(…, [bytes.buffer]) does to the sender's view.
        structuredClone(bytes, { transfer: [bytes.buffer as ArrayBuffer] });
      },
    };
    const conn = { insertCSVFromPath() {}, query() {}, close() {} };
    const handle = duckdbHandle(db, conn, () => {});
    const bytes = new Uint8Array([80, 65, 82, 49]);
    await handle.registerFileBuffer("paged_src_products.parquet", bytes);
    expect(received).toEqual([[80, 65, 82, 49]]);
    expect(bytes.byteLength).toBe(4);
    expect([...bytes]).toEqual([80, 65, 82, 49]);
  });
});
