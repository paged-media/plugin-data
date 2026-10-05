// The bundle's own `bin/` directory, resolved against THIS module's URL — the
// same mechanism engine.ts uses for `../bin/data_js.js`. It holds for both
// layouts the bundle runs from: the source tree (`src/bin-url.ts` → `bin/`) and
// the published build (tsup inlines this module into `dist/index.js` →
// `bin/`). A host serves `bin/` next to the code that imports it; see the
// editor's DuckDB route for the dev server and the build-output copy.
//
// The path is kept out of a `new URL("<literal>", import.meta.url)` expression
// on purpose: Vite rewrites that literal form into a hashed asset at build time,
// which would move the file away from the siblings the DuckDB worker expects.
const BIN_DIR = "../bin/";

/** The absolute URL of a file in the bundle's `bin/`. */
export function binUrl(file: string): string {
  return new URL(BIN_DIR + file, import.meta.url).href;
}
