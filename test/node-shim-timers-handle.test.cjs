'use strict';
// Characterizes that the GLOBAL timer functions return Node-shaped Timeout /
// Immediate HANDLES (ref/unref/hasRef/refresh + numeric coercion) rather than
// txiki's bare NUMBER. The extracted bundle pervasively uses the Node idiom
// `setTimeout(...).unref()` (e.g. its DataDog telemetry-flush timer) — on a bare
// number that throws `TypeError: not a function`, which silently bails the -p
// action before the Messages round-trip. Matched against host node for the same
// fixture. SKIPs without tjs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function prog(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-timers-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

const BODY = `
  const t = setTimeout(() => {}, 10000);
  const out = {
    unref: typeof t.unref, ref: typeof t.ref, hasRef: typeof t.hasRef, refresh: typeof t.refresh,
    unrefReturnsSelf: t.unref() === t,
    hasRefAfterUnref: t.hasRef(),
    hasRefAfterRef: (t.ref(), t.hasRef()),
    coerces: (typeof Number(t) === 'number' && !Number.isNaN(Number(t))),
  };
  clearTimeout(t);
  const iv = setInterval(() => {}, 10000);
  out.ivUnref = typeof iv.unref;
  clearInterval(iv);
  const im = setImmediate(() => {});
  out.imUnref = typeof im.unref;
  clearImmediate(im);
  console.log(JSON.stringify(out));
`;

test('timers: setTimeout/setInterval/setImmediate return Node-shaped handles', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(BODY);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

test('timers: clearTimeout accepts the handle and cancels the timer', (t) => {
  if (skipUnlessTjs(t)) return;
  // If clearTimeout(handle) fails to cancel (e.g. it can't map the handle back
  // to txiki's numeric id), the callback fires and prints FIRED.
  const f = prog(`
    const t = setTimeout(() => { console.log('FIRED'); }, 50);
    clearTimeout(t);
    setTimeout(() => { console.log('DONE'); }, 200);
  `);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'DONE');
});
