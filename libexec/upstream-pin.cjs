'use strict';
// THE UPSTREAM VERSION THIS TREE IS PINNED TO: UPSTREAM_PIN's one `claude-code <version>` line. One reader for every
// consumer (the every-carve check, the evidence scripts, the drift check, the version baked into a built clode), so
// the grammar is parsed in one place. null when the file or the line is absent.
const fs = require('node:fs');
const path = require('node:path');

function upstreamPin(repo = path.resolve(__dirname, '..'), read = (p) => fs.readFileSync(p, 'utf8')) {
  let text;
  try { text = read(path.join(repo, 'UPSTREAM_PIN')); } catch { return null; }
  const m = /^claude-code (\S+)$/m.exec(text);
  return m ? m[1] : null;
}

module.exports = { upstreamPin };
