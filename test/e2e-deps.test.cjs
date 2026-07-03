const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { sandbox, runClode, mkProvider, fakeNpm, REPO } = require('./e2e.cjs');

// test_deps.bats: clode auto-installs its runtime npm deps (package.json manifest) on
// first run into a user-owned dir, re-installs when the manifest changes, and exits
// loud if npm can't run — UNLESS the deps already ship in clode's own node_modules.
// A fake npm (CLODE_NPM) stands in for the real one.
//
// This runs a COPIED standalone package (bin + libexec + manifest + VERSION) under a
// tmp dir so we can mutate its $HERE/../node_modules and package.json without touching
// the repo. CLODE_DEPS is overridden to an EMPTY dir so ensureDeps does NOT take the
// harness's user-managed opt-out and instead exercises the install path via the fake npm.
function setupPkg(t) {
  const sbx = sandbox(t);
  const pkg = path.join(sbx.dir, 'pkg');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'bin', 'clode'), path.join(pkg, 'bin', 'clode'));
  fs.chmodSync(path.join(pkg, 'bin', 'clode'), 0o755);
  fs.cpSync(path.join(REPO, 'libexec'), path.join(pkg, 'libexec'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(pkg, 'package.json'));
  fs.copyFileSync(path.join(REPO, 'VERSION'), path.join(pkg, 'VERSION'));
  const pkgBin = path.join(pkg, 'bin', 'clode');

  const depsDir = path.join(sbx.dir, 'deps');        // empty -> install path, not opt-out
  fs.mkdirSync(path.join(sbx.dir, 'bin'), { recursive: true });
  const provider = mkProvider(path.join(sbx.dir, 'bin', 'claude'), 'v');
  sbx.env.CLODE_CACHE = path.join(sbx.dir, 'cache');
  sbx.env.CLODE_DEPS = depsDir;                       // overrides the harness sentinel
  sbx.env.CLODE_CLAUDE_BIN = provider;

  const npmlog = path.join(sbx.dir, 'npmlog');
  const npmOk = fakeNpm(path.join(sbx.dir, 'npm-ok'), { ok: true, log: npmlog });
  const npmFail = fakeNpm(path.join(sbx.dir, 'npm-fail'), { ok: false });
  return { sbx, pkg, pkgBin, depsDir, npmlog, npmOk, npmFail };
}

// `cat "$NPMLOG" 2>/dev/null` — '' when the log was never written.
function readLog(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

test('auto-install runs when the deps dir is empty, and records a sig', (t) => {
  const { sbx, pkgBin, depsDir, npmlog, npmOk } = setupPkg(t);
  runClode(sbx, [], { bin: pkgBin, env: { CLODE_NPM: npmOk } });   // output ignored (as bats)
  assert.match(readLog(npmlog), /install/);
  assert.ok(fs.existsSync(path.join(depsDir, 'node_modules', '.installed')));
  assert.ok(fs.existsSync(path.join(depsDir, '.deps-sig')));
});

test('auto-install is skipped when the manifest sig already matches', (t) => {
  const { sbx, pkgBin, npmlog, npmOk } = setupPkg(t);
  runClode(sbx, [], { bin: pkgBin, env: { CLODE_NPM: npmOk } });
  fs.writeFileSync(npmlog, '');                                    // : > "$NPMLOG"
  runClode(sbx, [], { bin: pkgBin, env: { CLODE_NPM: npmOk } });
  assert.doesNotMatch(readLog(npmlog), /install/);
});

test('a changed manifest triggers a reinstall', (t) => {
  const { sbx, pkg, pkgBin, npmlog, npmOk } = setupPkg(t);
  runClode(sbx, [], { bin: pkgBin, env: { CLODE_NPM: npmOk } });
  fs.writeFileSync(npmlog, '');
  fs.appendFileSync(path.join(pkg, 'package.json'), '\n');         // manifest sig changes
  runClode(sbx, [], { bin: pkgBin, env: { CLODE_NPM: npmOk } });
  assert.match(readLog(npmlog), /install/);
});

test('missing/failing npm exits loud, before launching the bundle', (t) => {
  const { sbx, pkgBin, npmFail } = setupPkg(t);
  const r = runClode(sbx, [], { bin: pkgBin, env: { CLODE_NPM: npmFail } });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.output, /depend/i);
});

test('a user-managed CLODE_DEPS (node_modules, no .deps-sig) is left alone', (t) => {
  const { sbx, pkgBin, depsDir, npmlog, npmOk } = setupPkg(t);
  fs.mkdirSync(path.join(depsDir, 'node_modules', '.user'), { recursive: true });
  fs.writeFileSync(npmlog, '');
  runClode(sbx, [], { bin: pkgBin, env: { CLODE_NPM: npmOk } });
  assert.doesNotMatch(readLog(npmlog), /install/);
});

test("deps shipped in clode's own node_modules (npm install -g .) -> no auto-install", (t) => {
  const { sbx, pkg, pkgBin, npmlog, npmOk } = setupPkg(t);
  fs.mkdirSync(path.join(pkg, 'node_modules', '.shipped'), { recursive: true });
  fs.writeFileSync(npmlog, '');
  runClode(sbx, [], { bin: pkgBin, env: { CLODE_NPM: npmOk } });
  assert.doesNotMatch(readLog(npmlog), /install/);
});
