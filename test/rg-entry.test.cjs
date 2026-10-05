'use strict';
// quaude's rg as a COMMAND (grep-native Task 10c, user ruling 2026-10-04): what the Bash tool's `rg` runs.
//
// Native's snapshot defines `rg` (inside upstream's "is rg installed?" guard) as a shell function that runs the
// claude binary with argv[0] `rg` (`ARGV0=rg "$_cc_bin"` in zsh, `(exec -a rg "$_cc_bin")` in bash), and the
// binary answers as its embedded ripgrep. quaude mirrors that: libexec/rg-entry.cjs is what a quaude (or naude)
// invoked as rg runs, before any of the bundle loads, and it answers with rg-native.cjs, the rg the
// rg-differential gate judges byte for byte against native.
//
// What the command adds to the rg the bundle spawns is what only a command has:
//   RG-ARGV0          which invocations are rg (native 2.1.283, measured 2026-10-04 on darwin-arm64):
//                     argv[0] whose last path component is exactly `rg` (`rg`, `/x/rg`, a symlink named rg), or
//                     the environment's ARGV0 exactly `rg` (bash's `ARGV0=rg cmd` exports it: upstream's msys
//                     branch); not `RG`, not `rg.exe`, not ARGV0=/x/rg, not ARGV0=ugrep
//   RG-IMPLICIT-PATH  what rg searches when it names no path: its stdin when that is a regular file, a FIFO or a
//                     socket (`echo x | rg x`; ripgrep 14.1.1 hiargs.rs + grep-cli is_readable_stdin), else ./ with
//                     the `./` left off every path it prints (strip_dot_prefix: `a.txt:...`, the walk's own
//                     errors keep it: `rg: ./d: IO error ...`); --files always lists ./. The Bash tool runs
//                     every command `< /dev/null` (2.1.283's Qtt), a character device, so a bare `rg x` there
//                     searches the working directory
//   RG-CONFIG         native's shell function passes no --no-config, so native's Bash `rg` reads
//                     RIPGREP_CONFIG_PATH; quaude's rg reads no config file, so with RIPGREP_CONFIG_PATH set (and
//                     no --no-config) it REFUSES by name rather than search without it
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const P = require('../scripts/lib/rg-probe.cjs');
const rgn = require('../libexec/rg-native.cjs');
const { tjsPath, engineSpawn, LOADER } = require('./node-shim-helper.cjs');
const { providerBin } = require('./provider-resolve.cjs');

const REPO = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO, 'libexec', 'rg-entry.cjs');
const POSIX = process.platform === 'win32' ? 'the stdin kinds and the trees here are POSIX (Windows unmeasured, BACKLOG)' : false;
function hostUgrep() {
  if (process.env.CLODE_UGREP) return process.env.CLODE_UGREP;
  for (const d of (process.env.PATH || '').split(path.delimiter)) { const p = path.join(d, 'ugrep'); if (d && fs.existsSync(p)) return p; }
  return null;
}
const UGREP = hostUgrep();
const NEED = { skip: POSIX || (!UGREP ? 'no ugrep on this host' : false) };
const NATIVE = providerBin(process.env);

// RG-ARGV0: native 2.1.283 (darwin-arm64), `--version` run under each spelling, 2026-10-04: `ripgrep 14.1.1 ...`
// (rg) or `2.1.283 (Claude Code)` (not rg).
const ARGV0_ROWS = [
  ['rg', {}, true], ['/x/rg', {}, true], ['RG', {}, false], ['rg.exe', {}, false], ['claude', {}, false],
  ['/x/claude', { ARGV0: 'rg' }, true], ['/x/claude', { ARGV0: '/x/rg' }, false], ['/x/claude', { ARGV0: 'xx' }, false],
];

