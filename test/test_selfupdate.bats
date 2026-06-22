#!/usr/bin/env bats

load test_helper

setup() {
  cd "$BATS_TEST_DIRNAME/.."
  ROOT=$(pwd)
  TMP=$(mktemp -d)
  export HOME="$TMP/home"; mkdir -p "$HOME"
  export CLODE_CACHE="$TMP/cache"
  export CLODE_LIBEXEC="$ROOT/libexec"
  BIN="$TMP/usr/bin/claude"; mkdir -p "$(dirname "$BIN")"
  /opt/pkg/bin/python3 test/mkfixture.py "$BIN" v1
  export CLODE_CLAUDE_BIN="$BIN"
}

teardown() {
  rm -rf "$TMP"
}

@test "cache miss extracts and boots v1" {
  run ./bin/clode
  grep -q 'extracting JS' <<<"$output"
  [[ "$output" == *"CLODE-FIXTURE v1"* ]]
}

@test "cache hit skips re-extract" {
  ./bin/clode >/dev/null 2>/dev/null  # warm cache
  run ./bin/clode
  ! grep -q 'extracting JS' <<<"$output"
  [[ "$output" == *"CLODE-FIXTURE v1"* ]]
}

@test "provider upgrade auto-invalidates cache and re-extracts v2" {
  ./bin/clode >/dev/null 2>/dev/null  # warm cache for v1
  /opt/pkg/bin/python3 test/mkfixture.py "$BIN" v2-updated
  run ./bin/clode
  grep -q 'extracting JS' <<<"$output"
  [[ "$output" == *"CLODE-FIXTURE v2-updated"* ]]
}
