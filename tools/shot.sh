#!/bin/bash
# Render one frame of the demo to a PNG, for looking at layout and colour.
# Usage: tools/shot.sh out.png [cols] [rows] [fleet options...]
# Needs rsvg-convert (brew install librsvg).
set -euo pipefail
out="$1"; cols="${2:-150}"; rows="${3:-44}"; shift; shift 2>/dev/null || true; shift 2>/dev/null || true
here="$(cd "$(dirname "$0")/.." && pwd)"
COLUMNS="$cols" LINES="$rows" bun "$here/demo.ts" --once "$@" | python3 "$here/tools/ansi2svg.py" | rsvg-convert -z 1.4 -o "$out" /dev/stdin
echo "$out"
