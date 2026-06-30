const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const NODE = process.env.CLODE_NODE || process.execPath;

test('mkfixture.cjs writes a carvable fixture the extractor boots', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkfix-'));
  const bin = path.join(tmp, 'claude');
  const r = spawnSync(NODE, [path.join(REPO, 'test', 'mkfixture.cjs'), bin, 'HELLO'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const buf = fs.readFileSync(bin);
  assert.ok(buf.includes(Buffer.from('@bun-cjs')), 'has marker');
  assert.ok(buf.includes(Buffer.from('src/entrypoints/cli.js')), 'has entry name');
  assert.ok(buf.includes(Buffer.from('@anthropic-ai/claude-code')), 'has sentinel');
  assert.ok(buf.length > 1_000_000, 'past size floor');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('distinct labels yield distinct sizes (distinct sigs)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkfix-'));
  const a = path.join(tmp, 'a'); const b = path.join(tmp, 'b');
  spawnSync(NODE, [path.join(REPO, 'test', 'mkfixture.cjs'), a, 'v1'], { encoding: 'utf8' });
  spawnSync(NODE, [path.join(REPO, 'test', 'mkfixture.cjs'), b, 'v2-longer'], { encoding: 'utf8' });
  assert.notStrictEqual(fs.statSync(a).size, fs.statSync(b).size);
  fs.rmSync(tmp, { recursive: true, force: true });
});
