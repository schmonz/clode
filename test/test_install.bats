#!/usr/bin/env bats

load test_helper

setup() {
  cd "$BATS_TEST_DIRNAME/.."
  TMP=$(mktemp -d)
  DEST="$TMP/dest"
  make install DESTDIR="$DEST" PREFIX=/usr \
    NODE="$(command -v node)" PYTHON="$(command -v python3)" CLAUDE_BIN=/opt/fake/claude
}

teardown() {
  rm -rf "$TMP"
}

@test "make install lands clode binary" {
  test -x "$DEST/usr/bin/clode"
}

@test "make install lands extractor" {
  test -f "$DEST/usr/libexec/clode/extract-claude-js"
}

@test "make install lands bun-shim" {
  test -f "$DEST/usr/libexec/clode/bun-shim.cjs"
}

@test "make install lands man page" {
  test -f "$DEST/usr/share/man/man1/clode.1"
}

@test "make install lands LICENSE doc" {
  test -f "$DEST/usr/share/doc/clode/LICENSE"
}

@test "installed clode has no unsubstituted placeholders" {
  ! grep -q '@[A-Z_]*@' "$DEST/usr/bin/clode"
}

@test "installed clode has libexec baked in" {
  grep -q '/usr/libexec/clode' "$DEST/usr/bin/clode"
}

@test "installed clode has CLAUDE_BIN baked in" {
  grep -q '/opt/fake/claude' "$DEST/usr/bin/clode"
}

@test "installed clode --clode-version reports correct version" {
  v=$(cat VERSION)
  run "$DEST/usr/bin/clode" --clode-version
  [ "$status" -eq 0 ]
  [ "$output" = "clode $v" ]
}

@test "make install lands inspect-claude-bundle" {
  test -f "$DEST/usr/libexec/clode/inspect-claude-bundle"
}

@test "make install does not install BACKLOG.md" {
  ! test -e "$DEST/usr/share/doc/clode/BACKLOG.md"
}
