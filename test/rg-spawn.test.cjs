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
    bun.spawnSync(['rg', '--surface-unique-xyz', 'foo']);
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
  try { bun.spawnSync(['rg', '--nomatch-unique-xyz', 'foo']); }
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
// `rg.exe` leaf. The stand-in ugrep prints UGREP plus its argv; the stand-in host rg prints
// HOST-RG-CALLED. Each answer must be the stand-in ugrep's, and none the host's.
const SURFACES = ['execFile', 'execFileSync', 'spawn', 'spawnSync', 'Bun.spawn', 'Bun.spawnSync'];

function surfacesProbe(rgs, args) {
  return `
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
  const ugrep = path.join(dir, 'ugrep');
  fs.writeFileSync(ugrep, '#!/bin/sh\nprintf UGREP; printf " %s" "$@"; printf "\\n"\n', { mode: 0o755 });
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
// have run, and the answer must be exactly the stand-in ugrep's (rc 0, its argv).
const UGREP_ANSWER = /^UGREP -r --ignore-files -I -n needle \.\n$/;
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
    for (const s of SURFACES) got[rg][s] = { status: 0, out: 'UGREP -r --ignore-files -I -n needle .\n', err: '' };
  }
  got[rgs[0]].execFile = { status: 0, out: 'HOST-RG-CALLED -n needle .\n', err: '' };
  return { got, rgs, engine: 'a synthetic control' };
}

function readSurfaces(run, engine) {
  const s = stubs();
  try {
    const prog = path.join(s.dir, 'probe.cjs');
    fs.writeFileSync(prog, surfacesProbe(s.rgs, ['-n', 'needle', '.']));
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
// WHY THE SPELLING `rg: error parsing flag ...`. It is native rg's own spelling of a
// usage error (measured, 2.1.283's embedded ripgrep 14.1.1: `rg: error parsing flag
// --max-columns: value is not a valid number: ...`), and it is one of the five spellings
// upstream's Grep and Glob consumer shows the model as an error. That consumer (`oX`,
// 2.1.283 chunk-9yjanq6m.js) rejects with "Search failed ... ripgrep rejected the
// pattern, glob, or file type without searching:" plus stderr ONLY when the call passed
// rejectOnInputError (both tools do), rc is 2, no line was printed, and stderr matches
// USAGE_ERROR below; any other rc 2 with no output it reads as "no results". So a refusal
// spelled any other way would reach the model as "No files found": the silent wrong
// answer this replaces.
const USAGE_ERROR = /^rg: (?:regex parse error|error parsing glob|unrecognized file type|error parsing flag|compiled regex exceeds size limit)/m;

function assertRefused(a, what, flagOrApplet) {
  assert.doesNotMatch(a.out + a.err, /HOST-RG-CALLED/, `${what} ran the HOST rg`);
  assert.strictEqual(a.status, 2, `${what}: not rc 2: ${JSON.stringify(a)}`);
  assert.strictEqual(a.out, '', `${what}: a refusal prints nothing on stdout`);
  assert.match(a.err, USAGE_ERROR, `${what}: the model would read this refusal as "no results": ${JSON.stringify(a.err)}`);
  assert.ok(a.err.includes(flagOrApplet), `${what}: the refusal does not name ${flagOrApplet}: ${JSON.stringify(a.err)}`);
  assert.doesNotMatch(a.err, /ripgrep/i, `${what}: a refusal never points at ripgrep`);
  assert.doesNotMatch(a.err, /install (it|rg)\b/i, `${what}: a refusal never says to install rg`);
}

test('a refusal is a failed child: rc 2, the flag and the reason on stderr, never ripgrep (every surface)', posixExec, () => {
  const s = stubs();
  const prog = path.join(s.dir, 'probe.cjs');
  fs.writeFileSync(prog, surfacesProbe(s.rgs, ['--json', 'needle', '.']));
  const got = parseProbe(cp.spawnSync(process.execPath, [prog], { encoding: 'utf8', env: s.env, cwd: s.dir }));
  for (const rg of s.rgs) for (const surf of SURFACES) assertRefused(got[rg][surf], `${surf}(${rg})`, '--json');
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

// ugrep rejecting a translated search (rc >= 2, nothing printed) is a refusal too: the
// Grep tool always passes `--max-columns 500`, which ugrep rejects, and before this the
// model read that rc 2 as "No files found" in every files and count call (report-grep.md).
test('ugrep rejecting the translation reaches the caller as a refusal naming what ugrep said', posixExec, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-rejected-'));
  const ugrep = path.join(dir, 'ugrep');
  fs.writeFileSync(ugrep, '#!/bin/sh\necho "ugrep: invalid option --max-columns" >&2\nexit 2\n', { mode: 0o755 });
  const prev = process.env.CLODE_UGREP; process.env.CLODE_UGREP = ugrep;
  const origErr = process.stderr.write;
  process.stderr.write = () => true;
  let r;
  try { r = cp.spawnSync('rg', ['--max-columns', '500', '-l', 'needle', '.'], { encoding: 'utf8' }); }
  finally {
    process.stderr.write = origErr;
    if (prev === undefined) delete process.env.CLODE_UGREP; else process.env.CLODE_UGREP = prev;
  }
  assertRefused({ status: r.status, out: r.stdout, err: r.stderr }, 'spawnSync(rg)', 'invalid option --max-columns');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rgRefusal: rc 2, nothing on stdout, the flag and reason on stderr in the spelling the Grep tool surfaces', () => {
  const { rgRefusal } = require('../libexec/rg-native.cjs');
  const r = rgRefusal('the reason', { flag: '--json' });
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.stdout.length, 0);
  assert.strictEqual(r.stderr.toString('utf8'), 'rg: error parsing flag --json: the reason\n');
  assert.match(r.stderr.toString('utf8'), USAGE_ERROR);
  const noFlag = rgRefusal('why');
  assert.match(noFlag.stderr.toString('utf8'), USAGE_ERROR);
  assert.match(noFlag.stderr.toString('utf8'), /why\n$/);
});
