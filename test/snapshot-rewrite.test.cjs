// test/snapshot-rewrite.test.cjs
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { rewriteSnapshot, collectShadows, warnAppletSkew, CLODE_SHADOWS } = require('../libexec/bun-shim.cjs');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

// Real-POSIX-shell integration: these tests spawn `sh` to generate a snapshot file. Gate them on a
// working sh (WSL/Linux/macOS; Windows only if Git Bash sh is on PATH). The rewrite LOGIC is covered
// by the pure-string rewriteSnapshot(...) tests above, so gating loses no coverage.
const HAS_SH = (() => {
  try { return require('node:child_process').spawnSync('sh', ['-c', 'exit 0']).status === 0; }
  catch { return false; }
})();
// Also skip on Windows: even with Git Bash `sh` on PATH (as under CI's `shell: bash`), a
// Windows `C:\…` snapshot path embedded UNQUOTED in the POSIX shell script gets its
// backslashes eaten as shell escapes, collapsing the whole path into ONE separator-less
// RELATIVE filename — so the generator writes litter like
// `C:UsersschmonzAppDataLocalTemp...snapshot-zsh-1.sh` into the test cwd (observed Jul 5
// 2026 in the repo root) and the assertion's readFileSync of the intended path ENOENTs.
// POSIX-shell snapshot GENERATION has no Windows analog. The rewrite LOGIC is covered
// cross-platform by the pure-string rewriteSnapshot(...) tests above.
const SH_SKIP = (process.platform === 'win32')
  ? 'POSIX-shell snapshot generation has no Windows analog (rewrite logic covered by the rewriteSnapshot string tests)'
  : (HAS_SH ? false : 'needs a POSIX shell (sh) to generate + verify a snapshot file; rewrite logic covered by the rewriteSnapshot string tests');

test('rewriteSnapshot: leaves text with no shadows unchanged', () => {
  const plain = 'export PATH=/usr/bin\nfunction hello { echo hi; }\n';
  assert.strictEqual(rewriteSnapshot(plain), plain);
});

test('rewriteSnapshot: leaves a user function named mygrep untouched', () => {
  const out = rewriteSnapshot(fx('snapshot-execpath.sh'));
  assert.match(out, /function mygrep \{ command grep --color=auto "\$@"; \}/);
});

test('rewriteSnapshot: grep shadow execs real ugrep with the upstream flags', () => {
  const out = rewriteSnapshot(fx('snapshot-execpath.sh'));
  // the rebuilt grep function resolves a real ugrep with override + fail-loud
  assert.match(out, /local _bin="\$\{CLODE_UGREP:-\$\(command -v ugrep 2>\/dev\/null\)\}"/);
  assert.match(out, /clode: grep needs 'ugrep'/);
  // the upstream flag list is preserved verbatim and exec'd
  assert.match(out, /exec "\$_bin" -G --ignore-files --hidden -I --exclude-dir=\.git --exclude-dir=\.svn "\$@"/);
  // the original native-multiplexer invocation is gone
  assert.doesNotMatch(out, /ARGV0=ugrep/);
  assert.doesNotMatch(out, /_cc_bin/);
  // the passthrough guard (config/pager flags fall back to real grep) is preserved
  assert.match(out, /case "\$_cc_a" in -\*-filter\*/);
});

test('rewriteSnapshot: find shadow execs real bfs with upstream flags', () => {
  const out = rewriteSnapshot(fx('snapshot-execpath.sh'));
  assert.match(out, /local _bin="\$\{CLODE_BFS:-\$\(command -v bfs 2>\/dev\/null\)\}"/);
  assert.match(out, /exec "\$_bin" -S dfs -regextype findutils-default "\$@"/);
  assert.match(out, /clode: find needs 'bfs'/);
  assert.doesNotMatch(out, /ARGV0=bfs/);
});

