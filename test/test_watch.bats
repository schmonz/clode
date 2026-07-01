#!/usr/bin/env bats
# clode --clode-watch: opportunistic update-signal watcher.
load test_helper

setup() {
  cd "$BATS_TEST_DIRNAME/.."
  # version_gt resolves `semver` from clode's dep store; pin it to the REAL store
  # so per-test HOME/XDG overrides don't hide it. (semver is a declared ext-dep.)
  # NB: test_helper (loaded above) points CLODE_DEPS at a fixture whose fake
  # `semver` has no `.gt`, so resolve the real store directly from the real HOME
  # (before any per-test override) rather than inheriting that fixture value.
  export CLODE_DEPS="${XDG_DATA_HOME:-$HOME/.local/share}/clode"
  if [ ! -d "$CLODE_DEPS/node_modules/semver" ]; then
    skip "semver ext-dep not installed (run: npm install --prefix \"$CLODE_DEPS\")"
  fi
}

# NB: the sourcing @tests that called sh-internal helpers directly (version_gt,
# watch_dir, write_watch_notice, file_mtime, clode_watch, clode_watch_banner,
# clode_watch_maybe) were removed when bin/clode became a Node program. Their
# behavior is covered by the module node --test units in test/clode-watch.test.cjs
# (versionGt, watchDir, writeWatchNotice, fileMtime, clodeWatch{,Banner,Maybe,Fire}
# incl. the npm-global node_modules layout). The subprocess @tests below still
# exercise the JS launcher end-to-end.

# Build a fake releases repo + provider store. $1 = stable version, $2 = provider
# current version (empty for none), $3 = "high"|"low" changelog content.
_watch_fixture() {
  TMP=$(mktempd)
  export HOME="$TMP/home"; mkdir -p "$HOME"
  export XDG_DATA_HOME="$TMP/data"
  export XDG_CACHE_HOME="$TMP/cache"
  export CLODE_WATCH_DIR="$TMP/cache/clode"
  REPO="$TMP/repo"; mkdir -p "$REPO"
  printf '%s\n' "$1" > "$REPO/stable"
  if [ "$3" = high ]; then
    printf '# Changelog\n\n## %s\n\n- requires the native binary now\n## %s\n\n- old\n' "$1" "${2:-0.0.0}" > "$REPO/CHANGELOG.md"
  else
    printf '# Changelog\n\n## %s\n\n- minor fix\n## %s\n\n- old\n' "$1" "${2:-0.0.0}" > "$REPO/CHANGELOG.md"
  fi
  export CLODE_RELEASES_URL="file://$REPO"
  export CLODE_CHANGELOG_URL="file://$REPO/CHANGELOG.md"
  export CLODE_PROVIDERS="$XDG_DATA_HOME/clode/providers"
  if [ -n "$2" ]; then
    mkdir -p "$CLODE_PROVIDERS/$2"; : > "$CLODE_PROVIDERS/$2/claude"
    ln -sfn "$2" "$CLODE_PROVIDERS/current"
  fi
}

@test "clode --clode-watch runs a cycle, writes a notice, prints a summary, exits 0" {
  _watch_fixture 2.0.0 1.0.0 high
  run "$CLODE_BIN" --clode-watch
  [ "$status" -eq 0 ]
  grep -qx 'high=1' "$CLODE_WATCH_DIR/watch-notice"
  echo "$output" | grep -qi "running under Node"
  rm -rf "$TMP"
}

@test "clode --clode-watch does not reach the bundle (no node/provider needed)" {
  _watch_fixture 2.0.0 1.0.0 low
  run env CLODE_CLAUDE_BIN=/nonexistent "$CLODE_BIN" --clode-watch
  [ "$status" -eq 0 ]
  rm -rf "$TMP"
}

@test "clode --clode-help mentions --clode-watch" {
  run "$CLODE_BIN" --clode-help
  [ "$status" -eq 0 ]
  echo "$output" | grep -q -- '--clode-watch'
}
