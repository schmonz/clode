#!/usr/bin/env bats
# clode is distributed/installed as an npm package (`npm install -g .`). `npm pack`
# produces the installable tarball; verify it ships exactly what a runnable clode
# needs and nothing else, and that the packed launcher works.

load test_helper

setup() {
  cd "$BATS_TEST_DIRNAME/.."
  NPM="${CLODE_NPM:-npm}"
  command -v "$NPM" >/dev/null 2>&1 || { NPM_SKIP="npm not installed"; return; }
  v=$(cat VERSION)
  PACKDIR=$(mktempd)
  "$NPM" pack --pack-destination "$PACKDIR" >/dev/null 2>&1
  TGZ="$PACKDIR/clode-$v.tgz"
  LIST=$(tar tzf "$TGZ" 2>/dev/null)
}

teardown() { [ -n "${PACKDIR:-}" ] && rm -rf "$PACKDIR"; }

@test "npm pack produces the package tarball" {
  [ -n "${NPM_SKIP:-}" ] && skip "$NPM_SKIP"
  test -f "$TGZ"
}

@test "package ships the launcher, libexec helpers, manifest, version, man, license" {
  [ -n "${NPM_SKIP:-}" ] && skip "$NPM_SKIP"
  for f in bin/clode libexec/bun-shim.cjs libexec/extract-claude-js \
           libexec/inspect-claude-bundle package.json VERSION man/clode.1 LICENSE; do
    echo "$LIST" | grep -q "^package/$f\$" || { echo "missing: $f"; false; }
  done
}

@test "package excludes tests, build artifacts, and node_modules" {
  [ -n "${NPM_SKIP:-}" ] && skip "$NPM_SKIP"
  ! echo "$LIST" | grep -qE 'package/(test/|Makefile|node_modules/)|cli\.cjs|/build/'
}

@test "the packed launcher runs and reports its version" {
  [ -n "${NPM_SKIP:-}" ] && skip "$NPM_SKIP"
  tar xzf "$TGZ" -C "$PACKDIR"
  run "$PACKDIR/package/bin/clode" --clode-version
  [ "$status" -eq 0 ]
  [ "$output" = "clode $v" ]
}