test('rewriteSnapshot: works on install-path-style snapshots too (resolver-agnostic)', () => {
  const out = rewriteSnapshot(fx('snapshot-installpath.sh'));
  assert.match(out, /exec "\$_bin" -G --ignore-files --hidden -I --exclude-dir=\.git "\$@"/);
  assert.match(out, /exec "\$_bin" -S dfs -regextype findutils-default "\$@"/);
  assert.doesNotMatch(out, /_cc_bin|ARGV0=/);
});

test('rewriteSnapshot: rewrites an rg shadow when present', () => {
  const snap = 'function rg {\n  local _cc_bin="$HOME/.local/bin/claude"\n' +
    '  ARGV0=rg "$_cc_bin" --color=never "$@"\n}\n';
  const out = rewriteSnapshot(snap);
  assert.match(out, /local _bin="\$\{CLODE_RG:-\$\(command -v rg 2>\/dev\/null\)\}"/);
  assert.match(out, /exec "\$_bin" --color=never "\$@"/);
});

test('rewriteSnapshot: throws on a multiplexer shadow with an unknown applet', () => {
  const snap = 'function sk {\n  local _cc_bin="${CLAUDE_CODE_EXECPATH:-}"\n' +
    '  ARGV0=skim "$_cc_bin" --tac "$@"\n}\n';
  assert.throws(() => rewriteSnapshot(snap), /unrecognized search shadow function sk -> skim/);
});

test('rewriteSnapshot: throws if a known command shadows an unexpected applet', () => {
  const snap = 'function grep {\n  local _cc_bin="${CLAUDE_CODE_EXECPATH:-}"\n' +
    '  ARGV0=ripgrep "$_cc_bin" -n "$@"\n}\n';
  assert.throws(() => rewriteSnapshot(snap), /unrecognized search shadow function grep -> ripgrep/);
});

test('rewriteSnapshot: handles a } inside a quoted string in the shadow body', () => {
  const snap = [
    'function grep {',
    '  echo "warn: bad input }"',
    '  local _cc_bin="${CLAUDE_CODE_EXECPATH:-}"',
    '  ARGV0=ugrep "$_cc_bin" -G --ignore-files "$@"',
    '}',
  ].join('\n');
  const out = rewriteSnapshot(snap);
  assert.match(out, /exec "\$_bin" -G --ignore-files "\$@"/);
  assert.doesNotMatch(out, /ARGV0=ugrep/);
  // the quoted-string line with the stray } must be preserved in the rebuilt body?
  // NOTE: the rebuilt shadow REPLACES the whole body, so the echo line is intentionally
  // dropped (the rewrite emits a clean exec form). We only require the shadow is rewritten.
});

test('rewriteSnapshot: handles a { inside a quoted string in the shadow body', () => {
  const snap = [
    'function find {',
    "  echo 'open brace { in single quotes'",
    '  local _cc_bin="${CLAUDE_CODE_EXECPATH:-}"',
    '  ARGV0=bfs "$_cc_bin" -S dfs "$@"',
    '}',
    'function after { echo untouched; }',
  ].join('\n');
  const out = rewriteSnapshot(snap);
  assert.match(out, /exec "\$_bin" -S dfs "\$@"/);
  assert.doesNotMatch(out, /ARGV0=bfs/);
  // the following unrelated function must remain intact (proves matchBrace found the right end)
  assert.match(out, /function after \{ echo untouched; \}/);
});

// --- applet skew probe (collectShadows / warnAppletSkew) ---

const skewSnap = [
  'function grep {',
  '  local _cc_bin="${CLAUDE_CODE_EXECPATH:-}"',
  '  ARGV0=ugrep "$_cc_bin" -G --ignore-files "$@"',
  '}',
  'function find {',
  '  local _cc_bin="${CLAUDE_CODE_EXECPATH:-}"',
  '  ARGV0=bfs "$_cc_bin" -S dfs -regextype findutils-default "$@"',
  '}',
].join('\n');

