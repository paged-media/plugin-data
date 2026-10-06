#!/usr/bin/env bash
# ADR 559's InDesign lane: InDesign 2025 opens every fixture paged wrote
# (fixtures/*.idml, made by `PAGED_RECORD_INDESIGN_FIXTURES=1 vitest run
# test/indesign-binding.spec.ts` in packages/data-bundle), records what it
# sees and re-saves it (recorded/). Local only (needs InDesign; takes the GUI
# for a few seconds). CI replays the recordings (test/indesign-binding.spec.ts).
#
#   bash conformance/indesign-binding/record.sh
#   PAGED_IB_ONLY=bound bash conformance/indesign-binding/record.sh
#
# The stage path is FIXED: the Data Merge template names its data source by
# full path (dm-template.idml → /tmp/paged-data-binding-stage/dm.csv).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="${INDESIGN_APP:-Adobe InDesign 2025}"
STAGE=/tmp/paged-data-binding-stage
rm -rf "$STAGE"
mkdir -p "$STAGE" "$DIR/recorded"
cp "$DIR"/fixtures/*.idml "$DIR"/fixtures/dm.csv "$STAGE/"
SHIM="$STAGE/shim.jsx"
trap 'rm -rf "$STAGE"' EXIT
cat > "$SHIM" <<JSX
var PAGED_IB_DIR = "$DIR";
var PAGED_IB_STAGE = "$STAGE";
var PAGED_IB_ONLY = "${PAGED_IB_ONLY:-}";
\$.evalFile(File("$DIR/record.jsx"));
JSX
# `do script` by its raw event code (core tools/indesign-export/run-export.sh).
osascript <<OSA
with timeout of 600 seconds
    tell application "$APP"
        «event K2  dosc» (POSIX file "$SHIM") given «class doLg»:«constant ****JSLg»
    end tell
end timeout
OSA
cat "$STAGE/record.log"
! grep -q ERROR "$STAGE/record.log"
