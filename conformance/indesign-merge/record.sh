#!/usr/bin/env bash
# Record the InDesign Data Merge oracle (docs/design/oracles.md): drives the
# local Adobe InDesign 2025 through record.jsx and rewrites recorded/<id>.json
# and templates/<id>.idml. Local only (needs InDesign; takes the GUI for a few
# seconds per fixture). CI never runs this; it replays the committed JSON.
#
#   bash conformance/indesign-merge/record.sh                 # every fixture
#   PAGED_DM_ONLY=overset bash conformance/indesign-merge/record.sh
#
# Re-record one fixture at a time when one is wrong: a recording is evidence,
# and rewriting all of them hides which answer changed.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="${INDESIGN_APP:-Adobe InDesign 2025}"
# InDesign is not sandboxed, but stage outside the repo so the template .indd
# and the staged CSV/images (which carry absolute paths) never land in git.
# The path is FIXED: the template IDML records its data source by full path,
# so a fixed stage keeps re-recordings byte-comparable (and private paths out).
STAGE=/tmp/paged-data-merge-stage
rm -rf "$STAGE"
mkdir -p "$STAGE"
SHIM="$STAGE/shim.jsx"
trap 'rm -rf "$STAGE"' EXIT
cat > "$SHIM" <<JSX
var PAGED_DM_DIR = "$DIR";
var PAGED_DM_STAGE = "$STAGE";
var PAGED_DM_ONLY = "${PAGED_DM_ONLY:-}";
\$.evalFile(File("$DIR/record.jsx"));
JSX
# `do script` by its raw event code (core tools/indesign-export/run-export.sh
# explains why: InDesign's terminology is dynamic and a sandboxed shell cannot
# fetch it at compile time).
osascript <<OSA
with timeout of 900 seconds
    tell application "$APP"
        «event K2  dosc» (POSIX file "$SHIM") given «class doLg»:«constant ****JSLg»
    end tell
end timeout
OSA
cat "$STAGE/record.log"
! grep -q ERROR "$STAGE/record.log"
