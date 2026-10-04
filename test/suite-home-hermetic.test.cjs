'use strict';
// suite-home-hermetic: the suite runs under its OWN home, and nothing in it reaches back for the developer's
// (grep-native Task 10b fix round 3, ruling G33; the setup is test/suite-home.cjs).
//
// FAIL-CLOSED, by construction rather than by inference. The previous guard tried to FIND every spawn of the bundle and
// judge its env; a review found eight shapes it could not see (concatenated paths, unseeded names, libexec resolvers,
// shell strings, sh -c, callbacks, a pty spawn) and a live hole none of it reached (`clode build`'s smoke). Now the
// default is safe for every child whatever it spawns, and this guard only has to keep the way back closed:
//   1. test/run.mjs applies the suite home FIRST (its first require is ./suite-home.cjs), and the helpers that launch
//      the bundle require it too, so a standalone `node --test file` gets the same home;
//   2. only the files named in READERS may read the real values (CLODE_TEST_REAL_HOME, or realHome()): the module that
//      keeps them, the runner (it watches the real dirs), and the one opt-in run that exists to use the developer's
//      own credentials;
//   3. no file sets HOME, USERPROFILE or CLAUDE_CONFIG_DIR from os.homedir(), os.userInfo().homedir, or the real
//      values, in any spelling.
// Read: every JS file under test/ (test/.harness and test/fixtures aside) and scripts/lib/. Comments are stripped first.
// CONTROL: one planted file per way back, each named.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');
const { stripComments } = require('./strip-comments.cjs');

