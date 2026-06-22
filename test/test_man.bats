#!/usr/bin/env bats

load test_helper

setup() { cd "$BATS_TEST_DIRNAME/.." ; }

@test "man page file exists" {
  test -f man/clode.1
}

@test "man page has NAME section" {
  grep -q '^\.Sh NAME' man/clode.1
}

@test "man page has SYNOPSIS section" {
  grep -q '^\.Sh SYNOPSIS' man/clode.1
}

@test "man page has DESCRIPTION section" {
  grep -q '^\.Sh DESCRIPTION' man/clode.1
}

@test "man page has ENVIRONMENT section" {
  grep -q '^\.Sh ENVIRONMENT' man/clode.1
}

@test "man page has FILES section" {
  grep -q '^\.Sh FILES' man/clode.1
}

@test "man page documents CLODE_CLAUDE_BIN" {
  grep -q 'CLODE_CLAUDE_BIN' man/clode.1
}

@test "man page documents CLODE_CACHE" {
  grep -q 'CLODE_CACHE' man/clode.1
}

@test "man page documents CLODE_LIBEXEC" {
  grep -q 'CLODE_LIBEXEC' man/clode.1
}

@test "man page documents CLODE_NODE" {
  grep -q 'CLODE_NODE' man/clode.1
}

@test "mandoc lint runs without error (if mandoc available)" {
  command -v mandoc >/dev/null 2>&1 || skip "mandoc not available"
  mandoc -Tlint man/clode.1 || true
}
