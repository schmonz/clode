// test/yaml.test.cjs — Bun.YAML backed by the npm `yaml` dep, with FAIL-LOUD
// behavior at point-of-use when `yaml` isn't installed.
//
// Unlike `ws` (needed during startup, so missing = exit), the bundle only touches
// Bun.YAML at feature time — parsing/serializing skill/command/memory frontmatter —
// and wraps many parse() calls in try/catch. So a plain throw gets SWALLOWED and the
// user never learns why frontmatter silently broke. We make the failure UNSWALLOWABLE
// the same way the ws adapter does: write the actionable message to fd 2 (once), then
// throw (CLODE_YAML_MISSING) so each feature can still degrade per-item.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
// runShimChild loads the shim from a temp copy OUTSIDE the repo with cwd there, so
// the child can never resolve a host- OR repo-installed `yaml` — these assert the
// yaml-ABSENT behavior deterministically regardless of the repo's node_modules.
const { runShimChild } = require('./isolated-shim.cjs');

test('fail-loud: missing yaml cannot be swallowed — parse prints the hint, throws a coded error', () => {
  // Mimics the bundle: the caller swallows the throw. The message must STILL surface
  // (stderr), the error must carry CLODE_YAML_MISSING, and the process keeps running
  // (throw, not exit — yaml is point-of-use, not startup-critical).
  const r = runShimChild(
    `var e; try { Bun.YAML.parse('a: 1'); } catch (x) { e = x; }
     console.log('CODE=' + (e && e.code));
     console.log('CONTINUED');`);
  assert.match(r.stderr, /yaml/);
  assert.match(r.stderr, /npm install/);
  assert.match(r.stdout, /CODE=CLODE_YAML_MISSING/);
  assert.match(r.stdout, /CONTINUED/, 'must throw (recoverable), not exit');
});

test('fail-loud: missing yaml — stringify is loud and coded too', () => {
  const r = runShimChild(
    `var e; try { Bun.YAML.stringify({a:1}); } catch (x) { e = x; }
     console.log('CODE=' + (e && e.code));`);
  assert.match(r.stderr, /yaml/);
  assert.match(r.stdout, /CODE=CLODE_YAML_MISSING/);
});

test('fail-loud: the install hint is printed at most once across many parses', () => {
  const r = runShimChild(
    `for (var i = 0; i < 3; i++) { try { Bun.YAML.parse('a: 1'); } catch (x) {} }`);
  const n = (r.stderr.match(/npm install/g) || []).length;
  assert.strictEqual(n, 1, 'message must not spam every frontmatter parse');
});

// A fake `yaml` whose parse/stringify echo every arg they receive, so we can prove
// the shim forwards them verbatim — Bun calls `YAML.stringify(value, replacer, space)`
// and the old shim dropped everything past the first arg.
function withFakeYaml() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-yaml-'));
  fs.mkdirSync(path.join(dir, 'yaml'));
  fs.writeFileSync(path.join(dir, 'yaml', 'package.json'),
    '{"name":"yaml","version":"0.0.0-clode-test","main":"index.js"}');
  fs.writeFileSync(path.join(dir, 'yaml', 'index.js'),
    'exports.parse=(...a)=>({parsedArgs:a});exports.stringify=(...a)=>"S:"+JSON.stringify(a);');
  return dir;  // a NODE_PATH dir: require("yaml") resolves to <dir>/yaml
}

test('forwards all args to the real yaml (Bun signature value,replacer,space)', () => {
  const r = runShimChild(
    `console.log(Bun.YAML.stringify({a:1}, null, 2));
     console.log(JSON.stringify(Bun.YAML.parse('a: 1')));`,
    { NODE_PATH: withFakeYaml() });
  // stringify must forward the replacer + space args, not just the value
  assert.match(r.stdout, /S:\[\{"a":1\},null,2\]/);
  assert.match(r.stdout, /\{"parsedArgs":\["a: 1"\]\}/);
});

test('inspect honesty: Bun.YAML is tagged a stub when yaml is absent', () => {
  // inspect-claude-bundle counts a tagged Bun member as "stubbed", not implemented.
  const r = runShimChild(`console.log('STUB=' + (Bun.YAML.__bunShimStub === true));`);
  assert.match(r.stdout, /STUB=true/);
});

test('inspect honesty: Bun.YAML is not a stub when yaml is present', () => {
  const r = runShimChild(`console.log('STUB=' + (Bun.YAML.__bunShimStub === true));`,
    { NODE_PATH: withFakeYaml() });
  assert.match(r.stdout, /STUB=false/);
});
