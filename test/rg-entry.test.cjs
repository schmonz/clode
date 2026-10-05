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
const { rgOracle, rgOracleSkip } = require('./provider-resolve.cjs');

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
const NATIVE = rgOracle(process.env), NATIVE_SKIP = rgOracleSkip(process.env);

// RG-ARGV0: native 2.1.283 (darwin-arm64), `--version` run under each spelling, 2026-10-04: `ripgrep 14.1.1 ...`
// (rg) or `2.1.283 (Claude Code)` (not rg).
// `a\rg` and `C:rg` are Claude Code too off Windows (review M-1: a backslash and a drive are no separators there).
const ARGV0_ROWS = [
  ['rg', {}, true], ['/x/rg', {}, true], ['RG', {}, false], ['rg.exe', {}, false], ['claude', {}, false],
  ['/x/claude', { ARGV0: 'rg' }, true], ['/x/claude', { ARGV0: '/x/rg' }, false], ['/x/claude', { ARGV0: 'xx' }, false],
  ['a\\rg', {}, false], ['C:rg', {}, false],
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

test('RG-ARGV0: isRgInvocation reads argv[0] and ARGV0 as native does (off Windows)', () => {
  const { isRgInvocation } = require('../libexec/rg-entry.cjs');
  for (const platform of ['darwin', 'linux', 'netbsd']) {
    for (const [argv0, env, want] of ARGV0_ROWS) assert.strictEqual(isRgInvocation(argv0, env, platform), want, `${platform}: ${argv0} ${JSON.stringify(env)}`);
  }
});
// On Windows a path component ends at either separator, after any drive (unmeasured against native there).
test('RG-ARGV0: on Windows, `\\` and a drive end the directory part too', () => {
  const { isRgInvocation } = require('../libexec/rg-entry.cjs');
  for (const [argv0, want] of [['C:\\x\\rg', true], ['C:rg', true], ['a/rg', true], ['rg.exe', false], ['C:\\x\\claude.exe', false]]) {
    assert.strictEqual(isRgInvocation(argv0, {}, 'win32'), want, argv0);
  }
});
// Stated ONCE (review M-1): naude's entry requires it, and the quaude bootstrap evaluates rg-entry.cjs's own member for
// it (test/quaude-build.test.cjs drives the built quaude through the table's rows), so no copy can drift.
test('RG-ARGV0: naude\'s entry is rg-entry\'s rule', () => {
  assert.strictEqual(require('../libexec/naude-entry.cjs').isRgInvocation, require('../libexec/rg-entry.cjs').isRgInvocation);
});

test('RG-ARGV0: native answers as rg exactly where the table says (native, off Windows)', { skip: POSIX || (!NATIVE ? NATIVE_SKIP : false) }, () => {
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
test('RG-IMPLICIT-PATH: ours under tjs equals native run the same way, order included under -j1 (native)', { skip: NEED.skip || (!tjsPath() ? 'no tjs engine' : false) || (!NATIVE ? NATIVE_SKIP : false) }, () => {
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

test('RG-CONFIG: native with --no-config searches as with no config (native)', { skip: NEED.skip || (!NATIVE ? NATIVE_SKIP : false) }, () => {
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

// I/O AS NATIVE'S (grep-native Task 10c fix round, review I-1, M-2): measured against native 2.1.283 on darwin-arm64,
// 2026-10-04, each through bash so the shell reports what it saw:
//   `rg needle BIG | head -1`   native dies of SIGPIPE: the producer's status 141, stderr empty
//   `rg needle >&-`             a closed stdout writes nothing: rc 0 (a match), stderr empty
//   `rg needle zzz 2>&-`        a closed stderr: rc 2
//   a non-blocking empty stdin  `rg: <stdin>: Resource temporarily unavailable (os error 35)`, rc 2 (never waited out)
// The big file is more than any pipe holds (> 64 KiB of output), so the reader is gone while rg still writes.
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const bigFile = () => {
  const f = path.join(BASE || (tree(), BASE), 'big.txt');
  if (!fs.existsSync(f)) fs.writeFileSync(f, Buffer.from('a line with a needle in it\n'.repeat(400000)));   // 10.8 MB
  return f;
};
const asCmd = (label) => (label === 'native' ? `ARGV0=rg ${q(NATIVE)}` : engineSpawn(['run', LOADER, ENTRY]).flat().map(q).join(' '));
const bash = (script) => cp.spawnSync('bash', ['-c', script], { cwd: tree(), env: { HOME: BASE, PATH: process.env.PATH, CLODE_UGREP: UGREP || '' }, encoding: 'utf8', timeout: 120000 });
const IO_ROWS = [
  ['| head -1, more than a pipe holds', (c) => `${c} needle ${q(bigFile())} </dev/null 2>"$E" | head -1 >/dev/null; echo "rc=\${PIPESTATUS[0]} err=$(cat "$E")"`, 'rc=141 err=\n'],
  ['a closed stdout', (c) => `${c} needle a.txt </dev/null >&- 2>"$E"; echo "rc=$? err=$(cat "$E")"`, 'rc=0 err=\n'],
  ['a closed stderr', (c) => `${c} needle zzz </dev/null 2>&-; echo "rc=$?"`, 'rc=2\n'],
];
for (const [label, run] of [['tjs', 'tjs'], ['native', 'native']]) {
  test(`rg-entry's I/O is native's: a reader that goes away, a closed stdout, a closed stderr (${label})`,
    { skip: POSIX || (label === 'tjs' ? NEED.skip || (!tjsPath() ? 'no tjs engine' : false) : !NATIVE ? NATIVE_SKIP : false) }, () => {
      for (const [what, script, want] of IO_ROWS) {
        const r = bash(`E=$(mktemp); ${script(asCmd(run))}; rm -f "$E"`);
        assert.strictEqual(r.stdout, want, `${what}: ${r.stderr}`);
      }
    });
}
const NONBLOCK = `import os, fcntl, subprocess, sys
r, w = os.pipe()
fcntl.fcntl(r, fcntl.F_SETFL, fcntl.fcntl(r, fcntl.F_GETFL) | os.O_NONBLOCK)
p = subprocess.run(sys.argv[1:], stdin=r, capture_output=True, timeout=60)
sys.stdout.write('%d %s' % (p.returncode, p.stderr.decode()))
os.close(w)
`;
const HAS_PY = (() => { try { return cp.spawnSync('python3', ['-c', 'pass']).status === 0; } catch { return false; } })();
test('rg-entry with a non-blocking stdin holding nothing yet: rg\'s error for <stdin>, rc 2, at once (tjs and native)', { skip: POSIX || NEED.skip || (!tjsPath() ? 'no tjs engine' : !HAS_PY ? 'no python3 to make the pipe' : false) }, () => {
  const run = (argv) => cp.spawnSync('python3', ['-c', NONBLOCK, ...argv], { cwd: tree(), encoding: 'utf8', timeout: 90000,
    env: { HOME: BASE, PATH: process.env.PATH, CLODE_UGREP: UGREP, ARGV0: 'rg' } }).stdout;
  const [cmd, a] = engineSpawn(['run', LOADER, ENTRY]);
  const errno = require('node:os').constants.errno.EAGAIN;
  for (const argv of [['-n', 'needle'], ['-c', 'needle', '-']]) {
    const ours = run([cmd, ...a, ...argv]);
    assert.match(ours, new RegExp(`^2 rg: <stdin>: [A-Z][^\\n]* \\(os error ${errno}\\)\\n$`), argv.join(' '));
    if (NATIVE) assert.strictEqual(ours, run([NATIVE, ...argv]), `${argv.join(' ')} vs native`);
  }
});

// RG-STREAM, as a process: `yes needle | rg needle | head -1` ends (native at once; ours read its stdin to the end,
// which never comes), and a 10.8 MB file under `| head -1` is not read whole first. Bounded by the run's timeout
// (a search that waited for the end would be killed at it) and by what the shell saw.
test('RG-STREAM: yes | rg | head -1 ends, and a big file under | head -1 prints its first line (tjs)', { skip: POSIX || NEED.skip || (!tjsPath() ? 'no tjs engine' : false) }, () => {
  const c = asCmd('tjs');
  const y = bash(`yes needle | ${c} needle | head -1; echo "rc=\${PIPESTATUS[1]}"`);
  assert.strictEqual(y.status, 0, `yes | rg | head -1 did not end: ${y.signal} ${y.stderr}`);
  assert.strictEqual(y.stdout, 'needle\nrc=141\n');
  const b = bash(`${c} -n needle ${q(bigFile())} </dev/null | head -1`);
  assert.strictEqual(b.stdout, '1:a line with a needle in it\n');
});

// A CLOSED stdout under tjs is not closed by the time any JS runs: libuv's own event-loop descriptor takes the lowest
// free number at start-up. On darwin and NetBSD that is kqueue (a write fails ENXIO); on Linux it is epoll
// (`readlink /proc/self/fd/1` = anon_inode:[eventpoll], measured in an ubuntu:24.04 container 2026-10-05), and a write
// to it fails EINVAL. Native's `rg needle >&-` writes nothing and exits 0 (above); so must ours on each, not throw.
test('fdWriter: a stdout that is libuv\'s own descriptor (ENXIO on kqueue, EINVAL on epoll) writes nothing, quietly', () => {
  const { fdWriter } = require('../libexec/rg-entry.cjs');
  for (const code of ['EBADF', 'ENXIO', 'EINVAL']) {
    let calls = 0;
    const out = fdWriter(1, { writeSync: () => { calls++; throw Object.assign(new Error(code), { code }); } });
    assert.doesNotThrow(() => { out(Buffer.from('a.txt:needle\n')); out(Buffer.from('more\n')); }, code);
    assert.strictEqual(calls, 1, `${code}: gone after the first failed write`);
  }
  // ...and anything else is still rg's to report (EPIPE ends rg as SIGPIPE would, an unknown failure throws)
  assert.throws(() => fdWriter(1, { writeSync: () => { throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' }); } })(Buffer.from('x')), (e) => e.sinkClosed === true);
  assert.throws(() => fdWriter(1, { writeSync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } })(Buffer.from('x')), /EIO/);
});