test('collectShadows: returns known shadows with applet/env/flags, skips unknown', () => {
  const shadows = collectShadows(skewSnap);
  assert.deepStrictEqual(shadows, [
    { name: 'grep', applet: 'ugrep', env: 'CLODE_UGREP', flags: '-G --ignore-files' },
    { name: 'find', applet: 'bfs', env: 'CLODE_BFS', flags: '-S dfs -regextype findutils-default' },
  ]);
});

test('CLODE_SHADOWS probe specs: build a no-op invocation + skew predicate', () => {
  const find = CLODE_SHADOWS.find.probe(['-S', 'dfs', '-regextype', 'findutils-default']);
  assert.deepStrictEqual(find.args, ['-S', 'dfs', '-regextype', 'findutils-default', '-quit', '.']);
  assert.strictEqual(find.skew(0), false);   // accepted
  assert.strictEqual(find.skew(1), true);    // bfs errors with exit 1
  const grep = CLODE_SHADOWS.grep.probe(['-G']);
  assert.deepStrictEqual(grep.args, ['-G', '-e', 'x', '/dev/null']);
  assert.strictEqual(grep.skew(1), false);   // 1 == "no match", not skew
  assert.strictEqual(grep.skew(2), true);    // 2 == usage error
});

// A mock spawn that reports a chosen exit code + stderr, injected into warnAppletSkew.
// This exercises the skew-probe LOGIC without a real executable stub, so it runs on
// every platform (a `#!/bin/sh` stub isn't runnable on Windows).
function mockSpawn(code, stderr) {
  return () => ({ status: code, stdout: '', stderr });
}

function captureStderr(fn) {
  const orig = process.stderr.write;
  let buf = '';
  process.stderr.write = (s) => { buf += s; return true; };
  try { fn(); } finally { process.stderr.write = orig; }
  return buf;
}

test('warnAppletSkew: warns, naming the rejected flag, when the host applet errors on the flags', () => {
  const prev = process.env.CLODE_BFS;
  process.env.CLODE_BFS = '/fake/bfs';
  const spawn = mockSpawn(1, "bfs: error: Unsupported -regextype 'findutils-default'.");
  try {
    const out = captureStderr(() => warnAppletSkew(collectShadows(skewSnap), spawn));
    assert.match(out, /host bfs rejects the flags/);
    assert.match(out, /Unsupported -regextype 'findutils-default'/);
    // applet-specific remedy: bfs needs an Oniguruma-enabled build, not just an "upgrade"
    assert.match(out, /install bfs ≥ 3\.3 built with Oniguruma, or set CLODE_BFS to such a build/);
    assert.doesNotMatch(out, /upgrade it/);
  } finally {
    if (prev === undefined) delete process.env.CLODE_BFS; else process.env.CLODE_BFS = prev;
  }
});

test('warnAppletSkew: silent when the host applet accepts the flags', () => {
  const prev = process.env.CLODE_BFS;
  process.env.CLODE_BFS = '/fake/bfs';
  const spawn = mockSpawn(0, '');
  try {
    const out = captureStderr(() => warnAppletSkew([
      { name: 'find', applet: 'bfs', env: 'CLODE_BFS', flags: '-S dfs' },
    ], spawn));
    assert.strictEqual(out, '');
  } finally {
    if (prev === undefined) delete process.env.CLODE_BFS; else process.env.CLODE_BFS = prev;
  }
});

test('warnAppletSkew: records findings on globalThis.__clodeDoctor for the /doctor hook', () => {
  const prev = process.env.CLODE_BFS;
  process.env.CLODE_BFS = '/fake/bfs';
  const spawn = mockSpawn(1, "bfs: error: Unsupported -regextype 'findutils-default'.");
  try {
    // unique flags => fresh dedupe key, independent of other tests in this file
    captureStderr(() => warnAppletSkew([
      { name: 'find', applet: 'bfs', env: 'CLODE_BFS', flags: '-regextype doctor-hook-unique' },
    ], spawn));
    assert.ok(globalThis.__clodeDoctor && Array.isArray(globalThis.__clodeDoctor.appletSkew),
      'expected globalThis.__clodeDoctor.appletSkew array');
    const f = globalThis.__clodeDoctor.appletSkew.find((x) => x.why.includes('doctor-hook') || x.why.includes('Unsupported'));
    assert.ok(f, 'expected the recorded bfs skew finding');
    assert.strictEqual(f.name, 'find');
    assert.strictEqual(f.applet, 'bfs');
    assert.match(f.why, /Unsupported -regextype/);
    // the finding carries the applet-specific remedy so the /doctor hook renders it too
    assert.match(f.fix, /Oniguruma/);
  } finally {
    if (prev === undefined) delete process.env.CLODE_BFS; else process.env.CLODE_BFS = prev;
  }
});

