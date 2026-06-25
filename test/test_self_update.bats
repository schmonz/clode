#!/usr/bin/env bats
# clode update: host-agnostic fetch of the upstream JS into a clode-owned provider store.
load test_helper

setup() {
  cd "$BATS_TEST_DIRNAME/.."
  TMP=$(mktempd)
  export HOME="$TMP/home"; mkdir -p "$HOME"
  export XDG_DATA_HOME="$TMP/data"
  REPO="$TMP/repo"; V=9.9.9; PLAT=linux-x64
  mkdir -p "$REPO/$V/$PLAT"
  "$CLODE_PYTHON" test/mkfixture.py "$REPO/$V/$PLAT/claude" v
  if command -v sha256sum >/dev/null 2>&1; then SUM=$(sha256sum "$REPO/$V/$PLAT/claude" | cut -d' ' -f1)
  else SUM=$(shasum -a 256 "$REPO/$V/$PLAT/claude" | cut -d' ' -f1); fi
  printf '%s\n' "$V" > "$REPO/stable"
  printf '%s\n' "$V" > "$REPO/latest"
  printf '{"platforms":{"%s":{"checksum":"%s"}}}\n' "$PLAT" "$SUM" > "$REPO/$V/manifest.json"
  export CLODE_RELEASES_URL="file://$REPO"
}
teardown() { rm -rf "$TMP"; }

@test "sha256_of computes the file digest" {
  echo -n "hello" > "$TMP/h"
  run sh -c 'CLODE_SOURCED=1 . ./bin/clode; sha256_of "'"$TMP"'/h"'
  [ "$status" -eq 0 ]
  [ "$output" = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" ]
}

@test "clode_update fetches the fixed platform into the provider store + current pointer" {
  run sh -c 'CLODE_SOURCED=1 . ./bin/clode; PYTHON="$CLODE_PYTHON" clode_update stable'
  [ "$status" -eq 0 ]
  test -f "$XDG_DATA_HOME/clode/providers/9.9.9/claude"
  [ "$(readlink "$XDG_DATA_HOME/clode/providers/current")" = "9.9.9" ]
  echo "$output" | grep -q "updated to 9.9.9"
}

@test "a bad checksum aborts the update without moving 'current'" {
  printf '{"platforms":{"linux-x64":{"checksum":"%064d"}}}\n' 0 > "$REPO/9.9.9/manifest.json"
  run sh -c 'CLODE_SOURCED=1 . ./bin/clode; PYTHON="$CLODE_PYTHON" clode_update stable'
  [ "$status" -ne 0 ]
  echo "$output" | grep -qi "checksum mismatch"
  [ ! -e "$XDG_DATA_HOME/clode/providers/current" ]
}

@test "resolve_claude_bin prefers the fetched provider; cache_key uses its version" {
  mkdir -p "$XDG_DATA_HOME/clode/providers/9.9.9"
  : > "$XDG_DATA_HOME/clode/providers/9.9.9/claude"
  ln -sfn 9.9.9 "$XDG_DATA_HOME/clode/providers/current"
  run sh -c 'CLODE_SOURCED=1 . ./bin/clode; BIN=$(resolve_claude_bin); echo "$BIN"; cache_key; echo "$KEY"'
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "providers/9.9.9/claude"
  echo "$output" | grep -qx "9.9.9"
}

@test "clode update <channel> fetches and reports, then exits" {
  run env CLODE_CLAUDE_BIN=/nonexistent ./bin/clode update stable
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "updated to 9.9.9"
  test -f "$XDG_DATA_HOME/clode/providers/9.9.9/claude"
}
