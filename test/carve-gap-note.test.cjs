'use strict';
// The daily drift check's green says "anchors as expected, CLI reachable". Both are
// true and neither is what we are actually afraid of: `clode build` from a NEWER
// bundle fails at the SCC MERGE (2.1.257, "invalid property name"), and this check
// never reaches the merge because the merge needs an engine. A green that does not
// say so is a green the next reader takes for "newest upstream is fine" — the same
// over-claiming disclosure phase 5b spent itself removing, one layer up.
//
// So the note is asserted here rather than trusted to prose: if someone deletes the
// caveat, this goes red.
const { test } = require('node:test');
const assert = require('node:assert');

test('the carve-gap note says what a green does NOT prove', async () => {
  const { carveGapNote } = await import('../scripts/lib/carve-gap-note.mjs');
  const note = carveGapNote({ pin: '2.1.251' });
  assert.match(note, /does NOT prove/);
  assert.match(note, /merge/i, 'must name the step that actually breaks');
  assert.match(note, /2\.1\.251/, 'must name the pin it was given');
  assert.doesNotMatch(note, /merge (is )?(ok|fine|works)/i);
});

// The note used to end at "nothing exercises the merge", which stopped being true the day
// the carve probe landed. A caveat that names no owner is where a reader stops: this
// asserts the pointer, so deleting the probe's name goes red rather than quietly leaving
// the drift green sounding like the last word on the question.
test('the carve-gap note points at the job that DOES reach the merge', async () => {
  const { carveGapNote } = await import('../scripts/lib/carve-gap-note.mjs');
  const note = carveGapNote({ pin: '2.1.251', checked: '2.1.278' });
  assert.match(note, /carve-probe\.mjs/, 'must name the probe a reader should go read');
  assert.match(note, /carve/, 'must name the job');
});

test('the carve-gap note names the distance when the checked version is known', async () => {
  const { carveGapNote } = await import('../scripts/lib/carve-gap-note.mjs');
  const note = carveGapNote({ pin: '2.1.251', checked: '2.1.270' });
  assert.match(note, /2\.1\.270/, 'must name the version actually inspected');
  assert.match(note, /2\.1\.251/);
});

test('the carve-gap note degrades honestly when the pin cannot be read', async () => {
  const { carveGapNote } = await import('../scripts/lib/carve-gap-note.mjs');
  const note = carveGapNote({ pin: null });
  assert.match(note, /does NOT prove/, 'the caveat survives even with no pin to name');
  assert.doesNotMatch(note, /null|undefined/);
});
