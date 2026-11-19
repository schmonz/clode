'use strict';
// A STALE BUILD HOST: a stand-in for the engine scripts/bootstrap-engine.sh hands the build in
// CI -- the LAST release's, which predates every engine patch since (today: stat identity and
// strerror; test/fixtures/stale-engine-prelude.js has the measured shape). Built from a real,
// current tjs so it needs no network and no old binary.
//
// WHY THE LOADER IS COPIED. node-shim's loader captures __tjs_fs_sync on its line 29 and fs.cjs
// captures it at load, so a prelude that runs as part of the ENTRY is too late for anything the
// loader itself set up. The stand-in therefore runs a copy of libexec/ with the prelude inserted
// right after the loader's 'use strict' (the copy is a whole libexec/ because node-shim reaches
// ../../target-env.cjs and ../../unicode-text.cjs, and deps/ is symlinked in because the loader
// resolves packages from ../../../deps/claude/node_modules). Every `run <...>/loader.cjs` is
// redirected to that copy; every other `run <file>` gets the prelude prepended; `eval` gets it
// prefixed. So build.sh, the resolver, build-tjs-boot.sh and everything they start see one engine.
//
// What it does NOT model: a binding the old engine lacks entirely beyond the two in the prelude.
// test/bootstrap-engine-online.test.cjs runs the real published bytes for that.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tjsPath } = require('./node-shim-helper.cjs');

const REPO = path.resolve(__dirname, '..');
const PRELUDE = path.join(REPO, 'test', 'fixtures', 'stale-engine-prelude.js');
const FLOOR_LINE = 'node-shim: this engine';

// -> { engine, tripwire, env } or { skip }.
function makeStaleHost(dir) {
  if (process.platform === 'win32') return { skip: 'POSIX-only: the stand-in engine is a /bin/sh wrapper' };
  const real = tjsPath();
  if (!real) return { skip: 'no real tjs (CLODE_TJS or a local build) to stand the stale engine on' };
  const lib = path.join(dir, 'libexec');
  fs.cpSync(path.join(REPO, 'libexec'), lib, { recursive: true });
  fs.symlinkSync(path.join(REPO, 'deps'), path.join(dir, 'deps'));
  const loader = path.join(lib, 'node-shim', 'loader.cjs');
  const src = fs.readFileSync(loader, 'utf8');
  const nl = src.indexOf('\n');
  if (!/^'use strict';$/.test(src.slice(0, nl))) throw new Error('loader.cjs no longer opens with \'use strict\'; re-derive the prelude insertion point');
  fs.writeFileSync(loader, `${src.slice(0, nl + 1)}${fs.readFileSync(PRELUDE, 'utf8')}${src.slice(nl + 1)}`);
  const q = JSON.stringify;
  const engine = path.join(dir, 'stale-tjs');
  fs.writeFileSync(engine, `#!/bin/sh
# The last release's engine as HEAD sees it: test/stale-build-host.cjs.
REAL=${q(real)}
PRE=${q(PRELUDE)}
case "$1" in
  run)
    case "$2" in
      */libexec/node-shim/loader.cjs) shift 2; exec "$REAL" run ${q(loader)} "$@" ;;
    esac
    f=$2; shift 2
    t=$(mktemp "\${TMPDIR:-/tmp}/stale-engine.XXXXXX")
    cat "$PRE" "$f" > "$t"
    "$REAL" run "$t" "$@"; rc=$?
    rm -f "$t"; exit $rc ;;
  eval)
    shift; e=$1; shift
    exec "$REAL" eval "$(cat "$PRE")
$e" "$@" ;;
esac
exec "$REAL" "$@"
`);
  fs.chmodSync(engine, 0o755);
  const tripwire = path.join(dir, 'tripwire.log');
  return { engine, tripwire, env: { CLODE_STALE_ENGINE_TRIPWIRE: tripwire } };
}

// Everything a stale build host refused, from the tripwire and the captured output.
function refusals(host, output) {
  let wire = '';
  try { wire = fs.readFileSync(host.tripwire, 'utf8'); } catch { /* never written: nothing refused */ }
  const seen = String(output || '').split('\n').filter((l) => l.includes(FLOOR_LINE) || l.includes('ERR_CLODE_ENGINE_FLOOR'));
  return { wire, seen, any: wire.length > 0 || seen.length > 0 };
}

const mkdtemp = (tag) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `stale-host-${tag}-`)));

module.exports = { makeStaleHost, refusals, mkdtemp, FLOOR_LINE, REPO };
