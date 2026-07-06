#!/bin/sh
# Gate 1 syntax micro-tests: parse (qjsc) + run (qjs) each file, node as
# control. Writes ../results/gate1-syntax.md. Exit 0 always — the table is
# the evidence; the gate decision is made by a human against the spec.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
QJS="$HERE/../vendor/quickjs-ng/build/qjs"
QJSC="$HERE/../vendor/quickjs-ng/build/qjsc"
OUT="$HERE/../results/gate1-syntax.md"
{
  echo "# Gate 1 — syntax micro-tests"
  echo
  echo "Engines: node $(node -v), quickjs-ng $(awk '$1=="quickjs-ng"{print $2; exit}' "$HERE/../PINS.md")"
  echo
  echo "| file | node run | qjsc parse | qjs run |"
  echo "|---|---|---|---|"
} > "$OUT"
for f in using.js await-using.js static-blocks.js regex-features.js import-meta.mjs; do
  case "$f" in *.mjs) M="-m";; *) M="";; esac
  if node "$HERE/$f" >/dev/null 2>&1; then NODE=RUN-OK; else NODE=RUN-FAIL; fi
  if "$QJSC" $M -o /dev/null "$HERE/$f" >/dev/null 2>&1; then PARSE=PARSE-OK; else PARSE=PARSE-FAIL; fi
  if "$QJS" $M "$HERE/$f" >/dev/null 2>&1; then RUN=RUN-OK; else RUN=RUN-FAIL; fi
  echo "| $f | $NODE | $PARSE | $RUN |" >> "$OUT"
done
cat "$OUT"
