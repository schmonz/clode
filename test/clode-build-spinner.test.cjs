'use strict';
// The build progress spinner (makePhaseSpinner) — a TTY-only, in-place phase
// indicator mirroring clode-update's download progress (\r … \x1b[K). It must:
// render only when active (a TTY and not CLODE_VERBOSE, so piped/CI builds and
// the verbose firehose are untouched), draw the current phase label immediately
// on phase(), and clear the line on done(). Progress goes to stderr; the final
// `clode: fused …` result stays on stdout.
const test = require('node:test');
const assert = require('node:assert');
const { makePhaseSpinner } = require('../libexec/clode-fuse.cjs');

// A fake stream that records writes and lets us set isTTY.
function fakeStream(isTTY) {
  const writes = [];
  return { isTTY, write: (s) => { writes.push(s); return true; }, writes, text: () => writes.join('') };
}

test('inactive (non-TTY): phase() and done() write nothing', () => {
  const err = fakeStream(false);
  const spin = makePhaseSpinner(err, false);
  spin.phase('Fusing');
  spin.done();
  assert.strictEqual(err.text(), '', 'a piped/CI build must get no spinner output');
});

test('active (TTY): phase() draws the label immediately, in place', () => {
  const err = fakeStream(true);
  const spin = makePhaseSpinner(err, true);
  spin.phase('Fusing');
  const out = err.text();
  spin.done(); // stop the interval so the test process does not hang
  assert.match(out, /Fusing/, 'the phase label must render');
  assert.match(out, /^\r/, 'must redraw in place (carriage return), not append lines');
  assert.match(out, /\x1b\[K/, 'must clear to end-of-line so a shorter label leaves no tail');
});

test('active: done() clears the spinner line so the result prints clean', () => {
  const err = fakeStream(true);
  const spin = makePhaseSpinner(err, true);
  spin.phase('Smoking');
  err.writes.length = 0; // isolate what done() emits
  spin.done();
  assert.strictEqual(err.text(), '\r\x1b[K', 'done() must erase the line (\\r + clear-to-EOL)');
});

test('done() before any phase is a no-op (no stray clear on an untouched line)', () => {
  const err = fakeStream(true);
  const spin = makePhaseSpinner(err, true);
  spin.done();
  assert.strictEqual(err.text(), '', 'clearing with no phase drawn must emit nothing');
});

test('done() is idempotent and stops the animation (no leaked interval)', () => {
  const err = fakeStream(true);
  const spin = makePhaseSpinner(err, true);
  spin.phase('Extracting bundle');
  spin.done();
  err.writes.length = 0;
  spin.done();
  assert.strictEqual(err.text(), '', 'a second done() must do nothing');
});
