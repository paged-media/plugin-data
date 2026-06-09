#!/usr/bin/env bash
# Build the paged.data engine wasm (data-js) and land the wasm-bindgen
# `--target web` output in packages/data-bundle/bin/ — the path the manifest
# declares under capabilities.wasm[] (governance + the 8 MiB plugin-cli size
# gate). The bundle loads it via the wbindgen glue (the core/canvas-wasm
# pattern), NOT via loadBundleWasm — BREAKAGE D-07. NOTE: the multi-MB
# DuckDB-WASM artifact is SEPARATE (vendor/duckdb-wasm/, scripts/vendor-duckdb.sh)
# and is NOT subject to this 8 MiB engine budget (D-07b).
#
# wasm-opt: CI pins binaryen (old apt binaryen breaks wasm-bindgen externref
# table grow — the "Table.grow failed" gotcha); locally it is applied when
# present, skipped with a warning when absent.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=packages/data-bundle/bin
BUDGET=$((8 * 1024 * 1024))

cargo build --release --target wasm32-unknown-unknown -p data-js

# Pin check: wasm-bindgen-cli must match the Cargo.lock wasm-bindgen.
LOCKED=$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | grep version | head -1 | cut -d'"' -f2)
CLI=$(wasm-bindgen --version | awk '{print $2}')
if [ "$LOCKED" != "$CLI" ]; then
  echo "error: wasm-bindgen-cli $CLI != Cargo.lock wasm-bindgen $LOCKED" >&2
  echo "       cargo install wasm-bindgen-cli --version $LOCKED" >&2
  exit 1
fi

wasm-bindgen target/wasm32-unknown-unknown/release/data_js.wasm \
  --target web --out-dir "$OUT"

if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz "$OUT/data_js_bg.wasm" -o "$OUT/data_js_bg.wasm"
else
  echo "warning: wasm-opt not found — shipping unoptimized wasm (CI optimizes)" >&2
fi

SIZE=$(wc -c < "$OUT/data_js_bg.wasm" | tr -d ' ')
echo "data_js_bg.wasm: $SIZE bytes (budget $BUDGET)"
if [ "$SIZE" -gt "$BUDGET" ]; then
  echo "error: wasm artifact exceeds the 8 MiB plugin budget" >&2
  exit 1
fi
