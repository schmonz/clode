const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const PY = process.env.CLODE_PYTHON || 'python3';
const NODE = process.env.CLODE_NODE || process.execPath;
const PY_TOOL = path.join(REPO, 'libexec', 'inspect-claude-bundle');
const JS_TOOL = path.join(REPO, 'libexec', 'inspect-claude-bundle.cjs');
const SHIM = path.join(REPO, 'libexec', 'bun-shim.cjs');
const VERSIONS = ['2.1.177', '2.1.179', '2.1.183', '2.1.185', '2.1.186', '2.1.193', '2.1.195']
  .map((v) => path.join(REPO, 'build', v, 'cli.cjs')).filter(fs.existsSync);

function run(tool, bin, args, isJs) {
  return spawnSync(isJs ? NODE : PY, [tool, bin, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

test('have goldens to inspect', () => assert.ok(VERSIONS.length >= 1));

for (const cli of VERSIONS) {
  const ver = path.basename(path.dirname(cli));
  test(`inspect --json parity for ${ver}`, () => {
    const py = run(PY_TOOL, cli, ['--json'], false);
    const js = run(JS_TOOL, cli, ['--json'], true);
    assert.strictEqual(js.stdout, py.stdout, '--json stdout');
    assert.strictEqual(js.status, py.status, '--json exit');
  });
  test(`inspect --strict parity for ${ver}`, () => {
    const py = run(PY_TOOL, cli, ['--shim', SHIM, '--strict'], false);
    const js = run(JS_TOOL, cli, ['--shim', SHIM, '--strict'], true);
    assert.strictEqual(js.status, py.status, '--strict exit');
  });
}
