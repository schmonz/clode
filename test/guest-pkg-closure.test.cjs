'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
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