const cp = require('node:child_process');

// Build a snapshot-generator command exactly like the bundle does: a shell script
// that, when run, writes $SNAPSHOT_FILE with the grep/find shadows via a heredoc.
function snapshotCmd(snapPath){
  return [
    `SNAPSHOT_FILE=${snapPath}`,
    `echo "# Snapshot file" >| "$SNAPSHOT_FILE"`,
    `cat >> "$SNAPSHOT_FILE" << 'SHADOW_END'`,
    `function grep {`,
    `  local _cc_bin="\${CLAUDE_CODE_EXECPATH:-}"`,
    `  ARGV0=ugrep "$_cc_bin" -G --ignore-files --hidden -I --exclude-dir=.git "$@"`,
    `}`,
    `function find {`,
    `  local _cc_bin="\${CLAUDE_CODE_EXECPATH:-}"`,
    `  ARGV0=bfs "$_cc_bin" -S dfs -regextype findutils-default "$@"`,
    `}`,
    `SHADOW_END`,
  ].join('\n');
}

test('child_process.execFileSync rewrites the snapshot-generator command (shell writes real-applet shadows)', { skip: SH_SKIP }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-cp-'));
  fs.mkdirSync(path.join(dir, 'shell-snapshots'));
  const snap = path.join(dir, 'shell-snapshots', 'snapshot-zsh-1.sh');
  cp.execFileSync('sh', ['-c', snapshotCmd(snap)]);
  const got = fs.readFileSync(snap, 'utf8');
  assert.doesNotMatch(got, /ARGV0=ugrep|ARGV0=bfs|_cc_bin/);
  assert.match(got, /exec "\$_bin" -G --ignore-files/);
  assert.match(got, /exec "\$_bin" -S dfs -regextype findutils-default/);
});

test('child_process.execFile (async) rewrites the snapshot-generator command', { skip: SH_SKIP }, (t, done) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-cp-'));
  fs.mkdirSync(path.join(dir, 'shell-snapshots'));
  const snap = path.join(dir, 'shell-snapshots', 'snapshot-zsh-2.sh');
  cp.execFile('sh', ['-c', snapshotCmd(snap)], (err) => {
    try {
      assert.ifError(err);
      const got = fs.readFileSync(snap, 'utf8');
      assert.doesNotMatch(got, /ARGV0=ugrep/);
      assert.match(got, /exec "\$_bin" -G --ignore-files/);
      done();
    } catch (e) { done(e); }
  });
});

test('child_process passes through non-snapshot commands unchanged', { skip: SH_SKIP }, () => {
  const out = cp.execFileSync('sh', ['-c', 'echo hello-world']).toString();
  assert.match(out, /hello-world/);
});

test('child_process.spawnSync rewrites the snapshot-generator command', { skip: SH_SKIP }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-cp-'));
  fs.mkdirSync(path.join(dir, 'shell-snapshots'));
  const snap = path.join(dir, 'shell-snapshots', 'snapshot-zsh-3.sh');
  cp.spawnSync('sh', ['-c', snapshotCmd(snap)]);
  const got = fs.readFileSync(snap, 'utf8');
  assert.match(got, /exec "\$_bin" -G --ignore-files/);
  assert.doesNotMatch(got, /ARGV0=ugrep/);
});
