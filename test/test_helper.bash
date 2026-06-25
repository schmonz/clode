#!/usr/bin/env bash
# Shared setup for clode BATS tests. Discover host tools on PATH (CLODE_* override
# per machine); set here too so a file run directly under `bats` — not via
# run-all.sh — still finds node/python without a hardcoded prefix.
export CLODE_NODE="${CLODE_NODE:-$(command -v node)}"
export CLODE_PYTHON="${CLODE_PYTHON:-$(command -v python3)}"

# Point clode's runtime-dep install at a "user-managed" sentinel — a node_modules with
# no clode .deps-sig, which ensure_deps treats as user-managed and never touches — so
# the suite NEVER runs a real `npm install` (offline, deterministic). Created here (and
# gitignored) rather than committed, since `node_modules/` is ignored. test_deps.bats
# overrides CLODE_DEPS to exercise the auto-install itself.
export CLODE_DEPS="${CLODE_DEPS:-$BATS_TEST_DIRNAME/fixtures/managed-deps}"
mkdir -p "$CLODE_DEPS/node_modules"

# Portable temp creation. NetBSD/BSD/macOS mktemp REQUIRE an explicit template;
# only GNU mktemp accepts a bare `mktemp -d`. Always pass a template so the tests
# run the same on pkgsrc, *BSD, macOS, and Linux.
mktempd() { mktemp -d "${TMPDIR:-/tmp}/clode.XXXXXX"; }
mktempf() { mktemp    "${TMPDIR:-/tmp}/clode.XXXXXX"; }
