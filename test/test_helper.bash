#!/usr/bin/env bash
# Shared setup for clode BATS tests. Discover host tools on PATH (CLODE_* override
# per machine); set here too so a file run directly under `bats` — not via
# run-all.sh — still finds node without a hardcoded prefix.
export CLODE_NODE="${CLODE_NODE:-$(command -v node)}"

# The launcher under test. Defaults to the shipped bin/clode; the launcher→JS
# parity gate runs the whole suite against the JS entry via CLODE_BIN.
export CLODE_BIN="${CLODE_BIN:-./bin/clode}"

# Point clode's runtime-dep install at a "user-managed" sentinel — a node_modules with
# no clode .deps-sig, which ensure_deps treats as user-managed and never touches — so
# the suite NEVER runs a real `npm install` (offline, deterministic). Created here (and
# gitignored) rather than committed, since `node_modules/` is ignored. test_deps.bats
# overrides CLODE_DEPS to exercise the auto-install itself.
export CLODE_DEPS="${CLODE_DEPS:-$BATS_TEST_DIRNAME/fixtures/managed-deps}"
mkdir -p "$CLODE_DEPS/node_modules"

# Seed functional fakes for the bundle's render ext-deps into a node_modules dir.
# The renderer REQUIRES string-width/strip-ansi/wrap-ansi (and semver) to draw at all,
# so any test that runs a real session (e.g. `-p` end-to-end) needs them resolvable.
# clode would `ensure_deps`-install these on a real host; the offline suite provides
# equivalents instead of running npm (cf. test_tui's own fakes). NOT needed for
# print-and-exit paths: `clode --version`/--help deliberately skip the settings/render
# path (bin/clode guard_settings_for_args), so they stay dep-free without these.
seed_render_deps() {  # $1 = node_modules dir
  _srd_mod() {  # $1 = node_modules dir, $2 = package; index.js body on stdin
    mkdir -p "$1/$2"
    printf '{"name":"%s","version":"0.0.0-clode-test","main":"index.js"}\n' "$2" > "$1/$2/package.json"
    cat > "$1/$2/index.js"
  }
  _srd_mod "$1" string-width <<'JS'
module.exports = (s) => [...String(s).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')].length;
JS
  _srd_mod "$1" strip-ansi <<'JS'
module.exports = (s) => String(s).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
JS
  _srd_mod "$1" wrap-ansi <<'JS'
module.exports = (s) => String(s);
JS
  _srd_mod "$1" semver <<'JS'
const P = (v) => String(v).replace(/^[v=]+/, '').split('.').map((n) => parseInt(n, 10) || 0);
exports.compare = (a, b) => { const x = P(a), y = P(b); for (let i = 0; i < 3; i++) if ((x[i]||0) !== (y[i]||0)) return (x[i]||0) < (y[i]||0) ? -1 : 1; return 0; };
exports.satisfies = () => true;
JS
}
seed_render_deps "$CLODE_DEPS/node_modules"

# Portable temp creation. NetBSD/BSD/macOS mktemp REQUIRE an explicit template;
# only GNU mktemp accepts a bare `mktemp -d`. Always pass a template so the tests
# run the same on pkgsrc, *BSD, macOS, and Linux.
mktempd() { mktemp -d "${TMPDIR:-/tmp}/clode.XXXXXX"; }
mktempf() { mktemp    "${TMPDIR:-/tmp}/clode.XXXXXX"; }

# Portable wall-clock timeout. clode runs where GNU coreutils' `timeout` is absent
# (NetBSD/pkgsrc, older macOS — macOS ships it only as `gtimeout`), so a test must
# not hard-depend on it. Prefer a real timeout/gtimeout; otherwise fall back to
# node, which clode already requires (so this is exactly as portable as clode).
# Args: SECONDS CMD...; output/stdin pass through; exits 124 on timeout (as GNU does).
clode_timeout() {
  _to=$1; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$_to" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$_to" "$@"
  else "$CLODE_NODE" -e '
const { spawn } = require("child_process");
const to = parseFloat(process.argv[1]);
const p = spawn(process.argv[2], process.argv.slice(3), { stdio: "inherit" });
let timedOut = false;
const t = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, to * 1000);
p.on("error", () => process.exit(127));
p.on("exit", (code) => { clearTimeout(t); process.exit(timedOut ? 124 : (code == null ? 1 : code)); });
' "$_to" "$@"
  fi
}
