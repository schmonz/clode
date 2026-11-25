'use strict';
// spawn-watchdog-gate — a child killed by a timeout says so. No hand-rolled kill-on-timeout under test/ or scripts/.
//
// WHY. node-shim-oracle-darwin (CI 45646543044) failed twice in one job with "stderr: (empty) / null !== 0": naude had
// hung, test/oracle-models.cjs's own `setTimeout(() => child.kill('SIGKILL'), opts.timeout)` had fired, and nothing on the
// page said a watchdog killed it, or after how long. test/spawn-collect.cjs already had the kill, a `timedOut` flag, and a
// grace for a grandchild holding the pipe; that file and two more had written their own without them. spawnCollect now
// also writes `KILLED_BY_TIMEOUT` into the child's stderr, which every caller prints on failure.
//
// THE RULE, lexical and stated once: a line with `setTimeout(` that also calls `.kill(` is a finding when its delay is
// not a numeric literal under 1000 ms (a kill that soon is the scenario, not a watchdog), unless the file is
// test/spawn-collect.cjs (or this gate) or the line carries `// spawn-watchdog: <reason>` (the kill IS the scenario, or the line
// itself puts the kill on the page). BLIND SPOTS: a setTimeout whose callback starts on the next line, and a kill by
// another name (process.kill(pid)).
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');
const { defineGuard, guardTests } = require('./guard.cjs');

const REPO = path.resolve(__dirname, '..');
const ROOTS = ['test', 'scripts'];
const HOME = 'test/spawn-collect.cjs';
const SELF = 'test/spawn-watchdog-gate.test.cjs';   // its own cases and prose carry the shape

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

// PURE: the delay is the last top-level argument of the setTimeout call on this line.
function delayOf(line) {
  const at = line.indexOf('setTimeout(');
  let depth = 0, lastComma = -1, end = -1;
  for (let i = at + 'setTimeout('.length; i < line.length; i++) {
    const ch = line[i];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { if (depth === 0) { end = i; break; } depth--; }
    else if (ch === ',' && depth === 0) lastComma = i;
  }
  if (end < 0 || lastComma < 0) return null;
  return line.slice(lastComma + 1, end).trim();
}

// PURE: files = [{ rel, text }] -> { findings, examined }.
function scanSources(files) {
  const findings = [];
  for (const { rel, text } of files) {
    if (rel === HOME || rel === SELF) continue;
    text.split('\n').forEach((line, i) => {
      if (!line.includes('setTimeout(') || !/\.kill\(/.test(line) || /\/\/ spawn-watchdog: \S/.test(line)) return;
      const d = delayOf(line);
      if (d !== null && /^\d[\d_]*$/.test(d) && Number(d.replace(/_/g, '')) < 1000) return;
      findings.push(`${rel}:${i + 1}: kills a child on a timeout (${d === null ? 'delay unread' : d}) without saying so; `
        + `use test/spawn-collect.cjs's timeoutMs, or mark the line \`// spawn-watchdog: <reason>\`: ${line.trim().slice(0, 120)}`);
    });
  }
  return { findings, examined: files.length };
}

guardTests(defineGuard({
  name: 'spawn-watchdog',
  floor: 200,
  read() {
    return ROOTS.flatMap((r) => listFiles(path.join(REPO, r)))
      .map((p) => ({ rel: path.relative(REPO, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') }));
  },
  scan: scanSources,
  control() {
    // test/oracle-models.cjs's dispatchAsync before this gate, verbatim. Split so this file does not carry the shape.
    const planted = "    const to = opts.timeout ? setTimeout(() => child." + "kill('SIGKILL'), opts.timeout) : null;";
    const filler = Array.from({ length: 199 }, (_, i) => ({ rel: `filler-${i}.cjs`, text: "c.on('close', (s) => resolve(s));\n" }));
    return [{ rel: 'test/oracle-models.cjs', text: planted }, ...filler];
  },
}));

test('spawn-watchdog: what the rule passes over, and what it names', () => {
  const f = (text, rel = 'test/x.cjs') => scanSources([{ rel, text }]).findings;
  assert.deepStrictEqual(f("setTimeout(() => c.kill('SIGKILL'), 300);"), [], 'a kill 300 ms in is the scenario');
  assert.strictEqual(f("const k = setTimeout(() => c.kill('SIGKILL'), 180000);").length, 1, 'a watchdog');
  assert.strictEqual(f("setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* */ } }, TIMEOUT);").length, 1, 'a named delay');
  assert.deepStrictEqual(f("setTimeout(() => c.kill(), N); // spawn-watchdog: the run line prints it"), [], 'marked');
  assert.deepStrictEqual(f("to = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);", HOME), [], 'spawn-collect itself');
  assert.strictEqual(delayOf("setTimeout(() => { f(a, b); }, delay * 1000);"), 'delay * 1000');
});

module.exports = { scanSources, delayOf };
