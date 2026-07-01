#!/usr/bin/env bats

load test_helper

setup() { cd "$BATS_TEST_DIRNAME/.." ; }

@test "clode --clode-version reports the shipped VERSION" {
  run "$CLODE_BIN" --clode-version
  [ "$status" -eq 0 ]
  [ "$output" = "clode $(cat VERSION)" ]
}

@test "package.json version matches the VERSION file" {
  # Single source of truth: npm needs a version in package.json; the launcher + dist
  # read the VERSION file. A mismatch means a release would disagree with itself.
  pkgver=$("$CLODE_NODE" -p "require('./package.json').version")
  [ "$pkgver" = "$(cat VERSION)" ]
}

@test "VERSION is 0.1.0 and LICENSE is BSD-2-Clause" {
  run cat VERSION
  [ "$output" = "0.1.0" ]
  grep -qi 'BSD 2-Clause\|Redistribution and use' LICENSE
}
