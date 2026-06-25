#!/usr/bin/env bats
# clode auto-installs its runtime npm deps (package.json manifest) on first run into
# a user-owned dir, re-installing when the manifest changes, and exits loud if npm
# can't run. A fake npm (CLODE_NPM) stands in for the real one.

load test_helper

setup() {
  cd "$BATS_TEST_DIRNAME/.."
  ROOT=$(pwd)
  TMP=$(mktempd)
  export HOME="$TMP/home"; mkdir -p "$HOME"
  # A test-owned libexec copy so we can mutate the manifest without touching the repo.
  cp -R "$ROOT/libexec" "$TMP/libexec"
  cp "$ROOT/package.json" "$TMP/libexec/package.json"
  export CLODE_LIBEXEC="$TMP/libexec"
  export CLODE_CACHE="$TMP/cache"
  export CLODE_DEPS="$TMP/deps"
  # Fake claude binary so the launch path runs without a real bundle.
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
  # Fake npm that fails.
  printf '#!/bin/sh\necho "boom" >&2\nexit 1\n' > "$TMP/npm-fail"; chmod +x "$TMP/npm-fail"
}

teardown() { rm -rf "$TMP"; }

run_clode() { CLODE_CLAUDE_BIN="$TMP/bin/claude" ./bin/clode "$@"; }

@test "auto-install runs when the deps dir is empty, and records a sig" {
  CLODE_NPM="$TMP/npm-ok" run_clode >/dev/null 2>&1
  grep -q 'install' "$NPMLOG"
  test -d "$TMP/deps/node_modules/.installed"
  test -f "$TMP/deps/.deps-sig"
}

@test "auto-install is skipped when the manifest sig already matches" {
  CLODE_NPM="$TMP/npm-ok" run_clode >/dev/null 2>&1   # first run installs
  : > "$NPMLOG"
  CLODE_NPM="$TMP/npm-ok" run_clode >/dev/null 2>&1   # second run: fresh, no npm
  ! grep -q 'install' "$NPMLOG"
}

@test "a changed manifest triggers a reinstall" {
  CLODE_NPM="$TMP/npm-ok" run_clode >/dev/null 2>&1
  : > "$NPMLOG"
  # bump the manifest (new size+mtime) -> sig changes
  printf '\n' >> "$TMP/libexec/package.json"
  CLODE_NPM="$TMP/npm-ok" run_clode >/dev/null 2>&1
  grep -q 'install' "$NPMLOG"
}

@test "missing/failing npm exits loud, before launching the bundle" {
  run env CLODE_NPM="$TMP/npm-fail" CLODE_CLAUDE_BIN="$TMP/bin/claude" ./bin/clode
  [ "$status" -ne 0 ]
  echo "$output" | grep -qi 'depend'
}

@test "a user-managed CLODE_DEPS (already has node_modules) is left alone" {
  mkdir -p "$TMP/deps/node_modules/.user"
  : > "$NPMLOG"
  CLODE_NPM="$TMP/npm-ok" run_clode >/dev/null 2>&1
  ! grep -q 'install' "$NPMLOG"
}
