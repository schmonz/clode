'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateScenario } = require('../bench/lib/scenario.cjs');

const good = {
  name: 'x',
  description: 'd',
  prompt: 'do it',
  setup: () => {},
  mock: { respond: () => 'event: ping\n\n' },
};

test('validateScenario accepts a well-formed scenario', () => {
  assert.doesNotThrow(() => validateScenario(good));
});

test('validateScenario rejects missing prompt', () => {
  const bad = { ...good };
  delete bad.prompt;
  assert.throws(() => validateScenario(bad), /prompt/);
});

test('validateScenario rejects non-function mock.respond', () => {
  assert.throws(
    () => validateScenario({ ...good, mock: { respond: 'nope' } }),
    /mock\.respond/,
  );
});
