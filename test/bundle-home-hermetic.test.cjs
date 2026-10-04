'use strict';
// bundle-runs-own-home (grep-native Task 10b fix round, ruling G30): every test that runs the bundle against a model
// hands it a throwaway HOME and CLAUDE_CONFIG_DIR of its own, never the developer's.
//
// WHY. Ten agentic rows inherited the runner's real HOME, so the bundle read ~/.claude/settings.json, ran its hooks
// (an iTerm2 status hook blocking 30 s per call timed every one of them out in one suite), and wrote into the real
// ~/.claude (the headless plugin install restamped ~/.claude/plugins/known_marketplaces.json).
//
// WHAT IS READ. Every JS file under test/ (test/.harness and test/fixtures aside): each object literal that sets
// ANTHROPIC_BASE_URL or ANTHROPIC_API_KEY (the env of a bundle run that talks to a model, mock or real) must spread
// `...throwawayHome(<its own temp dir>)` (test/throwaway-home.cjs), or set both HOME and CLAUDE_CONFIG_DIR itself, and
// never to process.env.HOME. A literal that only reads those keys (`env.ANTHROPIC_BASE_URL`) is not one. Comments are
// stripped first (test/strip-comments.cjs). EXEMPT, by name: literals that are not handed to a run.
// FLOOR: the literals 2026-10-04's tree holds. CONTROL: a planted run inheriting process.env.HOME, and one setting
// HOME to process.env.HOME, must both be named.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');
const { stripComments } = require('./strip-comments.cjs');

const REPO = path.resolve(__dirname, '..');
const TEST_DIR = path.join(REPO, 'test');
const SELF = path.relative(TEST_DIR, __filename);
const EXEMPT = new Map([
  ['oracle-models.test.cjs', 'a unit test of modelEnv\'s merge: the literal is the function\'s input, nothing is spawned with it'],
  ['build-gates/live-checks-gates.test.cjs', 'the literal is a fixture STRING of a live check the guard reads, never run'],
  ['frame-oracle.cjs', 'its env is built from nothing (no process.env), and each capture runs in test/e2e.cjs sandbox(): a fresh, '
    + 'seeded HOME per side and no CLAUDE_CONFIG_DIR, so the bundle reads that HOME\'s .claude.json'],
]);
const FLOOR = 18;   // measured 2026-10-04: 18 env literals outside the exemptions

function jsFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (e.name !== '.harness' && e.name !== 'fixtures' && e.name !== 'node_modules') out.push(...jsFiles(path.join(dir, e.name), r)); continue; }
    if (/\.(cjs|mjs|js)$/.test(e.name)) out.push(r);
  }
  return out;
}
// The object literal around `at`: from its unmatched `{` to the matching `}`.
function literalAround(src, at) {
  let depth = 0, open = -1;
  for (let i = at; i >= 0; i--) {
    const c = src[i];
    if (c === '}') depth++;
    else if (c === '{') { if (depth === 0) { open = i; break; } depth--; }
  }
  if (open === -1) return null;
  depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return { start: open, text: src.slice(open, i + 1) };
  }
  return null;
}
function scanSource(file, src) {
  const code = stripComments(src);
  const literals = [], seen = new Set();
  for (const m of code.matchAll(/(?<![\w$.'"`])(ANTHROPIC_BASE_URL|ANTHROPIC_API_KEY)\s*:/g)) {
    const lit = literalAround(code, m.index);
    if (!lit || seen.has(lit.start)) continue;
    seen.add(lit.start);
    const line = code.slice(0, lit.start).split('\n').length;
    const t = lit.text;
    const own = /\.\.\.\s*throwawayHome\(/.test(t)
      || (/(?<![\w$.])HOME\s*[:,}]/.test(t) && /(?<![\w$.])CLAUDE_CONFIG_DIR\s*[:,}]/.test(t) && !/(?<![\w$.])HOME\s*:\s*process\.env\.HOME\b/.test(t));
    literals.push({ where: `${file}:${line}`, own });
  }
  return literals;
}
function scan({ files, what }) {
  const findings = [];
  let examined = 0;
  for (const { file, src } of files) {
    if (EXEMPT.has(file)) continue;
    for (const l of scanSource(file, src)) {
      examined++;
      if (!l.own) findings.push(`${l.where}: a bundle run's env talks to a model without its own throwaway HOME and CLAUDE_CONFIG_DIR `
        + '(spread ...throwawayHome(<temp dir>) from test/throwaway-home.cjs): it would run the developer\'s ~/.claude hooks and write there');
    }
  }
  return { findings, examined, note: `${what}: ${examined} env literals that talk to a model` };
}
function read() {
  const files = jsFiles(TEST_DIR).filter((f) => f !== SELF).map((f) => ({ file: f, src: fs.readFileSync(path.join(TEST_DIR, f), 'utf8') }));
  return { files, what: `${files.length} test files` };
}
const PLANTED = [
  "const env = { ...process.env, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock' };",
  "spawn(cli, ['-p', 'x'], { env: { ...process.env, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_API_KEY: 'k' } });",
  "const ok = { ...process.env, ...throwawayHome(dir), ANTHROPIC_BASE_URL: url };",
].join('\n');
const control = () => ({ files: [...read().files, { file: 'planted.test.cjs', src: PLANTED }], what: 'the test tree plus two planted runs' });

guardTests(defineGuard({ name: 'bundle-runs-own-home', floor: FLOOR, read, scan, control }));

test('the control names both planted runs, and not the one with its own home', () => {
  const f = scan({ files: [{ file: 'planted.test.cjs', src: PLANTED }], what: 'planted' });
  assert.deepStrictEqual(f.findings.map((x) => x.split(':').slice(0, 2).join(':')), ['planted.test.cjs:1', 'planted.test.cjs:2']);
  assert.strictEqual(f.examined, 3);
});
test('a comment or a read of the key is not a literal', () => {
  const f = scan({ files: [{ file: 'c.test.cjs', src: '// { ANTHROPIC_BASE_URL: x }\nassert.ok(env.ANTHROPIC_BASE_URL);\n' }], what: 'c' });
  assert.deepStrictEqual([f.findings, f.examined], [[], 0]);
});
