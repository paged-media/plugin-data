// The InDesign Data Merge oracle over the SHIPPED query path
// (docs/design/oracles.md). data-conformance/tests/oracle.rs replays the
// recordings with every CSV field ingested as TEXT, the way Data Merge reads
// it. Here the same CSVs go the way a user's file goes: registerCsv into the
// shipped duckdb-wasm (type sniffing and all) → recordset.ts → the data-js
// record flow; and each merged record's text is compared with what InDesign
// wrote into its frame. Placement is oracle.rs's job; this lane is text only.
//
// GATE: skips without DuckDB or the data-js wasm, fails under
// REQUIRE_REAL_DUCKDB=1 (duckdb-sql-oracle.spec.ts carries the boot gate).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BIN, PKG, tryBootNodeDuckDB } from "./duckdb-node-boot";
import { bootEngine } from "./pipeline-parts.mjs";

const LANE = join(PKG, "..", "..", "conformance", "indesign-merge");
const spec = JSON.parse(readFileSync(join(LANE, "fixtures.json"), "utf8"));

/** Where the shipped path's text differs from InDesign's, per fixture: the
 *  number of records whose text agrees, pinned. A moved count fails; the
 *  commit that moves it updates the pin. */
const PINS: Record<string, { agree: number; why?: string }> = {
  "single-record": { agree: 2, why: "DEFECT DM-8: DuckDB sniffs price as DOUBLE, so 1234.50 prints 1234.5" },
  "multi-record-column": { agree: 6, why: "DEFECT DM-8: price DOUBLE, so 2.50 prints 2.5 and 10.00 prints 10" },
  "multi-record-grid": { agree: 7 },
  "long-record-set": { agree: 57 },
  "empty-field-lines": { agree: 1, why: "DEFECT DM-5 the empty field's line is kept; DM-8 1.00 prints 1" },
  overset: { agree: 2 },
  "number-text": { agree: 3 },
  "image-field": { agree: 3 },
};

function normalise(s: string): string {
  return s.replace(/\r/g, "\n").replace(/﻿/g, "");
}

function indesignTexts(id: string): Array<{ text: string; overset: boolean }> {
  const rec = JSON.parse(readFileSync(join(LANE, "recorded", `${id}.json`), "utf8"));
  return rec.merged.pages.flatMap((p: any) =>
    p.text_frames.map((t: any) => ({ text: normalise(t.text), overset: t.overset })),
  );
}

const boot = await tryBootNodeDuckDB();
const engineBuilt = existsSync(join(BIN, "data_js_bg.wasm"));

describe.skipIf(!boot.duck || !engineBuilt)(
  "InDesign Data Merge texts over the shipped DuckDB path [data.lower.content]",
  () => {
    for (const fx of spec.fixtures as any[]) {
      const pin = PINS[fx.id];
      it(`${fx.id}: ${pin.agree} record texts agree with InDesign${pin.why ? ` (${pin.why})` : ""}`, async () => {
        const duck = boot.duck!;
        const table = `dm_${fx.id.replace(/-/g, "_")}`;
        await duck.handle.registerCsv(table, readFileSync(join(LANE, "csv", `${fx.id}.csv`), "utf8"));
        const rs = await duck.handle.query(`SELECT * FROM ${table}`);

        const text = fx.frames.find((f: any) => f.kind === "text");
        const fields = text.lines.map((line: string) => {
          const at = line.indexOf("<<");
          return { label: line.slice(0, at), expr: line.slice(at + 2, -2) };
        });
        const engine = await bootEngine();
        engine.define_source({ id: "s", kind: { kind: "inlineSeed", table }, capability: "inline" });
        engine.define_query({ id: "q", sql: `SELECT * FROM ${table}`, params: [], shape: { shape: "recordStream" } });
        engine.define_template({ id: "t", fields, lineHeightPt: spec.text.leading });
        engine.define_binding({
          id: "rf",
          kind: "recordFlow",
          chain: "c",
          query: "q",
          template: "t",
          options: {},
        });
        engine.ingest_result("q", rs);
        const chain = Array.from({ length: rs.row_count }, (_, i) => ({ frame: `f${i}`, page: `p${i}`, heightPt: 1e6 }));
        const flow = engine.lower_record_flow("rf", chain, undefined);
        const ours: string[] = flow.frames.flatMap((f: any) =>
          f.blocks.filter((b: any) => b.block === "record").map((b: any) => b.cells.join("\n")),
        );
        expect(ours.length).toBe(rs.row_count);

        const theirs = indesignTexts(fx.id);
        const used = new Set<number>();
        let agree = 0;
        const disagree: string[] = [];
        for (const t of theirs) {
          const i = ours.findIndex(
            (o, j) => !used.has(j) && (t.overset ? o.startsWith(t.text.trimEnd()) : o === t.text),
          );
          if (i >= 0) {
            used.add(i);
            agree++;
          } else disagree.push(JSON.stringify(t.text));
        }
        if (agree !== pin.agree) console.log(fx.id, { ours, disagree });
        expect(agree, `${fx.id}: InDesign texts with no match: ${disagree.join(", ")}`).toBe(pin.agree);
      });
    }
  },
);
