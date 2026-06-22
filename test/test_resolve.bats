#!/usr/bin/env bats

load test_helper

setup() {
  cd "$BATS_TEST_DIRNAME/.."
  ROOT=$(pwd)
  TMP=$(mktempd)
  export HOME="$TMP/home"; mkdir -p "$HOME/.local/bin"
  export CLODE_CACHE="$TMP/cache"
  export CLODE_LIBEXEC="$ROOT/libexec"

  mkdir -p "$TMP/share/versions" "$TMP/pathdir"
  "$CLODE_PYTHON" test/mkfixture.py "$TMP/explicit" L-explicit
  "$CLODE_PYTHON" test/mkfixture.py "$TMP/share/versions/9.9.9" L-versiondir
  "$CLODE_PYTHON" test/mkfixture.py "$TMP/local-target" L-local
  ln -sf "$TMP/local-target" "$HOME/.local/bin/claude"
  "$CLODE_PYTHON" test/mkfixture.py "$TMP/pathdir/claude" L-path
  chmod +x "$TMP/pathdir/claude"
}

teardown() {
  rm -rf "$TMP"
}

@test "1. CLODE_CLAUDE_BIN wins over all" {
  out=$(CLODE_CLAUDE_BIN="$TMP/explicit" CLODE_VERSION_DIR="$TMP/share/versions/9.9.9" ./bin/clode 2>/dev/null)
  [[ "$out" == *"L-explicit"* ]]
}

@test "2. CLODE_VERSION_DIR next" {
  out=$(CLODE_VERSION_DIR="$TMP/share/versions/9.9.9" ./bin/clode 2>/dev/null)
  [[ "$out" == *"L-versiondir"* ]]
}

@test "3. ~/.local/bin/claude symlink next" {
  out=$(PATH="$TMP/pathdir:$PATH" ./bin/clode 2>/dev/null)
  [[ "$out" == *"L-local"* ]]
}

@test "4. claude on PATH last" {
  rm -f "$HOME/.local/bin/claude"
  out=$(PATH="$TMP/pathdir:$PATH" ./bin/clode 2>/dev/null)
  [[ "$out" == *"L-path"* ]]
}

@test "5. no provider yields exit 1 and guidance" {
  err=$(PATH="/usr/bin:/bin" HOME="$TMP/empty" ./bin/clode 2>&1 >/dev/null) || rc=$?
  [ "${rc:-0}" -eq 1 ]
  [[ "$err" == *"CLODE_CLAUDE_BIN"* ]]
}
