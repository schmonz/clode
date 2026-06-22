#!/usr/bin/env bats

load test_helper

setup() { cd "$BATS_TEST_DIRNAME/.." ; }

@test "Bash tool works end-to-end via -p" {
  [ -z "${CLODE_OFFLINE:-}" ] || skip "offline"
  run timeout 120 ./bin/clode -p 'run the bash command: echo HELLO123 and report its output' --allowedTools Bash
  [ "$status" -eq 0 ]
  ! grep -qiE 'not yet implemented|is not a function|Cannot find module' <<<"$output"
  [[ "$output" == *HELLO123* ]]
}
