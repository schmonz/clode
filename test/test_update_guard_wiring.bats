#!/usr/bin/env bats

BIN_CLODE="${BATS_TEST_DIRNAME}/../bin/clode"

setup() {
  export HOME="$BATS_TEST_TMPDIR/home"
  export XDG_CACHE_HOME="$BATS_TEST_TMPDIR/cache"
  mkdir -p "$HOME" "$XDG_CACHE_HOME"
  CLODE_SOURCED=1 . "$BIN_CLODE"           # source without launching
  LIBEXEC="${BATS_TEST_DIRNAME}/../libexec"
  NODE="$(command -v node)"
}

@test "write_update_guard_settings emits a clode-only PreToolUse hook settings file" {
  out=$(write_update_guard_settings)
  [ -n "$out" ]
  [ -f "$out" ]
  grep -q '"PreToolUse"' "$out"
  grep -q '"matcher":"Bash"' "$out"
  grep -q 'clode-update-guard.cjs' "$out"
}

@test "write_update_guard_settings returns nothing if the hook script is absent" {
  LIBEXEC="$BATS_TEST_TMPDIR/empty"; mkdir -p "$LIBEXEC"
  out=$(write_update_guard_settings)
  [ -z "$out" ]
}

@test "no guard --settings for print-and-exit flags (no model runs)" {
  [ -z "$(guard_settings_for_args --version)" ]
  [ -z "$(guard_settings_for_args -v)" ]
  [ -z "$(guard_settings_for_args --help)" ]
  [ -z "$(guard_settings_for_args -h)" ]
}

@test "guard --settings IS emitted for a real session invocation" {
  out=$(guard_settings_for_args "explain this code")
  [ -n "$out" ]
  [ -f "$out" ]
  grep -q '"PreToolUse"' "$out"
}

@test "a flag value that isn't a real --version flag still gets the guard" {
  out=$(guard_settings_for_args -p "tell me about --version handling")
  [ -n "$out" ]
}
