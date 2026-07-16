#!/bin/sh
# smoke-clode-sparc.sh — wall #5a: does the cross-fused sparc clode self-load
# and RUN on real NetBSD/sparc? No compiler, no provider needed — the builder
# carries its own tjs template + payload and materializes on first run. Fetch
# the 14MB clode-sparc over :8180, then ask it its own flags.
# Markers: fetch-clode-exit, selfload-version-exit, selfload-help-exit, GUEST-DONE.
set -ux
H=http://10.0.2.2:8180
W=/root/smoke
mkdir -p "$W"; cd "$W" || exit 1
echo "=== HOSTINFO ==="; date; uname -a

echo "=== FETCH clode-sparc ==="
f1() { n=0; while [ "$n" -lt 3 ]; do ftp -o "$1" "$2" && return 0; n=$((n+1)); sleep 10; done; echo "FETCH-FAILED $2"; return 1; }
f1 clode-sparc "$H/clode-sparc"; echo "fetch-clode-exit=$?"
chmod +x clode-sparc
ls -l clode-sparc
file clode-sparc 2>/dev/null || true

echo "=== SELF-LOAD: --version ==="
(ulimit -t 1800; ./clode-sparc --version); echo "selfload-version-exit=$?"

echo "=== SELF-LOAD: --help (must mention 'clode build') ==="
(ulimit -t 900; ./clode-sparc --help 2>&1 | grep -c 'clode build'); echo "selfload-help-exit=$?"

echo "=== GUEST-DONE ==="
