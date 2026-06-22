#!/usr/bin/env bats

load test_helper

setup() { cd "$BATS_TEST_DIRNAME/.." ; }

@test "embedded-asset shim raises no consumer errors on --help" {
  [ -z "${CLODE_OFFLINE:-}" ] || skip "offline"
  run bash -c './bin/clode --help >/dev/null 2>/tmp/a_bats.err; cat /tmp/a_bats.err'
  ! echo "$output" | grep -qiE 'embeddedFiles|yoga|ENOENT.*\.(wasm|node)'
}

@test "embedded-asset shim raises no consumer errors on -p" {
  [ -z "${CLODE_OFFLINE:-}" ] || skip "offline"
  run bash -c './bin/clode -p '"'"'reply with exactly: PONG'"'"' >/dev/null 2>/tmp/a_bats2.err; cat /tmp/a_bats2.err'
  ! echo "$output" | grep -qiE 'embeddedFiles|ENOENT.*\.(wasm|node)'
}
