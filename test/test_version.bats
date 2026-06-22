#!/usr/bin/env bats

load test_helper

setup() { cd "$BATS_TEST_DIRNAME/.." ; }

@test "clode --clode-version reports dev in-tree" {
  run ./bin/clode --clode-version
  [ "$status" -eq 0 ]
  [ "$output" = "clode dev" ]
}

@test "VERSION is 0.1.0 and LICENSE is BSD-2-Clause" {
  run cat VERSION
  [ "$output" = "0.1.0" ]
  grep -qi 'BSD 2-Clause\|Redistribution and use' LICENSE
}
