#!/usr/bin/env bats

load test_helper

setup() {
  cd "$BATS_TEST_DIRNAME/.."
  ROOT=$(pwd)
  TMP=$(mktempd)
  export HOME="$TMP/home"; mkdir -p "$HOME"
  export CLODE_CACHE="$TMP/cache"
  export CLODE_LIBEXEC="$ROOT/libexec"
  export CLODE_VERBOSE=1   # these tests assert on clode's 'extracting JS' /
                           # 'refreshed cached bun-shim' chatter, gated on verbose
  BIN="$TMP/usr/bin/claude"; mkdir -p "$(dirname "$BIN")"
  "$CLODE_PYTHON" test/mkfixture.py "$BIN" v1
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
  "$CLODE_PYTHON" test/mkfixture.py "$BIN" v2-updated
  run ./bin/clode
  grep -q 'extracting JS' <<<"$output"
  [[ "$output" == *"CLODE-FIXTURE v2-updated"* ]]
}

@test "stale cached shim is refreshed from source without a re-extract" {
  ./bin/clode >/dev/null 2>/dev/null  # warm cache
  KEY=$(ls "$CLODE_CACHE")
  cached="$CLODE_CACHE/$KEY/bun-shim.cjs"
  printf 'STALE-SHIM\n' > "$cached"   # simulate an out-of-date cached shim
  run ./bin/clode
  [ "$status" -eq 0 ]
  grep -q 'refreshed cached bun-shim' <<<"$output"   # refreshed, not re-extracted
  ! grep -q 'extracting JS' <<<"$output"
  cmp -s "$CLODE_LIBEXEC/bun-shim.cjs" "$cached"      # now matches source again
  [[ "$output" == *"CLODE-FIXTURE v1"* ]]
}