// RG-IMPLICIT-PATH: [argv, stdin, rc, stdout, stderr], native 2.1.283's embedded rg (ripgrep 14.1.1, darwin-arm64)
// over makeRgTree('root'), run in the tree with no path, stdin as named (`null` = /dev/null, as the Bash tool
// gives it; `pipe` = 'a needle\nno\nneedle two\n' through a pipe; `file` = the tree's a.txt; `closed` = fd 0
// closed), measured 2026-10-04 (generator: grep-native task-10c report, measure.cjs). Lines compare in any order
// here (the order is the filesystem's readdir order under -j1); order is judged live against native below.
const PIPE_INPUT = 'a needle\nno\nneedle two\n';
const IMPLICIT = [
  [['-j1', '-c', 'needle'], 'null', 0, 'code.js:1\nuni.txt:1\nnonl.txt:1\nsub/deep/nested.txt:1\nlatin1.txt:1\na.txt:3\nlong.txt:3\ncrlf.txt:2\n', ''],
  [['-j1', '-l', 'needle'], 'null', 0, 'code.js\nuni.txt\nnonl.txt\nsub/deep/nested.txt\nlatin1.txt\na.txt\nlong.txt\ncrlf.txt\n', ''],
  [['-j1', '--files'], 'null', 0, 'empty.txt\nsp.txt\ncode.js\nuni.txt\nnonl.txt\nsub/deep/nested.txt\nlatin1.txt\na.txt\nbin.dat\nlong.txt\ncrlf.txt\n', ''],
  [['-n', 'needle'], 'pipe', 0, '1:a needle\n3:needle two\n', ''],
  [['needle'], 'file', 0, 'alpha needle one\ngamma needle two needle\nzeta needle\n', ''],
  [['-c', 'needle'], 'pipe', 0, '2\n', ''],
  [['-j1', '--files'], 'pipe', 0, 'empty.txt\nsp.txt\ncode.js\nuni.txt\nnonl.txt\nsub/deep/nested.txt\nlatin1.txt\na.txt\nbin.dat\nlong.txt\ncrlf.txt\n', ''],
  [['-j1', '-U', 'needle.two'], 'null', 0, 'a.txt:gamma needle two needle\n', ''],
  [['-j1', '-l', 'needle'], 'closed', 0, 'code.js\nuni.txt\nnonl.txt\nsub/deep/nested.txt\nlatin1.txt\na.txt\nlong.txt\ncrlf.txt\n', ''],
  [['-j1', '-l', 'needle'], 'file', 0, '<stdin>\n', ''],
  [['-j1', '-c', 'zzz'], 'null', 1, '', ''],
  [['-c', 'needle'], 'null', 0, 'crlf.txt:2\nlong.txt:3\na.txt:3\nlatin1.txt:1\nsub/deep/nested.txt:1\nnonl.txt:1\nuni.txt:1\ncode.js:1\n', ''],
];
const lines = (s) => String(s).split('\n').filter((l, i, a) => i < a.length - 1 || l !== '').sort();

let BASE = null;
function tree() {
  if (BASE) return path.join(BASE, 'root');
  BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-entry-')));
  P.makeRgTree(path.join(BASE, 'root'), 'root');
  process.on('exit', () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* best effort */ } });
  return path.join(BASE, 'root');
}

// One run of a command in the tree with the named kind of stdin; `argv0` and `env` as given.
function runWith(cmd, args, stdin, { argv0, env } = {}) {
  const t = tree();
  const e = { HOME: BASE, PATH: process.env.PATH, ...(UGREP ? { CLODE_UGREP: UGREP } : {}), ...env };
  const o = { cwd: t, env: e, ...(argv0 ? { argv0 } : {}), maxBuffer: 64 * 1024 * 1024, timeout: 60000 };
  let r;
  if (stdin === 'closed') {
    r = cp.spawnSync('/bin/sh', ['-c', 'exec "$@" <&-', 'sh', cmd, ...args], { ...o, env: { ...e, ...(argv0 ? { ARGV0: argv0 } : {}) } });
  } else {
    const fd = stdin === 'null' ? fs.openSync('/dev/null', 'r') : stdin === 'file' ? fs.openSync(path.join(t, 'a.txt'), 'r') : 'pipe';
    try { r = cp.spawnSync(cmd, args, { ...o, stdio: [fd, 'pipe', 'pipe'], input: stdin === 'pipe' ? PIPE_INPUT : undefined }); }
    finally { if (typeof fd === 'number') fs.closeSync(fd); }
  }
  if (r.error) throw r.error;
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}
const underNode = (argv, stdin, opts) => runWith(process.execPath, [ENTRY, ...argv], stdin, opts);
function underTjs(argv, stdin, opts) {
  const [cmd, a] = engineSpawn(['run', LOADER, ENTRY, ...argv]);
  return runWith(cmd, a, stdin, opts);
}
const nativeRun = (argv, stdin) => runWith(NATIVE, argv, stdin, { argv0: 'rg' });

