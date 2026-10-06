// The browser lane's page entry: the bundle's REAL DuckDB boot (bootDuckDB,
// which spawns the shipped eh worker from bin/ and instantiates the shipped
// engine) plus the query guard and importer, exposed on `window.lane` for
// test/duckdb-browser.spec.ts to drive through Playwright. Bundled by
// test/browser-lane.ts with esbuild and served at /lane/entry.js, so
// `binUrl()` (../bin/) resolves to the served bin/.
import { bootDuckDB, type DuckDBHandle } from "../../src/query/duckdb";
import { loadIntoDuckDB } from "../../src/query/import";
import { guardQuery } from "../../src/query/sql";

(window as unknown as { lane: unknown }).lane = {
  bootDuckDB,
  guard: (_d: DuckDBHandle, sql: string) => guardQuery(sql),
  loadIntoDuckDB,
};
