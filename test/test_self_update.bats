#!/usr/bin/env bats
# clode update: host-agnostic fetch of the upstream JS into a clode-owned provider store.
load test_helper

setup() {
  cd "$BATS_TEST_DIRNAME/.."
  TMP=$(mktempd)
  export HOME="$TMP/home"; mkdir -p "$HOME"
  # CLODE_STATE_ROOT (set by test_helper's sandbox) outranks XDG_DATA_HOME in
  # clode-paths' precedence, so it would silently swallow this file's own
  # per-test isolation below. Unset it so XDG_DATA_HOME governs, as this file
  # (and its assertions against $XDG_DATA_HOME/clode/...) expects.
  unset CLODE_STATE_ROOT
  export XDG_DATA_HOME="$TMP/data"
  REPO="$TMP/repo"; V=9.9.9; PLAT=linux-x64
  mkdir -p "$REPO/$V/$PLAT"
  "$CLODE_NODE" test/mkfixture.cjs "$REPO/$V/$PLAT/claude" v
  if command -v sha256sum >/dev/null 2>&1; then SUM=$(sha256sum "$REPO/$V/$PLAT/claude" | cut -d' ' -f1)
  else SUM=$(shasum -a 256 "$REPO/$V/$PLAT/claude" | cut -d' ' -f1); fi
  printf '%s\n' "$V" > "$REPO/stable"
  printf '%s\n' "$V" > "$REPO/latest"
  printf '{"platforms":{"%s":{"checksum":"%s"}}}\n' "$PLAT" "$SUM" > "$REPO/$V/manifest.json"
  export CLODE_RELEASES_URL="file://$REPO"
  # Keep the post-update signals digest offline and out of the real repo: a
  # local changelog fixture + a temp snapshot dir (else it would fetch GitHub
  # and write into this checkout's signals/ via the $HERE/../.git fallback).
  printf '# Changelog\n\n## %s\n\n- Upgraded the bundled Bun runtime to 9.9\n- Fixed a thing\n' "$V" > "$REPO/CHANGELOG.md"
  export CLODE_CHANGELOG_URL="file://$REPO/CHANGELOG.md"
  export CLODE_SIGNALS_DIR="$TMP/signals"
}
teardown() { rm -rf "$TMP"; }

# NB: the sourcing @tests that called sh-internal helpers directly
# (sha256_of, clode_update, resolve_claude_bin, cache_key) were removed when
# bin/clode became a Node program. Their behavior is covered by the module
# node --test units: sha256_of -> sha256Of (test/clode-net.test.cjs),
# clode_update + checksum-abort -> test/clode-update.test.cjs, resolve_claude_bin
# + cache_key -> test/clode-resolve.test.cjs. The subprocess @tests below still
# exercise the JS launcher end-to-end.

@test "clode update <channel> fetches and reports, then exits" {
  run env CLODE_CLAUDE_BIN=/nonexistent "$CLODE_BIN" update stable
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "updated to 9.9.9"
  test -f "$XDG_DATA_HOME/clode/providers/9.9.9/claude"
}

@test "clode --clode-internal-update <channel> fetches like update (non-interactive)" {
  run env CLODE_CLAUDE_BIN=/nonexistent "$CLODE_BIN" --clode-internal-update stable
  [ "$status" -eq 0 ]
  test -f "$XDG_DATA_HOME/clode/providers/9.9.9/claude"
}

@test "clode update prints a warn-only signals digest and writes a snapshot" {
  run env CLODE_CLAUDE_BIN=/nonexistent "$CLODE_BIN" update stable
  [ "$status" -eq 0 ]                                   # warn-only: never blocks
  echo "$output" | grep -q "clode signals for 9.9.9"
  echo "$output" | grep -q "Upgraded the bundled Bun runtime"   # HIGH release-note signal
  test -f "$TMP/signals/9.9.9.json"
  grep -q '"version": "9.9.9"' "$TMP/signals/9.9.9.json"
}

@test "after clode update, launching clode extracts the fetched provider" {
  export CLODE_CACHE="$TMP/cache"
  env CLODE_CLAUDE_BIN=/nonexistent "$CLODE_BIN" update stable >/dev/null 2>&1
  # CLODE_CLAUDE_BIN was only set inline for the update above (never exported), so a
  # plain launch resolves the fetched provider. (Avoid `env -u`: BSD env lacks it.)
  "$CLODE_BIN" >/dev/null 2>&1 || true
  test -f "$TMP/cache/9.9.9/cli.cjs"
}
