// The Node lanes' extension repository: the SAME files the bundle ships
// (bin/duckdb-ext/<engine>/<platform>/<name>.duckdb_extension.wasm), and no
// network. DuckDB-WASM's Node runtime loads an extension through a
// synchronous XMLHttpRequest when one exists; without one it reads
// ~/.duckdb/extensions/… and, on a miss, downloads from the URL — which is how
// the Node lanes used to pass while the browser worker trapped (they fetched
// json/parquet from extensions.duckdb.org). Here every boot points DuckDB at a
// file:// repository over bin/duckdb-ext (src/query/duckdb.ts `bootSql`, the
// statements bootDuckDB runs) and installs an XMLHttpRequest that serves only
// that directory. Any other URL is refused (status 404, recorded in
// `refusedExtensionUrls`), so a load from anywhere else fails the test that
// caused it instead of reaching the network.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bootSql, DUCKDB_EXTENSIONS } from "../src/query/duckdb";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
/** The file:// repository the Node lanes use (no trailing slash). */
export const NODE_EXTENSION_REPO = pathToFileURL(join(BIN, DUCKDB_EXTENSIONS.dir)).href;

// On globalThis, not module state: specs reset modules (vi.resetModules), and
// the log must be the one every copy of this module writes.
const LOG = ((globalThis as unknown as { __pagedDuckExtLog?: { served: string[]; refused: string[] } })
  .__pagedDuckExtLog ??= { served: [], refused: [] });
/** Extension URLs served from bin/duckdb-ext, in order. */
export const servedExtensionUrls: string[] = LOG.served;
/** Every other URL DuckDB asked for — must stay empty. */
export const refusedExtensionUrls: string[] = LOG.refused;

class LocalOnlyXhr {
  status = 0;
  response: ArrayBuffer | null = null;
  responseType = "";
  private url = "";
  open(_method: string, url: string, async?: boolean) {
    if (async !== false) throw new Error(`LocalOnlyXhr: only synchronous requests (asked for ${url})`);
    this.url = url;
  }
  setRequestHeader() {}
  send() {
    if (this.url.startsWith(`${NODE_EXTENSION_REPO}/`)) {
      const file = fileURLToPath(this.url);
      if (existsSync(file)) {
        const b = readFileSync(file);
        this.response = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        this.status = 200;
        servedExtensionUrls.push(this.url);
        return;
      }
    }
    refusedExtensionUrls.push(this.url);
    this.status = 404;
  }
}

/** Install the local-only XMLHttpRequest and return the statements a Node
 *  boot runs after connecting (the extension repository, then the lock). */
export function nodeBootSql(): string[] {
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = LocalOnlyXhr;
  return bootSql(NODE_EXTENSION_REPO);
}
