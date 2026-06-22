#!/usr/bin/env bats
# Unit tests: source bin/clode with the main guard suppressed, test functions.

load test_helper

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export CLODE_SOURCED=1
  # shellcheck disable=SC1090
  . "$ROOT/bin/clode"
}

@test "cache_key uses the version when the path is versioned" {
  BIN="/home/u/.local/share/claude/versions/2.1.183"
  cache_key
  [ "$KEY" = "2.1.183" ]
}

@test "cache_key falls back to basename+signature for unversioned paths" {
  tmp="$(mktempf)"; BIN="$tmp"
  cache_key
  case "$KEY" in "$(basename "$tmp")"-*) ok=1 ;; *) ok=0 ;; esac
  rm -f "$tmp"
  [ "$ok" -eq 1 ]
}

@test "resolve_claude_bin honors CLODE_CLAUDE_BIN above all" {
  CLODE_CLAUDE_BIN=/x/y/claude
  run resolve_claude_bin
  [ "$status" -eq 0 ]
  [ "$output" = "/x/y/claude" ]
}

@test "launcher no longer scrubs the environment with env -i" {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  ! grep -q 'env -i' "$ROOT/bin/clode"
  ! grep -q 'CLEAN_PATH' "$ROOT/bin/clode"
}

@test "launcher enables Node-native proxy support (NODE_USE_ENV_PROXY)" {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  grep -q 'NODE_USE_ENV_PROXY' "$ROOT/bin/clode"
}

@test "legacy macOS (no trustd) defaults CLAUDE_CODE_CERT_STORE=bundled" {
  [ "$(uname -s)" = Darwin ] || skip "macOS-only heuristic"
  CLODE_TRUSTD=/nonexistent/trustd
  unset CLAUDE_CODE_CERT_STORE
  maybe_default_cert_store
  [ "$CLAUDE_CODE_CERT_STORE" = bundled ]
}

@test "modern macOS (trustd present) leaves CLAUDE_CODE_CERT_STORE unset" {
  [ "$(uname -s)" = Darwin ] || skip "macOS-only heuristic"
  CLODE_TRUSTD="$(command -v sh)"   # any path that exists
  unset CLAUDE_CODE_CERT_STORE
  maybe_default_cert_store
  [ -z "${CLAUDE_CODE_CERT_STORE:-}" ]
}

@test "a user-set CLAUDE_CODE_CERT_STORE is respected on legacy macOS" {
  [ "$(uname -s)" = Darwin ] || skip "macOS-only heuristic"
  CLODE_TRUSTD=/nonexistent/trustd
  CLAUDE_CODE_CERT_STORE=system
  maybe_default_cert_store
  [ "$CLAUDE_CODE_CERT_STORE" = system ]
}
