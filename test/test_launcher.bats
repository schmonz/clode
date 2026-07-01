#!/usr/bin/env bats

load test_helper

setup() {
  cd "$BATS_TEST_DIRNAME/.."
  export CLODE_CACHE="$(pwd)/build"
}

@test "clode --version reports Claude Code" {
  [ -e "$HOME/.local/bin/claude" ] || skip "no provider binary installed"
  run "$CLODE_BIN" --version
  [ "$status" -eq 0 ]
  [[ "$output" == *"Claude Code"* ]]
}

@test "cache file exists for the currently-linked version" {
  [ -e "$HOME/.local/bin/claude" ] || skip "no provider binary installed"
  ver="$(readlink "$HOME/.local/bin/claude" | xargs basename)"
  test -f "build/$ver/cli.cjs"
}
