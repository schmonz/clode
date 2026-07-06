#!/bin/sh
# Gate 1 bundle gate: can qjsc parse the real extracted bundle? If not, can
# an esbuild-lowered copy? Writes ../results/gate1-bundle.md.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
QJSC="$HERE/../vendor/quickjs-ng/build/qjsc"
OUT="$HERE/../results/gate1-bundle.md"
ESBUILD_PIN="0.25.5"
CLI=$(ls -t "${XDG_CACHE_HOME:-$HOME/.cache}"/clode/*/cli.cjs 2>/dev/null | head -1)
[ -n "$CLI" ] || { echo "no extracted cli.cjs in cache" >&2; exit 1; }
VER=$(basename "$(dirname "$CLI")")
SHIM="$(dirname "$CLI")/bun-shim.cjs"
SIZE=$(wc -c < "$CLI" | tr -d ' ')
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

parse_both() { # $1=file  -> sets R_script R_module T_script T_module E_first
  for MODE in script module; do
    case "$MODE" in module) M="-m";; *) M="";; esac
    START=$(date +%s)
    if ERR=$("$QJSC" $M -o /dev/null "$1" 2>&1); then R=PARSE-OK; else R=PARSE-FAIL; fi
    SECS=$(( $(date +%s) - START ))
    eval "R_$MODE=\$R T_$MODE=\$SECS"
    [ "$R" = PARSE-FAIL ] && E_first=$(printf '%s' "$ERR" | head -2 | tr '|' '/')
  done
}

E_first=""
parse_both "$CLI"
{
  echo "# Gate 1 — bundle parse gate"
  echo
  echo "Bundle: $CLI (version $VER, $SIZE bytes)"
  echo
  echo "| input | mode | result | seconds |"
  echo "|---|---|---|---|"
  echo "| raw | script | $R_script | $T_script |"
  echo "| raw | module | $R_module | $T_module |"
} > "$OUT"
[ -n "$E_first" ] && printf '\nFirst raw parse error:\n```\n%s\n```\n' "$E_first" >> "$OUT"

if [ "$R_script" = PARSE-FAIL ] && [ "$R_module" = PARSE-FAIL ]; then
  printf '\n## Transform fallback (esbuild %s)\n\n| target | esbuild | parse (best mode) | xform secs | bytes | node smoke |\n|---|---|---|---|---|---|\n' "$ESBUILD_PIN" >> "$OUT"
  for TGT in es2022 es2021 es2020; do
    LOW="$TMP/cli-$TGT.cjs"
    START=$(date +%s)
    if npx -y "esbuild@$ESBUILD_PIN" "$CLI" --target="$TGT" --outfile="$LOW" >/dev/null 2>"$TMP/eserr"; then EB=OK; else EB="FAIL: $(head -1 "$TMP/eserr" | tr '|' '/')"; fi
    XS=$(( $(date +%s) - START ))
    if [ "$EB" = OK ]; then
      parse_both "$LOW"
      BEST=$R_script; [ "$R_module" = PARSE-OK ] && BEST=PARSE-OK
      LB=$(wc -c < "$LOW" | tr -d ' ')
      if node --require "$SHIM" "$LOW" --version >/dev/null 2>&1; then SMOKE=OK; else SMOKE=FAIL; fi
      echo "| $TGT | OK | $BEST | $XS | $LB | $SMOKE |" >> "$OUT"
      [ "$BEST" = PARSE-OK ] && break
    else
      echo "| $TGT | $EB | - | $XS | - | - |" >> "$OUT"
    fi
  done
fi
cat "$OUT"
