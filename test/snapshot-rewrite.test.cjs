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

// --- self-explaining skew failures: rewriteSnapshot(text, findings) ---------
// When the generation-time probe found skew, the rewritten shadow must explain
// the failure AT THE POINT OF USE: no exec (so the exit code can be inspected),
// a per-applet rc test, a clode-authored stderr line carrying the probe's why +
// fix, and the applet's own exit code propagated unchanged.

const findFinding = {
  name: 'find', applet: 'bfs',
  why: "bfs: error: Unsupported -regextype 'findutils-default'.",
  fix: 'install bfs ≥ 3.3 built with Oniguruma, or set CLODE_BFS to such a build',
};

test('rewriteSnapshot with a skew finding: shadow diagnoses on failure, exit code intact', () => {
  const out = rewriteSnapshot(skewSnap, [findFinding]);
  // the skewed find shadow: plain invocation (no exec), rc capture, applet rc test
  assert.doesNotMatch(out, /exec "\$_bin" -S dfs/);
  assert.match(out, /\n {2}"\$_bin" -S dfs -regextype findutils-default "\$@"\n/);
  assert.match(out, /local _rc=\$\?/);
  assert.match(out, /\[ "\$_rc" -ne 0 \] && printf/);
  assert.match(out, /known applet skew/);
  assert.match(out, /Oniguruma/);
  assert.match(out, /return \$_rc/);
  // the why's single quotes are shell-escaped, not raw (would end the quoted msg)
  assert.match(out, /'\\''findutils-default'\\''/);
  // the un-skewed grep shadow keeps the exec fast path
  assert.match(out, /function grep \{[\s\S]*?exec "\$_bin" -G --ignore-files "\$@"/);
});

test('rewriteSnapshot without findings is byte-identical to the 1-arg form', () => {
  assert.strictEqual(rewriteSnapshot(skewSnap, []), rewriteSnapshot(skewSnap));
});

test('CLODE_SHADOWS: each probe-bearing applet carries a shell rc test matching its skew predicate', () => {
  assert.strictEqual(CLODE_SHADOWS.grep.skewRcTest, '[ "$_rc" -ge 2 ]');
  assert.strictEqual(CLODE_SHADOWS.find.skewRcTest, '[ "$_rc" -ne 0 ]');
  assert.strictEqual(CLODE_SHADOWS.rg.skewRcTest, '[ "$_rc" -ge 2 ]');
});

test('warnAppletSkew RETURNS the findings for the shadows it was given', () => {
  const prev = process.env.CLODE_BFS;
  process.env.CLODE_BFS = '/fake/bfs-return';
  const spawn = mockSpawn(1, "bfs: error: Unsupported -regextype 'findutils-default'.");
  try {
    const shadows = [{ name: 'find', applet: 'bfs', env: 'CLODE_BFS', flags: '-regextype return-contract-unique' }];
    let f1, f2;
    captureStderr(() => { f1 = warnAppletSkew(shadows, spawn); });
    const err2 = captureStderr(() => { f2 = warnAppletSkew(shadows, spawn); });
    assert.strictEqual(f1.length, 1);
    assert.strictEqual(f1[0].name, 'find');
    assert.match(f1[0].why, /Unsupported -regextype/);
    assert.match(f1[0].fix, /Oniguruma/);
    // memoized second call: same finding back, but no duplicate stderr warning
    assert.strictEqual(f2.length, 1);
    assert.strictEqual(f2[0].name, 'find');
    assert.strictEqual(err2, '');
  } finally {
    if (prev === undefined) delete process.env.CLODE_BFS; else process.env.CLODE_BFS = prev;
  }
});

test('warnAppletSkew why skips the command echo + underline, keeps the real complaint', () => {
  const prev = process.env.CLODE_BFS;
  process.env.CLODE_BFS = '/fake/bfs-why';
  // real bfs shape: line 1 echoes the command (contains the bin path), line 2 is
  // the tilde underline, line 3 is the actual complaint
  const spawn = mockSpawn(1, [
    'bfs: error: /fake/bfs-why -S dfs -regextype why-extract-unique -quit .',
    'bfs: error:             ~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
    'bfs: error: Unsupported regex type.',
  ].join('\n'));
  try {
    let f;
    captureStderr(() => { f = warnAppletSkew([
      { name: 'find', applet: 'bfs', env: 'CLODE_BFS', flags: '-regextype why-extract-unique' },
    ], spawn); });
    assert.strictEqual(f[0].why, 'bfs: error: Unsupported regex type.');
  } finally {
    if (prev === undefined) delete process.env.CLODE_BFS; else process.env.CLODE_BFS = prev;
  }
});

test('warnAppletSkew returns [] when the applet accepts the flags', () => {
  const prev = process.env.CLODE_BFS;
  process.env.CLODE_BFS = '/fake/bfs-ok';
  try {
    captureStderr(() => {
      const f = warnAppletSkew([
        { name: 'find', applet: 'bfs', env: 'CLODE_BFS', flags: '-S dfs' },
      ], mockSpawn(0, ''));
      assert.deepStrictEqual(f, []);
    });
  } finally {
    if (prev === undefined) delete process.env.CLODE_BFS; else process.env.CLODE_BFS = prev;
  }
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

// The generation-time skew probe runs against whatever CLODE_BFS/CLODE_UGREP (or
// PATH) resolves, and a skewed host applet legitimately changes the emitted
// shadow (exec fast path vs skew trailer — see the skew tests below). These
// generator tests assert the EXEC form, so they pin the applets to accepting
// stubs to be deterministic on any host.
function withOkApplets(fn){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-okstub-'));
  for (const stub of ['bfs', 'ugrep']){
    fs.writeFileSync(path.join(dir, stub), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const prevBfs = process.env.CLODE_BFS, prevUgrep = process.env.CLODE_UGREP;
  process.env.CLODE_BFS = path.join(dir, 'bfs');
  process.env.CLODE_UGREP = path.join(dir, 'ugrep');
  const restore = () => {
    if (prevBfs === undefined) delete process.env.CLODE_BFS; else process.env.CLODE_BFS = prevBfs;
    if (prevUgrep === undefined) delete process.env.CLODE_UGREP; else process.env.CLODE_UGREP = prevUgrep;
  };
  let result;
  try { result = fn(restore); } catch (e) { restore(); throw e; }
  if (result !== 'deferred') restore();
}

test('child_process.execFileSync rewrites the snapshot-generator command (shell writes real-applet shadows)', { skip: SH_SKIP }, () => {
  withOkApplets(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-cp-'));
    fs.mkdirSync(path.join(dir, 'shell-snapshots'));
    const snap = path.join(dir, 'shell-snapshots', 'snapshot-zsh-1.sh');
    cp.execFileSync('sh', ['-c', snapshotCmd(snap)]);
    const got = fs.readFileSync(snap, 'utf8');
    assert.doesNotMatch(got, /ARGV0=ugrep|ARGV0=bfs|_cc_bin/);
    assert.match(got, /exec "\$_bin" -G --ignore-files/);
    assert.match(got, /exec "\$_bin" -S dfs -regextype findutils-default/);
  });
});

test('child_process.execFile (async) rewrites the snapshot-generator command', { skip: SH_SKIP }, (t, done) => {
  withOkApplets((restore) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-cp-'));
    fs.mkdirSync(path.join(dir, 'shell-snapshots'));
    const snap = path.join(dir, 'shell-snapshots', 'snapshot-zsh-2.sh');
    // the rewrite (and its probe) happen synchronously inside this call, but
    // restore in the callback anyway so env stays pinned for the whole run
    cp.execFile('sh', ['-c', snapshotCmd(snap)], (err) => {
      try {
        assert.ifError(err);
        const got = fs.readFileSync(snap, 'utf8');
        assert.doesNotMatch(got, /ARGV0=ugrep/);
        assert.match(got, /exec "\$_bin" -G --ignore-files/);
        done();
      } catch (e) { done(e); }
      finally { restore(); }
    });
    return 'deferred';
  });
});

test('child_process passes through non-snapshot commands unchanged', { skip: SH_SKIP }, () => {
  const out = cp.execFileSync('sh', ['-c', 'echo hello-world']).toString();
  assert.match(out, /hello-world/);
});

test('child_process.spawnSync rewrites the snapshot-generator command', { skip: SH_SKIP }, () => {
  withOkApplets(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-cp-'));
    fs.mkdirSync(path.join(dir, 'shell-snapshots'));
    const snap = path.join(dir, 'shell-snapshots', 'snapshot-zsh-3.sh');
    cp.spawnSync('sh', ['-c', snapshotCmd(snap)]);
    const got = fs.readFileSync(snap, 'utf8');
    assert.match(got, /exec "\$_bin" -G --ignore-files/);
    assert.doesNotMatch(got, /ARGV0=ugrep/);
  });
});

// End-to-end skew diagnosis: generate a snapshot while CLODE_BFS points at a
// stub that rejects its flags (as a POSIX-only bfs would). The probe must mark
// the find shadow skewed, the rewritten shadow must carry the diagnosis, and
// RUNNING that find must print the self-explaining line on stderr AND still
// propagate the applet's own exit code. CLODE_UGREP points at an accepting
// stub, so the grep shadow must keep its exec fast path.
test('generated find explains a known skew at the point of use', { skip: SH_SKIP }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-skewrun-'));
  const bfsStub = path.join(dir, 'bfs-stub');
  fs.writeFileSync(bfsStub,
    '#!/bin/sh\necho "bfs: error: Unsupported -regextype \'findutils-default\'." >&2\nexit 1\n',
    { mode: 0o755 });
  const ugrepStub = path.join(dir, 'ugrep-stub');
  fs.writeFileSync(ugrepStub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'shell-snapshots'));
  const snap = path.join(dir, 'shell-snapshots', 'snapshot-skew-1.sh');
  const env = { ...process.env, CLODE_BFS: bfsStub, CLODE_UGREP: ugrepStub };
  const prevBfs = process.env.CLODE_BFS, prevUgrep = process.env.CLODE_UGREP;
  process.env.CLODE_BFS = bfsStub;      // the probe runs in THIS process
  process.env.CLODE_UGREP = ugrepStub;
  try {
    cp.execFileSync('sh', ['-c', snapshotCmd(snap)]);
  } finally {
    if (prevBfs === undefined) delete process.env.CLODE_BFS; else process.env.CLODE_BFS = prevBfs;
    if (prevUgrep === undefined) delete process.env.CLODE_UGREP; else process.env.CLODE_UGREP = prevUgrep;
  }
  const got = fs.readFileSync(snap, 'utf8');
  assert.match(got, /known applet skew/);
  assert.match(got, /function grep \{[\s\S]*?exec "\$_bin" -G/);
  // run the generated find: stderr carries the stub's error AND clode's diagnosis.
  // bash, not sh: snapshots use the `function name {` form (bash/zsh — what the
  // bundle actually sources them with); Ubuntu's sh is dash, which rejects it.
  const r = cp.spawnSync('bash', ['-c', `. "${snap}"; find . -name nope; echo "rc=$?"`],
    { encoding: 'utf8', env });
  assert.match(r.stdout, /rc=1/, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stderr, /Unsupported -regextype/);
  assert.match(r.stderr, /known applet skew/);
  assert.match(r.stderr, /Oniguruma/);
});
