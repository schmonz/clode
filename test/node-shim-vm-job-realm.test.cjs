'use strict';
// A vm context must outlive every promise job it queued, and a rejection inside one must not abort the engine.
//
// WHY (2026-11-21, BACKLOG "NETBSD-ARM64 INTERMITTENT SIGSEGV"): quaude died of SIGSEGV mid-turn in tools-local's
// "ReportFindings, Workflow and ListAgents" test on NetBSD/arm64 (2 of 25 runs of that one test; 0 of 40 on
// darwin-arm64). Both cores: free_gc_object reading a NULL shape, under js_new_promise_capability <-
// js_promise_then_finally_func <- promise_reaction_job, i.e. a cross-realm promise job freeing an already-freed object.
// An AddressSanitizer engine named the cause: quickjs-ng's JS_EnqueueJob kept the queuing context as a bare
// pointer, so a vm context (src/mod_vm.c, the Workflow tool's script realm) could be collected while a job it had
// queued was still pending, and the job then ran in freed memory (heap-use-after-free of the JSContext, freed by
// JS_FreeContext from the cycle collector). spike/quickjs/patches/quickjs-ng-job-realm-ref.patch holds a reference
// for as long as the job is queued.
//
// The second test is the abort found beside it: a child context had no TJSRuntime opaque, so the engine's promise
// rejection tracker hit CHECK_NOT_NULL and SIGABRTed on the first rejection inside a vm context, even one the host
// catches (a Workflow script that throws). txiki-vm-context.patch now gives the child its parent's runtime.
//
// The first program is the engine's own (the vm primitive, __tjs_vm, which node-shim's vm module is built on): the
// collection between queuing and running is forced with tjs.engine.gc.run, and the engine is the subject. The second
// runs through node-shim's require('vm') under host node too, and quaude must print what node prints.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { engineSpawn, skipUnlessTjs, LOADER } = require('./node-shim-helper.cjs');

function withProg(body, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-vm-job-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  try { return fn(f); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function runEngine(args) {
  const [cmd, argv] = engineSpawn(args);
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 60000 });
  return { status: r.status, signal: r.signal, out: (r.stdout || '').trim(), stderr: (r.stderr || '').slice(0, 800) };
}

// The child's own Promise.prototype.then, applied to a host promise that has already settled, queues its reaction
// job IN the child context, and every value the job holds (the host promise, the host handler, the host-realm result
// promise) is a host value: nothing the job holds keeps the child alive. Dropping the context and collecting before
// the microtask checkpoint frees the child while the job is queued; the churn reuses its memory before the job runs.
// Measured on the unpatched engine (darwin-arm64, 2026-11-21): SIGSEGV on every run, the handler never ran; under
// AddressSanitizer, heap-use-after-free of the JSContext. Through node-shim's require('vm') the same program did not
// crash (the loader keeps the child reachable), so it would be no instrument there.
const QUEUED_JOB = `
  const VM = globalThis.__tjs_vm;
  let h = VM.create();
  const out = [];
  VM.setGlobal(h, 'hostP', Promise.resolve(41));
  VM.setGlobal(h, 'hostFn', (v) => { out.push(v + 1); return v + 1; });
  VM.run(h, 'Promise.prototype.then.call(hostP, hostFn); undefined', 'job.js');
  h = null;
  tjs.engine.gc.run();
  const junk = []; for (let i = 0; i < 20000; i++) junk.push({ i, s: 'x'.repeat(i % 50) });
  setTimeout(() => console.log(JSON.stringify({ out, junk: junk.length })), 20);
`;

test('a job a vm context queued still runs after the context is dropped and collected', (t) => {
  if (skipUnlessTjs(t)) return;
  const r = withProg(QUEUED_JOB, (f) => runEngine(['run', f]));
  assert.deepStrictEqual({ status: r.status, signal: r.signal, out: r.out },
    { status: 0, signal: null, out: '{"out":[42],"junk":20000}' }, `stderr: ${r.stderr}`);
});

// An async script that throws, run in a vm context, with the host catching its promise: the Workflow tool's shape
// for a script that fails. Measured on the unpatched engine: SIGABRT on every run ("tjs__promise_rejection_tracker:
// Assertion (qrt) != NULL failed"), before the host's handler could run.
const CHILD_REJECTION = `
  const vm = require('vm');
  const ctx = vm.createContext({});
  const p = vm.runInContext('(async () => { throw new Error("script failed") })()', ctx);
  p.then(() => console.log('resolved'), (e) => console.log('caught: ' + e.message));
`;

test('a rejection inside a vm context reaches the host handler instead of aborting the engine (quaude matches node)', (t) => {
  if (skipUnlessTjs(t)) return;
  const { node, r } = withProg(CHILD_REJECTION, (f) => ({
    node: execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim(), r: runEngine(['run', LOADER, f]) }));
  assert.strictEqual(node, 'caught: script failed', 'the node oracle moved');
  assert.deepStrictEqual({ status: r.status, signal: r.signal, out: r.out }, { status: 0, signal: null, out: node },
    `quaude differs from node. stderr: ${r.stderr}`);
});
