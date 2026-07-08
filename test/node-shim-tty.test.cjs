'use strict';
// Characterization: node:tty + process stdio TTY behavior under tjs must match
// host node for the same fixture, run under a real PTY.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skipUnlessTjs } = require('./node-shim-helper.cjs');
const { runLoaderPty, runNodePty, extractMark } = require('./node-shim-tty-helper.cjs');

function fixture(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-tty-'));
  const f = path.join(dir, 'fx.cjs');
  fs.writeFileSync(f, body);
  return f;
}

test('isatty(0/1/2) is true under a PTY, matching host node', async (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(`
    const tty = require('node:tty');
    console.log('@@TTY@@' + JSON.stringify({
      i0: tty.isatty(0), i1: tty.isatty(1), i2: tty.isatty(2), i9: tty.isatty(9),
    }));
  `);
  const nodeOut = extractMark((await runNodePty(f, { ms: 3000 })).out);
  const tjsOut = extractMark((await runLoaderPty(f, { ms: 3000 })).out);
  assert.deepStrictEqual(tjsOut, nodeOut);
  assert.deepStrictEqual(tjsOut, { i0: true, i1: true, i2: true, i9: false });
});
