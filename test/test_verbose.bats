#!/usr/bin/env bats
# clode is silent by default (only Claude Code's output); --clode-verbose un-mutes
# clode's own progress chatter. Plus --clode-help.

load test_helper

setup() {
  cd "$BATS_TEST_DIRNAME/.."
  ROOT=$(pwd)
  TMP=$(mktempd)
  export HOME="$TMP/home"; mkdir -p "$HOME"
  export CLODE_LIBEXEC="$ROOT/libexec"
  export CLODE_CACHE="$TMP/cache"
  BIN="$TMP/claude"
  "$CLODE_NODE" test/mkfixture.cjs "$BIN" tok
  export CLODE_CLAUDE_BIN="$BIN"
}
teardown() { rm -rf "$TMP"; }

@test "--clode-help prints clode-specific options and exits 0" {
  run "$CLODE_BIN" --clode-help
  [ "$status" -eq 0 ]
  echo "$output" | grep -q -- '--clode-verbose'
  echo "$output" | grep -q -- '--clode-version'
  echo "$output" | grep -qi 'clode-specific options'
}

@test "--clode-verbose is stripped before clode-flag dispatch (works in any position)" {
  run "$CLODE_BIN" --clode-verbose --clode-help
  [ "$status" -eq 0 ]
  echo "$output" | grep -q 'run the latest Claude Code'
}

@test "default launch emits NO clode chatter (only the bundle's output)" {
  run "$CLODE_BIN"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q 'CLODE-FIXTURE tok'      # the bundle did run
  ! echo "$output" | grep -q 'extracting JS'        # ...but clode stayed quiet
  ! echo "$output" | grep -q '^clode:'
}

@test "--clode-verbose un-mutes clode's progress, and is consumed (bundle still boots)" {
  run "$CLODE_BIN" --clode-verbose
  [ "$status" -eq 0 ]
  echo "$output" | grep -q 'extracting JS'
  echo "$output" | grep -q 'CLODE-FIXTURE tok'      # flag consumed, not passed on
}

@test "CLODE_VERBOSE=1 env is equivalent to the flag" {
  run env CLODE_VERBOSE=1 "$CLODE_BIN"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q 'extracting JS'
}
