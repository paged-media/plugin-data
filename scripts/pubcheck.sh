#!/usr/bin/env bash
# The publish check: fail when a packed @paged-media/data tarball lacks an
# artifact the package needs at runtime or a stamp the next publish reads.
# publish.yml runs it on the tarball it is about to publish.
#
# bin/duckdb-engine.wasm is the reason this exists: the manifest declared
# it, but no workflow ran scripts/vendor-duckdb.sh, so every published
# version up to 0.1.0-canary.9 shipped without a query engine.
#
# Usage: bash scripts/pubcheck.sh <file.tgz>
set -euo pipefail
tgz="${1:?usage: pubcheck.sh <file.tgz>}"
listing=$(tar -tzf "$tgz")
missing=0
for f in package/package.json package/manifest.json package/dist/index.js \
         package/bin/data_js_bg.wasm package/bin/data_js.js \
         package/bin/duckdb-engine.wasm \
         package/bin/duckdb-ext/v1.1.1/wasm_eh/json.duckdb_extension.wasm \
         package/bin/duckdb-ext/v1.1.1/wasm_eh/parquet.duckdb_extension.wasm \
         package/bin/SOURCE_HASH package/bin/PACKAGE_HASH; do
  if ! grep -qx "$f" <<<"$listing"; then
    echo "pubcheck: $tgz lacks $f" >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || exit 1
echo "pubcheck: ok ($(wc -c < "$tgz" | tr -d ' ') bytes, $(wc -l <<<"$listing" | tr -d ' ') files)"
