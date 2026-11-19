'use strict';
// spawn-close-gate — no test collects a child's output and then settles on its 'exit' event.
//
// node fires 'exit' before the child's stdio has closed, so output collected by then can be missing its tail.
// node-shim-oracle (CI 44460009323) failed exactly so ('ready\n' collected, 'resumed' printed and lost to the race),
// and the same shape sat in about twenty files under test/. They use test/spawn-collect.cjs (resolves on 'close') now;
// this gate keeps the shape from coming back.
//
// THE RULE, lexical and stated once: a line `<id>.on('exit' | <id>.once('exit'` (any receiver but `process`) whose
// handler settles a promise on that line (resolve / res / done / reject), where `<id>.stdout.on('data'` or
// `<id>.stderr.on('data'` appears in the 20 lines before it. BLIND SPOTS: a handler that settles on a later line, a
// collector more than 20 lines up, or one bound under another name. Programs held in template strings (the node-shim
// child_process rows test 'exit' itself, under tjs) print rather than settle, so the rule passes them over. A row that
// tests the gap between 'exit' and 'close' ON PURPOSE says so on the line, `// spawn-close: <reason>`, and is passed over.
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('../guard.cjs');

const TEST_DIR = path.join(__dirname, '..');
const WINDOW = 20;

function listFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (/\.(c|m)?js$/.test(e.name)) out.push(p);
  }
  return out;
}

// PURE: files = [{ rel, text }] -> { findings, examined }.
function scanSources(files) {
  const findings = [];
  const exitLine = /([A-Za-z_$][\w$]*)\.(?:on|once)\(\s*'exit'\s*,(.*)$/;
  for (const { rel, text } of files) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const m = exitLine.exec(line);
      if (!m || m[1] === 'process' || /\/\/ spawn-close: \S/.test(line)) return;
      if (!/\b(?:resolve|res|done|reject)\b/.test(m[2])) return;
      const id = m[1].replace(/[$]/g, '\\$');
      const collects = new RegExp(`\\b${id}\\.(?:stdout|stderr)\\.on\\(\\s*'data'`);
      const before = lines.slice(Math.max(0, i - WINDOW), i + 1).join('\n');
      if (collects.test(before)) {
        findings.push(`${rel}:${i + 1}: collects ${m[1]}'s output and settles on 'exit', which can fire before its stdio `
          + `closes; use test/spawn-collect.cjs (or 'close'): ${line.trim().slice(0, 120)}`);
      }
    });
  }
  return { findings, examined: files.length };
}

guardTests(defineGuard({
  name: 'spawn-close',
  floor: 100,
  read() {
    return listFiles(TEST_DIR).map((p) => ({ rel: path.relative(TEST_DIR, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') }));
  },
  scan: scanSources,
  control() {
    // The node-shim-signals row's shape before 76d048e, verbatim in substance.
    const planted = [
      "  const child = spawn(tjsPath(), ['run', LOADER, prog], { stdio: ['ignore', 'pipe', 'pipe'] });",
      "  let out = '';",
      "  child.stdout.on('data', (d) => { out += d; });",
      // Split so this file's own source does not carry the shape it plants.
      "  const exited = new Promise((res) => child.on(" + "'exit', (code, signal) => res({ code, signal })));",
    ].join('\n');
    const filler = Array.from({ length: 99 }, (_, i) => ({ rel: `filler-${i}.cjs`, text: "c.on('close', (s) => resolve(s));\n" }));
    return [{ rel: 'planted.test.cjs', text: planted }, ...filler];
  },
}));

const test = require('node:test');
const assert = require('node:assert');
test('spawn-close: what the rule passes over', () => {
  const ok = [
    { rel: 'a', text: "c.stdout.on('data', f);\nc.on('close', (s) => resolve(s));" },                 // close
    { rel: 'b', text: "c.stdout.on('data', f);\nprocess.on('exit', () => done());" },                 // process
    { rel: 'c', text: "c.stdout.on('data', f);\nc.on('exit', (code) => { console.log(code); });" },  // prints (a shim row)
    { rel: 'd', text: "d.stdout.on('data', f);\nc.on('exit', (s) => resolve(s));" },                 // another child
    { rel: 'f', text: "c.stdout.on('data', f);\nc.on('exit', () => res()); // spawn-close: tests the exit/close gap" },
  ];
  assert.deepStrictEqual(scanSources(ok).findings, []);
  assert.strictEqual(scanSources([{ rel: 'e', text: "c.stderr.on('data', f);\nc.once('exit', (s) => reject(s));" }]).findings.length, 1);
});
