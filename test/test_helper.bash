#!/usr/bin/env bash
# Shared setup for clode BATS tests. Discover host tools on PATH (CLODE_* override
# per machine); set here too so a file run directly under `bats` — not via
# run-all.sh — still finds node/python without a hardcoded prefix.
export CLODE_NODE="${CLODE_NODE:-$(command -v node)}"
export CLODE_PYTHON="${CLODE_PYTHON:-$(command -v python3)}"

# Portable temp creation. NetBSD/BSD/macOS mktemp REQUIRE an explicit template;
# only GNU mktemp accepts a bare `mktemp -d`. Always pass a template so the tests
# run the same on pkgsrc, *BSD, macOS, and Linux.
mktempd() { mktemp -d "${TMPDIR:-/tmp}/clode.XXXXXX"; }
mktempf() { mktemp    "${TMPDIR:-/tmp}/clode.XXXXXX"; }
