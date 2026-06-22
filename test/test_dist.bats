#!/usr/bin/env bats

load test_helper

setup() {
  cd "$BATS_TEST_DIRNAME/.."
  v=$(cat VERSION)
  make dist >/dev/null
  TAR="clode-$v.tar.gz"
  LIST=$(tar tzf "$TAR")
}

teardown() {
  cd "$BATS_TEST_DIRNAME/.."
  v=$(cat VERSION)
  rm -f "clode-$v.tar.gz"
}

@test "dist tarball exists" {
  v=$(cat VERSION)
  test -f "clode-$v.tar.gz"
}

@test "dist contains bin/clode" {
  v=$(cat VERSION)
  echo "$LIST" | grep -q "clode-$v/bin/clode"
}

@test "dist contains Makefile" {
  v=$(cat VERSION)
  echo "$LIST" | grep -q "clode-$v/Makefile"
}

@test "dist contains LICENSE" {
  v=$(cat VERSION)
  echo "$LIST" | grep -q "clode-$v/LICENSE"
}

@test "dist contains libexec/bun-shim.cjs" {
  v=$(cat VERSION)
  echo "$LIST" | grep -q "clode-$v/libexec/bun-shim.cjs"
}

@test "dist contains libexec/extract-claude-js" {
  v=$(cat VERSION)
  echo "$LIST" | grep -q "clode-$v/libexec/extract-claude-js"
}

@test "dist contains man/clode.1" {
  v=$(cat VERSION)
  echo "$LIST" | grep -q "clode-$v/man/clode.1"
}

@test "dist contains no forbidden build artifacts" {
  if echo "$LIST" | grep -qE 'cli\.cjs|/build/|^build/'; then
    echo "$LIST" | grep -E 'cli\.cjs|build/'
    false
  fi
}
