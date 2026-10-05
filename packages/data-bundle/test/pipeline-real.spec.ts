// The real-wasm pipeline parts (test/pipeline-parts.mjs, formerly the
// standalone test-integration/pipeline.e2e.mjs that no runner executed),
// now inside vitest under the same dual gate as engine-real.spec.ts:
// skip locally without the built artifact, FAIL under REQUIRE_REAL_ENGINE=1.
// Part B (real DuckDB) lives in duckdb-real.spec.ts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { BIN, partA, partC, partD, partE } from "./pipeline-parts.mjs";

const WASM = join(BIN, "data_js_bg.wasm");
const built = existsSync(WASM);

if (process.env.REQUIRE_REAL_ENGINE === "1" && !built) {
  describe("real-wasm pipeline parts — REQUIRED", () => {
    it("FAILS: REQUIRE_REAL_ENGINE=1 but the wasm artifact is missing", () => {
      throw new Error(
        `REQUIRE_REAL_ENGINE=1 but ${WASM} is missing — build it with \`bash scripts/build-wasm.sh\``,
      );
    });
  });
}

describe.skipIf(!built)("real-wasm pipeline parts [data.query.seam]", () => {
  it("Part A — hand-built RecordSet → engine → lowered table", async () => {
    await partA();
  });
  it("Part C — provider / governed catalog / batch plan cross the boundary", async () => {
    await partC();
  });
  it("Part D — v43 consumer lanes (variable / image / rule / live flow)", async () => {
    await partD();
  });
  it("Part E — §9.8/§9.9 variables + data sets", async () => {
    await partE();
  });
});
