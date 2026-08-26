'use strict';
/* engine-harness — a node:test-SHAPED test runner that runs under txiki/quickjs.
 *
 * WHY: `npm test` requires the node-shim into NODE, so it exercises the shim's
 * LOGIC on an engine the shim never ships on. This harness supplies ONLY the
 * test/describe/it plumbing node:test would; EVERYTHING ELSE — assert, fs, path,
 * util, buffer, stream, timers — is required normally and therefore comes from
 * the real shim on the real engine.
 *
 * DELIBERATE NON-GOALS (each is a loud failure, never a silent stub):
 *   - t.mock / mock.method: throws. A test that mocks must fail here, not pass.
 *   - per-test timeouts: not implemented (the driver imposes a wall-clock one).
 *   - concurrency: everything runs sequentially.
 *
 * Output is TAP-ish and machine-checkable: `# tests/pass/fail/skip` at the end.
 */

const ROOT = { kind: 'suite', name: '<root>', children: [], hooks: newHooks() };
let current = ROOT;

function newHooks() { return { before: [], after: [], beforeEach: [], afterEach: [] }; }

// node:test accepts (name, fn) | (name, opts, fn) | (fn) | (opts, fn)
function normalize(a, b, c) {
  let name = null, opts = {}, fn = null;
  for (const x of [a, b, c]) {
    if (typeof x === 'function') fn = x;
    else if (typeof x === 'string') name = x;
    else if (x && typeof x === 'object') opts = x;
  }
  return { name: name || (fn && fn.name) || '<anonymous>', opts, fn };
}

function register(kind, a, b, c) {
  const { name, opts, fn } = normalize(a, b, c);
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const node = { kind, name, opts, fn, children: [], hooks: newHooks(), _resolve: resolve };
  current.children.push(node);
  if (kind === 'suite' && typeof fn === 'function') {
    const prev = current;
    current = node;
    try { fn(); } finally { current = prev; }
    resolve();
  }
  return done;
}

const test = (a, b, c) => register('test', a, b, c);
test.skip = (a, b, c) => register('test', a, mergeOpts(b, c, { skip: true }), pickFn(b, c));
test.todo = (a, b, c) => register('test', a, mergeOpts(b, c, { todo: true }), pickFn(b, c));
test.only = (a, b, c) => register('test', a, b, c);
function pickFn(b, c) { return typeof c === 'function' ? c : (typeof b === 'function' ? b : undefined); }
function mergeOpts(b, c, extra) {
  const o = (b && typeof b === 'object') ? b : (c && typeof c === 'object' ? c : {});
  return Object.assign({}, o, extra);
}

const describe = (a, b, c) => register('suite', a, b, c);
describe.skip = (a, b, c) => { const n = register('suite', a, b, c); markSkip(current.children[current.children.length - 1]); return n; };
function markSkip(node) { if (node) node.opts = Object.assign({}, node.opts, { skip: true }); }

const it = test;
it.skip = test.skip;
it.todo = test.todo;

const before = (fn, opts) => { current.hooks.before.push({ fn, opts }); };
const after = (fn, opts) => { current.hooks.after.push({ fn, opts }); };
const beforeEach = (fn, opts) => { current.hooks.beforeEach.push({ fn, opts }); };
const afterEach = (fn, opts) => { current.hooks.afterEach.push({ fn, opts }); };

/* ---- the `t` context -------------------------------------------------------
 * Everything here is plumbing node:test itself supplies. `mock` is NOT supplied:
 * a stub would let a mocking test go green while measuring nothing, which is the
 * exact defect this whole exercise exists to remove. */
function makeCtx(node, out) {
  const ctx = {
    name: node.name,
    skip(msg) { node._skipped = msg || true; },
    todo(msg) { node._todo = msg || true; },
    diagnostic(msg) { out.diagnostics.push(String(msg)); },
    plan() { /* count-only in node; not enforced here */ },
    runOnly() {},
    get signal() { throw new Error('engine-harness: t.signal not implemented'); },
    get mock() { throw new Error('engine-harness: t.mock not implemented (real gap, not a stub)'); },
  };
  ctx.test = (a, b, c) => {
    const { name, opts, fn } = normalize(a, b, c);
    const sub = { kind: 'test', name, opts, fn, children: [], hooks: newHooks() };
    node.children.push(sub);
    return Promise.resolve();
  };
  ctx.before = before; ctx.after = after;
  ctx.beforeEach = beforeEach; ctx.afterEach = afterEach;
  return ctx;
}