const REPO = path.resolve(__dirname, '..');
const TEST_DIR = path.join(REPO, 'test');
const LIB_DIR = path.join(REPO, 'scripts', 'lib');
const READERS = new Map([
  ['suite-home.cjs', 'keeps the real values under CLODE_TEST_REAL_HOME and hands out explicit paths'],
  ['run.mjs', 'watches the REAL home\'s dirs for writes (the hermetic guard), so it must know where they are'],
  ['fidelity/interactive-live-turn.test.cjs', 'the opt-in (CLODE_LIVE_ONLINE) turn with the developer\'s REAL credentials and config'],
]);
const LAUNCH_HELPERS = ['provider-resolve.cjs', 'oracle-models.cjs', 'node-shim-helper.cjs', 'e2e.cjs'];
const READS_REAL = /\bCLODE_TEST_REAL_HOME\b|(?<![\w$.])realHome\s*\(/;
const HOME_KEY = String.raw`(?:HOME|USERPROFILE|CLAUDE_CONFIG_DIR)`;
const REAL_SOURCE = String.raw`[^,;}\n]*(?:homedir\s*\(|userInfo\s*\([^)]*\)\s*\.\s*homedir|CLODE_TEST_REAL_HOME|realHome\s*\()`;
const SETS_HOME = new RegExp(String.raw`(?:\b${HOME_KEY}\b|\[\s*['"\x60]${HOME_KEY}['"\x60]\s*\])\s*[:=](?!=)${REAL_SOURCE}`);

function jsFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!['.harness', 'fixtures', 'node_modules'].includes(e.name)) out.push(...jsFiles(path.join(dir, e.name), r)); continue; }
    if (/\.(cjs|mjs|js)$/.test(e.name)) out.push(r);
  }
  return out;
}
// this file spells every way back in its patterns and plants, and checks the suite home against the real one
const SELF = path.relative(TEST_DIR, __filename);
function read() {
  const files = jsFiles(TEST_DIR).filter((f) => f !== SELF).map((f) => ({ file: f, src: fs.readFileSync(path.join(TEST_DIR, f), 'utf8') }))
    .concat(fs.readdirSync(LIB_DIR).filter((f) => /\.cjs$/.test(f)).map((f) => ({ file: `../scripts/lib/${f}`, src: fs.readFileSync(path.join(LIB_DIR, f), 'utf8') })));
  return { files, what: `${files.length} files under test/ and scripts/lib/` };
}
function scan({ files, what }) {
  const findings = [];
  const byName = new Map(files.map((f) => [f.file, f]));
  // 1. applied first, and by every launch helper
  const run = byName.get('run.mjs');
  if (!run) findings.push('test/run.mjs is not where the suite home is applied: it is missing');
  else {
    const firstReq = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/.exec(stripComments(run.src));
    if (!firstReq || firstReq[1] !== './suite-home.cjs') findings.push(`test/run.mjs's first require is ${firstReq ? firstReq[1] : 'nothing'}, not ./suite-home.cjs: something may resolve a path off the real HOME first`);
  }
  for (const h of LAUNCH_HELPERS) {
    const f = byName.get(h);
    if (f && !/require\(\s*['"]\.\/suite-home\.cjs['"]\s*\)/.test(f.src)) findings.push(`test/${h} launches the bundle and does not require ./suite-home.cjs: a standalone run of a test using it would run the bundle against the real HOME`);
  }
  let examined = 0;
  for (const { file, src } of files) {
    examined++;
    const code = stripComments(src);
    const lines = code.split('\n');
    lines.forEach((l, i) => {
      if (!READERS.has(file) && READS_REAL.test(l)) findings.push(`${file}:${i + 1}: reads the developer's real home (CLODE_TEST_REAL_HOME/realHome()); only ${[...READERS.keys()].join(', ')} may`);
      if (!READERS.has(file) && SETS_HOME.test(l)) findings.push(`${file}:${i + 1}: sets HOME, USERPROFILE or CLAUDE_CONFIG_DIR from the real home (os.homedir(), os.userInfo().homedir or the real values): ${l.trim().slice(0, 120)}`);
    });
  }
  return { findings, examined, note: `${what}; readers of the real home: ${[...READERS.keys()].join(', ')}` };
}
const PLANTS = {
  'planted-reads-name.test.cjs': 'const real = JSON.parse(process.env.CLODE_TEST_REAL_HOME);',
  'planted-reads-fn.test.cjs': "const { realHome } = require('./suite-home.cjs');\nconst h = realHome().HOME;",
  'planted-home-homedir.test.cjs': "spawnSync(bin, [], { env: { ...process.env, HOME: os.homedir() } });",
  'planted-userprofile.test.cjs': "const env = { ...process.env };\nenv.USERPROFILE = require('node:os').homedir();",
  'planted-config-dir.test.cjs': "spawnSync(bin, [], { env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude') } });",
  'planted-userinfo.test.cjs': "env['HOME'] = os.userInfo().homedir;",
};
const RUN_LATE = { file: 'run.mjs', src: "const x = require('./guard.cjs');\nconst { realHome } = require('./suite-home.cjs');\n" };
const HELPER_WITHOUT = { file: 'e2e.cjs', src: "'use strict';\nconst fs = require('node:fs');\n" };
const plantedFiles = () => Object.entries(PLANTS).map(([file, src]) => ({ file, src }));
const control = () => {
  const real = read().files.filter((f) => f.file !== 'run.mjs' && f.file !== 'e2e.cjs');
  return { files: [...real, ...plantedFiles(), RUN_LATE, HELPER_WITHOUT], what: 'the tree plus one planted way back per rule' };
};

guardTests(defineGuard({ name: 'suite-home-hermetic', floor: 400, read, scan, control }));

test('each planted way back to the real home is named', () => {
  const r = scan(control());
  for (const file of Object.keys(PLANTS)) assert.ok(r.findings.some((f) => f.startsWith(`${file}:`)), `${file} not named:\n${r.findings.join('\n')}`);
  assert.ok(r.findings.some((f) => /run\.mjs's first require is \.\/guard\.cjs/.test(f)), r.findings.join('\n'));
  assert.ok(r.findings.some((f) => /test\/e2e\.cjs launches the bundle and does not require \.\/suite-home\.cjs/.test(f)), r.findings.join('\n'));
});
test('a comment, or the suite\'s own HOME, is not a way back', () => {
  const r = scan({ files: [{ file: 'c.test.cjs', src: "// HOME: os.homedir() would be wrong\nconst env = { ...process.env, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: cfg };\n" }], what: 'c' });
  assert.deepStrictEqual(r.findings.filter((f) => f.startsWith('c.test.cjs')), []);
});
test('the suite runs under its own home: HOME, USERPROFILE and CLAUDE_CONFIG_DIR are not the developer\'s', () => {
  const { realHome } = require('./suite-home.cjs');
  const real = realHome();
  assert.ok(real && real.HOME, 'the real values are kept');
  assert.notStrictEqual(process.env.HOME, real.HOME);
  assert.strictEqual(process.env.USERPROFILE, process.env.HOME);
  assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, path.join(process.env.HOME, '.claude'));
  assert.ok(!process.env.HOME.startsWith(real.HOME + path.sep), 'the suite home is not inside the real one');
});
