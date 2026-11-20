'use strict';
// .github/actions/guest: the post-install check that every requested package's tool is
// really there. It used to stop at `command -v`, and CI run 44460009323's dragonflybsd
// leg went straight through it: node and cmake were ON PATH but the dynamic linker could
// not load them (`Shared object "libcrypto.so.17" not found` — the repo's packages were
// built against a newer openssl than the image had installed). The leg then died much
// later as a bare `Command failed: cmake`. This runs the REAL shell block from the action
// (extracted, not copied) against stub tools, so the check is exercised, not described.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');

const ACTION = path.join(__dirname, '..', '.github/actions/guest/action.yml');

function verifyBlock() {
  const src = fs.readFileSync(ACTION, 'utf8');
  const start = src.indexOf('        if [ -n "$PKGS" ]; then\n          guest_missing=');
  const endMark = 'echo "guest: verified on PATH and runnable -> $PKGS"\n        fi\n';
  const end = src.indexOf(endMark, start);
  assert.ok(start > 0 && end > start, 'the verify block moved — this extractor is blind');
  return src.slice(start, end + endMark.length).split('\n').map((l) => l.replace(/^ {8}/, '')).join('\n');
}

function runWith(stubs, pkgs, runtimeTools = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-verify-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const [name, body] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  const script = path.join(dir, 'verify.sh');
  fs.writeFileSync(script, `set -e\nPKGS="${pkgs}"\nGUEST_RUNTIME_TOOLS="${runtimeTools}"\n${verifyBlock()}\necho REACHED_THE_BUILD\n`);
  // /usr/bin:/bin for sed/printf only; none of the stubbed tool names live there on a
  // dev box or runner that matters (and if one did, the stub dir is FIRST). HOME is this throwaway directory: an env
  // built from nothing with no HOME makes anything that asks for it get the REAL home from the OS (suite-home-hermetic).
  return spawnSync('/bin/sh', [script], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir } });
}

// The guest action runs only inside Unix guests (its shell block is POSIX sh), and this harness runs it the same way:
// /bin/sh, '#!/bin/sh' stubs and a ':'-separated PATH. windows-latest has none of those (CI 44572930594: spawnSync
// '/bin/sh' fails, so stdout is undefined), and Git Bash would need every path translated: a different harness, not
// this one. Skipped there by name.
const UNIX_ONLY = { skip: process.platform === 'win32' && 'the guest action runs only in Unix guests; this harness needs /bin/sh, #!/bin/sh stubs and a POSIX PATH, which windows-latest lacks' };

const OK = 'echo "$0 1.0"';
const UNLOADABLE = 'echo \'Shared object "libcrypto.so.17" not found, required by "cmake"\' >&2; exit 1';

test('a tool that is on PATH but cannot run fails the package step, with its own error shown', UNIX_ONLY, () => {
  const r = runWith({ cmake: UNLOADABLE, gmake: OK }, 'cmake gmake');
  assert.notStrictEqual(r.status, 0, `an unloadable cmake passed the check:\n${r.stdout}${r.stderr}`);
  assert.ok(!r.stdout.includes('REACHED_THE_BUILD'), 'the build ran after an unloadable tool');
  assert.match(r.stderr, /guest: cmake --version: Shared object "libcrypto\.so\.17" not found/);
  assert.match(r.stderr, /on PATH but do NOT RUN.*cmake\(cmake\)/);
  assert.doesNotMatch(r.stderr, /gmake\(gmake\)/, 'a healthy tool was blamed');
});

test('runnable tools pass and the build proceeds', UNIX_ONLY, () => {
  const r = runWith({ cmake: OK, gmake: OK, node: OK }, 'cmake gmake node');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /guest: verified on PATH and runnable -> cmake gmake node/);
  assert.match(r.stdout, /REACHED_THE_BUILD/);
});

