const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandbox, REPO, NODE } = require('./e2e.cjs');
const cpaths = require('../libexec/clode-paths.cjs');

const BIN = path.join(REPO, 'scripts', 'stage0.mjs');

// `clode read-anthropic-tea-leaves` (clode-main.cjs step 9) is clode's OWN update-signal check —
// dispatched before any bin resolution/launch, so unaffected by the runner's
// retirement. Exercised with a direct spawn of scripts/stage0.mjs, not a model runner.
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

test('clode read-anthropic-tea-leaves runs a cycle, writes a notice, prints a summary, exits 0', (t) => {
  const sbx = sandbox(t);
  const env = watchFixture(sbx, '2.0.0', '1.0.0', 'high');
  const r = run(sbx, ['read-anthropic-tea-leaves'], { env });
  assert.strictEqual(r.status, 0);
  // grep -qx 'high=1' "$CLODE_WATCH_DIR/watch-notice": the notice records a HIGH signal.
  const notice = fs.readFileSync(noticePath(sbx), 'utf8');
  assert.match(notice, /^high=1$/m);
  // the manual summary flags it — reframed from "running under Node" (there is
  // no launch anymore) to how clode repackages it.
  assert.match(r.output, /may affect how clode repackages it/i);
});

// FIX ROUND 1 of phase 3a task 5 (coordinator, Important 3): `read-anthropic-tea-leaves`
// is the spelling --help advertises, and the only committed coverage was "it is in the
// table and in help" — never that it runs the cycle. Same fixture, same assertions as the
// `watch` test above, so the two spellings are proven to do the SAME thing while both
// exist (task 6 removes `watch`).
test('clode read-anthropic-tea-leaves runs the same cycle as watch: notice, summary, exit 0', (t) => {
  const sbx = sandbox(t);
  const env = watchFixture(sbx, '2.0.0', '1.0.0', 'high');
  const r = run(sbx, ['read-anthropic-tea-leaves'], { env });
  assert.strictEqual(r.status, 0, r.output);
  assert.match(fs.readFileSync(noticePath(sbx), 'utf8'), /^high=1$/m);
  assert.match(r.output, /may affect how clode repackages it/i);
});

test('clode read-anthropic-tea-leaves does not reach the bundle (no node/provider needed)', (t) => {
  const sbx = sandbox(t);
  const env = watchFixture(sbx, '2.0.0', '1.0.0', 'low');
  const r = run(sbx, ['read-anthropic-tea-leaves'], { env: { ...env, CLODE_CLAUDE_BIN: '/nonexistent' } });
  assert.strictEqual(r.status, 0);
  // A watch cycle never launches the provider: the fixture marker must be absent even
  // though CLODE_CLAUDE_BIN points at a bogus path.
  assert.doesNotMatch(r.output, /CLODE-FIXTURE/);
});

test('clode --help advertises the update-signal subcommand the table declares', (t) => {
  // Task 5: help is rendered from libexec/cli-surface.cjs's SURFACE, where this cycle
  // is spelled `read-anthropic-tea-leaves` — the name states its epistemic status (it
  // INFERS Anthropic's direction of travel from a changelog; it is never authoritative
  // and never downloads). Task 6 REMOVED `clode watch`: the table is the only spelling
  // there is, and help advertises exactly it.
  const { SURFACE } = require('../libexec/cli-surface.cjs');
  assert.ok('read-anthropic-tea-leaves' in SURFACE.verbs, 'the table must declare the verb');
  const sbx = sandbox(t);
  const r = run(sbx, ['--help']);
  assert.strictEqual(r.status, 0);
  assert.match(r.output, /clode read-anthropic-tea-leaves/);
});

test('clode --clode-watch (the old prefixed spelling) no longer dispatches', (t) => {
  const sbx = sandbox(t);
  const r = run(sbx, ['--clode-watch']);
  assert.strictEqual(r.status, 2);
});
