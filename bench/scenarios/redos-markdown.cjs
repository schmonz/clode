'use strict';
const { cannedSSE } = require('../../test/mock-anthropic-helper.cjs');

// Adversarial input aimed at backtracking regexes in the markdown/highlight
// path. A short timeout turns a hang into a recorded TIMEOUT rather than a
// stuck run — this scenario is a safety valve, not a speed number.
const EVIL = '['.repeat(200) + ' '.repeat(5000) + 'x'.repeat(5000);

module.exports = {
  name: 'redos-markdown',
  description: 'Adversarial line probing libregexp backtracking — expect a bounded time, never a hang',
  tags: ['regex', 'redos'],
  prompt: 'Echo this back',
  timeoutMs: 20000,
  setup: () => {},
  mock: { respond: () => cannedSSE(EVIL) },
};
