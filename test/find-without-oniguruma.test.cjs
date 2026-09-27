'use strict';
// THE RULE (FIND_WITHOUT_ONIGURUMA, libexec/bun-shim.cjs; the user's decision, 2026-09-27:
// "drop only that flag"): when the host bfs rejects upstream's `-regextype
// findutils-default` but accepts the rest of upstream's find flags, the rewritten find
// runs WITHOUT that one flag. It refuses, loudly and with the fix, only a find whose own
// arguments include -regex, -iregex or -regextype, because that find would otherwise
// silently read its regex in a different dialect. Every other find runs, with `-S dfs`
// kept, so results and order match native.
//
// Why: only a bfs built with Oniguruma knows findutils-default (pkgsrc's is built
// --without-oniguruma, e.g. this dev Mac's). Since F4 restored upstream's flags, such a
// host failed EVERY Bash `find` with the skew trailer, although only regex finds depend
// on the flag. A written divergence from upstream's argv, recorded in CHANGELOG.md and
// BACKLOG.md, for a flag the host cannot honour.
//
// Stand-in applets make each host shape exact on every platform: a bfs that rejects
// -regextype, a bfs that accepts everything, and one that rejects everything.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { warnAppletSkew, rewriteSnapshot } = require('../libexec/bun-shim.cjs');

const SKIP = process.platform === 'win32'
  ? 'POSIX-shell snapshot generation and sourcing have no Windows analog' : false;
function which(name) {
  const r = cp.spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}
const SHELLS = process.platform === 'win32' ? [] : [
  { name: 'bash', bin: which('bash'), args: ['-c'] },
  { name: 'zsh', bin: which('zsh'), args: ['-f', '-c'] },
];

// Stand-in bfs builds. Each prints the argv it ran with, one per line.
const BFS_NO_ONIG = [
  '#!/bin/sh',
  'for a in "$@"; do',
  '  if [ "$a" = -regextype ]; then echo "bfs: error: Unsupported regex type." >&2; exit 1; fi',
  'done',
  'printf "%s\\n" "$@"',
  '',
].join('\n');
const BFS_OK = '#!/bin/sh\nprintf "%s\\n" "$@"\n';
const BFS_BROKEN = '#!/bin/sh\necho "bfs: error: broken." >&2\nexit 1\n';

