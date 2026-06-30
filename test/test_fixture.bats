#!/usr/bin/env bats

load test_helper

setup() {
  cd "$BATS_TEST_DIRNAME/.."
  TMP=$(mktempd)
}

teardown() {
  rm -rf "$TMP"
}

@test "extractor carves fixture and Node boots it to the label" {
  "$CLODE_PYTHON" test/mkfixture.py "$TMP/claude" hello
  "$CLODE_NODE" libexec/extract-claude-js.cjs "$TMP/claude" "$TMP/cli.cjs" 2>/dev/null
  cp libexec/bun-shim.cjs "$TMP/bun-shim.cjs"
  run "$CLODE_NODE" "$TMP/cli.cjs"
  [[ "$output" == *"CLODE-FIXTURE hello"* ]]
}
