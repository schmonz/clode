'use strict';
// The build progress spinner (makePhaseSpinner) — a TTY-only, in-place phase
// indicator mirroring clode-update's download progress (\r … \x1b[K). It must:
// render only when active (a TTY and not CLODE_VERBOSE, so piped/CI builds and
// the verbose firehose are untouched), draw the current phase label immediately
// on phase(), and clear the line on done(). Progress goes to stderr; the final
// `clode: blobulated …` result stays on stdout.
const test = require('node:test');
const assert = require('node:assert');
const { makePhaseSpinner } = require('../libexec/clode-build.cjs');

// A fake stream that records writes and lets us set isTTY.
function fakeStream(isTTY) {
  const writes = [];
  return { isTTY, write: (s) => { writes.push(s); return true; }, writes, text: () => writes.join('') };
}

test('inactive (non-TTY): phase() and done() write nothing', () => {
  const err = fakeStream(false);
  const spin = makePhaseSpinner(err, false);
  spin.phase('Blobulating');
  spin.done();
  assert.strictEqual(err.text(), '', 'a piped/CI build must get no spinner output');
});

test('active (TTY): phase() draws the label immediately, in place', () => {
  const err = fakeStream(true);
  const spin = makePhaseSpinner(err, true);
  spin.phase('Blobulating');
  const out = err.text();
  spin.done(); // stop the interval so the test process does not hang
  assert.match(out, /Blobulating/, 'the phase label must render');
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

// stalls(): the longest the loop went unserviced in each phase, measured whether or not the spinner draws (a piped or
// CI build has no terminal, and its stalls still freeze a user's terminal build the same way).
test('stalls(): a phase that blocks the loop is measured, one that does not is not; TTY or not', async () => {
  const { makePhaseSpinner } = require('../libexec/clode-build.cjs');
  for (const tty of [false, true]) {
    const s = makePhaseSpinner(fakeStream(tty), tty, null);
    s.phase('Idle');
    await new Promise((r) => setTimeout(r, 350));
    s.phase('Blocking');
    await new Promise((r) => setTimeout(r, 120));
    const until = Date.now() + 600; while (Date.now() < until) { /* a blocking child process's worth of nothing */ }
    await new Promise((r) => setTimeout(r, 120));
    s.done();
    const [idle, blocking] = s.stalls();
    assert.strictEqual(idle.phase, 'Idle');
    assert.ok(idle.maxStallMs < 200, `tty=${tty}: an idle phase stalled ${idle.maxStallMs}ms`);
    assert.strictEqual(blocking.phase, 'Blocking');
    assert.ok(blocking.maxStallMs >= 400, `tty=${tty}: a 600ms block measured only ${blocking.maxStallMs}ms`);
  }
});

test('stalls(): a block that ends with the phase changing is charged to the phase it happened in', () => {
  // the shape of the real defect: a blocking call returns and the very next statement starts a new phase, so no
  // timer tick ever lands between the block and the switch
  const { makePhaseSpinner } = require('../libexec/clode-build.cjs');
  const s = makePhaseSpinner(fakeStream(false), false, null);
  s.phase('Extracting bundle');
  const until = Date.now() + 600; while (Date.now() < until) { /* blocked */ }
  s.phase('Resolving dependencies');
  s.done();
  const [blocked, next] = s.stalls();
  assert.ok(blocked.maxStallMs >= 400, `the block was charged ${blocked.maxStallMs}ms`);
  assert.ok(next.maxStallMs < 200, `the next phase was charged ${next.maxStallMs}ms`);
});
