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
