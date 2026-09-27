'use strict';
// THE RULE (SHADOW_ARG_SPELLINGS, libexec/bun-shim.cjs parseShadow): an upstream
// shadow's applet call is `"$_cc_bin" <flags> <args>`, where <args> is `${1+"$@"}` or
// `"$@"`, and the flags are everything in between. The rewrite keeps those flags, so
// the host applet runs the way upstream's embedded one would. A call that ends any other
// way is UNPARSED: it is never read as "no flags".
//
// Why this exists: every carve on the dev box from 2.1.185 to 2.1.283 spells the args
// `${1+"$@"}`, and parseShadow only knew `"$@"` (the spelling the older fixtures use).
// So against a REAL snapshot it read every shadow as flagless. The Bash tool's grep ran
// ugrep WITHOUT `-G --ignore-files --hidden -I --exclude-dir=...` (it searched
// .gitignored files, unlike native), find ran bfs without `-S dfs -regextype
// findutils-default`, and the skew probe had nothing to probe. Every fixture used
// `"$@"`, so nothing was red. Measured 2026-09-26 on a real native 2.1.283 snapshot.
//
// test/fixtures/snapshot-2.1.283.sh is that snapshot's shadow text, verbatim (its header
// records the provenance).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { rewriteSnapshot, collectShadows } = require('../libexec/bun-shim.cjs');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const SNAP_283 = fx('snapshot-2.1.283.sh');
const SNAP_OLD = fx('snapshot-execpath.sh');

const GREP_FLAGS_283 = '-G --ignore-files --hidden -I --exclude-dir=.git --exclude-dir=.svn '
  + '--exclude-dir=.hg --exclude-dir=.bzr --exclude-dir=.jj --exclude-dir=.sl';
const FIND_FLAGS = '-S dfs -regextype findutils-default';

// ---- the parse, both spellings -------------------------------------------------------
test('2.1.283 spelling ${1+"$@"}: collectShadows reads every upstream flag', () => {
  assert.deepStrictEqual(collectShadows(SNAP_283), [
    { name: 'rg', applet: 'rg', env: 'CLODE_UGREP', flags: '' },
    { name: 'find', applet: 'bfs', env: 'CLODE_BFS', flags: FIND_FLAGS },
    { name: 'grep', applet: 'ugrep', env: 'CLODE_UGREP', flags: GREP_FLAGS_283 },
  ]);
});

test('the older spelling "$@" still reads every upstream flag', () => {
  assert.deepStrictEqual(collectShadows(SNAP_OLD), [
    { name: 'find', applet: 'bfs', env: 'CLODE_BFS', flags: FIND_FLAGS },
    { name: 'grep', applet: 'ugrep', env: 'CLODE_UGREP',
      flags: '-G --ignore-files --hidden -I --exclude-dir=.git --exclude-dir=.svn' },
  ]);
});

