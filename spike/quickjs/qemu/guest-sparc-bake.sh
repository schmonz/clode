#!/bin/sh
# guest-sparc-bake.sh — PHASE A of the sparc S2 tjs campaign: the ONE
# persist-boot exception. Builds GNU make 4.4.1 then cmake 3.28.6 FROM SOURCE
# (no pkgsrc binaries exist for 32-bit sparc) and installs both to /usr/local,
# baking them into wd0.img (driver boots with persist=True; wd0.img.pristine-10.1
# backup taken on the host FIRST). Runs INSIDE the NetBSD/sparc 10.1 sun4m
# guest (SS-20, -m 512M). cmake choice: 3.28.6 — bootstrap needs only C++11
# (README.rst verified) so base g++ 10.5 suffices; satisfies every
# cmake_minimum_required in the txiki tree (max 3.18, and that dep — mimalloc —
# is built OFF anyway); avoids cmake 4.x compat removals while staying close in
# policy behavior to the pkgsrc cmake 4.2.3 that proved this tree on aarch64.
# cmake itself is built -O1: its runtime speed is irrelevant (configure of tjs
# is minutes) and -O1 cuts g++ TCG time + RAM spikes vs Release -O3.
#
# Markers: a-fetch-*, a-gmake-exit=N, a-cmake-bootstrap-exit=N,
# a-cmake-build-exit=N, a-cmake-exit=N (install), a-cmake-version-exit=N,
# '=== GUEST-DONE ===' at the end. Failures are findings — keep going where
# meaningful (a gmake-only bake is still worth persisting).
set -ux
H=http://10.0.2.2:8180
W=/root/bakework
mkdir -p "$W"; cd "$W" || exit 1

echo "=== HOSTINFO ==="
date
uname -a
cc --version 2>&1 | head -2
c++ --version 2>&1 | head -2
CXX_OK=$?
df -m /
swapctl -l
ulimit -a
# data-size soft limit up to hard (32-bit defaults can be far below physmem)
ulimit -d unlimited 2>/dev/null || ulimit -d "$(ulimit -H -d)" 2>/dev/null
echo "datasize-now=$(ulimit -d)"
# per-process CPU cap: no single compiler process should need >2h CPU even
# under TCG (quickjs.c, the biggest TU we've measured, took 216s); a runaway
# gets SIGXCPU instead of grinding silently. Children inherit.
ulimit -t 7200
echo "cputime-now=$(ulimit -t)"

echo "=== FETCH ==="
f1() { # $1=out $2=url ; 3 tries
  n=0
  while [ "$n" -lt 3 ]; do
    ftp -o "$1" "$2" && return 0
    n=$((n+1)); sleep 10
  done
  echo "FETCH-FAILED $2"; return 1
}
f1 make.tgz "$H/vendor/dist/srcpkgs/make-4.4.1.tar.gz"; echo "a-fetch-make-exit=$?"
f1 cmake.tgz "$H/vendor/dist/srcpkgs/cmake-3.28.6.tar.gz"; echo "a-fetch-cmake-exit=$?"
wc -c make.tgz cmake.tgz

echo "=== BAKE-GMAKE ==="
date
tar xzf make.tgz || echo "a-gmake-untar-failed"
cd "$W/make-4.4.1" || exit 1
GFAIL=0
./configure --prefix=/usr/local --disable-nls || GFAIL=1
# build.sh: GNU make's no-make bootstrap (NetBSD base make is bmake; don't
# trust it with GNU makefiles)
sh build.sh || GFAIL=1
./make install || GFAIL=1
echo "a-gmake-exit=$GFAIL"
/usr/local/bin/gmake --version 2>&1 | head -2
echo "a-gmake-version-exit=$?"
date

echo "=== BAKE-CMAKE ==="
GMAKE=/usr/local/bin/gmake
[ -x "$GMAKE" ] || { echo "a-cmake-exit=SKIP (no gmake)"; echo "=== GUEST-DONE ==="; exit 1; }
[ "$CXX_OK" = 0 ] || { echo "a-cmake-exit=SKIP (no c++ in base)"; echo "=== GUEST-DONE ==="; exit 1; }
cd "$W" || exit 1
tar xzf cmake.tgz || echo "a-cmake-untar-failed"
cd "$W/cmake-3.28.6" || exit 1
# bootstrap phase: unoptimized C++ subset of cmake, built by gmake, then that
# bootstrap cmake configures the real build. -O1 Release overrides keep the
# final build cheap under TCG. No curses (ccmake unused), no tests, no
# OpenSSL (cmake never fetches anything in our guests; slirp internet is dead
# anyway).
env MAKE="$GMAKE" ./bootstrap --prefix=/usr/local --parallel=1 -- \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS_RELEASE="-O1 -DNDEBUG" \
  -DCMAKE_CXX_FLAGS_RELEASE="-O1 -DNDEBUG" \
  -DBUILD_TESTING=OFF \
  -DBUILD_CursesDialog=OFF \
  -DCMAKE_USE_OPENSSL=OFF
echo "a-cmake-bootstrap-exit=$?"
date
"$GMAKE"
echo "a-cmake-build-exit=$?"
"$GMAKE" install
echo "a-cmake-exit=$?"
/usr/local/bin/cmake --version
echo "a-cmake-version-exit=$?"
date

echo "=== CLEANUP (keep the baked image lean) ==="
cd "$W" || exit 1
rm -rf make-4.4.1 cmake-3.28.6 make.tgz cmake.tgz
df -m / /usr/local 2>/dev/null || df -m /
sync
echo "=== GUEST-DONE ==="
