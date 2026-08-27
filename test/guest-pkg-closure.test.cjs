'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'guest-pkg-closure.sh');

// The script runs inside guests that may have no bash. Anything bash-only here is a
// failure that only shows up on the slowest legs, hours later.
test('is POSIX sh clean', () => {
  execFileSync('sh', ['-n', SCRIPT], { stdio: 'pipe' });
});

// An unknown platform must say so, not silently print nothing and read as "zero
// packages" — that is the shape of failure this whole plan exists to remove.
test('an unknown platform fails loudly and names it', () => {
  let status = 0, err = '';
  try {
    execFileSync('sh', [SCRIPT, 'plan9', 'cmake'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { status = e.status; err = (e.stderr || '') + (e.stdout || ''); }
  assert.notStrictEqual(status, 0);
  assert.match(err, /plan9/);
  assert.match(err, /unsupported|unknown/i);
});

// Zero packages is a legitimate input (a leg may install none) and must total zero
// rather than erroring.
test('no packages totals zero', () => {
  const out = execFileSync('sh', [SCRIPT, 'freebsd'], { encoding: 'utf8' });
  assert.match(out, /^PKGCLOSURE-TOTAL 0 0$/m);
});

// A real leg produces PKGCLOSURE lines from a manager query; each such run must end
// with exactly one PKGCLOSURE-TOTAL line whose count matches the packages resolved.
// A guest VM is not available here, so the manager binary (pkg_add, for the openbsd
// branch) is faked on PATH with known dry-run-shaped output.
test('a real query ends with exactly one accurate total line', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-pkg-closure-'));
  const fakePkgAdd = path.join(tmp, 'pkg_add');
  fs.writeFileSync(
    fakePkgAdd,
    '#!/bin/sh\necho "installing cmake-3.28.1"\necho "installing ninja-1.11.1"\n'
  );
  fs.chmodSync(fakePkgAdd, 0o755);

  const out = execFileSync('sh', [SCRIPT, 'openbsd', 'cmake', 'ninja'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { PATH: tmp + path.delimiter + process.env.PATH }),
  });

  const lines = out.trim().split('\n');
  const totalLines = lines.filter((l) => l.startsWith('PKGCLOSURE-TOTAL'));
  const pkgLines = lines.filter((l) => l.startsWith('PKGCLOSURE ') && !l.startsWith('PKGCLOSURE-TOTAL'));

  assert.strictEqual(totalLines.length, 1, 'exactly one total line');
  assert.strictEqual(lines[lines.length - 1], totalLines[0], 'total line is last');
  assert.strictEqual(pkgLines.length, 2, 'two package lines from the fake query');
  assert.strictEqual(totalLines[0], 'PKGCLOSURE-TOTAL 2 0');
});


// An unsupported platform must fail even when asked for zero packages — validation
// has to run before the zero-package shortcut, or a typo'd platform with no package
// args reads as a successful empty measurement (exactly the failure class this whole
// script exists to remove).
test('an unsupported platform with no packages still fails and names it', () => {
  let status = 0, err = '';
  try {
    execFileSync('sh', [SCRIPT, 'plan9'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { status = e.status; err = (e.stderr || '') + (e.stdout || ''); }
  assert.notStrictEqual(status, 0);
  assert.match(err, /plan9/);
  assert.match(err, /unsupported|unknown/i);
});

// If the package manager itself fails (repo unreachable, bad package name, etc.) the
// script must fail loudly rather than report a zero-package closure — a failed query
// is not the same thing as a genuine empty result, and conflating them would make the
// whole measurement untrustworthy. The fake pkg_add below fails with output that the
// openbsd awk filter would otherwise swallow entirely (a line starting "pkg_add:"),
// so the only thing that can catch this is checking the manager's own exit status.
test('a failing manager query fails loudly instead of reporting an empty closure', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-pkg-closure-fail-'));
  const fakePkgAdd = path.join(tmp, 'pkg_add');
  fs.writeFileSync(
    fakePkgAdd,
    '#!/bin/sh\necho "pkg_add: unable to fetch repository" >&2\nexit 1\n'
  );
  fs.chmodSync(fakePkgAdd, 0o755);

  let status = 0, out = '', err = '';
  try {
    out = execFileSync('sh', [SCRIPT, 'openbsd', 'cmake'], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: Object.assign({}, process.env, { PATH: tmp + path.delimiter + process.env.PATH }),
    });
  } catch (e) {
    status = e.status;
    out = e.stdout || '';
    err = e.stderr || '';
  }
  assert.notStrictEqual(status, 0, 'must not exit 0 on a failed query');
  assert.doesNotMatch(out, /PKGCLOSURE-TOTAL 0 0/, 'must not report a zero-package closure');
  assert.match(err, /FAILED/);
});
