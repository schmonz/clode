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

@test "version_gt uses real semver: greater, equal, lesser, prerelease" {
  run sh -c 'CLODE_SOURCED=1 . ./bin/clode
    version_gt 2.0.0 1.9.9   && echo gt1
    version_gt 2.1.10 2.1.9  && echo gt2
    version_gt 1.0.0 1.0.0   || echo not-eq
    version_gt 1.9.9 2.0.0   || echo not-lt
    version_gt 2.0.0 2.0.0-rc1 && echo gt-prerelease'
  [ "$status" -eq 0 ]
  echo "$output" | grep -qx gt1
  echo "$output" | grep -qx gt2
  echo "$output" | grep -qx not-eq
  echo "$output" | grep -qx not-lt
  echo "$output" | grep -qx gt-prerelease
}

@test "watch_dir honors CLODE_WATCH_DIR then XDG_CACHE_HOME then HOME" {
  run sh -c 'CLODE_WATCH_DIR=/x/y CLODE_SOURCED=1 . ./bin/clode; watch_dir'
  [ "$output" = "/x/y" ]
  run sh -c 'unset CLODE_WATCH_DIR; XDG_CACHE_HOME=/c HOME=/h CLODE_SOURCED=1 . ./bin/clode; watch_dir'
  [ "$output" = "/c/clode" ]
  run sh -c 'unset CLODE_WATCH_DIR XDG_CACHE_HOME; HOME=/h CLODE_SOURCED=1 . ./bin/clode; watch_dir'
  [ "$output" = "/h/.cache/clode" ]
}

@test "write_watch_notice emits parseable key=value lines" {
  TMP=$(mktempd)
  run sh -c 'CLODE_SOURCED=1 . ./bin/clode; write_watch_notice "'"$TMP"'/n" 2.0.0 1.0.0 1 1700000000'
  [ "$status" -eq 0 ]
  grep -qx 'latest=2.0.0'      "$TMP/n"
  grep -qx 'current=1.0.0'     "$TMP/n"
  grep -qx 'high=1'            "$TMP/n"
  grep -qx 'checked_at=1700000000' "$TMP/n"
  rm -rf "$TMP"
}

@test "file_mtime returns a single numeric epoch; 0 for missing" {
  TMP=$(mktempd)
  : > "$TMP/f"
  run sh -c 'CLODE_SOURCED=1 . ./bin/clode; file_mtime "'"$TMP"'/f"'
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | wc -l | tr -d " ")" -eq 0 ]   # one line, no trailing
  case "$output" in *[!0-9]*) false ;; esac                  # digits only
  run sh -c 'CLODE_SOURCED=1 . ./bin/clode; file_mtime "'"$TMP"'/nope"'
  [ "$output" = 0 ]
  rm -rf "$TMP"
}

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

@test "clode_watch: newer version with HIGH signal writes high=1 notice" {
  _watch_fixture 2.0.0 1.0.0 high
  run sh -c 'CLODE_SOURCED=1 . ./bin/clode; PYTHON="$CLODE_PYTHON" LIBEXEC="$PWD/libexec" clode_watch'
  [ "$status" -eq 0 ]
  grep -qx 'latest=2.0.0'  "$CLODE_WATCH_DIR/watch-notice"
  grep -qx 'current=1.0.0' "$CLODE_WATCH_DIR/watch-notice"
  grep -qx 'high=1'        "$CLODE_WATCH_DIR/watch-notice"
  rm -rf "$TMP"
}

@test "clode_watch: newer version without HIGH signal writes high=0" {
  _watch_fixture 2.0.0 1.0.0 low
  run sh -c 'CLODE_SOURCED=1 . ./bin/clode; PYTHON="$CLODE_PYTHON" LIBEXEC="$PWD/libexec" clode_watch'
  [ "$status" -eq 0 ]
  grep -qx 'high=0' "$CLODE_WATCH_DIR/watch-notice"
  rm -rf "$TMP"
}

@test "clode_watch: not newer writes high=0, never banners" {
  _watch_fixture 1.0.0 1.0.0 high
  run sh -c 'CLODE_SOURCED=1 . ./bin/clode; PYTHON="$CLODE_PYTHON" LIBEXEC="$PWD/libexec" clode_watch'
  [ "$status" -eq 0 ]
  grep -qx 'high=0' "$CLODE_WATCH_DIR/watch-notice"
  rm -rf "$TMP"
}

@test "clode_watch: no provider store is a silent no-op (no notice written)" {
  _watch_fixture 2.0.0 "" high
  run sh -c 'CLODE_SOURCED=1 . ./bin/clode; PYTHON="$CLODE_PYTHON" LIBEXEC="$PWD/libexec" clode_watch'
  [ "$status" -eq 0 ]
  [ ! -f "$CLODE_WATCH_DIR/watch-notice" ]
  rm -rf "$TMP"
}

@test "clode_watch manual mode: HIGH prints a Node-impact summary to stderr" {
  _watch_fixture 2.0.0 1.0.0 high
  run --separate-stderr sh -c 'CLODE_SOURCED=1 . ./bin/clode; PYTHON="$CLODE_PYTHON" LIBEXEC="$PWD/libexec" clode_watch manual'
  [ "$status" -eq 0 ]
  echo "$stderr" | grep -q "may affect running under Node"
  rm -rf "$TMP"
}

@test "clode_watch non-manual mode is silent (no stderr)" {
  _watch_fixture 2.0.0 1.0.0 high
  run --separate-stderr sh -c 'CLODE_SOURCED=1 . ./bin/clode; PYTHON="$CLODE_PYTHON" LIBEXEC="$PWD/libexec" clode_watch'
  [ "$status" -eq 0 ]
  [ -z "$stderr" ]
  rm -rf "$TMP"
}
