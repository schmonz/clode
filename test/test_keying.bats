#!/usr/bin/env bats

load test_helper

setup() {
  cd "$BATS_TEST_DIRNAME/.."
  ROOT=$(pwd)
  TMP=$(mktempd)
  export HOME="$TMP/home"; mkdir -p "$HOME"
  export CLODE_LIBEXEC="$ROOT/libexec"
  export CLODE_VERBOSE=1   # these tests use clode's 'extracting JS' chatter as the
                           # cache-miss/hit signal, which is silent unless verbose
}

teardown() {
  rm -rf "$TMP"
}

@test "version-encoded path uses version as cache key" {
  export CLODE_CACHE="$TMP/c1"
  mkdir -p "$TMP/share/versions"
  "$CLODE_PYTHON" test/mkfixture.py "$TMP/share/versions/9.9.9" v
  CLODE_CLAUDE_BIN="$TMP/share/versions/9.9.9" ./bin/clode >/dev/null 2>&1
  test -d "$TMP/c1/9.9.9"
}

@test "non-encoded path uses basename-sig as cache key" {
  export CLODE_CACHE="$TMP/c2"
  mkdir -p "$TMP/bin"
  "$CLODE_PYTHON" test/mkfixture.py "$TMP/bin/claude" v
  CLODE_CLAUDE_BIN="$TMP/bin/claude" ./bin/clode >/dev/null 2>&1
  ls "$TMP/c2" | grep -q '^claude-'
}

@test "stable key: identical binary re-run yields exactly one cache entry" {
  export CLODE_CACHE="$TMP/c2"
  mkdir -p "$TMP/bin"
  "$CLODE_PYTHON" test/mkfixture.py "$TMP/bin/claude" v
  CLODE_CLAUDE_BIN="$TMP/bin/claude" ./bin/clode >/dev/null 2>&1
  CLODE_CLAUDE_BIN="$TMP/bin/claude" ./bin/clode >/dev/null 2>&1
  n=$(ls "$TMP/c2" | wc -l | tr -d ' ')
  [ "$n" = "1" ]
}

@test "extractor change re-extracts the cached bundle (binary unchanged)" {
  # The bundle (cli.cjs) is a function of (binary, extractor logic), but the cache
  # key only captures the binary. Without this, an edit to extract-claude-js never
  # reaches existing caches until the provider binary moves (the /doctor patch bug).
  export CLODE_CACHE="$TMP/c3"
  LX="$TMP/libexec"; cp -R "$ROOT/libexec" "$LX"; export CLODE_LIBEXEC="$LX"
  mkdir -p "$TMP/bin"
  "$CLODE_PYTHON" test/mkfixture.py "$TMP/bin/claude" v
  # first run extracts
  CLODE_CLAUDE_BIN="$TMP/bin/claude" ./bin/clode >/dev/null 2>&1
  # second run, extractor UNCHANGED: cache hit, no re-extract
  run env CLODE_CLAUDE_BIN="$TMP/bin/claude" ./bin/clode
  ! echo "$output" | grep -q 'extracting JS'
  # change the extractor (new size+mtime) -> must re-extract even though BIN is identical
  printf '\n# clode-test touch\n' >> "$LX/extract-claude-js"
  run env CLODE_CLAUDE_BIN="$TMP/bin/claude" ./bin/clode
  echo "$output" | grep -q 'extracting JS'
}
