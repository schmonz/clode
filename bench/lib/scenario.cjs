'use strict';
const fs = require('node:fs');
const path = require('node:path');

function validateScenario(s) {
  if (!s || typeof s !== 'object') throw new Error('scenario: not an object');
  for (const k of ['name', 'description', 'prompt']) {
    if (typeof s[k] !== 'string' || !s[k]) throw new Error(`scenario: ${k} must be a non-empty string`);
  }
  if (typeof s.setup !== 'function') throw new Error('scenario: setup must be a function');
  if (!s.mock || typeof s.mock.respond !== 'function') {
    throw new Error('scenario: mock.respond must be a function');
  }
  if (s.timeoutMs !== undefined && typeof s.timeoutMs !== 'number') {
    throw new Error('scenario: timeoutMs must be a number');
  }
  return s;
}

function loadScenarios(dir) {
  return fs
    .readdirSync(dir)
    // Exclude dot-prefixed files — same rule as test/run.mjs: AppleDouble mounts
    // write `._foo.cjs` sidecars that end in .cjs but are not modules.
    .filter((f) => f.endsWith('.cjs') && !f.startsWith('.'))
    // path.resolve (not join): require() treats a relative specifier as a
    // package name, so an absolute path is required whether `dir` was relative
    // (the CLI verify step) or absolute (the orchestrator).
    .map((f) => validateScenario(require(path.resolve(dir, f))))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { validateScenario, loadScenarios };
