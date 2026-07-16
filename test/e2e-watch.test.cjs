const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandbox, REPO, NODE } = require('./e2e.cjs');
const cpaths = require('../libexec/clode-paths.cjs');

const BIN = path.join(REPO, 'bin', 'clode');

// `clode watch` (clode-main.cjs step 7) is clode's OWN update-signal check —
// dispatched before any bin resolution/launch, so unaffected by the runner's
// retirement. Exercised with a direct spawn of bin/clode, not a model runner.
function run(sbx, args = [], opts = {}) {
  const r = spawnSync(NODE, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...sbx.env, ...(opts.env || {}) },
    cwd: opts.cwd || REPO,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', output: (r.stdout || '') + (r.stderr || '') };
}

// Port of test_watch.bats' `_watch_fixture`: build a fake releases repo + provider
// store, layered on the hermetic sandbox. `stable`/version = $1, provider current =
// $2 (empty => none), sig = "high"|"low" changelog content. Returns the extra env the
// launcher needs (releases/changelog URLs + providers store) — merged over sbx.env at
// run time, never spread from process.env.
function watchFixture(sbx, stable, current, sig) {
  const repo = path.join(sbx.dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'stable'), `${stable}\n`);
  fs.writeFileSync(path.join(repo, 'latest'), `${stable}\n`);
  const prev = current || '0.0.0';
  if (sig === 'high') {
    fs.writeFileSync(path.join(repo, 'CHANGELOG.md'),
      `# Changelog\n\n## ${stable}\n\n- requires the native binary now\n## ${prev}\n\n- old\n`);
  } else {
    fs.writeFileSync(path.join(repo, 'CHANGELOG.md'),
      `# Changelog\n\n## ${stable}\n\n- minor fix\n## ${prev}\n\n- old\n`);
  }
  const providers = path.join(sbx.dir, 'data', 'clode', 'providers');
  const env = {
    CLODE_RELEASES_URL: `file://${repo}`,
    CLODE_CHANGELOG_URL: `file://${repo}/CHANGELOG.md`,
    CLODE_PROVIDERS: providers,
  };
  if (current) {
    fs.mkdirSync(path.join(providers, current), { recursive: true });
    fs.writeFileSync(path.join(providers, current, 'claude'), '');
    fs.writeFileSync(path.join(providers, 'current'), current + '\n');
  }
  return env;
}

// The watch dir the sandbox resolves to (no CLODE_WATCH_DIR/CLODE_CACHE override =>
// cacheBase = <stateRoot>/cache/clode). The notice lives at <watchDir>/watch-notice.
function noticePath(sbx) {
  return path.join(cpaths.watchDir(sbx.env), 'watch-notice');
}

test('clode watch runs a cycle, writes a notice, prints a summary, exits 0', (t) => {
  const sbx = sandbox(t);
  const env = watchFixture(sbx, '2.0.0', '1.0.0', 'high');
  const r = run(sbx, ['watch'], { env });
  assert.strictEqual(r.status, 0);
  // grep -qx 'high=1' "$CLODE_WATCH_DIR/watch-notice": the notice records a HIGH signal.
  const notice = fs.readFileSync(noticePath(sbx), 'utf8');
  assert.match(notice, /^high=1$/m);
  // echo "$output" | grep -qi "running under Node": the manual summary flags it.
  assert.match(r.output, /running under Node/i);
});

test('clode watch does not reach the bundle (no node/provider needed)', (t) => {
  const sbx = sandbox(t);
  const env = watchFixture(sbx, '2.0.0', '1.0.0', 'low');
  const r = run(sbx, ['watch'], { env: { ...env, CLODE_CLAUDE_BIN: '/nonexistent' } });
  assert.strictEqual(r.status, 0);
  // A watch cycle never launches the provider: the fixture marker must be absent even
  // though CLODE_CLAUDE_BIN points at a bogus path.
  assert.doesNotMatch(r.output, /CLODE-FIXTURE/);
});

test('clode --help advertises the watch subcommand', (t) => {
  const sbx = sandbox(t);
  const r = run(sbx, ['--help']);
  assert.strictEqual(r.status, 0);
  assert.match(r.output, /clode watch/);
});

test('clode --clode-watch (the old prefixed spelling) no longer dispatches', (t) => {
  const sbx = sandbox(t);
  const r = run(sbx, ['--clode-watch']);
  assert.strictEqual(r.status, 2);
});
