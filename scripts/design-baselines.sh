#!/usr/bin/env bash
# Capture the Design-approved visual baselines: one headless-chromium render
# per approved flow prototype (design/prototypes/*). These are the reference
# images the visual-parity AC holds the built frontend against — Design
# accepts the prototypes, CI keeps the build honest. Full state-matrix
# captures (state × theme × surface via each embed's switcher) run under
# Playwright in CI once npm is reachable; this script needs only a chromium
# binary (CHROME env var or the Playwright cache path).
set -euo pipefail
CHROME="${CHROME:-/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell}"
OUT="${1:-design/baselines}"
mkdir -p "$OUT"
shopt -s nullglob
for f in design/prototypes/*.html; do
  name=$(basename "$f" .html | tr ' &' '-.' | tr -s '-')
  "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --screenshot="$OUT/$name.png" --window-size=1440,900 \
    "file://$(realpath "$f")" 2>/dev/null
  echo "baseline: $OUT/$name.png"
done
