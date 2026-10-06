// The REAL-BROWSER DuckDB lane: the shipped eh worker + engine
// (bin/duckdb-browser-eh.worker.js, bin/duckdb-engine.wasm) booted by the
// bundle's own bootDuckDB in headless Chromium. The Node lane runs the same
// engine through DuckDB's Node runtime, which is not the code the editor
// runs: `json_serialize_sql` passed every Node spec and trapped ("table index
// is out of bounds") in the browser worker on every refresh. This lane exists
// so that class of bug — Node passes, browser traps — goes red here.
//
// Needs playwright-core (devDependency) and a Chromium: PAGED_CHROMIUM, or
// the Playwright browser cache (`npx playwright-core install
// chromium-headless-shell`). REQUIRE_REAL_BROWSER=1 turns "no browser" into
// a failure instead of a skip.
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const BIN = join(PKG, "bin");
export const REQUIRE_REAL_BROWSER = process.env.REQUIRE_REAL_BROWSER === "1";

const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".html": "text/html",
};

/** A Chromium playwright-core can launch, or null. */
function findChromium(chromium: { executablePath(): string }): string | null {
  const env = process.env.PAGED_CHROMIUM;
  if (env && existsSync(env)) return env;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    // not installed for this playwright-core revision
  }
  // Any cached headless shell (the revision need not match exactly).
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Caches", "ms-playwright")
      : join(homedir(), ".cache", "ms-playwright"));
  if (!existsSync(cache)) return null;
  const shells = readdirSync(cache)
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .sort()
    .reverse();
  for (const d of shells) {
    for (const rel of [
      "chrome-headless-shell-mac-arm64/chrome-headless-shell",
      "chrome-headless-shell-mac-x64/chrome-headless-shell",
      "chrome-headless-shell-linux64/chrome-headless-shell",
      "chrome-linux/headless_shell",
    ]) {
      const p = join(cache, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export interface BrowserLane {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any;
  /** Console errors and page errors seen so far (worker traps land here). */
  errors: string[];
  /** Requests to any origin but the lane's (DuckDB extension autoloads). */
  offOrigin: string[];
  /** Every path the lane's server answered 200, in order (bin/ and lane/). */
  served: string[];
  close(): Promise<void>;
}

/** Bundle the lane entry, serve it with bin/, open it in headless Chromium.
 *  Never throws: returns why not. */
export async function startBrowserLane(): Promise<{ lane?: BrowserLane; error?: string }> {
  for (const f of ["duckdb-engine.wasm", "duckdb-browser-eh.worker.js", "duckdb-browser.mjs"]) {
    if (!existsSync(join(BIN, f))) return { error: `${join(BIN, f)} is missing — run scripts/vendor-duckdb.sh` };
  }
  const req = createRequire(join(PKG, "package.json"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pw: any;
  try {
    pw = req("playwright-core");
  } catch {
    return { error: "playwright-core is not installed — pnpm install" };
  }
  const exe = findChromium(pw.chromium);
  if (!exe) return { error: "no Chromium — set PAGED_CHROMIUM or `npx playwright-core install chromium-headless-shell`" };

  // esbuild via tsup (a root devDependency), as scripts/bundle-duckdb-api.mjs does.
  const rootReq = createRequire(resolve(PKG, "..", "..", "package.json"));
  const esbuild = createRequire(rootReq.resolve("tsup"))("esbuild");
  const out = mkdtempSync(join(tmpdir(), "paged-data-lane-"));
  await esbuild.build({
    entryPoints: [join(HERE, "browser", "entry.ts")],
    outfile: join(out, "entry.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    logLevel: "silent",
  });
  writeFileSync(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><script type="module" src="./entry.js"></script>`);

  const served: string[] = [];
  const server: Server = createServer((rq, rs) => {
    const url = new URL(rq.url ?? "/", "http://x");
    const file = url.pathname.startsWith("/bin/")
      ? join(BIN, url.pathname.slice(5))
      : url.pathname.startsWith("/lane/")
        ? join(out, url.pathname.slice(6))
        : "";
    if (!file || file.includes("..") || !existsSync(file)) {
      rs.writeHead(404).end();
      return;
    }
    rs.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      // The editor's headers (apps/canvas vite config): cross-origin
      // isolated, and a CSP whose connect-src is the page's own origin. That
      // CSP is what made the json_serialize_sql guard trap: the guard made
      // DuckDB autoload its json extension from extensions.duckdb.org, the
      // CSP refused the fetch, and the half-loaded extension trapped. A lane
      // without it fetched the extension from the internet and passed.
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "credentialless",
      "cross-origin-resource-policy": "same-origin",
      "content-security-policy": "connect-src 'self' blob: data:",
      "cache-control": "no-cache",
    });
    served.push(url.pathname);
    rs.end(readFileSync(file));
  });
  // Port 0: the OS picks a free port (never reuse a running server).
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;

  const browser = await pw.chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("console", (m: { type(): string; text(): string }) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e: Error) => errors.push(e.message));
  // Every request that leaves the lane's origin: the lane must make none.
  const offOrigin: string[] = [];
  page.on("request", (r: { url(): string }) => {
    if (!r.url().startsWith(`http://127.0.0.1:${port}/`)) offOrigin.push(r.url());
  });
  await page.goto(`http://127.0.0.1:${port}/lane/index.html`);
  await page.waitForFunction(() => (window as unknown as { lane?: unknown }).lane !== undefined);
  return {
    lane: {
      page,
      errors,
      offOrigin,
      served,
      async close() {
        await browser.close();
        await new Promise<void>((ok) => server.close(() => ok()));
        rmSync(out, { recursive: true, force: true });
      },
    },
  };
}
