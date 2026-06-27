#!/usr/bin/env bats

GUARD="${BATS_TEST_DIRNAME}/../libexec/clode-update-guard.cjs"
NODE="$(command -v node)"

run_guard() {  # $1 = stdin JSON
  printf '%s' "$1" | CLODE_SELF=/opt/clode/bin/clode "$NODE" "$GUARD"
}

@test "denies claude update with the clode-self command in the reason" {
  out=$(run_guard '{"tool_name":"Bash","tool_input":{"command":"claude update"}}')
  echo "$out" | grep -q '"permissionDecision":"deny"'
  echo "$out" | grep -q '/opt/clode/bin/clode update'
}

@test "denies claude upgrade even with surrounding tokens" {
  out=$(run_guard '{"tool_name":"Bash","tool_input":{"command":"sudo claude upgrade --yes"}}')
  echo "$out" | grep -q '"permissionDecision":"deny"'
}

@test "allows unrelated bash (no output)" {
  out=$(run_guard '{"tool_name":"Bash","tool_input":{"command":"npm test"}}')
  [ -z "$out" ]
}

@test "allows malformed json, exits 0, no output" {
  run run_guard 'not json at all'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
