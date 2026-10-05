#!/usr/bin/env bash
# Acquire the MIT-licensed DuckDB-WASM artifact and vendor it as a PREBUILT
# artifact under vendor/duckdb-wasm/ (spec §3/§4: "vendored MIT DuckDB-WASM
# artifact + bindings, NOT compiled in-tree"), then stages the ONE shipped
# variant into packages/data-bundle/bin/ (see the end of this script). The
# runtime loads only bin/; vendor/ is for local work and the Node test lane.
# Attribution + the MIT license text are preserved in vendor/duckdb-wasm/SOURCE.md.
#
# Requires `pnpm install` first: the JS API is re-bundled with esbuild (via
# tsup) and apache-arrow from packages/data-bundle/node_modules.
#
# This is the deliberate vendoring step (like sync-wasm.sh / build-wasm.sh
# elsewhere): reproducible, license-recorded, not a silent npm pull. The
# multi-MB dist is gitignored; SOURCE.md + .gitkeep are committed.
set -euo pipefail
cd "$(dirname "$0")/.."

# Pinned MIT version (bump deliberately; record in SOURCE.md). DuckDB-WASM is
# distributed under the MIT license by DuckDB Labs.
DUCKDB_WASM_VERSION="${DUCKDB_WASM_VERSION:-1.29.0}"
OUT=vendor/duckdb-wasm
DIST="$OUT/dist"

mkdir -p "$DIST"

MARKER="$DIST/.duckdb-wasm-version"
TARBALL="https://registry.npmjs.org/@duckdb/duckdb-wasm/-/duckdb-wasm-${DUCKDB_WASM_VERSION}.tgz"
LICENSE_NOTE="MIT (DuckDB Labs); the npm tarball ships no standalone license file — MIT terms (package.json \`license\`) apply"
[ -f "$OUT/LICENSE" ] && LICENSE_NOTE="MIT (DuckDB Labs) — see ./LICENSE"

if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$DUCKDB_WASM_VERSION" ] && [ -z "${DUCKDB_REFETCH:-}" ]; then
  echo "vendor-duckdb: $DIST already holds ${DUCKDB_WASM_VERSION} (set DUCKDB_REFETCH=1 to fetch again)"
else
  echo "vendor-duckdb: fetching @duckdb/duckdb-wasm@${DUCKDB_WASM_VERSION} (MIT)…"

  # Resolve the tarball URL from the npm registry and unpack only its dist/.
  TARBALL=$(npm view "@duckdb/duckdb-wasm@${DUCKDB_WASM_VERSION}" dist.tarball 2>/dev/null || true)
  if [ -z "$TARBALL" ]; then
    echo "error: could not resolve @duckdb/duckdb-wasm@${DUCKDB_WASM_VERSION} from npm." >&2
    echo "       Check the version, or set DUCKDB_WASM_VERSION to a published release." >&2
    exit 1
  fi

  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "$TARBALL" | tar xz -C "$TMP"
  # npm tarballs unpack under package/
  cp -R "$TMP"/package/dist/. "$DIST"/
  # Preserve any upstream license/notice file. DuckDB-WASM declares MIT in its
  # package.json and does not always ship a standalone LICENSE file in the npm
  # tarball; record which case applies so the attribution is honest.
  for cand in LICENSE LICENSE.txt LICENSE.md COPYING; do
    if [ -f "$TMP/package/$cand" ]; then
      cp "$TMP/package/$cand" "$OUT/LICENSE"
      LICENSE_NOTE="MIT (DuckDB Labs) — see ./LICENSE"
      break
    fi
  done
  printf '%s' "$DUCKDB_WASM_VERSION" > "$MARKER"
fi

cat > "$OUT/SOURCE.md" <<EOF
# Vendored: @duckdb/duckdb-wasm

