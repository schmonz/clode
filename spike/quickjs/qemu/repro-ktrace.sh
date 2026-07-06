#!/bin/sh
# Minimal repro + ktrace root-cause of the `qjs -c` standalone spin
# (Gate 3 finding). Runs INSIDE the NetBSD guest. Builds qjs-ng from the
# pinned tarball only (no txiki), compiles a TINY standalone (console.log),
# ktraces it for a few seconds, then (bounded by ulimit -t) also spins the
# real bundle-exe to confirm same signature.
set -ux
HOSTD=http://10.0.2.2:8080
W=/root/qjswork; mkdir -p "$W"; cd "$W"
ftp -o PINS.md "$HOSTD/PINS.md"
QJS_TAG=$(awk '$1=="quickjs-ng"{print $2; exit}' PINS.md)
ftp -o qjs.tgz "$HOSTD/vendor/dist/quickjs-ng-$QJS_TAG.tar.gz"
tar xzf qjs.tgz && mv quickjs-* qjs-src
echo "=== BUILD-QJS ==="
(cd qjs-src && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j2); echo "qjs-build-exit=$?"

QJS="$W/qjs-src/build/qjs"

echo "=== MINIMAL-REPRO-SETUP ==="
echo 'console.log(1);' > tiny.js
"$QJS" -c tiny.js -o tiny-exe
ls -la tiny-exe

echo "=== MINIMAL-REPRO-RUN (bounded, ktrace) ==="
# Launch under ktrace, bounded CPU time so it can't run away; </dev/null so
# stdin is a real, immediately-EOF fd (matches how the driver's earlier
# unbounded run had no controlling tty either).
(ulimit -t 8; ktrace -f tiny.ktrace ./tiny-exe </dev/null >tiny.out 2>tiny.err)
echo "tiny-exe-exit=$?"
echo "--- tiny.out ---"; cat tiny.out
echo "--- tiny.err ---"; cat tiny.err
echo "--- kdump head ---"
kdump -f tiny.ktrace | head -40
echo "--- kdump syscall histogram ---"
kdump -f tiny.ktrace | awk '{print $4}' | sort | uniq -c | sort -rn | head -20
echo "--- kdump line count ---"
kdump -f tiny.ktrace | wc -l

echo "=== BUNDLE-REPRO-SETUP ==="
ftp -o cli.cjs "$HOSTD/vendor/dist/cli.cjs"
"$QJS" -c cli.cjs -o bundle-exe
ls -la bundle-exe

echo "=== BUNDLE-REPRO-RUN (bounded, ktrace) ==="
(ulimit -t 8; ktrace -f bundle.ktrace ./bundle-exe </dev/null >bundle.out 2>bundle.err)
echo "bundle-exe-exit=$?"
echo "--- bundle.out ---"; cat bundle.out
echo "--- bundle.err ---"; cat bundle.err
echo "--- kdump histogram (bundle) ---"
kdump -f bundle.ktrace | awk '{print $4}' | sort | uniq -c | sort -rn | head -20

echo "=== HOSTINFO ==="
uname -a
echo "=== REPRO-DONE ==="
