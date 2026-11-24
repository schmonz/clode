'use strict';
// process.execve and spawnSync stdio:'inherit' UNDER A PTY: the rows of test/node-shim-execve.test.cjs that need a
// real terminal (that file has the bug's history and the pipe-only rows). Named node-shim-tty-* so the node-shim
// oracle jobs' glob leaves it out with node-shim-tty (their EXCLUDE, and ORACLE_EXCLUDE in test/ci-gates.cjs): it needs
// the node-pty harness, and the linux oracle container has none (CI 45224603603). test/ci-gates.cjs places it in the
// jobs that install the harness and run its preflight, where a skip is judged by name.
//
// The oracle is host node where node can answer, and Bun (the native the bundle targets) where it is the better
// witness: under a pty a perl probe exec'd from Bun 1.4.4 reports fds 0-2 BLOCKING, no fd above 2 open, an empty
// signal mask; node 24/26 hand the same except an O_NONBLOCK leaked on a raw-mode stdin, which the engine clears.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skipUnlessTjs, LOADER } = require('./node-shim-helper.cjs');
const { ptyRun, runLoaderPty, runNodePty } = require('./node-shim-tty-helper.cjs');

const POSIX = process.platform !== 'win32';
const PERL = ['/usr/bin/perl', '/usr/pkg/bin/perl', '/opt/pkg/bin/perl', '/usr/local/bin/perl'].find((p) => fs.existsSync(p));

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'shim-execve-pty-')); }
function prog(dir, name, body) { const f = path.join(dir, name); fs.writeFileSync(f, body); return f; }

test("spawnSync stdio:'inherit' under a pty: the child owns the terminal (isatty 0/1/2), like node", { skip: !POSIX && 'POSIX pty' }, async (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = tmpdir();
  try {
    const child = "const t=require('tty');process.stdout.write('@@TTY@@'+JSON.stringify({i0:t.isatty(0),i1:t.isatty(1),i2:t.isatty(2)})+'\\n')";
    const f = prog(dir, 'p.cjs', `require('node:child_process').spawnSync(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(child)}], { stdio: 'inherit' });`);
    const mark = (out) => { const m = out.match(/@@TTY@@(\{.*?\})/); return m && JSON.parse(m[1]); };
    const node = mark((await runNodePty(f)).out);
    assert.deepStrictEqual(node, { i0: true, i1: true, i2: true });
    assert.deepStrictEqual(mark((await runLoaderPty(f)).out), node);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The replaced image, probed by perl (it can read O_NONBLOCK, the signal mask and the open fds, which node cannot):
// same pid, the argv and env asked for, and the inherited world Bun hands on. The parent first puts stdin in raw
// mode (libuv then sets O_NONBLOCK on the tty) and opens a stray fd, the two things that would leak.
test('process.execve replaces the process: same pid, new argv and env, fds 0-2 blocking, nothing else open', { skip: !POSIX && 'POSIX' }, async (t) => {
  if (skipUnlessTjs(t)) return;
  if (!PERL) { t.skip('no perl to probe the replaced image with'); return; }
  const dir = tmpdir();
  try {
    const probe = prog(dir, 'probe.pl', `use POSIX qw(:signal_h);
use Fcntl;
my $old = POSIX::SigSet->new; sigprocmask(SIG_BLOCK, POSIX::SigSet->new, $old);
my @blocked = grep { $old->ismember($_) } 1..31;
my @nb; for my $fd (0..2) { open(my $h, "+<&=", $fd) or next; my $fl = fcntl($h, F_GETFL, 0); push @nb, $fd if $fl & O_NONBLOCK; }
my @open; for my $fd (3..255) { if (open(my $h, "<&=", $fd)) { push @open, $fd } }
print '@@PROBE@@{"pid":', $$, ',"args":"', join(' ', @ARGV), '","foo":"', ($ENV{FOO} // ''), '","envn":', scalar(keys %ENV),
  ',"blocked":"', "@blocked", '","nb":"', "@nb", '","open":"', "@open", '","tty":[', (-t STDIN ? 1 : 0), ',', (-t STDOUT ? 1 : 0), ']}', "\\n";
`);
    const f = prog(dir, 'p.cjs', `
      process.stdout.write('@@PARENT@@' + process.pid + '\\n');
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.on('data', () => {});
      require('node:fs').openSync(__filename, 'r');
      setTimeout(() => process.execve(${JSON.stringify(PERL)}, ['perl-renamed', ${JSON.stringify(probe)}, 'a', 'b'], { FOO: 'bar' }), 50);`);
    const { out } = await runLoaderPty(f, { ms: 15000 });
    const parent = Number((out.match(/@@PARENT@@(\d+)/) || [])[1]);
    const m = out.match(/@@PROBE@@(\{.*?\})/);
    assert.ok(m, `the probe never ran: ${JSON.stringify(out)}`);
    const got = JSON.parse(m[1]);
    assert.strictEqual(got.pid, parent, 'execve keeps the pid; a different one means the shim spawned instead');
    assert.deepStrictEqual({ ...got, pid: undefined },
      { pid: undefined, args: 'a b', foo: 'bar', envn: 1, blocked: '', nb: '', open: '', tty: [1, 1] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// END TO END, relaunch-shaped: the bundle's execReplaceProcess + fallback, verbatim in structure, under tjs in a pty.
// The relaunched program must own a LIVE terminal: it reads a line typed into the pty and echoes it. Both routes:
// execve (POSIX, what native takes) and the spawnSync fallback (what Windows takes, and what POSIX took while
// process.execve was missing — the dead terminal).
for (const route of ['execve', 'spawnSync fallback']) {
  test(`relaunch (${route}) under a pty: the new program owns a live terminal`, { skip: !POSIX && 'POSIX pty' }, async (t) => {
    if (skipUnlessTjs(t)) return;
    const dir = tmpdir();
    try {
      const child = prog(dir, 'child.cjs', `
        const tty = require('tty');
        process.stdout.write('@@READY@@ tty=' + tty.isatty(0) + ',' + tty.isatty(1) + '\\n');
        let buf = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (d) => { buf += d; if (buf.includes('\\n') || buf.includes('\\r')) {
          process.stdout.write('@@ECHO@@' + buf.trim() + '@@\\n'); process.exit(0); } });`);
      const f = prog(dir, 'relaunch.cjs', `
        const { spawnSync } = require('child_process');
        ${route === 'execve' ? '' : 'delete process.execve;'}
        function relaunch(cmd, args, env) {
          if (process.platform !== 'win32' && typeof process.execve === 'function') {
            try { process.execve(cmd, [cmd, ...args], env); } catch (e) { console.error('falling back to spawn: ' + e.message); }
          }
          const c = spawnSync(cmd, args, { stdio: 'inherit', env });
          process.exit(c.status ?? (c.signal ? 1 : 0));
        }
        process.stdout.write('@@OLD@@' + process.pid + '\\n');
        relaunch(${JSON.stringify(process.execPath)}, [${JSON.stringify(child)}], { ...process.env });`);
      const tjs = require('./node-shim-helper.cjs').tjsPath();
      const r = await ptyRun({ cmd: tjs, args: ['run', LOADER, f], input: 'hello-relaunch\r', readyMark: '@@READY@@', ms: 20000 });
      assert.match(r.out, /@@READY@@ tty=true,true/, `the relaunched program does not have the terminal: ${JSON.stringify(r.out)}`);
      assert.match(r.out, /@@ECHO@@hello-relaunch@@/, `typing reached nobody: ${JSON.stringify(r.out)}`);
      assert.doesNotMatch(r.out, /falling back to spawn/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
