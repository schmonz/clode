'use strict';
// Characterization: shim path/os/url answers must MATCH host node's answers
// for the same inputs (posix). The table runs in both worlds.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const TABLE = `
const p = require('node:path');
const u = require('node:url');
const cases = [
  p.join('a', 'b', '..', 'c'), p.join('/x//y/', 'z'), p.join('.'),
  p.normalize('/a/b/../../c/./d//'), p.normalize('a/../../b'),
  p.dirname('/a/b/c'), p.dirname('/a'), p.dirname('a'), p.dirname('/'),
  p.basename('/a/b/c.txt'), p.basename('/a/b/c.txt', '.txt'), p.basename('/'),
  p.extname('a/b.c.d'), p.extname('.hidden'), p.extname('noext'),
  p.isAbsolute('/x'), p.isAbsolute('x'),
  p.relative('/a/b/c', '/a/d'), p.relative('/a/b', '/a/b'),
  JSON.stringify(p.parse('/home/user/file.txt')),
  p.resolve('/base', 'sub', '../x'),
  u.fileURLToPath('file:///tmp/x%20y.txt'),
  u.pathToFileURL('/tmp/q r').href,
  new u.URL('https://h/p?a=1').searchParams.get('a'),
];
console.log(JSON.stringify(cases));
`;

test('path/url characterization vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-path-'));
  const f = path.join(dir, 'table.cjs');
  fs.writeFileSync(f, TABLE);
  const nodeOut = JSON.parse(require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const tjsOut = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(tjsOut, nodeOut);
});

// Wall (Task 4): the -p bundle require()s `path/win32` and calls
// isAbsolute/join/dirname/delimiter in its Windows git-bash-detection branch.
// The win32 surface must match host node's path.win32 for Windows-style inputs.
test('path/win32 characterization vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-win32-'));
  const f = path.join(dir, 'win32.cjs');
  fs.writeFileSync(f, String.raw`
const w = require('path/win32');
const cases = [
  w.sep, w.delimiter,
  w.isAbsolute('C:\\a'), w.isAbsolute('\\\\srv\\s'), w.isAbsolute('a\\b'),
  w.isAbsolute('/x'), w.isAbsolute('\\x'), w.isAbsolute('C:a'), w.isAbsolute(''),
  w.join('C:\\a', '..', '..', 'bin', 'bash.exe'),
  w.join('a', 'b\\c'), w.join('C:\\x\\y', 'z'), w.join('\\\\srv\\s', 'a', 'b'),
  w.normalize('C:\\a\\.\\b\\..\\c'), w.normalize('a/b\\c'),
  w.dirname('C:\\a\\b'), w.dirname('C:\\a'), w.dirname('a\\b\\c'), w.dirname('\\\\srv\\s\\x'),
];
console.log(JSON.stringify(cases));
`);
  const nodeOut = JSON.parse(require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), nodeOut);
});

test('os module basics under tjs', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-os-'));
  const f = path.join(dir, 'os.cjs');
  fs.writeFileSync(f, `const os = require('node:os');
console.log(JSON.stringify({ home: os.homedir().startsWith('/'), tmp: os.tmpdir().length > 0, plat: os.platform(), eol: os.EOL }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(out, { home: true, tmp: true, plat: process.platform, eol: '\n' });
});

// Wall (Task 4, -p round-trip): the bundle builds the system prompt's
// environment block with `${os.type()} ${os.release()}` — a missing os.release
// threw `TypeError: not a function` and crashed the query session before the
// Messages POST. os.release/version/hostname/networkInterfaces/endianness/machine
// must all be callable. DIVERGENCE (modules/os.cjs): release()/version() return
// '' (this tjs build exposes no uname/kernel-release API) — asserted here so the
// approximation is characterized, not merely mentioned.
test('os.release/version/hostname/networkInterfaces/endianness are callable', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-osrel-'));
  const f = path.join(dir, 'osrel.cjs');
  fs.writeFileSync(f, `const os = require('node:os');
console.log(JSON.stringify({
  release: os.release(),
  version: os.version(),
  hostnameStr: typeof os.hostname() === 'string' && os.hostname().length > 0,
  niObj: typeof os.networkInterfaces() === 'object',
  endianness: os.endianness(),
  machine: os.machine(),
  // the exact call the bundle makes ('Darwin ' + release) must not throw:
  envLine: os.type() + ' ' + os.release(),
}));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  // DIVERGENCE assertions: release/version are the documented '' on this tjs.
  assert.strictEqual(out.release, '');
  assert.strictEqual(out.version, '');
  assert.strictEqual(out.hostnameStr, true);
  assert.strictEqual(out.niObj, true);
  assert.ok(out.endianness === 'LE' || out.endianness === 'BE');
  // the exact system-prompt env line the bundle builds (`os.type()+' '+release`)
  // must be a string and not throw; on darwin it is type-prefixed.
  assert.strictEqual(typeof out.envLine, 'string');
  assert.ok(out.envLine.startsWith(require('node:os').type()));
});

// Wall (Task 4): the -p boot sizes parallelism from os.cpus().length. cpus()
// must return a non-empty array of Node-shaped entries; the count must match
// host node on this machine.
test('os.cpus(): count + shape match host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-cpus-'));
  const f = path.join(dir, 'cpus.cjs');
  fs.writeFileSync(f, `const c = require('node:os').cpus();
console.log(JSON.stringify({
  count: c.length,
  keys: Object.keys(c[0]).sort(),
  timeKeys: Object.keys(c[0].times).sort(),
  modelStr: typeof c[0].model === 'string',
  parallelism: require('node:os').availableParallelism(),
}));`);
  const nodeC = require('node:os').cpus();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.count, nodeC.length);
  assert.deepStrictEqual(out.keys, ['model', 'speed', 'times']);
  assert.deepStrictEqual(out.timeKeys, ['idle', 'irq', 'nice', 'sys', 'user']);
  assert.strictEqual(out.modelStr, true);
  assert.strictEqual(out.parallelism, nodeC.length);
});

// Wall (Task 4): the -p boot calls os.type() (compared against 'OS400').
test('os.type() matches host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-ostype-'));
  const f = path.join(dir, 'ostype.cjs');
  fs.writeFileSync(f, `console.log(require('node:os').type());`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

test('os.tmpdir root-edge (TMPDIR=/) matches host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-tmproot-'));
  const f = path.join(dir, 'tmproot.cjs');
  fs.writeFileSync(f, `console.log(JSON.stringify(require('node:os').tmpdir()));`);
  const nodeOut = JSON.parse(require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8', env: { ...process.env, TMPDIR: '/' } }).trim());
  const r = runLoader(f, [], { env: { TMPDIR: '/' } });
  assert.strictEqual(r.status, 0, r.stderr);
  const tjsOut = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(tjsOut, nodeOut);
});
