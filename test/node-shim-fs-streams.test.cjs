'use strict';
// Discovery-pass batch 2 (2026-07-23): the shim's fs had NO streaming layer —
// fs.createReadStream (19 bundle sites, incl. `readline.createInterface({input:
// fs.createReadStream(file)})` for NDJSON/transcript scans) and createWriteStream
// (17 sites) were undefined; fs.cpSync/realpathSync.native missing too. Oracle:
// exercise the real patterns under the loader and diff against host node.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const BODY = `
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), readline = require('node:readline');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'strm-'));
  const out = {};
  (async () => {
    // createReadStream + readline — the bundle's NDJSON line-scan pattern.
    const nd = path.join(d, 'nd'); fs.writeFileSync(nd, '{"t":"a"}\\n{"t":"b"}\\n{"t":"c"}\\n');
    const rl = readline.createInterface({ input: fs.createReadStream(nd), crlfDelay: Infinity });
    const lines = []; for await (const l of rl) lines.push(l); out.readlineLines = lines;
    // createReadStream content via data/end (encoding), large enough to chunk.
    const cf = path.join(d, 'cf'); fs.writeFileSync(cf, 'hello stream world'.repeat(5000));
    const rs = fs.createReadStream(cf, { encoding: 'utf8' });
    let acc = ''; await new Promise((res, rej) => { rs.on('data', (c) => acc += c); rs.on('end', res); rs.on('error', rej); });
    out.readLen = acc.length; out.readHead = acc.slice(0, 5);
    // createWriteStream roundtrip.
    const wf = path.join(d, 'wf'); const ws = fs.createWriteStream(wf);
    ws.write('part1-'); ws.write('part2');
    await new Promise((res, rej) => { ws.on('finish', res); ws.on('error', rej); ws.end(); });
    out.written = fs.readFileSync(wf, 'utf8');
    // cpSync recursive.
    const s = path.join(d, 'src/a'); fs.mkdirSync(s, { recursive: true }); fs.writeFileSync(path.join(s, 'f'), 'X');
    fs.cpSync(path.join(d, 'src'), path.join(d, 'dst'), { recursive: true }); out.cp = fs.readFileSync(path.join(d, 'dst/a/f'), 'utf8');
    // realpathSync.native.
    out.realpathNative = typeof fs.realpathSync.native;
    console.log(JSON.stringify(out));
  })().catch((e) => console.log(JSON.stringify({ ERR: String((e && e.message) || e).slice(0, 90) })));`;

function prog(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-strm-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

test('fs streaming layer (createReadStream/createWriteStream) + cpSync + realpathSync.native match node', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(BODY);
  const node = JSON.parse(execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  assert.deepStrictEqual(node, {
    readlineLines: ['{"t":"a"}', '{"t":"b"}', '{"t":"c"}'],
    readLen: 90000, readHead: 'hello', written: 'part1-part2', cp: 'X', realpathNative: 'function',
  }, 'host node baseline');
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(got, node, 'quaude must match node across the streaming layer');
});
