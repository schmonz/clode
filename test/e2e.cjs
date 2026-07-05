'use strict';
// Shared end-to-end harness for node:test launcher tests — the node-native successor
// to test_helper.bash's bash sandbox. Every clode subprocess is spawned with a
// CONSTRUCTED-CLEAN env (nothing from the real process.env), so no test can read or
// write real machine state (the hermetic-guard enforces it) and the suite is
// Windows-portable (no bash). Pure Node stdlib.
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BIN = path.join(REPO, 'bin', 'clode');
const NODE = process.env.CLODE_NODE || process.execPath;
const MKFIXTURE = path.join(REPO, 'test', 'mkfixture.cjs');

// The render ext-deps clode's TUI requires. Functional fakes (the same
// 0.0.0-clode-test stubs the bash harness used) so offline render paths resolve
// without a real npm install. Bodies copied verbatim from test_helper.bash.
const RENDER_FAKES = {
  'string-width': "module.exports = (s) => [...String(s).replace(/\\x1b\\[[0-9;?]*[ -\\/]*[@-~]/g, '')].length;\n",
  'strip-ansi': "module.exports = (s) => String(s).replace(/\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\x1b\\[[0-9;?]*[ -\\/]*[@-~]/g, '');\n",
  'wrap-ansi': "module.exports = (s) => String(s);\n",
  'semver': "const P = (v) => String(v).replace(/^[v=]+/, '').split('.').map((n) => parseInt(n, 10) || 0);\n"
    + "exports.compare = (a, b) => { const x = P(a), y = P(b); for (let i = 0; i < 3; i++) if ((x[i]||0) !== (y[i]||0)) return (x[i]||0) < (y[i]||0) ? -1 : 1; return 0; };\n"
    + "exports.satisfies = () => true;\n",
};

function seedRenderDeps(nodeModulesDir) {
  for (const pkg of Object.keys(RENDER_FAKES)) {
    const d = path.join(nodeModulesDir, pkg);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'),
      JSON.stringify({ name: pkg, version: '0.0.0-clode-test', main: 'index.js' }) + '\n');
    fs.writeFileSync(path.join(d, 'index.js'), RENDER_FAKES[pkg]);
  }
}

// Create a private, disposable sandbox for one test. Pass the node:test `t` so cleanup
// registers via t.after (deterministic — no teardown race). NOTHING from process.env
// leaks in.
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-e2e-'));
  const home = path.join(dir, 'home');
  const stateRoot = dir;
  const depsDir = path.join(stateRoot, 'share', 'clode');   // == depsStore(CLODE_STATE_ROOT)
  fs.mkdirSync(home, { recursive: true });
  seedRenderDeps(path.join(depsDir, 'node_modules'));
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    CLODE_STATE_ROOT: stateRoot,
    // Point CLODE_DEPS at the seeded (no .deps-sig) store so ensureDeps takes its
    // user-managed opt-out (clode-deps.cjs) and NEVER shells out to npm — the bundle
    // boots offline against the fakes. Without this the launcher would try to
    // `npm install` the real ext-deps (the bash harness relied on npm being on PATH +
    // an npm cache to do that install into its throwaway sandbox; the constructed-clean
    // PATH here has no npm, so we take the npm-free path instead — strictly more
    // hermetic). Tests exercising ensureDeps itself (test_deps) override CLODE_DEPS to
    // an empty dir so the opt-out does not fire.
    CLODE_DEPS: depsDir,
    CLODE_NODE: NODE,
    CLODE_NO_WATCH: '1',
    CLODE_OFFLINE: '1',
  };
  // On Windows, clode must reach the command interpreter to run a .cmd (e.g. npm.cmd) —
  // the parallel of /bin/sh being reachable via the POSIX sandbox PATH above. ComSpec is
  // an OS constant (path to cmd.exe), not real user/app state, so surfacing it keeps the
  // sandbox hermetic while letting the Windows .cmd-spawn paths work.
  if (process.platform === 'win32') {
    env.ComSpec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  }
  if (t && typeof t.after === 'function') {
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  }
  return { dir, home, stateRoot, env };
}

// Spawn bin/clode with the sandbox env. opts.env merges over sbx.env; opts.input is
// stdin. Returns status/signal/stdout/stderr plus `output` = stdout+stderr (matching
// bats `run`'s merged $output).
function runClode(sbx, args = [], opts = {}) {
  const r = spawnSync(NODE, [opts.bin || BIN, ...args], {
    encoding: 'utf8',
    env: { ...sbx.env, ...(opts.env || {}) },
    input: opts.input,
    cwd: opts.cwd || REPO,
  });
  return {
    status: r.status, signal: r.signal,
    stdout: r.stdout || '', stderr: r.stderr || '',
    output: (r.stdout || '') + (r.stderr || ''),
  };
}

// Fake provider binary at `dest`, printing "CLODE-FIXTURE <label>" when booted.
function mkProvider(dest, label) {
  execFileSync(NODE, [MKFIXTURE, dest, label]);
  return dest;
}

// Write a fake npm at `dest`, used via CLODE_NPM to exercise ensureDeps without a real
// npm. `ok:true` (default) logs the invocation to `opts.log` (if given) and simulates a
// successful install by mkdir'ing node_modules/.installed under the `--prefix` dir;
// `ok:false` fails loud (exit 1). The log path is baked into the script (absolute), so
// no env plumbing is needed. Returns the path CLODE_NPM should point at.
//
// Cross-platform: on POSIX a `#!/bin/sh` shim; on Windows a `.cmd` shim (npm on Windows
// IS npm.cmd, and clode routes .cmd through cmd.exe) delegating to a paired `.cjs` run
// by NODE. spawnSync can't exec a `#!/bin/sh` on Windows. NODE is embedded absolute
// because the hermetic sandbox PATH (/usr/bin:/bin) carries no node.
function fakeNpm(dest, opts = {}) {
  const ok = opts.ok !== false;
  if (process.platform === 'win32') {
    const cjs = dest + '.cjs';
    let body;
    if (ok) {
      body = 'const fs=require("fs"),path=require("path");const a=process.argv.slice(2);\n'
        + (opts.log ? `fs.appendFileSync(${JSON.stringify(opts.log)},"npm "+a.join(" ")+"\\n");\n` : '')
        + 'let p="";for(let i=0;i<a.length-1;i++)if(a[i]==="--prefix")p=a[i+1];\n'
        + 'if(p)fs.mkdirSync(path.join(p,"node_modules",".installed"),{recursive:true});\n'
        + 'process.exit(0);\n';
    } else {
      body = 'process.stderr.write("boom\\n");process.exit(1);\n';
    }
    fs.writeFileSync(cjs, body);
    const cmd = dest + '.cmd';
    fs.writeFileSync(cmd, `@echo off\r\n"${NODE}" "${cjs}" %*\r\n`);
    return cmd;
  }
  let body;
  if (ok) {
    body = '#!/bin/sh\n'
      + (opts.log ? `echo "npm $*" >> "${opts.log}"\n` : '')
      + 'p=""; while [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && p="$2"; shift; done\n'
      + '[ -n "$p" ] && mkdir -p "$p/node_modules/.installed"\n'
      + 'exit 0\n';
  } else {
    body = '#!/bin/sh\necho "boom" >&2\nexit 1\n';
  }
  fs.writeFileSync(dest, body);
  fs.chmodSync(dest, 0o755);
  return dest;
}

module.exports = { sandbox, runClode, mkProvider, fakeNpm, seedRenderDeps, REPO, BIN, NODE };
