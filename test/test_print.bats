#!/usr/bin/env bats

load test_helper

setup() { cd "$BATS_TEST_DIRNAME/.." ; }

@test "clode -p reaches the model" {
  [ -z "${CLODE_OFFLINE:-}" ] || skip "offline"
  run "$CLODE_BIN" -p 'reply with exactly: PONG'
  [ "$status" -eq 0 ]
  ! grep -qiE 'not yet implemented|Cannot find module|is not a function' <<<"$output"
  [[ "$output" == *PONG* ]]
}
