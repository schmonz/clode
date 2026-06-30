const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PY = process.env.CLODE_PYTHON || 'python3';
const NODE = process.env.CLODE_NODE || process.execPath;
const REPO = path.resolve(__dirname, '..');
const PY_TOOL = path.join(REPO, 'libexec', 'clode-signals');
const JS_TOOL = path.join(REPO, 'libexec', 'clode-signals.cjs');

const CHANGELOG = [
  '# Changelog', '',
  '## 2.1.200', '',
  '- Upgraded the bundled Bun runtime to 1.3',
  '- requires the native binary for gateway',
  '- A normal feature with an apostrophe ’ here', '',
  '## 2.1.195', '', '- old note', '',
].join('\n');

function run(tool, args, isJs) {
  const bin = isJs ? NODE : PY;
  return spawnSync(bin, [tool, ...args], { encoding: 'utf8' });
}

test('JS clode-signals matches Python: stdout, --json, snapshot bytes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigdiff-'));
  const cl = path.join(tmp, 'CHANGELOG.md');
  fs.writeFileSync(cl, CHANGELOG);
  const args = ['--version', '2.1.200', '--prev', '2.1.195', '--changelog-file', cl];

  for (const flag of [[], ['--json']]) {
    const py = run(PY_TOOL, [...args, ...flag], false);
    const js = run(JS_TOOL, [...args, ...flag], true);
    assert.strictEqual(js.status, py.status, 'exit code');
    assert.strictEqual(js.stdout, py.stdout, 'stdout' + (flag.length ? ' --json' : ''));
  }

  const pyDir = path.join(tmp, 'snap-py');
  const jsDir = path.join(tmp, 'snap-js');
  run(PY_TOOL, [...args, '--snapshot-dir', pyDir], false);
  run(JS_TOOL, [...args, '--snapshot-dir', jsDir], true);
  const a = fs.readFileSync(path.join(pyDir, '2.1.200.json'));
  const b = fs.readFileSync(path.join(jsDir, '2.1.200.json'));
  assert.ok(a.equals(b), 'snapshot bytes identical');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('JS clode-signals matches Python: --version only (no prev, no changelog)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigdiff-'));
  const args = ['--version', '2.1.200'];

  for (const flag of [[], ['--json']]) {
    const py = run(PY_TOOL, [...args, ...flag], false);
    const js = run(JS_TOOL, [...args, ...flag], true);
    assert.strictEqual(js.status, py.status, 'exit code');
    assert.strictEqual(js.stdout, py.stdout, 'stdout' + (flag.length ? ' --json' : ''));
  }

  const pyDir = path.join(tmp, 'snap-py');
  const jsDir = path.join(tmp, 'snap-js');
  run(PY_TOOL, [...args, '--snapshot-dir', pyDir], false);
  run(JS_TOOL, [...args, '--snapshot-dir', jsDir], true);
  const a = fs.readFileSync(path.join(pyDir, '2.1.200.json'));
  const b = fs.readFileSync(path.join(jsDir, '2.1.200.json'));
  assert.ok(a.equals(b), 'snapshot bytes identical');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('JS clode-signals matches Python: --bundle phrase counts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigdiff-'));
  const cl = path.join(tmp, 'CHANGELOG.md');
  fs.writeFileSync(cl, CHANGELOG);
  const bundle = path.join(tmp, 'bundle.bin');
  fs.writeFileSync(bundle, [
    'some preamble',
    'requires the native binary here',
    'and again requires the native binary',
    'typeof Bun === "undefined"',
    'install.sh instead of npm path',
  ].join('\n'));
  const args = ['--version', '2.1.200', '--prev', '2.1.195',
    '--changelog-file', cl, '--bundle', bundle];

  for (const flag of [[], ['--json']]) {
    const py = run(PY_TOOL, [...args, ...flag], false);
    const js = run(JS_TOOL, [...args, ...flag], true);
    assert.strictEqual(js.status, py.status, 'exit code');
    assert.strictEqual(js.stdout, py.stdout, 'stdout' + (flag.length ? ' --json' : ''));
  }

  const pyDir = path.join(tmp, 'snap-py');
  const jsDir = path.join(tmp, 'snap-js');
  run(PY_TOOL, [...args, '--snapshot-dir', pyDir], false);
  run(JS_TOOL, [...args, '--snapshot-dir', jsDir], true);
  const a = fs.readFileSync(path.join(pyDir, '2.1.200.json'));
  const b = fs.readFileSync(path.join(jsDir, '2.1.200.json'));
  assert.ok(a.equals(b), 'snapshot bytes identical');
  fs.rmSync(tmp, { recursive: true, force: true });
});