test('rewriteSnapshot of the 2.1.283 snapshot runs each applet WITH upstream\'s flags', () => {
  const out = rewriteSnapshot(SNAP_283);
  assert.ok(out.includes(`\n  "$_bin" ${GREP_FLAGS_283} "$@"\n`), `grep flags missing:\n${out}`);
  assert.ok(out.includes(`\n  "$_bin" ${FIND_FLAGS} "$@"\n`), `find flags missing:\n${out}`);
  assert.doesNotMatch(out, /\n {2}"\$_bin" "\$@"\n/, 'a shadow was rebuilt with no flags');
  assert.doesNotMatch(out, /_cc_bin|ARGV0=|exec -a /);
  assert.strictEqual((out.match(/function rg \{/g) || []).length, 1);
  assert.doesNotMatch(out, /clode: could not read upstream/);
});

// ---- an unrecognized spelling stays LOUD ----------------------------------------------
const oddShadow = (callTail) => [
  'function grep {',
  '  local _cc_bin="${CLAUDE_CODE_EXECPATH:-}"',
  `  ARGV0=ugrep "$_cc_bin" ${callTail}`,
  '}',
].join('\n');

test('an argument spelling it does not know is reported, never read as "no flags"', () => {
  const snap = oddShadow('-G --ignore-files $*');
  const [sh] = collectShadows(snap);
  assert.strictEqual(sh.flags, '');
  assert.match(sh.unparsed, /-G --ignore-files \$\*/);
  const out = rewriteSnapshot(snap);
  // the marker travels in the rewritten function, where the flags would have been
  assert.match(out, /# clode: could not read upstream's flags for grep/);
  assert.match(out, /\n {2}"\$_bin" "\$@"\n/);   // still routed to the host applet
});

test('flags that would expand shell text are reported, not copied into a function without upstream\'s locals', () => {
  for (const tail of ['-G --exclude-dir=$HOME ${1+"$@"}', '-G `cmd` ${1+"$@"}', '-G $(cmd) "$@"']) {
    const [sh] = collectShadows(oddShadow(tail));
    assert.strictEqual(sh.flags, '', tail);
    assert.match(sh.unparsed, /flags expand shell text/, tail);
  }
});

test('an unparsed shadow reaches /doctor, and an unparsed rg says rg is unaffected', { skip: process.platform === 'win32' ? 'POSIX-shell snapshot generation has no Windows analog' : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-flags-doctor-'));
  fs.mkdirSync(path.join(dir, 'shell-snapshots'));
  for (const stub of ['bfs', 'ugrep']) fs.writeFileSync(path.join(dir, stub), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const snap = path.join(dir, 'shell-snapshots', 'snapshot-odd-2.sh');
  const cmd = [
    `SNAPSHOT_FILE=${snap}`,
    `echo "# Snapshot file" >| "$SNAPSHOT_FILE"`,
    `cat >> "$SNAPSHOT_FILE" << 'SHADOW_END'`,
    oddShadow('-G --doctor-row-unique $*'),
    'function rg {',
    '  local _cc_bin="${CLAUDE_CODE_EXECPATH:-}"',
    '  ARGV0=rg "$_cc_bin" --rg-doctor-unique $*',
    '}',
    'SHADOW_END',
  ].join('\n');
  const prev = { b: process.env.CLODE_BFS, u: process.env.CLODE_UGREP };
  process.env.CLODE_BFS = path.join(dir, 'bfs'); process.env.CLODE_UGREP = path.join(dir, 'ugrep');
  const orig = process.stderr.write;
  let err = '';
  process.stderr.write = (s) => { err += s; return true; };
  try { cp.execFileSync('sh', ['-c', cmd]); } finally {
    process.stderr.write = orig;
    for (const [k, v] of [['CLODE_BFS', prev.b], ['CLODE_UGREP', prev.u]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  const recorded = (globalThis.__clodeDoctor && globalThis.__clodeDoctor.appletSkew) || [];
  const grepRow = recorded.find((f) => f.name === 'grep' && /doctor-row-unique/.test(f.issue || ''));
  assert.ok(grepRow, `no /doctor record for the unparsed grep: ${JSON.stringify(recorded)}`);
  assert.match(grepRow.issue, /it runs ugrep without them/);
  assert.match(err, /rg is translated to ugrep and never uses upstream's flags, so nothing changes/);
  assert.doesNotMatch(err, /it runs rg without them/);
});

test('branches that disagree on the flags are reported, not guessed', () => {
  const snap = [
    'function find {',
    '  local _cc_bin="${CLAUDE_CODE_EXECPATH:-}"',
    '  if [[ -n ${ZSH_VERSION:-} ]]; then',
    '    ARGV0=bfs "$_cc_bin" -S dfs ${1+"$@"}',
    '  else',
    '    (exec -a bfs "$_cc_bin" -S bfs ${1+"$@"})',
    '  fi',
    '}',
  ].join('\n');
  const [sh] = collectShadows(snap);
  assert.strictEqual(sh.flags, '');
  assert.match(sh.unparsed, /disagree/);
});

test('an unparsed shadow warns on stderr when a real snapshot command is rewritten', { skip: process.platform === 'win32' ? 'POSIX-shell snapshot generation has no Windows analog' : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-flags-warn-'));
  fs.mkdirSync(path.join(dir, 'shell-snapshots'));
  for (const stub of ['bfs', 'ugrep']) fs.writeFileSync(path.join(dir, stub), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const snap = path.join(dir, 'shell-snapshots', 'snapshot-odd-1.sh');
  const cmd = [
    `SNAPSHOT_FILE=${snap}`,
    `echo "# Snapshot file" >| "$SNAPSHOT_FILE"`,
    `cat >> "$SNAPSHOT_FILE" << 'SHADOW_END'`,
    oddShadow('-G --warn-row-unique $*'),
    'SHADOW_END',
  ].join('\n');
  const prev = { b: process.env.CLODE_BFS, u: process.env.CLODE_UGREP };
  process.env.CLODE_BFS = path.join(dir, 'bfs'); process.env.CLODE_UGREP = path.join(dir, 'ugrep');
  const orig = process.stderr.write;
  let err = '';
  process.stderr.write = (s) => { err += s; return true; };
  try {
    cp.execFileSync('sh', ['-c', cmd]);   // the patched child_process rewrites it
  } finally {
    process.stderr.write = orig;
    for (const [k, v] of [['CLODE_BFS', prev.b], ['CLODE_UGREP', prev.u]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  assert.match(err, /clode: could not read upstream's flags for the grep shadow/);
  assert.match(fs.readFileSync(snap, 'utf8'), /# clode: could not read upstream's flags for grep/);
});

// ---- end to end: the rewritten shadows, sourced into bash and zsh ----------------------
function which(name) {
  const r = cp.spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}
const SHELLS = process.platform === 'win32' ? [] : [
  { name: 'bash', bin: which('bash'), args: ['-c'] },
  { name: 'zsh', bin: which('zsh'), args: ['-f', '-c'] },
];
const shellSkip = (sh) => (sh.bin ? false : `${sh.name} is not installed on this host`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-flags-'));
const snapFile = path.join(work, 'snap.sh');
fs.writeFileSync(snapFile, rewriteSnapshot(SNAP_283));
function runIn(shell, cwd, cmd, env) {
  const e = { ...process.env, ...env, CLODE_T_CMD: cmd };
  delete e.BASH_ENV; delete e.ENV;
  return cp.spawnSync(shell.bin, [...shell.args, `. '${snapFile}' && eval "$CLODE_T_CMD"`],
    { cwd, env: e, encoding: 'utf8' });
}

// A stand-in applet that reports the argv it was handed, one per line.
const argvStub = path.join(work, 'argv-applet');
fs.writeFileSync(argvStub, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });

for (const shell of SHELLS) {
  test(`${shell.name}: the rewritten grep and find hand the applet upstream's flags, then the user's`, { skip: shellSkip(shell) }, () => {
    const env = { CLODE_UGREP: argvStub, CLODE_BFS: argvStub };
    const g = runIn(shell, work, 'grep -rl NEEDLE .', env);
    assert.deepStrictEqual(g.stdout.trim().split('\n'), [...GREP_FLAGS_283.split(' '), '-rl', 'NEEDLE', '.'], g.stderr);
    const f = runIn(shell, work, 'find . -name x', env);
    assert.deepStrictEqual(f.stdout.trim().split('\n'), [...FIND_FLAGS.split(' '), '.', '-name', 'x'], f.stderr);
  });
}

// The flags' POINT, measured with the real applets: upstream's grep skips .gitignored
// files and VCS directories and searches hidden files. The oracle is the host ugrep run
// directly with upstream's own flags; the rewritten shadow must agree with it, and must
// leave the .gitignored file out.
const UGREP = which('ugrep');
const BFS = which('bfs');
function gitignoreTree() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-flags-tree-'));
  fs.writeFileSync(path.join(d, '.gitignore'), 'ignored.txt\n');
  fs.writeFileSync(path.join(d, 'ignored.txt'), 'NEEDLE\n');
  fs.writeFileSync(path.join(d, 'kept.txt'), 'NEEDLE\n');
  fs.writeFileSync(path.join(d, '.hidden.txt'), 'NEEDLE\n');
  fs.mkdirSync(path.join(d, '.git'));
  fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'NEEDLE\n');
  fs.mkdirSync(path.join(d, 'sub'));
  fs.writeFileSync(path.join(d, 'sub', 'deep.txt'), 'NEEDLE\n');
  return d;
}
const lines = (s) => s.split('\n').filter(Boolean).sort();

for (const shell of SHELLS) {
  const skip = shellSkip(shell) || (UGREP ? false : 'needs a host ugrep (not installed)');
  test(`${shell.name}: the rewritten grep skips a .gitignored file, exactly as upstream's flags say`, { skip }, () => {
    const d = gitignoreTree();
    const oracle = cp.spawnSync(UGREP, [...GREP_FLAGS_283.split(' '), '-rl', 'NEEDLE', '.'], { cwd: d, encoding: 'utf8' });
    const got = runIn(shell, d, 'grep -rl NEEDLE .', { CLODE_UGREP: UGREP });
    assert.deepStrictEqual(lines(got.stdout), lines(oracle.stdout), got.stderr);
    assert.ok(!lines(got.stdout).some((f) => /ignored\.txt$/.test(f)), `listed a .gitignored file: ${got.stdout}`);
    assert.ok(!lines(got.stdout).some((f) => /\.git\//.test(f)), `searched .git: ${got.stdout}`);
    assert.ok(lines(got.stdout).some((f) => /kept\.txt$/.test(f)), `missed kept.txt: ${got.stdout}`);
    // upstream's --hidden: a hidden file IS searched
    assert.ok(lines(got.stdout).some((f) => /(^|\/)\.hidden\.txt$/.test(f)), `missed .hidden.txt: ${got.stdout}`);
  });
}

// find: `-regextype findutils-default` is what makes an emacs-style -regex mean what GNU
// find means. Only a bfs built with Oniguruma accepts it; on a bfs without it, the rewritten
// find drops that flag and refuses regex finds (FIND_WITHOUT_ONIGURUMA,
// find-without-oniguruma.test.cjs). So these rows skip on the dev Mac (pkgsrc bfs
// --without-oniguruma) and on CI's apt bfs 3.1.2 (regex types other than POSIX arrived in
// bfs 3.3). They last PASSED on NetBSD 11 arm64, pkgsrc bfs 4.1.3, node 24.18.0,
// 2026-09-27, with the whole file 14/14.
const BFS_ACCEPTS = BFS && cp.spawnSync(BFS, [...FIND_FLAGS.split(' '), '-quit', '.']).status === 0;
for (const shell of SHELLS) {
  const skip = shellSkip(shell) || (!BFS ? 'needs a host bfs (not installed)'
    : (BFS_ACCEPTS ? false : 'host bfs rejects -regextype findutils-default (a POSIX-only build); the rewritten find carries the skew trailer instead'));
  test(`${shell.name}: the rewritten find applies upstream's regex type`, { skip }, () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-flags-find-'));
    for (const n of ['foo', 'far', 'fzz']) fs.writeFileSync(path.join(d, n), '');
    const regex = '.*/f\\(oo\\|ar\\)';   // emacs syntax: groups and alternation are escaped
    const got = runIn(shell, d, `find . -regex '${regex}'`, { CLODE_BFS: BFS });
    assert.deepStrictEqual(lines(got.stdout), ['./far', './foo'], got.stderr);
  });
}
