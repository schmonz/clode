const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { sandbox, runClode, mkProvider } = require('./e2e.cjs');

// Node port of test_resolve.bats. Each test builds fixture providers at the various
// precedence locations (explicit bin, version dir, ~/.local/bin/claude symlink, and a
// PATH dir) and asserts WHICH provider resolves. Every fixture prints
// "CLODE-FIXTURE <label>" (mkProvider) so the resolved label is observable in output.
//
// Resolution precedence (libexec/clode-resolve.cjs resolveClaudeBin):
//   CLODE_CLAUDE_BIN > CLODE_VERSION_DIR > providers/current
//     > baked > ~/.local/bin/claude > `claude` on PATH
//
// The bats setup() built ALL fixtures for every test; we mirror that with buildFixtures
// (except the "no provider" case, which needs a pristine sandbox — see that test).
function buildFixtures(sbx) {
  const explicit = path.join(sbx.dir, 'explicit');
  mkProvider(explicit, 'L-explicit');

  const versionsDir = path.join(sbx.dir, 'share', 'versions');
  fs.mkdirSync(versionsDir, { recursive: true });
  const versionDir = path.join(versionsDir, '9.9.9');
  mkProvider(versionDir, 'L-versiondir');

  const localTarget = path.join(sbx.dir, 'local-target');
  mkProvider(localTarget, 'L-local');
  const localBin = path.join(sbx.home, '.local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  const localLink = path.join(localBin, 'claude');
  fs.cpSync(localTarget, localLink, { recursive: true });

  const pathDir = path.join(sbx.dir, 'pathdir');
  fs.mkdirSync(pathDir, { recursive: true });
  const pathClaude = path.join(pathDir, 'claude');
  mkProvider(pathClaude, 'L-path');
  fs.chmodSync(pathClaude, 0o755); // `claude` on PATH must be executable (X_OK check)

  return { explicit, versionDir, localTarget, localLink, pathDir, pathClaude };
}

// 1. CLODE_CLAUDE_BIN wins over all
test('CLODE_CLAUDE_BIN wins over all', (t) => {
  const sbx = sandbox(t);
  const fx = buildFixtures(sbx);
  const r = runClode(sbx, [], {
    env: { CLODE_CLAUDE_BIN: fx.explicit, CLODE_VERSION_DIR: fx.versionDir },
  });
  assert.match(r.output, /L-explicit/);
});

// 2. CLODE_VERSION_DIR next
test('CLODE_VERSION_DIR next', (t) => {
  const sbx = sandbox(t);
  const fx = buildFixtures(sbx);
  const r = runClode(sbx, [], { env: { CLODE_VERSION_DIR: fx.versionDir } });
  assert.match(r.output, /L-versiondir/);
});

// 3. ~/.local/bin/claude symlink next (beats `claude` on PATH)
test('~/.local/bin/claude symlink next', (t) => {
  const sbx = sandbox(t);
  const fx = buildFixtures(sbx);
  const r = runClode(sbx, [], { env: { PATH: `${fx.pathDir}:${sbx.env.PATH}` } });
  assert.match(r.output, /L-local/);
});

// 4. claude on PATH last (once the ~/.local/bin/claude symlink is removed)
test('claude on PATH last', (t) => {
  const sbx = sandbox(t);
  const fx = buildFixtures(sbx);
  fs.rmSync(fx.localLink, { force: true });
  const r = runClode(sbx, [], { env: { PATH: `${fx.pathDir}:${sbx.env.PATH}` } });
  assert.match(r.output, /L-path/);
});

// 5. no provider yields exit 1 and guidance.
// A pristine sandbox is the node analogue of the bats "empty HOME + minimal PATH":
// constructed-clean PATH=/usr/bin:/bin has no `claude`, the fresh HOME has no
// ~/.local/bin/claude, and no providers/current exists — so NO fixture leaks in for
// either the resolver's HOME- or PATH-based fallbacks. (We deliberately do NOT call
// buildFixtures here.)
test('no provider yields exit 1 and guidance', (t) => {
  const sbx = sandbox(t);
  const r = runClode(sbx, []);
  assert.strictEqual(r.status, 1);
  assert.match(r.output, /CLODE_CLAUDE_BIN/);
});

// 6. a tiny exec-wrapper is followed to the real bundle (issue #1)
test('a tiny exec-wrapper is followed to the real bundle', (t) => {
  const sbx = sandbox(t);
  const fx = buildFixtures(sbx);
  const wrapper = path.join(sbx.dir, 'wrapper');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${fx.explicit} "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  const r = runClode(sbx, [], { env: { CLODE_CLAUDE_BIN: wrapper } });
  assert.match(r.output, /L-explicit/);
});

// 7. a real (non-wrapper) bundle is left untouched by follow_wrapper
test('a real (non-wrapper) bundle is left untouched', (t) => {
  const sbx = sandbox(t);
  const fx = buildFixtures(sbx);
  const r = runClode(sbx, [], { env: { CLODE_CLAUDE_BIN: fx.explicit } });
  assert.match(r.output, /L-explicit/);
});
