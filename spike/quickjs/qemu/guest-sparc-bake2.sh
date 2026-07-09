#!/bin/sh
# guest-sparc-bake2.sh — PHASE A run 2 (persist): finish the toolchain bake.
# Run 1 (sparc-s2a-console.log.run1) built GNU make 4.4.1 fine but installed
# it under its DEFAULT name /usr/local/bin/make (no --program-prefix=g), so
# the cmake stage's [ -x /usr/local/bin/gmake ] guard — probing the explicit
# path — correctly failed and cmake was skipped. (The contradictory
# a-gmake-version-exit=0 was pipe masking: `gmake --version | head` reports
# head's status.) This run: give GNU make its gmake name (symlink; rebuild
# only if run 1's make didn't persist), then build cmake 3.28.6 from source.
# Version markers here avoid pipes so $? is the probed command's own status,
# and every guard echoes the exact path it probed.
set -ux
H=http://10.0.2.2:8180
W=/root/bakework
mkdir -p "$W"; cd "$W" || exit 1

echo "=== HOSTINFO ==="
date
uname -a
df -m /
ulimit -d unlimited 2>/dev/null || ulimit -d "$(ulimit -H -d)" 2>/dev/null
echo "datasize-now=$(ulimit -d)"
ulimit -t 7200
echo "cputime-now=$(ulimit -t)"

echo "=== A2-GMAKE (name fix / rebuild-if-missing) ==="
GFAIL=0
if [ -x /usr/local/bin/make ] && /usr/local/bin/make --version 2>/dev/null | grep -q 'GNU Make'; then
  echo "a2-gmake-probe=/usr/local/bin/make is GNU Make (run-1 bake persisted)"
  ln -sf make /usr/local/bin/gmake || GFAIL=1
else
  echo "a2-gmake-probe=/usr/local/bin/make missing or not GNU — rebuilding"
  f1() { n=0; while [ "$n" -lt 3 ]; do ftp -o "$1" "$2" && return 0; n=$((n+1)); sleep 10; done; echo "FETCH-FAILED $2"; return 1; }
  f1 make.tgz "$H/vendor/dist/srcpkgs/make-4.4.1.tar.gz" || GFAIL=1
  tar xzf make.tgz || GFAIL=1
  cd "$W/make-4.4.1" || exit 1
  ./configure --prefix=/usr/local --program-prefix=g --disable-nls || GFAIL=1
  sh build.sh || GFAIL=1
  ./make install || GFAIL=1
  cd "$W" || exit 1
fi
echo "a2-gmake-exit=$GFAIL"
[ -x /usr/local/bin/gmake ] || echo "a2-gmake-probe-FAILED path=/usr/local/bin/gmake"
/usr/local/bin/gmake --version > /tmp/gmv.txt 2>&1
echo "a2-gmake-version-exit=$?"
sed -n 1,2p /tmp/gmv.txt

echo "=== BAKE-CMAKE ==="
GMAKE=/usr/local/bin/gmake
[ -x "$GMAKE" ] || { echo "a-cmake-exit=SKIP (probed $GMAKE: not executable)"; echo "=== GUEST-DONE ==="; exit 1; }
c++ --version > /tmp/cxx.txt 2>&1
CXX_OK=$?
sed -n 1,1p /tmp/cxx.txt
[ "$CXX_OK" = 0 ] || { echo "a-cmake-exit=SKIP (probed c++: exit $CXX_OK)"; echo "=== GUEST-DONE ==="; exit 1; }
f2() { n=0; while [ "$n" -lt 3 ]; do ftp -o "$1" "$2" && return 0; n=$((n+1)); sleep 10; done; echo "FETCH-FAILED $2"; return 1; }
f2 cmake.tgz "$H/vendor/dist/srcpkgs/cmake-3.28.6.tar.gz"
echo "a-fetch-cmake-exit=$?"
wc -c cmake.tgz
tar xzf cmake.tgz || echo "a-cmake-untar-failed"
cd "$W/cmake-3.28.6" || exit 1
# bootstrap: unoptimized C++ subset built by gmake, which then configures the
# real build. -O1 Release overrides keep the final build cheap under TCG
# (cmake runtime speed is irrelevant here). No curses/tests/OpenSSL.
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
df -m /
sync
echo "=== GUEST-DONE ==="
