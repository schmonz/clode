#!/bin/sh
# Gate 4 ladder: smallest module -> extractor -> bundle. Each rung appends
# its output to ../results/gate4-walls.md. Stop rule: ~10 distinct walls or
# the timebox — assessments are added BY HAND after each run.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
TJS="$HERE/../vendor/txiki.js/build/tjs"
OUT="$HERE/../results/gate4-walls.md"
CLI=$(ls -t "${XDG_CACHE_HOME:-$HOME/.cache}"/clode/*/cli.cjs 2>/dev/null | head -1)
[ -f "$OUT" ] || printf '# Gate 4 — boot-attempt wall log\n' > "$OUT"
for rung in "$REPO/libexec/clode-net.cjs" "$REPO/libexec/extract-claude-js.cjs" "$CLI"; do
  printf '\n## rung: %s\n```\n' "$rung" >> "$OUT"
  ~/.local/bin/timeout 60 "$TJS" run "$HERE/cjs-loader.js" "$rung" >> "$OUT" 2>&1
  rc=$?
  if [ "$rc" -eq 124 ]; then printf '(( HANG: killed after 60s ))\n' >> "$OUT"; fi
  printf '```\n' >> "$OUT"
done
cat "$OUT"