- **Package:** \`@duckdb/duckdb-wasm\`
- **Version:** ${DUCKDB_WASM_VERSION}
- **License:** ${LICENSE_NOTE}
- **Source:** ${TARBALL}
- **Acquired by:** scripts/vendor-duckdb.sh (reproducible; bump the pinned
  DUCKDB_WASM_VERSION deliberately).

This is the query/ingest engine (spec §6). It is vendored as a PREBUILT
artifact and consumed as a WASM module + JS bindings — NOT compiled in-tree,
NOT linked into the MPL/PMEL Rust crates. The boundary is the Arrow-shaped
\`RecordSet\` interchange (spec §3 license boundary — data outputs only). No
DuckDB engine source is part of this repo's build.
EOF

# D-11 / D-07b — stage the ONE shipped engine variant into the bundle's
# governed `bin/`. The npm tarball ships `bin/` ("files" in
# packages/data-bundle/package.json), and the runtime (src/query/duckdb.ts)
# loads exactly these three files relative to the bundle's own module, the same
# way it loads `bin/data_js.js`. Nothing at runtime reads vendor/.
#
#   bin/duckdb-engine.wasm           the EH variant (exception handling, no
#                                    threads); the manifest declares it as
#                                    `purpose: "engine"` with maxBytes 48 MiB.
#   bin/duckdb-browser-eh.worker.js  the worker that instantiates it
#                                    (self-contained, no imports).
#   bin/duckdb-browser.mjs           the JS API, re-bundled with its one bare
#                                    import (apache-arrow) inlined, so a host can
#                                    serve it as a plain file: no import map, no
#                                    dev-server rewrite.
#
# Only EH ships: mvp (40.6 MB) is over the cap and coi needs threads plus
# cross-origin isolation; every browser the editor supports has wasm exceptions.
# vendor/ keeps the full dist for local work and for the Node test lane
# (duckdb-node-blocking.cjs), but it is never shipped.
BUNDLE_BIN=packages/data-bundle/bin
MAX_BYTES=$(node -e 'const m=require("./packages/data-bundle/manifest.json");const a=m.capabilities.wasm.find(w=>w.name==="duckdb-engine");process.stdout.write(String(a.maxBytes))')
mkdir -p "$BUNDLE_BIN"
# Drop anything an older version of this script staged (the old layout put the
# whole dist under bin/duckdb-wasm/), so exactly one variant can ship.
rm -rf "$BUNDLE_BIN/duckdb-wasm"
rm -f "$BUNDLE_BIN"/duckdb-*.wasm "$BUNDLE_BIN"/duckdb-*.js "$BUNDLE_BIN"/duckdb-*.mjs
for f in duckdb-eh.wasm duckdb-browser-eh.worker.js duckdb-browser.mjs; do
  if [ ! -f "$DIST/$f" ]; then
    echo "error: $DIST/$f is missing from @duckdb/duckdb-wasm@${DUCKDB_WASM_VERSION}" >&2
    exit 1
  fi
done
cp "$DIST/duckdb-eh.wasm" "$BUNDLE_BIN/duckdb-engine.wasm"
cp "$DIST/duckdb-browser-eh.worker.js" "$BUNDLE_BIN/duckdb-browser-eh.worker.js"
node scripts/bundle-duckdb-api.mjs "$DIST/duckdb-browser.mjs" "$BUNDLE_BIN/duckdb-browser.mjs"
ENGINE_SIZE=$(wc -c < "$BUNDLE_BIN/duckdb-engine.wasm" | tr -d ' ')
if [ "$ENGINE_SIZE" -gt "$MAX_BYTES" ]; then
  echo "error: duckdb-engine.wasm is $ENGINE_SIZE bytes, over the manifest's maxBytes $MAX_BYTES" >&2
  exit 1
fi
echo "vendor-duckdb: staged into $BUNDLE_BIN (engine $ENGINE_SIZE bytes, cap $MAX_BYTES):"
ls -l "$BUNDLE_BIN"/duckdb-* | awk '{print "  " $5 "\t" $NF}'

echo "vendor-duckdb: done → $DIST"
ls -1 "$DIST" | sed 's/^/  /'
