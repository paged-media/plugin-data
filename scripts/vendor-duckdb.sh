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

# DuckDB's json + parquet extensions for exactly this engine. The eh build of
# DuckDB-WASM 1.29.0 (engine v1.1.1) has neither built in: DuckDB loads them on
# first use from <repository>/<engine>/<platform>/<name>.duckdb_extension.wasm,
# by default from extensions.duckdb.org, which a host CSP (connect-src 'self')
# refuses — the worker then traps. The bundle ships both under
# bin/duckdb-ext/ and bootDuckDB points `custom_extension_repository` there
# (src/query/duckdb.ts DUCKDB_EXTENSIONS — change the two together). The files
# are signed by DuckDB Labs (the engine verifies the signature); the SHA-256
# pins catch an upstream re-upload. MIT, like the engine.
DUCKDB_ENGINE_VERSION="${DUCKDB_ENGINE_VERSION:-v1.1.1}"
DUCKDB_EXT_PLATFORM=wasm_eh
DUCKDB_EXT_REPO=https://extensions.duckdb.org
EXT_CACHE="$OUT/extensions/$DUCKDB_ENGINE_VERSION/$DUCKDB_EXT_PLATFORM"
EXT_NAMES="json parquet"
ext_sha() {
  case "$DUCKDB_ENGINE_VERSION/$1" in
    v1.1.1/json) echo 84958e8b52814ff0035dfcb208dbac80d99d30e582c668090879d3b814c571e4 ;;
    v1.1.1/parquet) echo e24fb2953c6a80e32d17fa3921f90f1f05ccbfa40f382e77702c1e6af9b79479 ;;
    *) echo "error: no SHA-256 pin for the $1 extension of DuckDB $DUCKDB_ENGINE_VERSION" >&2; return 1 ;;
  esac
}

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

# The engine must be the version the extensions are built for: DuckDB refuses
# an extension built for another engine version.
if ! grep -aq "$DUCKDB_ENGINE_VERSION" "$DIST/duckdb-eh.wasm"; then
  echo "error: $DIST/duckdb-eh.wasm does not name engine $DUCKDB_ENGINE_VERSION — set DUCKDB_ENGINE_VERSION for this DuckDB-WASM" >&2
  exit 1
fi
mkdir -p "$EXT_CACHE"
EXT_TABLE=""
for name in $EXT_NAMES; do
  file="$name.duckdb_extension.wasm"
  url="$DUCKDB_EXT_REPO/$DUCKDB_ENGINE_VERSION/$DUCKDB_EXT_PLATFORM/$file"
  want=$(ext_sha "$name")
  if [ ! -f "$EXT_CACHE/$file" ] || [ "$(shasum -a 256 "$EXT_CACHE/$file" | cut -d' ' -f1)" != "$want" ]; then
    echo "vendor-duckdb: fetching $url"
    curl -fsSL --max-time 120 -o "$EXT_CACHE/$file.part" "$url"
    mv "$EXT_CACHE/$file.part" "$EXT_CACHE/$file"
  fi
  got=$(shasum -a 256 "$EXT_CACHE/$file" | cut -d' ' -f1)
  if [ "$got" != "$want" ]; then
    echo "error: $url has SHA-256 $got, pinned $want — check upstream and update the pin deliberately" >&2
    exit 1
  fi
  EXT_TABLE="${EXT_TABLE}| \`$name\` | $(wc -c < "$EXT_CACHE/$file" | tr -d ' ') | $url | \`$got\` |
"
done

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
NOT linked into the AGPL/PMEL Rust crates. The boundary is the Arrow-shaped
\`RecordSet\` interchange (spec §3 license boundary — data outputs only). No
DuckDB engine source is part of this repo's build.

## Extensions (shipped in bin/duckdb-ext/)

DuckDB's own \`json\` and \`parquet\` extensions for engine ${DUCKDB_ENGINE_VERSION},
platform \`${DUCKDB_EXT_PLATFORM}\` — the eh build has neither built in. Prebuilt
and signed by DuckDB Labs; MIT, as part of DuckDB (https://github.com/duckdb/duckdb).
They ship so DuckDB loads them same-origin: bootDuckDB sets
\`custom_extension_repository\` to the bundle's \`bin/duckdb-ext\` (and turns
autoinstall off) before the configuration lock, so nothing is fetched from
extensions.duckdb.org at run time.

| Extension | Bytes | Source | SHA-256 |
| --- | --- | --- | --- |
${EXT_TABLE}
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
# The extensions, at the path DuckDB builds from the repository URL, each
# within its manifest maxBytes.
rm -rf "$BUNDLE_BIN/duckdb-ext"
mkdir -p "$BUNDLE_BIN/duckdb-ext/$DUCKDB_ENGINE_VERSION/$DUCKDB_EXT_PLATFORM"
for name in $EXT_NAMES; do
  rel="duckdb-ext/$DUCKDB_ENGINE_VERSION/$DUCKDB_EXT_PLATFORM/$name.duckdb_extension.wasm"
  cp "$EXT_CACHE/$name.duckdb_extension.wasm" "$BUNDLE_BIN/$rel"
  cap=$(REL="bin/$rel" node -e 'const m=require("./packages/data-bundle/manifest.json");const a=m.capabilities.wasm.find(w=>w.path===process.env.REL);if(!a)process.exit(3);process.stdout.write(String(a.maxBytes))') || {
    echo "error: the manifest declares no wasm artifact at bin/$rel" >&2
    exit 1
  }
  size=$(wc -c < "$BUNDLE_BIN/$rel" | tr -d ' ')
  if [ "$size" -gt "$cap" ]; then
    echo "error: bin/$rel is $size bytes, over the manifest's maxBytes $cap" >&2
    exit 1
  fi
  echo "vendor-duckdb: staged bin/$rel ($size bytes, cap $cap)"
done
ENGINE_SIZE=$(wc -c < "$BUNDLE_BIN/duckdb-engine.wasm" | tr -d ' ')
if [ "$ENGINE_SIZE" -gt "$MAX_BYTES" ]; then
  echo "error: duckdb-engine.wasm is $ENGINE_SIZE bytes, over the manifest's maxBytes $MAX_BYTES" >&2
  exit 1
fi
echo "vendor-duckdb: staged into $BUNDLE_BIN (engine $ENGINE_SIZE bytes, cap $MAX_BYTES):"
ls -l "$BUNDLE_BIN"/duckdb-*.* | awk '{print "  " $5 "\t" $NF}'

echo "vendor-duckdb: done → $DIST"
ls -1 "$DIST" | sed 's/^/  /'
