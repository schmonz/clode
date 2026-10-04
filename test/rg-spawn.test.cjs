'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const cp = require('node:child_process');
const bun = require('../libexec/bun-shim.cjs');
const { _rgTranslate } = bun;
const { tjsPath, runLoader } = require('./node-shim-helper.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');
const { writeFakeUgrep } = require('./rg-fake-ugrep.cjs');

const REPO = path.resolve(__dirname, '..');
const SHIM = path.join(REPO, 'libexec', 'bun-shim.cjs');

function withStubUgrep(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-spawn-'));
  const ugrep = path.join(dir, 'ugrep');
  fs.writeFileSync(ugrep, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prev = process.env.CLODE_UGREP; process.env.CLODE_UGREP = ugrep;
  try { return fn(ugrep); } finally {
    if (prev === undefined) delete process.env.CLODE_UGREP; else process.env.CLODE_UGREP = prev;
  }
}

test('_rgTranslate: an rg search is translated to ugrep with the translated argv', () => {
  withStubUgrep((ugrep) => {
    assert.deepStrictEqual(_rgTranslate(['-n', 'foo']),
      { argv: [ugrep, '-r', '--ignore-files', '-I', '-n', 'foo'] });
  });
});

test('_rgTranslate: an rg-only flag is a refusal naming the flag, never an argv', () => {
  withStubUgrep(() => {
    const t = _rgTranslate(['--json', 'foo', '.']);
    assert.strictEqual(t.argv, undefined);
    assert.strictEqual(t.flag, '--json');
    assert.match(t.refuse, /--json/);
  });
});

// CHANGED 2026-08-21, and again 2026-09-28. It first asserted the argv was left
// UNTOUCHED when ugrep was missing, so the app's not-found fallback would engage: a host
// that happened to HAVE ripgrep then ran it. Then it asserted an argv that cannot
// resolve (`clode-rg-unavailable`): no host rg, but the app's not-found fallback told the
// MODEL "ripgrep not found on PATH. Install it", which is the one remedy quaude refuses on
// purpose (rg cannot run everywhere quaude does). Now the missing applet is a refusal like
// any other: a synthesized failed child, rc 2, naming ugrep, never ripgrep.
test('_rgTranslate: applet absent is a refusal naming the applet, never a host rg', () => {
  const prev = process.env.CLODE_UGREP; delete process.env.CLODE_UGREP;
  const prevPath = process.env.PATH; process.env.PATH = '/nonexistent';
  try {
    const t = _rgTranslate(['foo']);
    assert.strictEqual(t.argv, undefined, 'must not hand back an argv a host rg could satisfy');
    assert.match(t.refuse, /ugrep/);
    assert.doesNotMatch(t.refuse, /ripgrep/i);
  } finally {
    if (prev !== undefined) process.env.CLODE_UGREP = prev; process.env.PATH = prevPath;
  }
});

// These drive the REAL spawn path against an executable ugrep stub — a `#!/bin/sh`
// script, which Windows cannot exec (no shebang, no chmod bit). The logic itself is
// OS-agnostic; only this harness (a shell-script stub) is POSIX-only. The unit rows above
// run everywhere.
const posixExec = { skip: process.platform === 'win32' ? 'needs an executable /bin/sh ugrep stub' : false };

test('rg spawn.sync: ugrep usage error (exit >=2) surfaces a clode diagnostic + /doctor', posixExec, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-skew-'));
  const ugrep = path.join(dir, 'ugrep');
  fs.writeFileSync(ugrep, '#!/bin/sh\necho "ugrep: unknown option" >&2\nexit 2\n', { mode: 0o755 });
  const prev = process.env.CLODE_UGREP; process.env.CLODE_UGREP = ugrep;
  const origErr = process.stderr.write; let buf = '';
  process.stderr.write = (s) => { buf += s; return true; };
  try {
    // rg --files still goes through today's translation (the plan's Task 10 takes it over)
    bun.spawnSync(['rg', '--files', '--glob', 'surface-unique-xyz', '.']);
  } finally {
    process.stderr.write = origErr;
    if (prev === undefined) delete process.env.CLODE_UGREP; else process.env.CLODE_UGREP = prev;
  }
  assert.match(buf, /rg.*ugrep/i);
  assert.ok(globalThis.__clodeDoctor && Array.isArray(globalThis.__clodeDoctor.appletSkew));
  assert.ok(globalThis.__clodeDoctor.appletSkew.some((f) => f.name === 'rg'));
});

test('rg spawn.sync: ugrep exit 1 (no match) does NOT surface', posixExec, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-nomatch-'));
  const ugrep = path.join(dir, 'ugrep');
  fs.writeFileSync(ugrep, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const prev = process.env.CLODE_UGREP; process.env.CLODE_UGREP = ugrep;
  const origErr = process.stderr.write; let buf = '';
  process.stderr.write = (s) => { buf += s; return true; };
  try { bun.spawnSync(['rg', '--files', '--glob', 'nomatch-unique-xyz', '.']); }
  finally {
    process.stderr.write = origErr;
    if (prev === undefined) delete process.env.CLODE_UGREP; else process.env.CLODE_UGREP = prev;
  }
  assert.doesNotMatch(buf, /surface/);
});

