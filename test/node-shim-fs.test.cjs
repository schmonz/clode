'use strict';
// fs characterization: a scripted round-trip in a temp sandbox must produce
// the same observable answers under node and under the shim.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROG = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
const out = [];
fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true });
fs.writeFileSync(path.join(dir, 'a/x.txt'), 'hello sync world');
out.push(fs.readFileSync(path.join(dir, 'a/x.txt'), 'utf8'));
out.push(fs.existsSync(path.join(dir, 'a/x.txt')), fs.existsSync(path.join(dir, 'nope')));
const st = fs.statSync(path.join(dir, 'a/x.txt'));
out.push(st.isFile(), st.isDirectory(), st.size);
fs.symlinkSync(path.join(dir, 'a/x.txt'), path.join(dir, 'a/lnk'));
out.push(fs.lstatSync(path.join(dir, 'a/lnk')).isSymbolicLink());
out.push(path.basename(fs.realpathSync(path.join(dir, 'a/lnk'))));
out.push(fs.readdirSync(path.join(dir, 'a')).sort());
const fd = fs.openSync(path.join(dir, 'a/x.txt'), 'r');
const buf = new Uint8Array(5);
out.push(fs.readSync(fd, buf, 0, 5, 6), new TextDecoder().decode(buf));
fs.closeSync(fd);
fs.renameSync(path.join(dir, 'a/x.txt'), path.join(dir, 'a/y.txt'));
fs.unlinkSync(path.join(dir, 'a/lnk'));
out.push(fs.readdirSync(path.join(dir, 'a')).sort());
try { fs.readFileSync(path.join(dir, 'ghost')); } catch (e) { out.push(e.code); }
fs.promises.readFile(path.join(dir, 'a/y.txt'), 'utf8').then((s) => {
  out.push('p:' + s.slice(0, 5));
  console.log(JSON.stringify(out));
});
`;

test('fs characterization vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-fs-'));
  const f = path.join(base, 'prog.cjs');
  fs.writeFileSync(f, PROG);
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-fs-node-'));
  const tjsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-fs-tjs-'));
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f, nodeDir], { encoding: 'utf8' }).trim();
  const r = runLoader(f, [tjsDir]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

// fs.promises.open + O_* constants (tjs Bash-tool wall): the bundle's Bash tool
// opens a per-command log file with `fs.promises.open(path, O_WRONLY|O_CREAT|
// O_APPEND|O_NOFOLLOW)` and passes the returned FileHandle's real fd as child
// stdio so the subprocess writes into the file. Without promises.open (returning
// a FileHandle with a numeric .fd) and the O_* constants, that throws
// "not a function" and EVERY Bash tool call fails. Verify: the constants are
// numbers, open() yields a FileHandle whose fd write+append lands bytes that
// read back, and close() works — same observable answers as host node.
const OPEN_PROG = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
(async () => {
  const out = [];
  out.push(['O_WRONLY','O_CREAT','O_APPEND','O_RDONLY','O_TRUNC'].every((k) => typeof fs.constants[k] === 'number'));
  const p = path.join(dir, 'log.txt');
  const fh = await fs.promises.open(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND);
  out.push(typeof fh.fd === 'number' && fh.fd >= 0);
  await fh.write(Buffer.from('line1\\n'));
  await fh.appendFile('line2\\n');
  await fh.close();
  out.push(fs.readFileSync(p, 'utf8'));
  console.log(JSON.stringify(out));
})();
`;

test('fs.promises.open + O_* constants vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-open-'));
  const f = path.join(base, 'open.cjs');
  fs.writeFileSync(f, OPEN_PROG);
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-open-node-'));
  const tjsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-open-tjs-'));
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f, nodeDir], { encoding: 'utf8' }).trim();
  const r = runLoader(f, [tjsDir]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

// writeFileSync(fd, data): the fd-as-first-arg form. Claude Code's atomic config
// writer (saveConfigWithLock -> the atomic-write helper) does exactly this:
//   const fd = fs.openSync(tmp, O_WRONLY|O_CREAT|O_EXCL, mode);
//   fs.writeFileSync(fd, JSON.stringify(config), { encoding: 'utf-8' });
//   fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(tmp, '~/.claude.json');
// A shim writeFileSync that assumes arg1 is a PATH re-opens the fd NUMBER as a
// path (creating a bogus file named "8"), leaving the real temp fd 0 bytes — so
// the rename clobbers the config to 0 bytes (the observed "config not persisted"
// / "Unexpected end of JSON input" daily-driver bug). Same observable answers as
// host node: the temp reads back the written JSON, and no bogus numeric file.
const FDWRITE_PROG = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
const out = [];
const tmp = path.join(dir, 'cfg.json.tmp');
const data = JSON.stringify({ theme: 'dark', n: 999, s: 'x'.repeat(50) });
const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
fs.writeFileSync(fd, data, { encoding: 'utf-8' });
fs.fsyncSync(fd);
fs.closeSync(fd);
const target = path.join(dir, 'cfg.json');
fs.renameSync(tmp, target);
out.push(fs.readFileSync(target, 'utf8'));       // must equal data (not '')
out.push(fs.statSync(target).size);              // must equal data byte length
out.push(fs.readdirSync(dir).sort());            // must NOT contain a bogus "<fd>" file
console.log(JSON.stringify(out));
`;

test('fs.writeFileSync(fd, data) writes to the fd (CC atomic-write) vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-fdw-'));
  const f = path.join(base, 'fdw.cjs');
  fs.writeFileSync(f, FDWRITE_PROG);
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-fdw-node-'));
  const tjsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-fdw-tjs-'));
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f, nodeDir], { encoding: 'utf8' }).trim();
  const r = runLoader(f, [tjsDir]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

// latin1 byte round-trip: this is the extractor's core representation
// (extract-claude-js reads the native binary as a latin1 string so 1 char == 1
// byte, then writes Buffer.from(text, 'latin1')). readFileSync(,'latin1') must
// return a string of code points 0..255, and Buffer.from(str,'latin1') must
// re-encode low-byte (NOT utf-8, which would corrupt bytes >= 0x80).
const LATIN1_PROG = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
// Every byte value 0..255, twice, so a naive utf-8 round-trip is visibly wrong.
const src = Buffer.from(Array.from({ length: 512 }, (_, i) => i & 0xff));
const srcPath = path.join(dir, 'bytes.bin');
fs.writeFileSync(srcPath, src);
const s = fs.readFileSync(srcPath, 'latin1');
const outPath = path.join(dir, 'rt.bin');
fs.writeFileSync(outPath, Buffer.from(s, 'latin1'));
const rt = fs.readFileSync(outPath); // bytes
console.log(JSON.stringify({
  typeofRead: typeof s,
  len: s.length,
  cp0: s.charCodeAt(0), cp200: s.charCodeAt(200), cp255: s.charCodeAt(255),
  roundTripLen: rt.length,
  roundTripEqual: Buffer.from(rt).equals(src),
}));
`;

// FileHandle disposal (tjs Bash-tool wall, bundle 2.1.204): the Bash tool's
// output-file readers open with `await using fh = await fs.promises.open(...)`,
// then fh.stat() for the size and positioned fh.read() for the window. A
// FileHandle without Symbol.asyncDispose makes \`await using\` throw
// "TypeError: value is not disposable" — no .code, so the tool reports
// "output file could not be read (unknown)" and EVERY Bash result degrades to
// the persisted-file detour. Verify: the await-using read round-trips like
// host node, and disposal really closes the fd (fstat after the block EBADFs).
const AWAIT_USING_PROG = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
(async () => {
  const out = [];
  const p = path.join(dir, 'out.txt');
  fs.writeFileSync(p, '0123456789abcdef');
  let fd;
  {
    await using fh = await fs.promises.open(p, 'r');
    fd = fh.fd;
    out.push(typeof fh[Symbol.asyncDispose]);
    out.push((await fh.stat()).size);
    const buf = Buffer.alloc(6);
    const { bytesRead } = await fh.read(buf, 0, 6, 10);
    out.push(bytesRead, buf.toString('utf8'));
  }
  try { fs.fstatSync(fd); out.push('still-open'); } catch (e) { out.push(e.code); }
  console.log(JSON.stringify(out));
})();
`;

test('fs.promises.open FileHandle supports await using vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-adisp-'));
  const f = path.join(base, 'adisp.cjs');
  fs.writeFileSync(f, AWAIT_USING_PROG);
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-adisp-node-'));
  const tjsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-adisp-tjs-'));
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f, nodeDir], { encoding: 'utf8' }).trim();
  const r = runLoader(f, [tjsDir]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), ['function', 16, 6, 'abcdef', 'EBADF']);
});