// Generate a snapshot the way the bundle does (a shell writing $SNAPSHOT_FILE through a
// heredoc), with the patched child_process rewriting it and running the skew probe
// against the given stand-in bfs. Returns the snapshot path and the probe's stderr.
function generate(bfsBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-onig-'));
  const bfs = path.join(dir, 'bfs');
  fs.writeFileSync(bfs, bfsBody, { mode: 0o755 });
  const ugrep = path.join(dir, 'ugrep');
  fs.writeFileSync(ugrep, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'shell-snapshots'));
  const snap = path.join(dir, 'shell-snapshots', 'snapshot-onig-1.sh');
  const cmd = [
    `SNAPSHOT_FILE=${snap}`,
    `echo "# Snapshot file" >| "$SNAPSHOT_FILE"`,
    `cat >> "$SNAPSHOT_FILE" << 'SHADOW_END'`,
    'function find {',
    '  local _cc_bin="${CLAUDE_CODE_EXECPATH:-}"',
    '  ARGV0=bfs "$_cc_bin" -S dfs -regextype findutils-default ${1+"$@"}',
    '}',
    'SHADOW_END',
  ].join('\n');
  const prev = { b: process.env.CLODE_BFS, u: process.env.CLODE_UGREP };
  process.env.CLODE_BFS = bfs; process.env.CLODE_UGREP = ugrep;
  const orig = process.stderr.write;
  let err = '';
  process.stderr.write = (s) => { err += s; return true; };
  try { cp.execFileSync('sh', ['-c', cmd]); } finally {
    process.stderr.write = orig;
    for (const [k, v] of [['CLODE_BFS', prev.b], ['CLODE_UGREP', prev.u]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return { dir, bfs, snap, err, text: fs.readFileSync(snap, 'utf8') };
}
function runIn(shell, g, cmd) {
  const env = { ...process.env, CLODE_BFS: g.bfs, CLODE_T_CMD: cmd };
  delete env.BASH_ENV; delete env.ENV;
  return cp.spawnSync(shell.bin, [...shell.args, `. '${g.snap}' && eval "$CLODE_T_CMD"`],
    { cwd: g.dir, env, encoding: 'utf8' });
}

test('a bfs without Oniguruma: the probe drops only -regextype, and says find still works', { skip: SKIP }, () => {
  const g = generate(BFS_NO_ONIG);
  assert.match(g.text, /\n {2}"\$_bin" -S dfs "\$@"\n/, `find does not run with -S dfs alone:\n${g.text}`);
  assert.doesNotMatch(g.text, /"\$_bin" -S dfs -regextype/);
  assert.doesNotMatch(g.text, /known applet skew/, 'the every-find skew trailer must not be used');
  // the session-start line is honest: find works, regex finds do not
  assert.match(g.err, /`find` works/);
  assert.match(g.err, /-regex, -iregex or -regextype/);
  assert.doesNotMatch(g.err, /`find` will fail/);
});

for (const shell of SHELLS) {
  const skip = SKIP || (shell.bin ? false : `${shell.name} is not installed on this host`);
  test(`${shell.name}: without Oniguruma, a plain find runs (with -S dfs) and succeeds`, { skip }, () => {
    const g = generate(BFS_NO_ONIG);
    const r = runIn(shell, g, 'find . -name x; echo rc=$?');
    assert.strictEqual(r.stdout, '-S\ndfs\n.\n-name\nx\nrc=0\n', `stderr: ${r.stderr}`);
    assert.strictEqual(r.stderr, '');
  });
  test(`${shell.name}: without Oniguruma, a -regex find fails loud with the fix, and never runs`, { skip }, () => {
    const g = generate(BFS_NO_ONIG);
    for (const flag of ['-regex', '-iregex', '-regextype']) {
      const r = runIn(shell, g, `find . ${flag} '.*x'; echo rc=$?`);
      assert.strictEqual(r.stdout, 'rc=1\n', `${flag}: the applet ran, or the status is wrong (stderr: ${r.stderr})`);
      assert.match(r.stderr, /clode: this find uses a regex/, flag);
      assert.match(r.stderr, /Oniguruma/, flag);
    }
  });
  test(`${shell.name}: a bfs that accepts findutils-default runs upstream's flags unchanged`, { skip }, () => {
    const g = generate(BFS_OK);
    assert.match(g.text, /\n {2}"\$_bin" -S dfs -regextype findutils-default "\$@"\n/);
    assert.strictEqual(g.err, '');
    const r = runIn(shell, g, `find . -regex '.*x'; echo rc=$?`);
    assert.strictEqual(r.stdout, '-S\ndfs\n-regextype\nfindutils-default\n.\n-regex\n.*x\nrc=0\n', `stderr: ${r.stderr}`);
  });
}

test('a bfs that rejects even -S dfs keeps the every-find skew trailer', { skip: SKIP }, () => {
  const g = generate(BFS_BROKEN);
  assert.match(g.text, /known applet skew/);
  assert.match(g.err, /`find` will fail/);
});

test('warnAppletSkew records the degraded finding for /doctor, with an honest why', () => {
  const prev = process.env.CLODE_BFS;
  process.env.CLODE_BFS = '/fake/bfs-no-onig-doctor';
  const spawn = (bin, args) => (args.includes('-regextype')
    ? { status: 1, stdout: '', stderr: 'bfs: error: Unsupported regex type.' }
    : { status: 0, stdout: '', stderr: '' });
  const orig = process.stderr.write;
  process.stderr.write = () => true;
  let f;
  try {
    f = warnAppletSkew([{ name: 'find', applet: 'bfs', env: 'CLODE_BFS', flags: '-S dfs -regextype findutils-default' }], spawn);
  } finally {
    process.stderr.write = orig;
    if (prev === undefined) delete process.env.CLODE_BFS; else process.env.CLODE_BFS = prev;
  }
  assert.strictEqual(f.length, 1);
  assert.deepStrictEqual(f[0].degraded, { flags: '-S dfs', dropped: '-regextype findutils-default' });
  assert.match(f[0].why, /Unsupported regex type/);
  assert.match(f[0].why, /find still works/);
  const recorded = globalThis.__clodeDoctor.appletSkew.find((x) => x === f[0] || (x.degraded && x.why === f[0].why));
  assert.ok(recorded, 'the degraded finding must reach /doctor');
  // and the rewrite that takes this finding builds the degraded body
  const out = rewriteSnapshot('function find {\n  local _cc_bin="${CLAUDE_CODE_EXECPATH:-}"\n'
    + '  ARGV0=bfs "$_cc_bin" -S dfs -regextype findutils-default ${1+"$@"}\n}\n', f);
  assert.match(out, /-regex\|-iregex\|-regextype\) printf/);
  assert.match(out, /\n {2}"\$_bin" -S dfs "\$@"\n/);
});
