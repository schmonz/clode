#!/usr/bin/env bats
# clode auto-installs its runtime npm deps (package.json manifest) on first run into
# a user-owned dir, re-installing when the manifest changes, and exits loud if npm
# can't run — UNLESS the deps already ship in clode's own node_modules (an
# `npm install -g .`), in which case there's nothing to install. A fake npm
# (CLODE_NPM) stands in for the real one.

load test_helper

setup() {
  cd "$BATS_TEST_DIRNAME/.."
  ROOT=$(pwd)
  TMP=$(mktempd)
  export HOME="$TMP/home"; mkdir -p "$HOME"
  # A standalone clode package layout (bin + libexec + manifest + VERSION) we can run
  # and mutate without touching the repo, and whose $HERE/../node_modules we control.
  PKG="$TMP/pkg"; mkdir -p "$PKG/bin"
  cp "$ROOT/bin/clode" "$PKG/bin/clode"; chmod +x "$PKG/bin/clode"
  cp -R "$ROOT/libexec" "$PKG/libexec"
  cp "$ROOT/package.json" "$PKG/package.json"
  cp "$ROOT/VERSION" "$PKG/VERSION"
  export CLODE_CACHE="$TMP/cache"
  export CLODE_DEPS="$TMP/deps"        # overrides test_helper's sentinel
  mkdir -p "$TMP/bin"
  "$CLODE_PYTHON" test/mkfixture.py "$TMP/bin/claude" v
  export CLODE_CLAUDE_BIN="$TMP/bin/claude"
  # Fake npm: log the call and create node_modules under --prefix (a "successful" install).
  export NPMLOG="$TMP/npmlog"
  cat > "$TMP/npm-ok" <<'SH'
#!/bin/sh
echo "npm $*" >> "$NPMLOG"
p=""; while [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && p="$2"; shift; done
[ -n "$p" ] && mkdir -p "$p/node_modules/.installed"
SH
  chmod +x "$TMP/npm-ok"
  printf '#!/bin/sh\necho "boom" >&2\nexit 1\n' > "$TMP/npm-fail"; chmod +x "$TMP/npm-fail"
}

teardown() { rm -rf "$TMP"; }

run_clode() { "$PKG/bin/clode" "$@"; }

@test "auto-install runs when the deps dir is empty, and records a sig" {
  CLODE_NPM="$TMP/npm-ok" run_clode >/dev/null 2>&1
  grep -q 'install' "$NPMLOG"
  test -d "$TMP/deps/node_modules/.installed"
  test -f "$TMP/deps/.deps-sig"
}

@test "auto-install is skipped when the manifest sig already matches" {
  CLODE_NPM="$TMP/npm-ok" run_clode >/dev/null 2>&1
  : > "$NPMLOG"
  CLODE_NPM="$TMP/npm-ok" run_clode >/dev/null 2>&1
  ! grep -q 'install' "$NPMLOG"
}

@test "a changed manifest triggers a reinstall" {
  CLODE_NPM="$TMP/npm-ok" run_clode >/dev/null 2>&1
  : > "$NPMLOG"
  printf '\n' >> "$PKG/package.json"
  CLODE_NPM="$TMP/npm-ok" run_clode >/dev/null 2>&1
  grep -q 'install' "$NPMLOG"
}

@test "missing/failing npm exits loud, before launching the bundle" {
  run env CLODE_NPM="$TMP/npm-fail" "$PKG/bin/clode"
  [ "$status" -ne 0 ]
  echo "$output" | grep -qi 'depend'
}

@test "a user-managed CLODE_DEPS (node_modules, no .deps-sig) is left alone" {
  mkdir -p "$TMP/deps/node_modules/.user"
  : > "$NPMLOG"
  CLODE_NPM="$TMP/npm-ok" run_clode >/dev/null 2>&1
  ! grep -q 'install' "$NPMLOG"
}

@test "deps shipped in clode's own node_modules (npm install -g .) -> no auto-install" {
  mkdir -p "$PKG/node_modules/.shipped"   # what `npm install -g .` leaves next to bin/
  : > "$NPMLOG"
  CLODE_NPM="$TMP/npm-ok" run_clode >/dev/null 2>&1
  ! grep -q 'install' "$NPMLOG"
}