test('RG-ARGV0: isRgInvocation reads argv[0] and ARGV0 as native does', () => {
  const { isRgInvocation } = require('../libexec/rg-entry.cjs');
  for (const [argv0, env, want] of ARGV0_ROWS) assert.strictEqual(isRgInvocation(argv0, env), want, `${argv0} ${JSON.stringify(env)}`);
});

// The quaude bootstrap cannot require anything (it is compiled raw to bytecode), so it carries its own copy of the
// predicate; naude's entry requires rg-entry.cjs's. All three must answer the native table alike.
test('RG-ARGV0: the quaude bootstrap\'s copy and naude\'s entry answer the native table alike', async () => {
  const boot = await import(path.join(REPO, 'libexec', 'quaude-bootstrap.mjs'));
  const naude = require('../libexec/naude-entry.cjs');
  for (const [argv0, env, want] of ARGV0_ROWS) {
    assert.strictEqual(boot.isRgInvocation(argv0, env), want, `bootstrap: ${argv0} ${JSON.stringify(env)}`);
    assert.strictEqual(naude.isRgInvocation(argv0, env), want, `naude: ${argv0} ${JSON.stringify(env)}`);
  }
});

test('RG-ARGV0: native answers as rg exactly where the table says (native)', { skip: POSIX || (!NATIVE ? 'no native provider' : false) }, () => {
  for (const [argv0, env, want] of ARGV0_ROWS) {
    const r = cp.spawnSync(NATIVE, ['--version'], { argv0, env: { HOME: os.tmpdir(), PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.stdout.startsWith('ripgrep '), want, `${argv0} ${JSON.stringify(env)}: ${r.stdout.split('\n')[0]}`);
  }
});

// rg-native itself, with the implicit path the command decides: the literal rows, sync, in-process.
test('RG-IMPLICIT-PATH: runRg with no path searches stdin or ./, as native', NEED, () => {
  const t = tree();
  for (const [argv, stdin, rc, out, err] of IMPLICIT) {
    if (stdin === 'closed') continue;   // fd 0 is the command's question, below
    const implicit = stdin === 'null' ? 'cwd' : 'stdin';
    const input = stdin === 'pipe' ? Buffer.from(PIPE_INPUT) : stdin === 'file' ? Buffer.from(P.treeEntries('root').find(([rel]) => rel === 'a.txt')[1]) : null;
    const r = rgn.runRg(argv, { cwd: t, env: { HOME: BASE, PATH: process.env.PATH }, ugrep: () => UGREP, implicit, input });
    const where = `${argv.join(' ')} <${stdin}: ${r.stderr}`;
    assert.strictEqual(r.status, rc, where);
    assert.deepStrictEqual(lines(r.stdout.toString('latin1')), lines(out), where);
    assert.strictEqual(r.stderr.toString('latin1'), err, where);
  }
});

test('RG-IMPLICIT-PATH: a caller that decides nothing still refuses a pathless search by name (the bundle never runs one)', () => {
  const r = rgn.runRg(['needle'], { cwd: os.tmpdir() });
  assert.strictEqual(r.status, 2);
  assert.match(rgn.parseRgRefusal(r.stderr).reason, /names no path to search/);
});

// The command, as a process: fd 0 is what it is, under node and under tjs (the engine quaude ships).
for (const [label, run, skip] of [['node', underNode, false], ['tjs', underTjs, !tjsPath() ? 'no tjs engine' : false]]) {
  test(`rg-entry under ${label}: the literal rows, each stdin kind as native`, { skip: NEED.skip || skip }, () => {
    for (const [argv, stdin, rc, out, err] of IMPLICIT) {
      const r = run(argv, stdin);
      const where = `${label}: ${argv.join(' ')} <${stdin}: ${r.stderr}`;
      assert.strictEqual(r.status, rc, where);
      assert.deepStrictEqual(lines(r.stdout.toString('latin1')), lines(out), where);
      assert.strictEqual(r.stderr.toString('latin1'), err, where);
    }
  });
}

// RG-IMPLICIT-PATH's errors: a file rg cannot read is named as printed (no ./), the walk's own error keeps it.
// Native 2.1.283, measured 2026-10-04, -j1 so the order is fixed (the walk meets ./d, then the files).
const PERM_ROWS = [
  [['-j1', 'needle'], 2, 'ok.txt:needle\n', ['rg: no.txt: Permission denied (os error 13)', 'rg: ./d: IO error for operation on ./d: Permission denied (os error 13)']],
  [['-j1', 'needle', '.'], 2, './ok.txt:needle\n', ['rg: ./no.txt: Permission denied (os error 13)', 'rg: ./d: IO error for operation on ./d: Permission denied (os error 13)']],
];
test('RG-IMPLICIT-PATH: an unreadable file is named as printed, the walk\'s error keeps ./ (tjs)', { skip: NEED.skip || (!tjsPath() ? 'no tjs engine' : false) || (process.getuid && process.getuid() === 0 ? 'root reads mode-000 files' : false) }, () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-entry-perm-')));
  try {
    fs.writeFileSync(path.join(d, 'ok.txt'), 'needle\n');
    fs.writeFileSync(path.join(d, 'no.txt'), 'needle\n');
    fs.mkdirSync(path.join(d, 'd'));
    fs.writeFileSync(path.join(d, 'd', 'x'), 'needle\n');
    fs.chmodSync(path.join(d, 'no.txt'), 0o000); fs.chmodSync(path.join(d, 'd'), 0o000);
    for (const [argv, rc, out, errs] of PERM_ROWS) {
      const [cmd, a] = engineSpawn(['run', LOADER, ENTRY, ...argv]);
      const null0 = fs.openSync('/dev/null', 'r');
      const r = cp.spawnSync(cmd, a, { cwd: d, stdio: [null0, 'pipe', 'pipe'], env: { HOME: d, PATH: process.env.PATH, CLODE_UGREP: UGREP } });
      fs.closeSync(null0);
      const where = `${argv.join(' ')}: ${r.stderr}`;
      assert.strictEqual(r.status, rc, where);
      assert.strictEqual(r.stdout.toString(), out, where);
      assert.deepStrictEqual(r.stderr.toString().split('\n').filter(Boolean).sort(), errs.slice().sort(), where);
    }
  } finally { fs.chmodSync(path.join(d, 'd'), 0o755); fs.chmodSync(path.join(d, 'no.txt'), 0o644); fs.rmSync(d, { recursive: true, force: true }); }
});

// Live: every literal row and the order under -j1, against native here, run the same way (and --json, whose
// elapsed times compareRg forgives).
test('RG-IMPLICIT-PATH: ours under tjs equals native run the same way, order included under -j1 (native)', { skip: NEED.skip || (!tjsPath() ? 'no tjs engine' : false) || (!NATIVE ? 'no native provider' : false) }, () => {
  const rows = [...IMPLICIT.map(([argv, stdin]) => [argv, stdin]), [['-j1', '--json', 'needle'], 'null'], [['--json', 'needle'], 'pipe'],
    [['-j1', 'needle'], 'null'], [['-j1', '-c', 'needle', 'sub'], 'pipe']];
  for (const [argv, stdin] of rows) {
    const n = nativeRun(argv, stdin), o = underTjs(argv, stdin);
    const d = P.compareRg({ argv, ...n }, { argv, ...o });
    assert.ok(d.same, `${argv.join(' ')} <${stdin}: ${d.why}`);
  }
});

// RG-CONFIG: native's Bash `rg` reads RIPGREP_CONFIG_PATH; quaude's rg cannot, so it says so.
test('RG-CONFIG: RIPGREP_CONFIG_PATH set refuses by name; --no-config, or an empty value, searches', { skip: NEED.skip }, () => {
  const t = tree();
  const cfg = path.join(BASE, 'rgrc');
  fs.writeFileSync(cfg, '--hidden\n');
  const refused = underNode(['-l', 'needle', 'sub'], 'null', { env: { RIPGREP_CONFIG_PATH: cfg } });
  assert.strictEqual(refused.status, 2);
  assert.strictEqual(refused.stdout.length, 0);
  const why = rgn.parseRgRefusal(refused.stderr);
  assert.ok(why && /RIPGREP_CONFIG_PATH/.test(why.reason), String(refused.stderr));
  for (const [argv, env] of [[['--no-config', '-l', 'needle', 'sub'], { RIPGREP_CONFIG_PATH: cfg }], [['-l', 'needle', 'sub'], { RIPGREP_CONFIG_PATH: '' }]]) {
    const r = underNode(argv, 'null', { env });
    assert.deepStrictEqual([r.status, r.stdout.toString()], [0, 'sub/deep/nested.txt\n'], `${argv.join(' ')}: ${r.stderr}`);
  }
  assert.ok(fs.existsSync(t));
});

test('RG-CONFIG: native with --no-config searches as with no config (native)', { skip: NEED.skip || (!NATIVE ? 'no native provider' : false) }, () => {
  const r = nativeRun(['--no-config', '-l', 'needle', 'sub'], 'null');
  assert.deepStrictEqual([r.status, r.stdout.toString()], [0, 'sub/deep/nested.txt\n']);
});

// No ugrep: the same refusal the bundle's rg gives (rg-native's), never a host rg.
test('rg-entry with no ugrep refuses by name, rc 2, never a host rg', { skip: POSIX }, () => {
  const t = tree();
  const trip = path.join(BASE, 'trip');
  fs.mkdirSync(trip, { recursive: true });
  fs.writeFileSync(path.join(trip, 'rg'), '#!/bin/sh\necho HOST-RG-RAN\nexit 99\n', { mode: 0o755 });
  const r = runWith(process.execPath, [ENTRY, '-l', 'needle', '.'], 'null', { env: { PATH: trip, CLODE_UGREP: '' } });
  assert.strictEqual(r.status, 2, String(r.stderr));
  assert.doesNotMatch(String(r.stdout) + String(r.stderr), /HOST-RG-RAN/);
  assert.match(rgn.parseRgRefusal(r.stderr).reason, /^quaude answers rg with ugrep, on purpose, and this host has no ugrep/);
  assert.ok(fs.existsSync(t));
});

// A reader that goes away (`rg x | head -1`) ends rg quietly: no message.
test('rg-entry writing into a closed pipe ends quietly (tjs)', { skip: NEED.skip || (!tjsPath() ? 'no tjs engine' : false) }, () => {
  const t = tree();
  const [cmd, a] = engineSpawn(['run', LOADER, ENTRY, '-j1', '--files']);
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const r = cp.spawnSync('/bin/sh', ['-c', `${[cmd, ...a].map(q).join(' ')} </dev/null | head -1`], { cwd: t, env: { HOME: BASE, PATH: process.env.PATH, CLODE_UGREP: UGREP }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.split('\n').filter(Boolean).length, 1);
  assert.strictEqual(r.stderr, '');
});
