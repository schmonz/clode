#!/usr/bin/env bash
# Shared setup for clode BATS tests. Discover host tools on PATH (CLODE_* override
# per machine); set here too so a file run directly under `bats` — not via
# run-all.sh — still finds node without a hardcoded prefix.
export CLODE_NODE="${CLODE_NODE:-$(command -v node)}"

# The launcher under test. Defaults to the shipped bin/clode; the launcher→JS
# parity gate runs the whole suite against the JS entry via CLODE_BIN.
export CLODE_BIN="${CLODE_BIN:-./bin/clode}"

# HERMETIC SANDBOX. Put ALL of clode's on-disk state under one private, disposable
# root so no test can read or write the real ~/.local/share/clode, ~/.cache/clode,
# or ~/.local/bin. Setting CLODE_STATE_ROOT redirects the npm dep store AND the SEA
# materialized-deps cache AND providers/watch (see libexec/clode-paths.cjs); setting
# HOME seals the ~/.local/bin/claude fallback and any os.homedir() read. Every other
# steering var is unset so nothing ambient leaks in. Per bats FILE (BATS_FILE_TMPDIR
# is auto-removed); files needing finer isolation re-scope in their own setup().
CLODE_SANDBOX="${BATS_FILE_TMPDIR:-$(mktemp -d "${TMPDIR:-/tmp}/clode-sbx.XXXXXX")}/sandbox"
export CLODE_STATE_ROOT="$CLODE_SANDBOX"
export HOME="$CLODE_SANDBOX/home"
mkdir -p "$HOME"
unset CLODE_DEPS CLODE_CACHE CLODE_PROVIDERS CLODE_WATCH_DIR CLODE_VERSION_DIR \
      CLODE_CLAUDE_BIN XDG_DATA_HOME XDG_CACHE_HOME

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

# Seed the render ext-deps (string-width/strip-ansi/wrap-ansi/semver) into the
# sandbox's data store so offline render paths resolve them WITHOUT a real npm
# install. No .deps-sig => ensure_deps treats it as user-managed and never installs.
CLODE_SANDBOX_DEPS="$CLODE_SANDBOX/share/clode/node_modules"
mkdir -p "$CLODE_SANDBOX_DEPS"
seed_render_deps "$CLODE_SANDBOX_DEPS"

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

# Cases that still require a real provider/store or write the repo tree are quarantined
# until the bats->node conversion restores them in hermetic form. Call at the top of
# such a test's body. Accepts an optional specific reason; defaults to the generic one.
# See BACKLOG "Hermetic test execution" thread.
clode_quarantine() {
  skip "${1:-pending hermetic node conversion (BACKLOG hermetic-testing)}"
}
