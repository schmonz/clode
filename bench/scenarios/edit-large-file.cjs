'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { cannedToolUseSSE, cannedSSE } = require('../../test/mock-anthropic-helper.cjs');

const FILE = 'big.txt';
const OLD = 'LINE-4242 needle';
const NEW = 'LINE-4242 patched';

module.exports = {
  name: 'edit-large-file',
  description: 'Edit tool on a ~10MB file — exercises structuredPatch diff + flat-string rebuild',
  tags: ['diff', 'string'],
  prompt: `Replace "${OLD}" with "${NEW}" in ${FILE}`,
  timeoutMs: 180000,
  setup: (dir) => {
    const lines = [];
    for (let i = 0; i < 250000; i++) {
      lines.push(i === 4242 ? OLD : `line ${i} filler text to reach ~10MB of content`);
    }
    fs.writeFileSync(path.join(dir, FILE), lines.join('\n'));
  },
  mock: {
    respond: (body) => {
      if (body.includes('tool_result')) return cannedSSE('Done.');
      return cannedToolUseSSE('Edit', { file_path: FILE, old_string: OLD, new_string: NEW });
    },
  },
};
