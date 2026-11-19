'use strict';
// spawn-close-gate — no test collects a child's output and then settles on its 'exit' event.
//
// node fires 'exit' before the child's stdio has closed, so output collected by then can be missing its tail.
// node-shim-oracle (CI 44460009323) failed exactly so ('ready\n' collected, 'resumed' printed and lost to the race),
// and the same shape sat in about twenty files under test/. They use test/spawn-collect.cjs (resolves on 'close') now;
// this gate keeps the shape from coming back.
//
// THE RULE, lexical and stated once: any `<id>.on('exit'` / `<id>.once('exit'` (any receiver but `process`), whatever
// its handler does and however many lines it spans (settling a promise, or a child PROGRAM printing what it collected:
// those programs run under real node as the reference too, so they race the same way), where
// `<id>.stdout.on('data'` or `<id>.stderr.on('data'` appears in the 20 lines before it, within the same test (the
// look-back stops at a line starting `test(`). A row that relies on 'exit' ON PURPOSE (the exit/close gap is what it
// tests, or the handler reads no collected output) says so on the line, `// spawn-close: <reason>`, and is passed over.
// BLIND SPOTS: a collector more than 20 lines up, or the child bound under another name between collector and handler.
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');

const TEST_DIR = path.resolve(__dirname);
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
      const id = m[1].replace(/[$]/g, '\\$');
      const collects = new RegExp(`\\b${id}\\.(?:stdout|stderr)\\.on\\(\\s*'data'`);
      let from = Math.max(0, i - WINDOW);
      for (let j = i; j >= from; j--) if (/^test\(/.test(lines[j])) { from = j; break; }
      const before = lines.slice(from, i + 1).join('\n');
      if (collects.test(before)) {
        findings.push(`${rel}:${i + 1}: collects ${m[1]}'s output and acts on 'exit', which can fire before its stdio `
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
    { rel: 'c', text: "c.stdout.on('data', f);\ntest('next', () => {\nc.on('exit', () => res());" },       // another test
    { rel: 'd', text: "d.stdout.on('data', f);\nc.on('exit', (s) => resolve(s));" },                 // another child
    { rel: 'f', text: "c.stdout.on('data', f);\nc.on('exit', () => res()); // spawn-close: tests the exit/close gap" },
  ];
  assert.deepStrictEqual(scanSources(ok).findings, []);
  assert.strictEqual(scanSources([{ rel: 'e', text: "c.stderr.on('data', f);\nc.once('exit', (s) => reject(s));" }]).findings.length, 1);
  // A child program printing what it collected (the node-shim-child-process rows before fix round 2), and a handler
  // spanning lines: both flagged.
  assert.strictEqual(scanSources([{ rel: 'g', text: "c.stdout.on('data', (d) => { out += d; });\nc.on('exit', (code) => { console.log(JSON.stringify({ code, out })); });" }]).findings.length, 1);
  assert.strictEqual(scanSources([{ rel: 'h', text: "c.stdout.on('data', f);\nc.on('exit', (code) => {\n  resolve(code);\n});" }]).findings.length, 1);
});
