#!/usr/bin/env bats

load test_helper

setup() {
  cd "$BATS_TEST_DIRNAME/.."
}

@test "cache populated for current version" {
  clode_quarantine
  [ -e "$HOME/.local/bin/claude" ] || skip "no provider binary installed"
  cur=$(basename "$(readlink "$HOME/.local/bin/claude")")
  run "$CLODE_BIN" --version
  test -f "build/$cur/cli.cjs"
}

@test "alternate version auto-extracts and boots transparently" {
  clode_quarantine
  [ -e "$HOME/.local/bin/claude" ] || skip "no provider binary installed"
  cur=$(basename "$(readlink "$HOME/.local/bin/claude")")
  alt=$(ls "$HOME/.local/share/claude/versions" | grep -E '^[0-9]' | grep -v "^${cur}$" | head -1)
  if [ -z "$alt" ]; then
    skip "only one version on disk"
  fi
  rm -rf "build/$alt"
  run env CLODE_VERSION_DIR="$HOME/.local/share/claude/versions/$alt" "$CLODE_BIN" --version
  [ "$status" -eq 0 ]
  [[ "$output" == *"$alt"* ]]
  test -f "build/$alt/cli.cjs"
}
