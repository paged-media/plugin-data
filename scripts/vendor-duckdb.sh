#!/usr/bin/env bash
# Acquire the MIT-licensed DuckDB-WASM artifact and vendor it as a PREBUILT
# artifact under vendor/duckdb-wasm/ (spec §3/§4: "vendored MIT DuckDB-WASM
# artifact + bindings, NOT compiled in-tree"). The bundle loads it from
# vendor/ in the bundle realm (BREAKAGE D-05/D-07). Attribution + the MIT
# license text are preserved in vendor/duckdb-wasm/SOURCE.md.
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
curl -sL "$TARBALL" | tar xz -C "$TMP"
# npm tarballs unpack under package/
cp -R "$TMP"/package/dist/. "$DIST"/
# Preserve the upstream license file next to the dist.
# Preserve any upstream license/notice file. DuckDB-WASM declares MIT in its
# package.json and does not always ship a standalone LICENSE file in the npm
# tarball; record which case applies so the attribution is honest.
LICENSE_NOTE="MIT (DuckDB Labs); the npm tarball ships no standalone license file — MIT terms (package.json \`license\`) apply"
for cand in LICENSE LICENSE.txt LICENSE.md COPYING; do
  if [ -f "$TMP/package/$cand" ]; then
    cp "$TMP/package/$cand" "$OUT/LICENSE"
    LICENSE_NOTE="MIT (DuckDB Labs) — see ./LICENSE"
    break
  fi
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
NOT linked into the MPL/PMEL Rust crates. The boundary is the Arrow-shaped
\`RecordSet\` interchange (spec §3 license boundary — data outputs only). No
DuckDB engine source is part of this repo's build.
EOF

echo "vendor-duckdb: done → $DIST"
ls -1 "$DIST" | sed 's/^/  /'
