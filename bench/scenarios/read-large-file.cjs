'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { cannedToolUseSSE, cannedSSE } = require('../../test/mock-anthropic-helper.cjs');

const FILE = 'huge.log';

module.exports = {
  name: 'read-large-file',
  description: 'Read tool on a big file — read + JSON-serialize tool_result + token counting',
  tags: ['io', 'json', 'tokenize'],
  prompt: `Read ${FILE} and summarize it`,
  timeoutMs: 180000,
  setup: (dir) => {
    const chunk = 'x'.repeat(120) + '\n';
    fs.writeFileSync(path.join(dir, FILE), chunk.repeat(60000)); // ~7MB
  },
  mock: {
    respond: (body) => {
      if (body.includes('tool_result')) return cannedSSE('Summarized.');
      return cannedToolUseSSE('Read', { file_path: FILE });
    },
  },
};