/* ---- execution ------------------------------------------------------------ */
const stats = { tests: 0, pass: 0, fail: 0, skip: 0, todo: 0 };
const failures = [];
let counter = 0;

function say(s) { console.log(s); }

async function callFn(fn, ctx) {
  if (typeof fn !== 'function') return;
  if (fn.length >= 2) {
    // node:test callback style: fn(t, done)
    return await new Promise((res, rej) => {
      let settled = false;
      const done = (e) => { if (settled) return; settled = true; e ? rej(e) : res(); };
      const r = fn(ctx, done);
      if (r && typeof r.then === 'function') r.then(() => done(), done);
    });
  }
  return await fn(ctx);
}

async function runHooks(list, ctx) { for (const h of list) await callFn(h.fn, ctx); }

async function runNode(node, prefix, eachStack) {
  if (node.kind === 'suite') {
    const label = prefix ? `${prefix} > ${node.name}` : node.name;
    if (node.opts && node.opts.skip) { skipTree(node, label); return; }
    const ctx = makeCtx(node, { diagnostics: [] });
    try { await runHooks(node.hooks.before, ctx); }
    catch (e) { record(false, label + ' (before hook)', e); return; }
    const stack = eachStack.concat([node.hooks]);
    for (const child of node.children.slice()) await runNode(child, label, stack);
    try { await runHooks(node.hooks.after, ctx); }
    catch (e) { record(false, label + ' (after hook)', e); }
    return;
  }

  const label = prefix ? `${prefix} > ${node.name}` : node.name;
  if (node.opts && (node.opts.skip || node.opts.todo)) {
    stats.tests++; counter++;
    if (node.opts.todo) { stats.todo++; say(`ok ${counter} - ${label} # TODO`); }
    else { stats.skip++; say(`ok ${counter} - ${label} # SKIP`); }
    if (node._resolve) node._resolve();
    return;
  }
  const out = { diagnostics: [] };
  const ctx = makeCtx(node, out);
  let err = null;
  try {
    for (const h of eachStack) await runHooks(h.beforeEach, ctx);
    await callFn(node.fn, ctx);
  } catch (e) { err = e; }
  try { for (const h of eachStack.slice().reverse()) await runHooks(h.afterEach, ctx); }
  catch (e) { if (!err) err = e; }

  stats.tests++; counter++;
  if (node._skipped && !err) {
    stats.skip++;
    say(`ok ${counter} - ${label} # SKIP ${node._skipped === true ? '' : node._skipped}`);
  } else if (err) {
    stats.fail++;
    failures.push({ label, err });
    say(`not ok ${counter} - ${label}`);
    say(`  ---`);
    say(`  error: ${errText(err)}`);
    const st = err && err.stack;
    if (st) say('  stack: ' + String(st).split('\n').slice(0, 6).join(' | '));
    say(`  ...`);
  } else {
    stats.pass++;
    say(`ok ${counter} - ${label}`);
  }
  for (const d of out.diagnostics) say(`# ${d}`);
  if (node._resolve) node._resolve();
  // subtests registered via t.test()
  for (const child of node.children.slice()) await runNode(child, label, eachStack);
}

function errText(e) {
  if (!e) return String(e);
  if (e.message) return e.message;
  return String(e);
}

function skipTree(node, label) {
  for (const c of node.children) {
    if (c.kind === 'suite') skipTree(c, `${label} > ${c.name}`);
    else { stats.tests++; stats.skip++; counter++; say(`ok ${counter} - ${label} > ${c.name} # SKIP`); }
  }
}

async function run() {
  for (const child of ROOT.children.slice()) await runNode(child, '', [ROOT.hooks]);
  say(`1..${counter}`);
  say(`# tests ${stats.tests}`);
  say(`# pass ${stats.pass}`);
  say(`# fail ${stats.fail}`);
  say(`# skip ${stats.skip}`);
  say(`# todo ${stats.todo}`);
  return stats;
}

const moduleExports = test;
moduleExports.test = test;
moduleExports.describe = describe;
moduleExports.it = it;
moduleExports.suite = describe;
moduleExports.before = before;
moduleExports.after = after;
moduleExports.beforeEach = beforeEach;
moduleExports.afterEach = afterEach;
moduleExports.default = test;
Object.defineProperty(moduleExports, 'mock', {
  get() { throw new Error('engine-harness: node:test mock is not implemented (real gap, not a stub)'); },
});

module.exports = { moduleExports, run, stats, failures, ROOT };
