#!/usr/bin/env bats
# Regression: the test harness must NEVER write into a store it merely inherited
# via CLODE_DEPS. seed_render_deps once wrote its fake render deps into
# "$CLODE_DEPS/node_modules"; when CLODE_DEPS pointed at the user's real store
# (e.g. ~/.local/share/clode, inherited from the environment), sourcing
# test_helper clobbered the real semver with a compare-only mock — breaking the
# live install's version_gt. Seeding must target the disposable fixtures dir only.

@test "sourcing test_helper never writes into an inherited CLODE_DEPS store" {
  store="$(mktemp -d)"
  mkdir -p "$store/node_modules/semver"
  printf 'REAL-SENTINEL' > "$store/node_modules/semver/package.json"

  # Source test_helper exactly as a bats file's `load` would, but with CLODE_DEPS
  # pre-set to the sentinel store (simulating an exported real-store value).
  ( cd "$BATS_TEST_DIRNAME" \
      && CLODE_DEPS="$store" BATS_TEST_DIRNAME="$BATS_TEST_DIRNAME" \
         bash -c 'source ./test_helper.bash' ) >/dev/null 2>&1 || true

  run cat "$store/node_modules/semver/package.json"
  rm -rf "$store"
  [ "$output" = "REAL-SENTINEL" ]
}
