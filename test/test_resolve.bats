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
  "$CLODE_NODE" test/mkfixture.cjs "$TMP/explicit" L-explicit
  "$CLODE_NODE" test/mkfixture.cjs "$TMP/share/versions/9.9.9" L-versiondir
  "$CLODE_NODE" test/mkfixture.cjs "$TMP/local-target" L-local
  ln -sf "$TMP/local-target" "$HOME/.local/bin/claude"
  "$CLODE_NODE" test/mkfixture.cjs "$TMP/pathdir/claude" L-path
  chmod +x "$TMP/pathdir/claude"
}

teardown() {
  rm -rf "$TMP"
}

@test "1. CLODE_CLAUDE_BIN wins over all" {
  out=$(CLODE_CLAUDE_BIN="$TMP/explicit" CLODE_VERSION_DIR="$TMP/share/versions/9.9.9" "$CLODE_BIN" 2>/dev/null)
  [[ "$out" == *"L-explicit"* ]]
}

@test "2. CLODE_VERSION_DIR next" {
  out=$(CLODE_VERSION_DIR="$TMP/share/versions/9.9.9" "$CLODE_BIN" 2>/dev/null)
  [[ "$out" == *"L-versiondir"* ]]
}

@test "3. ~/.local/bin/claude symlink next" {
  out=$(PATH="$TMP/pathdir:$PATH" "$CLODE_BIN" 2>/dev/null)
  [[ "$out" == *"L-local"* ]]
}

@test "4. claude on PATH last" {
  rm -f "$HOME/.local/bin/claude"
  out=$(PATH="$TMP/pathdir:$PATH" "$CLODE_BIN" 2>/dev/null)
  [[ "$out" == *"L-path"* ]]
}

@test "5. no provider yields exit 1 and guidance" {
  # node must be on PATH so the #!/usr/bin/env node JS launcher can start at all (the
  # sh launcher ignores it). We expose ONLY node via a lone symlink dir — not node's
  # real bin dir, which may also hold a `claude` and would defeat the isolation — so
  # empty HOME + this minimal PATH keep every provider absent for BOTH launchers.
  mkdir -p "$TMP/nodebin"; ln -sf "$CLODE_NODE" "$TMP/nodebin/node"
  err=$(PATH="$TMP/nodebin:/usr/bin:/bin" HOME="$TMP/empty" "$CLODE_BIN" 2>&1 >/dev/null) || rc=$?
  [ "${rc:-0}" -eq 1 ]
  [[ "$err" == *"CLODE_CLAUDE_BIN"* ]]
}

@test "6. a tiny exec-wrapper is followed to the real bundle (issue #1)" {
  # /usr/bin/claude is sometimes `exec /opt/.../claude "$@"`; extracting the
  # 110-byte wrapper used to fail with "no @bun-cjs entry marker". Follow it.
  printf '#!/bin/sh\nexec %s "$@"\n' "$TMP/explicit" > "$TMP/wrapper"
  chmod +x "$TMP/wrapper"
  out=$(CLODE_CLAUDE_BIN="$TMP/wrapper" "$CLODE_BIN" 2>/dev/null)
  [[ "$out" == *"L-explicit"* ]]
}

@test "7. a real (non-wrapper) bundle is left untouched" {
  # The big bundle must pass straight through follow_wrapper, not be scanned.
  out=$(CLODE_CLAUDE_BIN="$TMP/explicit" "$CLODE_BIN" 2>/dev/null)
  [[ "$out" == *"L-explicit"* ]]
}