test('_rgTranslate: CLODE_RG_DEBUG logs the rewrite; unset is silent', () => {
  withStubUgrep(() => {
    const origErr = process.stderr.write; let buf = '';
    process.stderr.write = (s) => { buf += s; return true; };
    const prev = process.env.CLODE_RG_DEBUG;
    try {
      delete process.env.CLODE_RG_DEBUG;
      _rgTranslate(['foo']);
      assert.doesNotMatch(buf, /rg-debug/);
      process.env.CLODE_RG_DEBUG = '1';
      _rgTranslate(['bar']);
      assert.match(buf, /rg-debug:/);
    } finally {
      process.stderr.write = origErr;
      if (prev === undefined) delete process.env.CLODE_RG_DEBUG; else process.env.CLODE_RG_DEBUG = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// EVERY SURFACE, BY BASENAME. A host rg is never run.
//
// The bundle finds rg as `Bun.which('rg') ?? 'rg'` (2.1.283's `nm`/`bQ`), and Bun.which
// answers an ABSOLUTE path whenever an rg is on PATH. The interception used to match only
// `file === 'rg'`, so on any host with ripgrep installed every Grep and Glob call ran the
// HOST's rg (measured 2026-09-27, report-grep.md: a stub rg on PATH answered the Grep tool
// with its own output). Now any file whose basename is rg is answered by quaude's rg
// (libexec/rg-native.cjs), on each of the six surfaces the bundle can reach it through:
// child_process execFile, execFileSync, spawn and spawnSync (node-shim's under quaude,
// node's under naude: bun-shim wraps whichever object `require('child_process')` is), and
// Bun.spawn / Bun.spawnSync.
//
// The probe runs every surface with the rg spelled three ways: an ABSOLUTE host rg (what
// Bun.which returns), a bare `rg` with that host rg first on PATH, and a Windows-style
// `rg.exe` leaf. The stand-in host rg prints HOST-RG-CALLED; ugrep is test/rg-fake-ugrep.cjs (a
// stand-in that answers quaude's rg as ugrep 7.8.2 does), and the search is `rg -n needle tree`
// over one file, so each answer must be rg's own (`tree/a.txt:1:x needle`), and none the host's.
const SURFACES = ['execFile', 'execFileSync', 'spawn', 'spawnSync', 'Bun.spawn', 'Bun.spawnSync'];

function surfacesProbe(rgs, args) {
  return `
    process.chdir(__dirname);   // the engine's loader is not handed a cwd (node-shim-helper runLoader)
    const Bun = require(${JSON.stringify(SHIM)});
    const cp = require('child_process');
    const RGS = ${JSON.stringify(rgs)};
    const ARGS = ${JSON.stringify(args)};
    const txt = (b) => (b == null ? '' : Buffer.isBuffer(b) ? b.toString('utf8') : String(b));
    const collect = (s) => new Promise((res) => {
      if (!s) { res(''); return; }
      let o = ''; s.on('data', (d) => { o += txt(d); }); s.on('end', () => res(o));
    });
    async function one(rg) {
      const r = {};
      r.execFile = await new Promise((res) => cp.execFile(rg, ARGS, { encoding: 'utf8' },
        (err, so, se) => res({ status: err ? err.code : 0, out: txt(so), err: txt(se) })));
      try { r.execFileSync = { status: 0, out: txt(cp.execFileSync(rg, ARGS, { encoding: 'utf8', stdio: 'pipe' })), err: '' }; }
      catch (e) { r.execFileSync = { status: e.status, out: txt(e.stdout), err: txt(e.stderr) || String(e.code || '') }; }
      r.spawn = await new Promise((res) => {
        const c = cp.spawn(rg, ARGS);
        const both = Promise.all([collect(c.stdout), collect(c.stderr)]);
        c.on('error', (e) => res({ status: null, out: '', err: String(e.code || e.message) }));
        c.on('close', (code) => both.then(([o, e]) => res({ status: code, out: o, err: e })));
      });
      const s = cp.spawnSync(rg, ARGS, { encoding: 'utf8' });
      r.spawnSync = { status: s.status, out: txt(s.stdout), err: txt(s.stderr) || (s.error ? String(s.error.code) : '') };
      try {
        const b = Bun.spawn([rg, ...ARGS]);
        const [o, e] = await Promise.all([collect(b.stdout), collect(b.stderr)]);
        r['Bun.spawn'] = { status: await b.exited, out: o, err: e };
      } catch (e) { r['Bun.spawn'] = { status: null, out: '', err: String(e.message) }; }
      const bs = Bun.spawnSync([rg, ...ARGS]);
      r['Bun.spawnSync'] = { status: bs.exitCode, out: txt(bs.stdout), err: txt(bs.stderr) };
      return r;
    }
    (async () => {
      const out = {};
      for (const rg of RGS) out[rg] = await one(rg);
      process.stdout.write('PROBE:' + JSON.stringify(out) + '\\n');
    })();
  `;
}

// A host rg that must never run, a stand-in ugrep that prints its argv, and the three
// spellings of rg the probe drives. `hostRgOnly` leaves ugrep out entirely.
function stubs({ hostRgOnly = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-surfaces-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const hostRg = path.join(bin, 'rg');
  fs.writeFileSync(hostRg, '#!/bin/sh\necho HOST-RG-CALLED "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'rg.exe'), '#!/bin/sh\necho HOST-RG-CALLED "$@"\n', { mode: 0o755 });
  const ugrep = writeFakeUgrep(dir);
  fs.mkdirSync(path.join(dir, 'tree'));
  fs.writeFileSync(path.join(dir, 'tree', 'a.txt'), 'x needle\n');
  const env = { ...process.env, PATH: hostRgOnly ? bin : `${bin}${path.delimiter}${process.env.PATH}`,
    CLODE_UGREP: hostRgOnly ? '' : ugrep, CLODE_BFS: '' };
  delete env.CLODE_RG_DEBUG;
  return { dir, bin, hostRg, env, rgs: [hostRg, 'rg', path.join(bin, 'rg.exe')] };
}

function parseProbe(r) {
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('PROBE:'));
  assert.ok(line, `the probe printed no result (exit ${r.status}):\n${(r.stderr || '').slice(0, 1500)}`);
  return JSON.parse(line.slice('PROBE:'.length));
}

// THE GATE, as two guards (one per engine): read() runs the probe, scan() judges each
// (rg spelling, surface) pair, so `examined` is the 18 pairs and a pair the probe never
// answered is a finding, not a silent pass. The verdict on one pair: the host rg must not
// have run, and the answer must be exactly quaude's rg's (rc 0, native's line for that file).
const UGREP_ANSWER = /^tree\/a\.txt:1:x needle\n$/;
const SURFACE_PAIRS = 3 * SURFACES.length;

function scanSurfaces({ got, rgs, engine }) {
  const findings = [];
  let examined = 0;
  for (const rg of rgs) {
    for (const s of SURFACES) {
      const a = got[rg] && got[rg][s];
      if (!a) { findings.push(`${s}(${rg}): the probe gave no answer for this pair`); continue; }
      examined++;
      if (/HOST-RG-CALLED/.test(a.out + a.err)) findings.push(`${s}(${rg}) ran the HOST rg`);
      else if (a.status !== 0 || !UGREP_ANSWER.test(a.out)) {
        findings.push(`${s}(${rg}) was not answered by quaude's rg: ${JSON.stringify(a)}`);
      }
    }
  }
  return { findings, examined, note: `${rgs.length} spellings of rg x ${SURFACES.length} surfaces under ${engine}` };
}

// Every pair answered by the stand-in ugrep, except ONE that the host rg answered: the
// exact defect this gate exists for (an absolute rg, which Bun.which hands the bundle).
function controlSurfaces() {
  const rgs = ['/opt/pkg/bin/rg', 'rg', 'C:\\tools\\rg.exe'];
  const got = {};
  for (const rg of rgs) {
    got[rg] = {};
    for (const s of SURFACES) got[rg][s] = { status: 0, out: 'tree/a.txt:1:x needle\n', err: '' };
  }
  got[rgs[0]].execFile = { status: 0, out: 'HOST-RG-CALLED -n needle .\n', err: '' };
  return { got, rgs, engine: 'a synthetic control' };
}

function readSurfaces(run, engine) {
  const s = stubs();
  try {
    const prog = path.join(s.dir, 'probe.cjs');
    fs.writeFileSync(prog, surfacesProbe(s.rgs, ['-n', 'needle', 'tree']));
    const r = run(prog, s);
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('PROBE:'));
    if (!line) throw new Error(`the ${engine} probe printed no result (exit ${r.status}):\n${(r.stderr || '').slice(0, 1500)}`);
    return { got: JSON.parse(line.slice('PROBE:'.length)), rgs: s.rgs, engine };
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
}

guardTests(defineGuard({
  name: 'rg-every-surface-node', floor: SURFACE_PAIRS, scan: scanSurfaces, control: controlSurfaces,
  read: () => (process.platform === 'win32' ? { skip: 'needs an executable /bin/sh ugrep stub' }
    : readSurfaces((prog, s) => cp.spawnSync(process.execPath, [prog], { encoding: 'utf8', env: s.env, cwd: s.dir }),
      'node')),
}));

// The same claim under the engine quaude ships: there `require('child_process')` is
// node-shim's module, which is the object bun-shim wraps.
guardTests(defineGuard({
  name: 'rg-every-surface-tjs', floor: SURFACE_PAIRS, scan: scanSurfaces, control: controlSurfaces,
  read: () => (process.platform === 'win32' ? { skip: 'needs an executable /bin/sh ugrep stub' }
    : !tjsPath() ? { skip: 'no tjs engine (set CLODE_TJS)' }
      : readSurfaces((prog, s) => runLoader(prog, [], { timeout: 120000,
        env: { ...s.env, NODE_PATH: path.join(REPO, 'deps', 'claude', 'node_modules') } }), 'tjs (node-shim\'s child_process)')),
}));

// ---------------------------------------------------------------------------
// THE HONEST REFUSAL. When quaude's rg cannot give native's answer, it says so, as a
// failed child: rc 2, the flag and the reason on stderr, no output. It never falls
// through to a host rg, and it never tells anyone to install ripgrep.
//
// The spelling is rg-native.cjs's (REFUSAL_LINE), read back here only through its
// parseRgRefusal. That the bundle's consumer shows it to the model as an error, and not as
// "no results", is judged against the consumer's own regex, read from the pinned carve:
// test/build-gates/rg-probe-gates.test.cjs. No copy of that regex lives in a test.
const { parseRgRefusal } = require('../libexec/rg-native.cjs');

function assertRefused(a, what, flagOrApplet) {
  assert.doesNotMatch(a.out + a.err, /HOST-RG-CALLED/, `${what} ran the HOST rg`);
  assert.strictEqual(a.status, 2, `${what}: not rc 2: ${JSON.stringify(a)}`);
  assert.strictEqual(a.out, '', `${what}: a refusal prints nothing on stdout`);
  assert.ok(parseRgRefusal(a.err), `${what}: not quaude's refusal: ${JSON.stringify(a.err)}`);
  assert.ok(a.err.includes(flagOrApplet), `${what}: the refusal does not name ${flagOrApplet}: ${JSON.stringify(a.err)}`);
  assert.doesNotMatch(a.err, /ripgrep/i, `${what}: a refusal never points at ripgrep`);
  assert.doesNotMatch(a.err, /install (it|rg)\b/i, `${what}: a refusal never says to install rg`);
}

test('a refusal is a failed child: rc 2, the flag and the reason on stderr, never ripgrep (every surface)', posixExec, () => {
  const s = stubs();
  const prog = path.join(s.dir, 'probe.cjs');
  // --pcre2: a flag quaude's rg refuses by name (PCRE2 is not rg's default engine, nor emulated)
  fs.writeFileSync(prog, surfacesProbe(s.rgs, ['--pcre2', 'needle', '.']));
  const got = parseProbe(cp.spawnSync(process.execPath, [prog], { encoding: 'utf8', env: s.env, cwd: s.dir }));
  for (const rg of s.rgs) for (const surf of SURFACES) assertRefused(got[rg][surf], `${surf}(${rg})`, '--pcre2');
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('no ugrep on this host: every rg is refused naming ugrep, and the host rg still never runs', posixExec, () => {
  const s = stubs({ hostRgOnly: true });
  const prog = path.join(s.dir, 'probe.cjs');
  fs.writeFileSync(prog, surfacesProbe(s.rgs, ['-n', 'needle', '.']));
  const got = parseProbe(cp.spawnSync(process.execPath, [prog], { encoding: 'utf8', env: s.env, cwd: s.dir }));
  for (const rg of s.rgs) for (const surf of SURFACES) assertRefused(got[rg][surf], `${surf}(${rg})`, 'ugrep');
  fs.rmSync(s.dir, { recursive: true, force: true });
});

// ugrep rejecting a translated call (rc >= 2, nothing printed) is a refusal too: the Grep
// tool's `--max-columns 500` made ugrep do exactly that, and the model read the rc 2 as "No
// files found" in every files and count call (report-grep.md). A search is quaude's rg's own now
// (--max-columns: RG-MAX-COLUMNS, test/rg-native.test.cjs); `rg --files` still goes through the
// translation until the plan's Task 10, so it carries the claim.
test('ugrep rejecting the translation reaches the caller as a refusal naming what ugrep said', posixExec, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-rejected-'));
  const ugrep = path.join(dir, 'ugrep');
  fs.writeFileSync(ugrep, '#!/bin/sh\necho "ugrep: invalid option --frobnicate" >&2\nexit 2\n', { mode: 0o755 });
  const prev = process.env.CLODE_UGREP; process.env.CLODE_UGREP = ugrep;
  const origErr = process.stderr.write;
  process.stderr.write = () => true;
  let r;
  try { r = cp.spawnSync('rg', ['--files', '--glob', 'rejected-unique', '.'], { encoding: 'utf8' }); }
  finally {
    process.stderr.write = origErr;
    if (prev === undefined) delete process.env.CLODE_UGREP; else process.env.CLODE_UGREP = prev;
  }
  assertRefused({ status: r.status, out: r.stdout, err: r.stderr }, 'spawnSync(rg)', 'invalid option --frobnicate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rgRefusal: rc 2, nothing on stdout, the flag and reason on stderr; parseRgRefusal reads it back', () => {
  const { rgRefusal } = require('../libexec/rg-native.cjs');
  const r = rgRefusal('quaude answers rg with x', { flag: '--json' });
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.stdout.length, 0);
  assert.strictEqual(r.stderr.toString('utf8'), 'rg: error parsing flag --json: quaude answers rg with x\n');
  assert.deepStrictEqual(parseRgRefusal(r.stderr), { flag: '--json', reason: 'quaude answers rg with x' });
  assert.deepStrictEqual(parseRgRefusal(rgRefusal('quaude answers rg: why').stderr), { flag: null, reason: 'quaude answers rg: why' });
  // native's own usage error shares the prefix and is not quaude's refusal
  assert.strictEqual(parseRgRefusal('rg: error parsing flag --max-columns: value is not a valid number'), null);
});

// ---------------------------------------------------------------------------
// THE ASYNC SURFACES STAY ASYNC. execFile, spawn and Bun.spawn run quaude's rg WITHOUT
// blocking the event loop, and the caller's bounds still end it: an AbortSignal, kill(), a
// timeout, a maxBuffer. The 2.1.283 bundle relies on each: the startup file-count prewarm
// passes AbortSignal.timeout(3000), Esc aborts a Grep, the file-suggestion spawn (dTo) aborts
// after 5 s, and the Grep/Glob consumer (oX) reads ERR_CHILD_PROCESS_STDIO_MAXBUFFER as
// "output passed the limit" (any kill it reads as "timed out after 20 seconds"). A search run
// synchronously inside the shim (as quaude's rg first did) honours none of them.
//
// BOTH ROUTES are held to it: a SEARCH, which quaude's rg answers itself over ugrep children
// (`rg needle tree`: the fake ugrep, test/rg-fake-ugrep.cjs, sleeping in its walk), and what still
// goes through today's translation to an applet (`rg --files .`: a stand-in that sleeps). Each bound
// must end the search in well under the sleep, and a 20 ms interval must keep ticking meanwhile.
// Target `-` (the bundle pipes a task-output file into rg's stdin) is a search: what the caller
// writes reaches it, and rg's answer for it comes back. A third stand-in, and a big tree, print more
// than a small maxBuffer.
const SLOW_S = 6;
const ROUTES = { search: ['needle', 'tree'], translated: ['--files', '.'] };
const BIG_ARGS = { search: ['needle', 'big'], translated: ['--files', '.'] };
function asyncProbe() {
  return `
    process.chdir(__dirname);   // the engine's loader is not handed a cwd (node-shim-helper runLoader)
    const Bun = require(${JSON.stringify(SHIM)});
    const cp = require('child_process');
    const txt = (b) => (b == null ? '' : Buffer.isBuffer(b) ? b.toString('utf8') : String(b));
    const out = {};
    let ticks = 0; const iv = setInterval(() => { ticks++; }, 20);
    const timed = async (name, f) => { const t0 = Date.now(), k0 = ticks; const r = await f(); out[name] = { ...r, ms: Date.now() - t0, ticks: ticks - k0 }; };
    // quaude's rg picks its ugrep from THIS process's CLODE_UGREP when the call is made.
    const env = (u) => { process.env.CLODE_UGREP = u; return process.env; };
    const ROUTES = ${JSON.stringify(ROUTES)}, BIG_ARGS = ${JSON.stringify(BIG_ARGS)};
    const slowUgrep = { search: process.env.FAKE, translated: process.env.SLOW };
    const bigUgrep = { search: process.env.FAKE, translated: process.env.BIG };
    (async () => {
      for (const route of ['search', 'translated']) {
        const A = ROUTES[route], U = slowUgrep[route];
        process.env.FAKE_UGREP_SLOW_MS = String(${SLOW_S * 1000});
        await timed(route + ' execFile+AbortSignal', () => new Promise((res) => {
          const ac = new AbortController(); setTimeout(() => ac.abort(), 300);
          cp.execFile('rg', A, { env: env(U), signal: ac.signal }, (err) => res({ name: err && err.name, code: err && err.code }));
        }));
        await timed(route + ' execFile+timeout', () => new Promise((res) => {
          cp.execFile('rg', A, { env: env(U), timeout: 300, killSignal: 'SIGKILL' }, (err) => res({ killed: err && err.killed, signal: err && err.signal }));
        }));
        await timed(route + ' spawn+kill', () => new Promise((res) => {
          const c = cp.spawn('rg', A, { env: env(U) });
          setTimeout(() => c.kill('SIGKILL'), 300);
          c.on('close', (code, signal) => res({ code, signal }));
        }));
        await timed(route + ' Bun.spawn+kill', async () => {
          env(U);
          const b = Bun.spawn(['rg', ...A]);
          setTimeout(() => b.kill('SIGKILL'), 300);
          return { exited: await b.exited };
        });
        delete process.env.FAKE_UGREP_SLOW_MS;
        await timed(route + ' execFile maxBuffer', () => new Promise((res) => {
          cp.execFile('rg', BIG_ARGS[route], { env: env(bigUgrep[route]), maxBuffer: 1000 },
            (err, so) => res({ code: err && err.code, message: err && err.message, len: txt(so).length }));
        }));
      }
      await timed('execFile stdin', () => new Promise((res) => {
        const c = cp.execFile('rg', ['-n', 'needle', '-'], { env: env(process.env.FAKE) },
          (err, so) => res({ err: err && err.message, out: txt(so) }));
        c.stdin.end('piped needle\\n');
      }));
      const s = cp.spawnSync('rg', ['-n', 'needle', '-'], { env: env(process.env.FAKE), input: 'sync needle\\n' });
      out['spawnSync input'] = { out: txt(s.stdout) };
      clearInterval(iv);
      process.stdout.write('PROBE:' + JSON.stringify(out) + '\\n');
    })();
  `;
}

function asyncStubs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-async-'));
  const w = (n, body) => { const p = path.join(dir, n); fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return p; };
  fs.mkdirSync(path.join(dir, 'tree'));
  fs.writeFileSync(path.join(dir, 'tree', 'a.txt'), 'x needle\n');
  fs.mkdirSync(path.join(dir, 'big'));
  fs.writeFileSync(path.join(dir, 'big', 'b.txt'), 'aaaaaaaaaaaaaaaaaaaa needle\n'.repeat(2000));
  return { dir, env: { ...process.env, SLOW: w('slow-ugrep', `exec sleep ${SLOW_S}`), FAKE: writeFakeUgrep(dir, 'fake-ugrep'),
    BIG: w('big-ugrep', 'i=0; while [ $i -lt 2000 ]; do echo "aaaaaaaaaaaaaaaaaaaa needle"; i=$((i+1)); done') } };
}

function assertAsyncSurfaces(got) {
  const quick = SLOW_S * 1000 / 2;
  for (const route of ['search', 'translated']) {
    for (const k of ['execFile+AbortSignal', 'execFile+timeout', 'spawn+kill', 'Bun.spawn+kill'].map((x) => `${route} ${x}`)) {
      const a = got[k];
      assert.ok(a, `${k}: no answer`);
      assert.ok(a.ms < quick, `${k}: the bound did not end the search (${a.ms} ms; the stand-in sleeps ${SLOW_S} s): ${JSON.stringify(a)}`);
      assert.ok(a.ticks >= 5, `${k}: the event loop did not turn while rg ran (${a.ticks} ticks in ${a.ms} ms)`);
    }
    assert.strictEqual(got[`${route} execFile+AbortSignal`].name, 'AbortError');
    assert.strictEqual(got[`${route} execFile+timeout`].killed, true);
    assert.strictEqual(got[`${route} execFile+timeout`].signal, 'SIGKILL');
    assert.strictEqual(got[`${route} spawn+kill`].signal, 'SIGKILL');
    assert.strictEqual(got[`${route} execFile maxBuffer`].code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', JSON.stringify(got[`${route} execFile maxBuffer`]));
  }
  // native 2.1.283's embedded rg, for these two (rg -n needle -, one line piped in)
  assert.strictEqual(got['execFile stdin'].out, '1:piped needle\n', 'what the caller wrote to stdin must be what rg searched');
  assert.strictEqual(got['spawnSync input'].out, '1:sync needle\n', 'spawnSync input must be what rg searched');
}

test('the async rg surfaces do not block the loop, and abort/kill/timeout/maxBuffer/stdin behave as node (node)', posixExec, () => {
  const s = asyncStubs();
  try {
    const prog = path.join(s.dir, 'probe.cjs');
    fs.writeFileSync(prog, asyncProbe());
    const r = cp.spawnSync(process.execPath, [prog], { encoding: 'utf8', env: s.env, cwd: s.dir, timeout: 120000 });
    assertAsyncSurfaces(parseProbe(r));
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('the async rg surfaces do not block the loop, and abort/kill/timeout/maxBuffer/stdin behave as node (tjs)', {
  skip: process.platform === 'win32' ? 'needs an executable /bin/sh ugrep stub' : !tjsPath() ? 'no tjs engine (set CLODE_TJS)' : false,
}, () => {
  const s = asyncStubs();
  try {
    const prog = path.join(s.dir, 'probe.cjs');
    fs.writeFileSync(prog, asyncProbe());
    const r = runLoader(prog, [], { timeout: 120000, env: { ...s.env, NODE_PATH: path.join(REPO, 'deps', 'claude', 'node_modules') } });
    assertAsyncSurfaces(parseProbe(r));
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

// THE CHILD'S BOOKKEEPING, AS NODE KEEPS IT (Task 4 review, N1 + N2).
// N1: node's spawn removes its 'abort' listener when the child exits. The 2.1.283 Grep tool
// passes the tool context's ONE AbortSignal to every rg it runs, so a listener left behind per
// call (each closure holding its child and its buffered stdout, up to the 20 MB maxBuffer) is
// a leak that grows with every search of a session. N searches on one signal must leave none.
// N2: node sets child.killed only when kill() actually delivered the signal. A kill() after
// the applet exited (before 'close') delivers nothing, so the child must not read as killed,
// and the applet's rc-2 rejection must still become quaude's refusal.
const N_CALLS = 15;
function bookkeepingProbe() {
  return `
    process.chdir(__dirname);   // the engine's loader is not handed a cwd (node-shim-helper runLoader)
    const Bun = require(${JSON.stringify(SHIM)});
    const cp = require('child_process');
    const { rgSpawn, parseRgRefusal } = require(${JSON.stringify(path.join(REPO, 'libexec', 'rg-native.cjs'))});
    const { EventEmitter } = require('events');
    const { Readable } = require('stream');
    const out = {};
    const tick = () => new Promise((r) => setTimeout(r, 5));
    (async () => {
      // N1: count the abort listeners on ONE signal, by watching add/remove on it.
      process.env.CLODE_UGREP = process.env.FAST;
      const ac = new AbortController(), sig = ac.signal, held = new Set();
      const add = sig.addEventListener.bind(sig), rm = sig.removeEventListener.bind(sig);
      sig.addEventListener = (t, f, o) => { if (t === 'abort') held.add(f); return add(t, f, o); };
      sig.removeEventListener = (t, f, o) => { if (t === 'abort') held.delete(f); return rm(t, f, o); };
      const run = (args) => new Promise((res) => cp.execFile('rg', args, { signal: sig, maxBuffer: 20000000 }, (err, so) => res({ err: err && err.code, so })));
      const answers = [];
      for (let i = 0; i < ${N_CALLS}; i++) answers.push(await run(['needle', 'tree']));
      for (let i = 0; i < 3; i++) answers.push(await run(['--pcre2', 'needle', '.']));   // refused: no process
      await tick();
      out.n1 = { calls: answers.length, listeners: held.size, answered: answers.filter((a) => /needle/.test(String(a.so))).length };
      // N2: a fake applet that has EXITED (rc 2, nothing printed) when kill() arrives.
      const applet = new EventEmitter();
      applet.stdout = new Readable({ read() {} }); applet.stderr = new Readable({ read() {} });
      applet.stdin = null; applet.pid = 4242;
      let gone = false; applet.kill = () => !gone;   // a process that is gone cannot be killed
      const child = rgSpawn(['--files', '.'], {}, { translate: () => ({ argv: ['ugrep', 'needle', '.'] }), spawn: () => applet });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      const closed = new Promise((res) => child.on('close', (code, signal) => res({ code, signal })));
      applet.stderr.push('ugrep: rejected\\n'); applet.stderr.push(null); applet.stdout.push(null);
      await tick();
      gone = true; applet.emit('exit', 2, null);
      const killRet = child.kill('SIGTERM');          // after exit, before close: delivers nothing
      applet.emit('close', 2, null);
      const c = await closed;
      out.n2 = { killRet, killed: child.killed, code: c.code, refusal: parseRgRefusal(err) };
      // ...and a kill that IS delivered marks the child killed, as node's does.
      const live = new EventEmitter();
      live.stdout = new Readable({ read() {} }); live.stderr = new Readable({ read() {} }); live.stdin = null; live.pid = 4243;
      live.kill = (s) => { setTimeout(() => { live.stdout.push(null); live.stderr.push(null); live.emit('exit', null, s); live.emit('close', null, s); }, 0); return true; };
      const c2 = rgSpawn(['--files', '.'], {}, { translate: () => ({ argv: ['ugrep', 'needle', '.'] }), spawn: () => live });
      c2.stdout.resume(); c2.stderr.resume();
      const closed2 = new Promise((res) => c2.on('close', (code, signal) => res({ code, signal })));
      const killRet2 = c2.kill('SIGKILL');
      out.n2live = { killRet: killRet2, killed: c2.killed, ...(await closed2) };
      process.stdout.write('PROBE:' + JSON.stringify(out) + '\\n');
    })();
  `;
}
function bookkeepingStubs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-book-'));
  // N1 searches (quaude's rg over the fake ugrep); N2 drives the translation's applet child, which
  // `rg --files` still takes (its stand-in applets are the probe's own).
  const fast = writeFakeUgrep(dir, 'fast-ugrep');
  fs.mkdirSync(path.join(dir, 'tree'));
  fs.writeFileSync(path.join(dir, 'tree', 'a.txt'), 'x needle\n');
  const prog = path.join(dir, 'probe.cjs');
  fs.writeFileSync(prog, bookkeepingProbe());
  return { dir, prog, env: { ...process.env, FAST: fast } };
}
function assertNoListenerLeft(got) {
  assert.strictEqual(got.n1.calls, N_CALLS + 3);
  assert.strictEqual(got.n1.answered, N_CALLS, `every search ran: ${JSON.stringify(got.n1)}`);
  assert.strictEqual(got.n1.listeners, 0, `${got.n1.calls} rg calls on one AbortSignal left ${got.n1.listeners} 'abort' listener(s) behind (node's spawn leaves none)`);
}
function assertKilledOnlyWhenDelivered(got) {
  assert.strictEqual(got.n2.killRet, false, 'kill() after the applet exited delivered nothing, so it must answer false');
  assert.strictEqual(got.n2.killed, false, 'a kill that delivered nothing must not mark the child killed (node sets killed only on success)');
  assert.strictEqual(got.n2.code, 2);
  assert.ok(got.n2.refusal, `the applet's rc-2 rejection must still become quaude's refusal: ${JSON.stringify(got.n2)}`);
  assert.deepStrictEqual(got.n2live, { killRet: true, killed: true, code: null, signal: 'SIGKILL' });
}
function runBookkeeping(engine) {
  const s = bookkeepingStubs();
  try {
    const r = engine === 'node'
      ? cp.spawnSync(process.execPath, [s.prog], { encoding: 'utf8', env: s.env, cwd: s.dir, timeout: 60000 })
      : runLoader(s.prog, [], { timeout: 60000, env: { ...s.env, NODE_PATH: path.join(REPO, 'deps', 'claude', 'node_modules') } });
    return parseProbe(r);
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
}
const tjsSkip = { skip: process.platform === 'win32' ? 'needs an executable /bin/sh ugrep stub' : !tjsPath() ? 'no tjs engine (set CLODE_TJS)' : false };

test('rg child: no abort listener outlives its search, N calls on one signal leave 0 (node)', posixExec, () => {
  assertNoListenerLeft(runBookkeeping('node'));
});
test('rg child: no abort listener outlives its search, N calls on one signal leave 0 (tjs)', tjsSkip, () => {
  assertNoListenerLeft(runBookkeeping('tjs'));
});
test('rg child: killed only when kill() delivered, so a late kill keeps the rc-2 refusal (node)', posixExec, () => {
  assertKilledOnlyWhenDelivered(runBookkeeping('node'));
});
test('rg child: killed only when kill() delivered, so a late kill keeps the rc-2 refusal (tjs)', tjsSkip, () => {
  assertKilledOnlyWhenDelivered(runBookkeeping('tjs'));
});

// isRgExe: every spelling a host's rg may take, on every OS (a pure check: no Windows box needed).
test('isRgExe: rg by basename, with any PATHEXT extension, either separator, a drive prefix; nothing else', () => {
  const { isRgExe } = require('../libexec/rg-native.cjs');
  for (const f of ['rg', '/opt/pkg/bin/rg', 'C:\\tools\\rg.exe', 'C:\\tools\\RG.EXE', 'C:rg', 'rg.cmd', 'D:\\x\\rg.bat',
    'C:/ProgramData/chocolatey/bin/rg.COM', 'a\\rg', '..\\bin\\rg.Cmd']) {
    assert.strictEqual(isRgExe(f), true, f);
  }
  for (const f of ['', 'rgx', 'xrg', '/a/rg/x', 'rg.sh', 'rg.exe.bak', 'C:\\rg\\ugrep.exe', 'rg.', null, undefined, 7]) {
    assert.strictEqual(isRgExe(f), false, String(f));
  }
});

// CLODE_RG_DEBUG: one parseable line per rg call (scripts/rg-inventory.mjs reads them), for the calls
// quaude's rg answers itself too: `=> quaude's rg over <ugrep>`, or `!! untranslatable <flag>`.
test('CLODE_RG_DEBUG: a search quaude\'s rg answers, and one it refuses, each print the parseable line', posixExec, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-debug-')));
  const ugrep = writeFakeUgrep(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'needle\n');
  const prev = { u: process.env.CLODE_UGREP, d: process.env.CLODE_RG_DEBUG };
  process.env.CLODE_UGREP = ugrep; process.env.CLODE_RG_DEBUG = '1';
  const origErr = process.stderr.write; let buf = '';
  process.stderr.write = (s) => { buf += s; return true; };
  try {
    bun.spawnSync(['rg', '-l', 'needle', dir]);
    bun.spawnSync(['rg', '-U', 'needle', dir]);
  } finally {
    process.stderr.write = origErr;
    for (const [k, v] of [['CLODE_UGREP', prev.u], ['CLODE_RG_DEBUG', prev.d]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // the shape rg-inventory.mjs parses: /^clode rg-debug: (rg .*?) (?:=>|!! needs (\S+)|!! untranslatable (\S+))(?:\s|$)/
  assert.ok(buf.split('\n').includes(`clode rg-debug: rg -l needle ${dir} => quaude's rg over ${ugrep}`), buf);
  assert.ok(buf.split('\n').includes(`clode rg-debug: rg -U needle ${dir} !! untranslatable -U`), buf);
});

// WHEN UGREP FAILS UNDER A SEARCH (Task 6 review I-2, I-3, M-3). quaude's rg walks in JS (grep-native
// Task 9, libexec/rg-walk.cjs) and runs ugrep for its match pass only, which has a legitimate rc 2 and a
// failing one:
//   - it exits 2 whenever it WARNS about a file it cannot read (ugrep 7.8.2, measured: one chmod-000
//     file is enough). That is rg's own per-path error (`rg: tree/locked.txt: Permission denied (os
//     error 13)`, the rest answered, exit 2), never skew: nothing reaches the operator's stderr or /doctor;
//   - a match pass that fails otherwise is ugrep failing: the CALLER gets quaude's refusal (the Grep tool
//     shows the model an error, where a bare rc 2 with no output reads as "No files found"), and the
//     operator hears which pass failed.
function withSearchStub(body, fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-fail-')));
  const fake = writeFakeUgrep(dir, 'fake-ugrep');
  const ugrep = path.join(dir, 'ugrep');
  fs.writeFileSync(ugrep, `#!/bin/sh\n${body}\nexec ${JSON.stringify(fake)} "$@"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'tree'));
  fs.writeFileSync(path.join(dir, 'tree', 'ok.txt'), 'needle\n');
  const prev = process.env.CLODE_UGREP; process.env.CLODE_UGREP = ugrep;
  const origErr = process.stderr.write; let said = '';
  process.stderr.write = (s) => { said += s; return true; };
  const doctor = () => ((globalThis.__clodeDoctor && globalThis.__clodeDoctor.appletSkew) || []).length;
  const before = doctor();
  try { return fn({ dir, ugrep, said: () => said, skews: () => doctor() - before }); } finally {
    process.stderr.write = origErr;
    if (prev === undefined) delete process.env.CLODE_UGREP; else process.env.CLODE_UGREP = prev;
    try { fs.chmodSync(path.join(dir, 'tree', 'locked.txt'), 0o644); } catch { /* none */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test('ugrep failing in the match pass, nothing printed: the caller gets a refusal naming it, the operator the pass', posixExec, () =>
  withSearchStub('for a in "$@"; do case "$a" in --format=*) echo "ugrep: error: simulated failure in the match pass" >&2; exit 2;; esac; done', (s) => {
    const r = cp.spawnSync('rg', ['-l', '--null', 'needle', 'tree'], { cwd: s.dir, encoding: 'utf8' });
    assert.strictEqual(r.status, 2);
    assert.strictEqual(r.stdout, '');
    const ref = parseRgRefusal(r.stderr);
    assert.ok(ref && /simulated failure in the match pass/.test(ref.reason), JSON.stringify(r.stderr));
    assert.match(s.said(), /ugrep exited 2 in quaude's rg's match pass/);
    assert.doesNotMatch(s.said(), /translated rg command/);
    assert.strictEqual(s.skews(), 1);
  }));
test('ugrep\'s warning about an unreadable file is rg\'s per-path error, never skew', {
  skip: posixExec.skip || ((process.getuid && process.getuid() === 0) ? 'root reads a chmod 000 file' : false),
}, () => withSearchStub('', (s) => {
  fs.writeFileSync(path.join(s.dir, 'tree', 'locked.txt'), 'needle\n');
  fs.chmodSync(path.join(s.dir, 'tree', 'locked.txt'), 0);
  const r = cp.spawnSync('rg', ['-c', '-H', '--null', 'needle', 'tree'], { cwd: s.dir, encoding: 'utf8' });
  // native 2.1.283's embedded rg, the same tree (measured: rc 2, the error, the rest answered)
  assert.deepStrictEqual([r.status, r.stdout, r.stderr], [2, 'tree/ok.txt\x001\n', 'rg: tree/locked.txt: Permission denied (os error 13)\n']);
  assert.strictEqual(parseRgRefusal(r.stderr), null);
  assert.strictEqual(s.said(), '', 'nothing reaches the operator: this is rg\'s answer, not skew');
  assert.strictEqual(s.skews(), 0);
}));
// THE WALK IS quaude's rg's OWN (grep-native Task 9): ugrep is never asked to list a directory, so a
// ugrep whose every listing fails changes nothing a search answers.
test('a search never asks ugrep to walk: a ugrep failing every -r listing changes nothing', posixExec, () =>
  withSearchStub('for a in "$@"; do case "$a" in -r) echo "ugrep: boom in a walk" >&2; exit 2;; esac; done', (s) => {
    fs.writeFileSync(path.join(s.dir, 'tree', 'b.txt'), 'needle\n');
    for (const argv of [['-l', '--null', 'needle', 'tree'], ['--hidden', '-c', '-H', '--null', 'needle', 'tree']]) {
      const r = cp.spawnSync('rg', argv, { cwd: s.dir, encoding: 'utf8' });
      assert.strictEqual(r.status, 0, JSON.stringify(r));
      const recs = (argv.includes('-c') ? r.stdout.split('\n') : r.stdout.split('\0')).filter(Boolean).sort();
      assert.deepStrictEqual(recs, argv.includes('-c') ? ['tree/b.txt\x001', 'tree/ok.txt\x001'] : ['tree/b.txt', 'tree/ok.txt']);
    }
    assert.strictEqual(s.said(), '');
    assert.strictEqual(s.skews(), 0);
  }));
// A PASS THAT FAILS PART WAY (Task 6 re-review N3). A ugrep that printed part of its answer and then
// failed for a reason that is not rg's own per-path error (an infrastructure failure: it died, ran out
// of memory, said something rg never says) must not hand the caller the part as if it were the whole:
// the Grep tool shows any rc-2 output to the model as the complete list. The caller gets quaude's
// refusal (TQ-matching) whatever was printed first. A per-path warning (`cannot read X: Permission
// denied`) is rg's own answer: that path's error, the rest of the pass answered, rc 2.
test('ugrep failing part way through the match pass, having printed some: the caller gets a refusal, never the part', posixExec, () =>
  withSearchStub('for a in "$@"; do case "$a" in --format=*) "$(dirname "$0")/fake-ugrep" "$@" | head -c 15; echo "ugrep: error: died midway" >&2; exit 2;; esac; done', (s) => {
    for (const f of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(s.dir, 'tree', f), 'needle\n');
    for (const argv of [['-l', '--null', 'needle', 'tree'], ['-c', '-H', '--null', 'needle', 'tree']]) {
      const r = cp.spawnSync('rg', argv, { cwd: s.dir, encoding: 'utf8' });
      assert.deepStrictEqual([r.status, r.stdout], [2, ''], JSON.stringify(r));
      const ref = parseRgRefusal(r.stderr);
      assert.ok(ref && /died midway/.test(ref.reason), JSON.stringify(r.stderr));
    }
    assert.match(s.said(), /ugrep exited 2 in quaude's rg's match pass/);
  }));
test('a per-path warning in the match pass is rg\'s error for that path, the rest answered, never a refusal or skew', posixExec, () =>
  withSearchStub('for a in "$@"; do case "$a" in --format=*) "$(dirname "$0")/fake-ugrep" "$@"; echo "ugrep: warning: cannot read tree/b.txt: Permission denied" >&2; exit 2;; esac; done', (s) => {
    fs.writeFileSync(path.join(s.dir, 'tree', 'b.txt'), 'nothing here\n');
    const r = cp.spawnSync('rg', ['-c', '-H', '--null', 'needle', 'tree'], { cwd: s.dir, encoding: 'utf8' });
    // as native answers a file it cannot read (RG-EXIT): the error, the rest, rc 2
    assert.deepStrictEqual([r.status, r.stdout, r.stderr], [2, 'tree/ok.txt\x001\n', 'rg: tree/b.txt: Permission denied (os error 13)\n']);
    assert.strictEqual(s.said(), '', 'rg\'s own answer, not skew');
    assert.strictEqual(s.skews(), 0);
  }));
