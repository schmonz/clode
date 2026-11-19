'use strict';
// loop-hold.test.cjs — every test that measures how long the event loop was held judges it through test/loop-hold.cjs
// (a share bound plus a ceiling, measured), never by an absolute-ms assert, which scales with machine load and failed
// rg-walk's gate at 602 ms in a loaded full suite.
//
// THE GUARD reads every tracked test file. A file MEASURES a loop gap when it keeps a running max of a gap
// (`Math.max(maxGap, ...)` / `Math.max(gap, ...)`). Such a file must call judgeHold, and no test file may assert a gap
// against a number (`maxGap < 600`, `gap <= 500`). Blind spot: a gap kept under some other name, or asserted through
// an intermediate variable, is not recognised.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');
const { judgeHold } = require('./loop-hold.cjs');

const REPO = path.resolve(__dirname, '..');
const SELF = new Set(['test/loop-hold.cjs', 'test/loop-hold.test.cjs']);
const MEASURES = /Math\.max\(\s*(?:maxGap|gap)\s*,/;
const ABSOLUTE = /\b(?:maxGap|gap)\s*<=?\s*\d/g;

function scanLoopHolds({ files }) {
  const findings = [];
  let examined = 0;
  for (const [file, text] of files) {
    for (const line of text.split('\n')) {
      if (/assert/.test(line) && ABSOLUTE.test(line)) findings.push(`${file}: asserts a loop gap in absolute ms (${line.trim().slice(0, 120)}); judge it with test/loop-hold.cjs judgeHold`);
      ABSOLUTE.lastIndex = 0;
    }
    if (!MEASURES.test(text)) continue;
    examined++;
    if (!/\bjudgeHold\(/.test(text)) findings.push(`${file}: measures a loop gap but never calls judgeHold`);
  }
  return { findings, examined, note: `${examined} test file(s) measure a loop gap, of ${files.length} read` };
}

const shimProbe = (assertion) => [
  'let last = Date.now(), maxGap = 0;',
  'const iv = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 10);',
  assertion,
].join('\n');

guardTests(defineGuard({
  name: 'loop-hold-judged',
  // rg-walk, rg-files, rg-multiline, rg-native measured on 2026-11-19.
  floor: 4,
  read: () => {
    const list = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'test'], { cwd: REPO, encoding: 'utf8' })
      .split('\n').filter((f) => /\.(c|m)?js$/.test(f) && !SELF.has(f) && fs.existsSync(path.join(REPO, f)));
    return { files: list.map((f) => [f, fs.readFileSync(path.join(REPO, f), 'utf8')]) };
  },
  scan: scanLoopHolds,
  // the shape every one of these gates had before 2026-11-19
  control: () => ({ files: [['test/x.test.cjs', shimProbe("assert.ok(got.maxGap < 600, 'held');")]] }),
}));

test('loop-hold-judged: a measured gap judged by judgeHold is clean; an absolute gate or an unjudged measurement is named', () => {
  assert.deepStrictEqual(scanLoopHolds({ files: [['test/a.test.cjs', shimProbe('const held = judgeHold(got); assert.ok(!held, held);')]] }).findings, []);
  const r = scanLoopHolds({ files: [['test/b.test.cjs', shimProbe("assert.ok(got.async.gap <= 500, 'x');")], ['test/c.test.cjs', shimProbe('')]] });
  assert.ok(r.findings.some((f) => /b.test.cjs: asserts a loop gap in absolute ms/.test(f)), r.findings.join('\n'));
  assert.ok(r.findings.some((f) => /c.test.cjs: measures a loop gap but never calls judgeHold/.test(f)), r.findings.join('\n'));
});

test('judgeHold passes every measured fixed run, and fails every measured held loop and a diluted-but-held one', () => {
  const fixed = [[123, 3191], [497, 14400], [66, 1536], [353, 7632], [38, 6457], [222, 32136], [76, 5193], [462, 36161], [258, 27747]];
  for (const [maxGap, ms] of fixed) assert.strictEqual(judgeHold({ maxGap, ms }), null, `fixed ${maxGap}/${ms}`);
  const held = [[1289, 3183], [5283, 13039], [1739, 1834], [10015, 10401], [6668, 6668], [1251, 1270], [33099, 33490]];
  for (const [maxGap, ms] of held) assert.ok(judgeHold({ maxGap, ms }), `held ${maxGap}/${ms}`);
  // what the share alone would miss: a 2.5 s hold inside a 60 s run (0.042 of it)
  assert.match(judgeHold({ maxGap: 2500, ms: 60000 }) || '', /2500 ms in one stretch/);
  assert.match(judgeHold({ maxGap: 10 }) || '', /no usable measurement/);
});
