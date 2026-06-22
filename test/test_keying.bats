#!/usr/bin/env bats

load test_helper

setup() {
  cd "$BATS_TEST_DIRNAME/.."
  ROOT=$(pwd)
  TMP=$(mktemp -d)
  export HOME="$TMP/home"; mkdir -p "$HOME"
  export CLODE_LIBEXEC="$ROOT/libexec"
}

teardown() {
  rm -rf "$TMP"
}

@test "version-encoded path uses version as cache key" {
  export CLODE_CACHE="$TMP/c1"
  mkdir -p "$TMP/share/versions"
  /opt/pkg/bin/python3 test/mkfixture.py "$TMP/share/versions/9.9.9" v
  CLODE_CLAUDE_BIN="$TMP/share/versions/9.9.9" ./bin/clode >/dev/null 2>&1
  test -d "$TMP/c1/9.9.9"
}

@test "non-encoded path uses basename-sig as cache key" {
  export CLODE_CACHE="$TMP/c2"
  mkdir -p "$TMP/bin"
  /opt/pkg/bin/python3 test/mkfixture.py "$TMP/bin/claude" v
  CLODE_CLAUDE_BIN="$TMP/bin/claude" ./bin/clode >/dev/null 2>&1
  ls "$TMP/c2" | grep -q '^claude-'
}

@test "stable key: identical binary re-run yields exactly one cache entry" {
  export CLODE_CACHE="$TMP/c2"
  mkdir -p "$TMP/bin"
  /opt/pkg/bin/python3 test/mkfixture.py "$TMP/bin/claude" v
  CLODE_CLAUDE_BIN="$TMP/bin/claude" ./bin/clode >/dev/null 2>&1
  CLODE_CLAUDE_BIN="$TMP/bin/claude" ./bin/clode >/dev/null 2>&1
  n=$(ls "$TMP/c2" | wc -l | tr -d ' ')
  [ "$n" = "1" ]
}
