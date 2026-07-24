'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { cannedToolUseSSE, cannedSSE } = require('../../test/mock-anthropic-helper.cjs');

module.exports = {
  name: 'grep-bigrepo',
  description: 'Grep over a wide tree — reveals whether search shells out to rg or walks in JS',
  tags: ['glob', 'search'],
  prompt: 'Find every occurrence of NEEDLE_TOKEN in the repo',
  timeoutMs: 180000,
  setup: (dir) => {
    for (let d = 0; d < 200; d++) {
      const sub = path.join(dir, `pkg${d}`);
      fs.mkdirSync(sub, { recursive: true });
      for (let f = 0; f < 100; f++) {
        const body = f === 50 ? 'has NEEDLE_TOKEN here\n' : 'nothing to see\n';
        fs.writeFileSync(path.join(sub, `f${f}.js`), body);
      }
    }
  },
  mock: {
    respond: (body) => {
      if (body.includes('tool_result')) return cannedSSE('Found them.');
      return cannedToolUseSSE('Grep', { pattern: 'NEEDLE_TOKEN', output_mode: 'files_with_matches' });
    },
  },
};
