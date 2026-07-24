'use strict';
const { cannedSSE } = require('../../test/mock-anthropic-helper.cjs');

// A 5000-line fenced code block as the assistant's final text. In -p mode this
// still drives markdown parsing + syntax highlighting for output rendering.
// NOTE: interactive per-frame TUI diffing is only partially exercised headless;
// see the PTY follow-up in "Out of scope".
function bigCodeBlock() {
  const lines = ['```js'];
  for (let i = 0; i < 5000; i++) {
    lines.push(`const v${i} = (a, b) => a.map((x) => x + ${i}).filter((y) => y > b); // row ${i}`);
  }
  lines.push('```');
  return lines.join('\n');
}

module.exports = {
  name: 'highlight-codeblock',
  description: '5000-line fenced code block — markdown parse + libregexp syntax highlight + render',
  tags: ['regex', 'render', 'markdown'],
  prompt: 'Show me a large example',
  timeoutMs: 180000,
  setup: () => {},
  mock: { respond: () => cannedSSE(bigCodeBlock()) },
};