test('a copyback tool the upgrade broke (rsync) fails the package step by name', UNIX_ONLY, () => {
  const r = runWith({ cmake: OK, rsync: UNLOADABLE.replace('cmake', 'rsync'), sudo: OK }, 'cmake', 'rsync sudo');
  assert.notStrictEqual(r.status, 0, `an unloadable rsync passed:\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /guest: rsync --version: Shared object/);
  assert.match(r.stderr, /do NOT RUN.*rsync\(guest-runtime\)/);
  const ok = runWith({ cmake: OK, rsync: OK, sudo: OK }, 'cmake', 'rsync sudo');
  assert.strictEqual(ok.status, 0, ok.stderr);
});

test('a missing tool is still reported as missing (the older half of the check)', UNIX_ONLY, () => {
  const r = runWith({ gmake: OK }, 'cmake gmake');
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /NOT on PATH: cmake\(cmake\)/);
});

// The cause half: pkg resolves an installed dependency by NAME, so install-only can
// leave the image's older openssl under packages built against a newer one.
function branchOf(yml, label, next) {
  const start = yml.indexOf(`          ${label})\n`);
  const end = start < 0 ? -1 : yml.indexOf(`          ${next})\n`, start);
  if (start < 0 || end < 0) return null;
  return yml.slice(start, end).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

// Ruling (fix round 1): a FULL `pkg upgrade -y` before install, DRAGONFLY ONLY (freebsd
// was green and is not exposed), and the copyback tools the upgrade rewrites are checked.
function scanPkgUpgradeOrder({ yml }) {
  const dfly = branchOf(yml, 'dragonflybsd', 'openbsd');
  const fbsd = branchOf(yml, 'freebsd', 'dragonflybsd');
  if (dfly === null || fbsd === null) return { findings: [], examined: 0 };
  const findings = [];
  const up = dfly.indexOf('pkg upgrade -y\n');
  const inst = dfly.indexOf('pkg install -y $PKGS');
  if (inst < 0) findings.push('dragonflybsd branch no longer installs $PKGS');
  else if (up < 0 || up > inst) findings.push('dragonflybsd installs $PKGS without a FULL `pkg upgrade -y` first (repo/installed skew: run 44460009323)');
  if (/pkg upgrade/.test(fbsd)) findings.push('freebsd runs pkg upgrade: the ruling scopes it to dragonflybsd (freebsd was green)');
  if (!/GUEST_RUNTIME_TOOLS="[^"]*\brsync\b[^"]*"/.test(dfly) || !/GUEST_RUNTIME_TOOLS="[^"]*\bsudo\b[^"]*"/.test(dfly)) {
    findings.push('dragonflybsd upgrades but does not runnable-check rsync + sudo (the copyback tools)');
  }
  return { findings, examined: 4 };
}

const pkgUpgradeGuard = defineGuard({
  name: 'guest-pkg-upgrade-before-install',
  read: () => ({ yml: fs.readFileSync(ACTION, 'utf8') }),
  scan: scanPkgUpgradeOrder,
  floor: 4,
  control: () => ({
    yml: '          freebsd)\n'
      + '            sudo env ASSUME_ALWAYS_YES=YES pkg upgrade -y\n'
      + '          dragonflybsd)\n'
      + '            [ -z "$PKGS" ] || sudo env ASSUME_ALWAYS_YES=YES pkg install -y $PKGS ;;\n'
      + '          openbsd)\n',
  }),
});
guardTests(pkgUpgradeGuard);

// THE PACKAGE-STEP METER (run 44718991403: freebsd-amd64 spent 12 minutes in `pkg install`
// on a slow mirror, then died at its job timeout saying only "The operation was canceled").
// Runs the REAL block — meter preamble, the install case, the closing meter — with a stub
// `pkg` that drops a 2 MB download into a throwaway cache dir.
function meterBlock(platform, cacheDir) {
  const src = fs.readFileSync(ACTION, 'utf8');
  const start = src.indexOf('        # METER THE PACKAGE STEP.');
  const endMark = '        pkg_meter "done"\n';
  const end = src.indexOf(endMark, start);
  assert.ok(start > 0 && end > start, 'the package-step meter moved — this extractor is blind');
  return src.slice(start, end + endMark.length)
    .replaceAll('${{ inputs.platform }}', platform)
    .replaceAll('/var/cache/pkg', cacheDir)
    .split('\n').map((l) => l.replace(/^ {8}/, '')).join('\n');
}

function runMeter(pkgExit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-meter-'));
  const bin = path.join(dir, 'bin');
  const cache = path.join(dir, 'cache');
  fs.mkdirSync(bin);
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub('sudo', 'exec "$@"');
  stub('pkg', [
    'case "$1" in',
    '  -vv) echo "Repositories:"; echo "  FreeBSD-ports: {"; echo \'    url             : "pkg+https://pkg.FreeBSD.org/${ABI}/quarterly",\' ;;',
    `  install) mkdir -p "${cache}/All" && dd if=/dev/zero of="${cache}/All/big.pkg" bs=1024 count=2048 2>/dev/null; exit ${pkgExit} ;;`,
    'esac',
  ].join('\n'));
  const script = path.join(dir, 'meter.sh');
  fs.writeFileSync(script, `set -e\nPKGS="cmake"\nGUEST_RUNTIME_TOOLS=''\n${meterBlock('freebsd', cache)}\necho REACHED_THE_VERIFY\n`);
  const t0 = Date.now();
  const r = spawnSync('/bin/sh', [script], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir }, timeout: 30000 });
  return { ...r, ms: Date.now() - t0 };
}

test('the package step reports its duration, what it fetched, and the mirror', UNIX_ONLY, () => {
  const r = runMeter(0);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /guest: package step done after 0m\d+s; fetched 2 MB in 1 files into \S+cache; mirror: pkg\+https:\/\/pkg\.FreeBSD\.org\/\$\{ABI\}\/quarterly/);
  assert.match(r.stdout, /REACHED_THE_VERIFY/);
  // The heartbeat's sleep must not hold stdout open: spawnSync (like cpa's ssh) waits for
  // every writer, so a leaked `sleep 60` shows up as a ~60 s run.
  assert.ok(r.ms < 20000, `the meter held the step open for ${r.ms} ms`);
});

test('a failing install still reports what the package step did, with its exit status', UNIX_ONLY, () => {
  const r = runMeter(3);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stdout, /guest: package step ended \(exit 3\) after 0m\d+s; fetched 2 MB in 1 files/);
  assert.doesNotMatch(r.stdout, /REACHED_THE_VERIFY/);
  assert.ok(r.ms < 20000, `the meter held the step open for ${r.ms} ms`);
});
