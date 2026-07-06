#!/bin/sh
# Gate 3 memory axis: peak RSS of parsing/running the real bundle under
# quickjs-ng. Portable across macOS and NetBSD (/usr/bin/time -l; units are
# bytes on macOS, KB on NetBSD — raw lines are recorded, not converted).
# Env overrides: QJS, QJSC, CLI. Arg 1: output-file suffix.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
QJS="${QJS:-$HERE/vendor/quickjs-ng/build/qjs}"
QJSC="${QJSC:-$HERE/vendor/quickjs-ng/build/qjsc}"
CLI="${CLI:-$(ls -t "${XDG_CACHE_HOME:-$HOME/.cache}"/clode/*/cli.cjs 2>/dev/null | head -1)}"
SUF="${1:-$(uname -s | tr 'A-Z' 'a-z')-$(uname -m)}"
mkdir -p "$HERE/results"
OUT="$HERE/results/gate3-mem-$SUF.md"
TMP="${TMPDIR:-/tmp}/qjsmem.$$"; mkdir -p "$TMP"; trap 'rm -rf "$TMP"' EXIT

m() { # $1=label, rest=command; append raw time(1) evidence
  L="$1"; shift
  echo; echo "## $L"; echo '```'
  echo "\$ $*"
  /usr/bin/time -l "$@" < /dev/null > /dev/null 2> "$TMP/t"
  echo "exit=$?"
  grep -iE 'maximum resident|real' "$TMP/t" || sed -n '1,4p' "$TMP/t"
  echo '```'
}

{
  echo "# Gate 3 — memory axis ($SUF)"
  echo
  echo "Bundle: $CLI ($(wc -c < "$CLI" | tr -d ' ') bytes)."
  m "qjsc parse+compile (source -> bytecode, discarded)" "$QJSC" -o /dev/null "$CLI"
  m "qjs run-from-source (crash at first missing API is expected evidence)" "$QJS" "$CLI"
  m "control: qjs empty script" "$QJS" -e "1"
} > "$OUT"

# Best-effort: standalone (bytecode-embedded) executable — measures the
# run-from-bytecode path the shipping mechanism would use. quickjs-ng's qjs
# interpreter has its own compile-and-embed mode (`qjs -c FILE -o OUT`) that
# emits a real executable; try that first. Do NOT confuse it with `qjsc -o`,
# which only ever emits C source and never links — that path is kept as a
# fallback for builds whose qjs lacks -c, and its failure is still evidence.
if "$QJS" -c "$CLI" -o "$TMP/bundle-exe" 2> "$TMP/saerr" \
   && [ -x "$TMP/bundle-exe" ]; then
  m "standalone run-from-bytecode via qjs -c (crash expected)" "$TMP/bundle-exe" >> "$OUT"
elif "$QJSC" -o "$TMP/bundle-bin" "$CLI" 2>> "$TMP/saerr" \
     && [ -x "$TMP/bundle-bin" ]; then
  m "standalone run-from-bytecode via qjsc -o (crash expected)" "$TMP/bundle-bin" >> "$OUT"
else
  { echo; echo "## standalone: neither qjs -c nor qjsc -o produced an executable"; echo '```'; sed -n '1,5p' "$TMP/saerr"; echo '```'; } >> "$OUT"
fi
cat "$OUT"
