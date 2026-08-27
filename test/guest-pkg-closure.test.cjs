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
  // `unknown`, NOT 0. pkg_add's dry run prints no download size, and the first version
  // of this script hardcoded bytes=0 in every branch — so every leg reported a total of
  // zero bytes and four legs went GREEN having measured nothing. `unknown` is not a
  // number on purpose: it cannot be summed or averaged by accident.
  assert.strictEqual(totalLines[0], 'PKGCLOSURE-TOTAL 2 unknown');
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
  // Assert the BEHAVIOUR, not the wording: a nonzero exit, no total on stdout, and a
  // message that names the platform and rules out the empty-closure reading. Pinning the
  // exact sentence just breaks the test whenever the message improves.
  assert.match(err, /openbsd/);
  assert.match(err, /NOT an empty closure/);
});

// THE TEST THAT WOULD HAVE CAUGHT IT. Everything above this line uses hand-written
// "dry-run-shaped" output, and that is exactly why the original script shipped broken:
// invented fixtures agree with whatever the parser happens to do. This one replays REAL
// captured stdout from the freebsd-amd64 guest in probe run 33121243887 (2026-08-27),
// where the manager reported 44 packages / 115 MiB and the parser reported `44 0` —
// having thrown the size away and hardcoded a zero.
// The load-bearing assertion is the BYTE COUNT: 115 MiB = 120586240. A parser that
// cannot read sizes fails here instead of quietly answering the pinning question with
// a zero.
test('real captured freebsd dry-run output yields the manager\'s own numbers', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-pkg-closure-real-'));
  const fixture = path.join(__dirname, 'fixtures', 'pkg-dryrun-freebsd-amd64.txt');
  const fakePkg = path.join(tmp, 'pkg');
  // exit 1 on purpose: `pkg install -n` DECLINES its own prompt and exits nonzero. The
  // first version read that as a failed query, which is why three legs that measured
  // perfectly well were reported red.
  fs.writeFileSync(fakePkg, `#!/bin/sh\ncat ${JSON.stringify(fixture)}\nexit 1\n`);
  fs.chmodSync(fakePkg, 0o755);

  const out = execFileSync('sh', [SCRIPT, 'freebsd', 'cmake', 'gmake', 'node', 'git', 'bash'], {
    encoding: 'utf8',
    stdio: 'pipe',
    env: Object.assign({}, process.env, { PATH: tmp + path.delimiter + process.env.PATH }),
  });
  const lines = out.trim().split('\n');
  const total = lines[lines.length - 1];
  assert.strictEqual(total, 'PKGCLOSURE-TOTAL 44 120586240',
    '44 packages and 115 MiB, exactly as the guest reported them');
  const pkgLines = lines.filter((l) => l.startsWith('PKGCLOSURE ') && !l.startsWith('PKGCLOSURE-TOTAL'));
  assert.strictEqual(pkgLines.length, 44, 'per-package lines agree with the total');
});
