'use strict';
// stream characterization: the shim's Readable/Writable/PassThrough must produce
// the same observable data/end/finish behavior as host node for the same fixture.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function prog(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-stream-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

const BODY = `
  const { Readable, Writable, PassThrough } = require('node:stream');
  const seen = [];
  const r = new Readable({ read() {} });
  const w = new Writable({ write(chunk, enc, cb) { seen.push(chunk.toString()); cb(); } });
  w.on('finish', () => console.log(JSON.stringify({ seen, joined: seen.join('') })));
  const pt = new PassThrough();
  r.pipe(pt).pipe(w);
  r.push('PO'); r.push('NG'); r.push(null);
`;

test('stream: Readable->PassThrough->Writable matches node', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(BODY);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
  assert.strictEqual(node.joined, 'PONG');
});

test('stream: async iteration over Readable matches node', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(`
    const { Readable } = require('node:stream');
    (async () => {
      const r = Readable.from(['P', 'O', 'N', 'G']);
      let out = '';
      for await (const c of r) out += c.toString();
      console.log(out);
    })();`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'PONG');
});
