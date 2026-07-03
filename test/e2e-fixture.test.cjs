const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');
const { sandbox, mkProvider, REPO, NODE } = require('./e2e.cjs');

// Port of test_fixture.bats. NOT a runClode test: it drives mkfixture.cjs +
// libexec/extract-claude-js.cjs and boots the carved cli.cjs directly under Node,
// mirroring the bats steps 1:1. TMP -> the disposable sandbox dir (sbx.dir).
const EXTRACTOR = path.join(REPO, 'libexec', 'extract-claude-js.cjs');
const BUN_SHIM = path.join(REPO, 'libexec', 'bun-shim.cjs');

test('extractor carves fixture and Node boots it to the label', (t) => {
  const sbx = sandbox(t);
  const claude = path.join(sbx.dir, 'claude');
  const cli = path.join(sbx.dir, 'cli.cjs');

  // "$CLODE_NODE" test/mkfixture.cjs "$TMP/claude" hello
  mkProvider(claude, 'hello');

  // "$CLODE_NODE" libexec/extract-claude-js.cjs "$TMP/claude" "$TMP/cli.cjs" 2>/dev/null
  execFileSync(NODE, [EXTRACTOR, claude, cli], { stdio: ['ignore', 'ignore', 'ignore'] });

  // cp libexec/bun-shim.cjs "$TMP/bun-shim.cjs"
  fs.copyFileSync(BUN_SHIM, path.join(sbx.dir, 'bun-shim.cjs'));

  // run "$CLODE_NODE" "$TMP/cli.cjs"
  const r = spawnSync(NODE, [cli], { encoding: 'utf8', env: sbx.env });
  const output = (r.stdout || '') + (r.stderr || '');

  // [[ "$output" == *"CLODE-FIXTURE hello"* ]]
  assert.match(output, /CLODE-FIXTURE hello/);
});