// writeFileSync string-encoding honesty: a STRING data arg must honor its
// encoding. Default (and 'utf8') is UTF-8; 'latin1'/'binary' byte-encodes
// (charCode & 0xff), so bytes >= 0x80 survive instead of being UTF-8-mangled.
const WRITE_LATIN1_PROG = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
// A latin1 string with code points >= 0x80 (each must land as ONE byte).
const s = String.fromCharCode(0, 65, 0x80, 0xa0, 0xc0, 0xff, 200);
const p = path.join(dir, 'l1-write.bin');
fs.writeFileSync(p, s, 'latin1');
const raw = fs.readFileSync(p); // bytes
console.log(JSON.stringify({ bytes: Array.from(raw), len: raw.length }));
`;

test('fs.writeFileSync string honors latin1 encoding vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-wl1-'));
  const f = path.join(base, 'wl1.cjs');
  fs.writeFileSync(f, WRITE_LATIN1_PROG);
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-wl1-node-'));
  const tjsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-wl1-tjs-'));
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f, nodeDir], { encoding: 'utf8' }).trim();
  const r = runLoader(f, [tjsDir]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), {
    bytes: [0, 65, 0x80, 0xa0, 0xc0, 0xff, 200], len: 7,
  });
});

test('fs.writeFileSync string with an unimplemented encoding fails loud', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-wenc-'));
  const f = path.join(base, 'wenc.cjs');
  fs.writeFileSync(f, `
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.argv[2], 'x.bin'), 'zzz', 'ucs2');
`);
  const r = runLoader(f, [base]);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /node-shim: fs\.writeFileSync encoding 'ucs2' not implemented/);
});

test('fs.readFileSync latin1 + Buffer.from latin1 round-trip vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-latin1-'));
  const f = path.join(base, 'l1.cjs');
  fs.writeFileSync(f, LATIN1_PROG);
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-l1-node-'));
  const tjsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-l1-tjs-'));
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f, nodeDir], { encoding: 'utf8' }).trim();
  const r = runLoader(f, [tjsDir]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), {
    typeofRead: 'string', len: 512, cp0: 0, cp200: 200, cp255: 255,
    roundTripLen: 512, roundTripEqual: true,
  });
});

// A no-encoding read MUST return a real Buffer, not a bare Uint8Array. CC reads
// bytes then calls Buffer methods (.toString('hex') for hashes/ids, .readUInt8/
// .readUInt32BE for binary/image parsing, Buffer.isBuffer for type dispatch). A
// Uint8Array is duck-close enough to pass smoke but silently wrong: .toString('hex')
// decimal-joins, .readUInt8 is undefined — no wall, no throw. Covers readFileSync,
// fd readSync's own path is separate; here the SYNC + PROMISES no-encoding returns.
// A1-audit finding #1 (2026-07-15). Diffs node vs the shim.
const BUFRET_PROG = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
(async () => {
  const p = path.join(dir, 'bytes.bin');
  fs.writeFileSync(p, Buffer.from([0x61, 0x62, 0x63, 0xff, 0x00]));
  const out = {};
  const b = fs.readFileSync(p);                       // no encoding
  out.syncIsBuffer = Buffer.isBuffer(b);
  out.syncHex = b.toString('hex');
  out.syncReadUInt8 = typeof b.readUInt8 === 'function' ? b.readUInt8(3) : 'no-fn';
  out.syncSliceIsBuffer = Buffer.isBuffer(b.slice(0, 2));
  const pb = await fs.promises.readFile(p);           // no encoding (promises)
  out.promIsBuffer = Buffer.isBuffer(pb);
  out.promHex = pb.toString('hex');
  console.log(JSON.stringify(out));
})();
`;

test('fs no-encoding reads return a real Buffer vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-bufret-'));
  const f = path.join(base, 'bufret.cjs');
  fs.writeFileSync(f, BUFRET_PROG);
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-bufret-node-'));
  const tjsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-bufret-tjs-'));
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f, nodeDir], { encoding: 'utf8' }).trim();
  const r = runLoader(f, [tjsDir]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), {
    syncIsBuffer: true, syncHex: '616263ff00', syncReadUInt8: 255,
    syncSliceIsBuffer: true, promIsBuffer: true, promHex: '616263ff00',
  });
});
