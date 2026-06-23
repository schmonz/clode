// test/snapshot-rewrite.test.cjs
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { rewriteSnapshot } = require('../libexec/bun-shim.cjs');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

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

test('child_process.execFileSync rewrites the snapshot-generator command (shell writes real-applet shadows)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-cp-'));
  fs.mkdirSync(path.join(dir, 'shell-snapshots'));
  const snap = path.join(dir, 'shell-snapshots', 'snapshot-zsh-1.sh');
  cp.execFileSync('sh', ['-c', snapshotCmd(snap)]);
  const got = fs.readFileSync(snap, 'utf8');
  assert.doesNotMatch(got, /ARGV0=ugrep|ARGV0=bfs|_cc_bin/);
  assert.match(got, /exec "\$_bin" -G --ignore-files/);
  assert.match(got, /exec "\$_bin" -S dfs -regextype findutils-default/);
});

test('child_process.execFile (async) rewrites the snapshot-generator command', (t, done) => {
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

test('child_process passes through non-snapshot commands unchanged', () => {
  const out = cp.execFileSync('sh', ['-c', 'echo hello-world']).toString();
  assert.match(out, /hello-world/);
});

test('child_process.spawnSync rewrites the snapshot-generator command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-cp-'));
  fs.mkdirSync(path.join(dir, 'shell-snapshots'));
  const snap = path.join(dir, 'shell-snapshots', 'snapshot-zsh-3.sh');
  cp.spawnSync('sh', ['-c', snapshotCmd(snap)]);
  const got = fs.readFileSync(snap, 'utf8');
  assert.match(got, /exec "\$_bin" -G --ignore-files/);
  assert.doesNotMatch(got, /ARGV0=ugrep/);
});
