'use strict';
// MODULE-NAME-INDEX (spike/quickjs/patches/quickjs-ng-module-name-index.patch): loading N
// ES modules costs O(N) in the engine's module lookup, not O(N^2).
//
// WHAT WAS WRONG. QuickJS-ng finds an already-loaded module by walking EVERY loaded module
// (js_find_loaded_module over ctx->loaded_modules), and it does so for each import of each
// module it reads (JS_ReadModule -> js_host_resolve_imported_module). Claude Code 2.1.330 is
// 3,574 ES modules, which the graph runner compiles and round-trips (two module records a
// name), so a boot walked that list for every import: `sample` of a plain -p /status turn on
// darwin-arm64 put 2,699 ms of a 12 s CPU boot on top of js_host_resolve_imported_module
// (2026-11-24), and under 32 `yes` that cost helped hold the loop past axios's 5 s timers
// (BACKLOG.md, "Under heavy CPU load").
//
// THE CLASS, NOT THE INSTANCE. The guard is a growth RATIO, not a duration: a synthetic graph
// of 4N modules must not cost much more than 4x a graph of N. Any lookup, registration or
// resolution step that walks all loaded modules per import (this one, or a new one an
// upstream bump brings) makes the ratio approach 16x and fails here, whatever the box's
// speed. Each size runs in its OWN engine process, built exactly as the graph runner builds
// the carve (libexec/extract-claude-js.cjs graphRunnerSource: tjs.engine.compile, then
// deserialize(serialize(...)), in topological order), and each takes the best of several
// runs, so a loaded box slows both sides rather than one.
//
// The semantics half holds on an engine WITHOUT the patch too: the index must not change
// what any lookup answers (the FIRST module registered under a name, which is what the list
// walk returned), nor survive a module the engine frees.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { engineSpawn, skipUnlessTjs } = require('./node-shim-helper.cjs');

function runFile(body, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modindex-'));
  const f = path.join(dir, 'probe.js');
  fs.writeFileSync(f, body);
  try {
    const [cmd, argv] = engineSpawn(['run', f, ...args]);
    const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 180000, cwd: dir });
    assert.strictEqual(r.status, 0, `tjs exited ${r.status} (${r.signal}): ${r.stderr}`);
    return { out: JSON.parse(r.stdout.trim().split('\n').pop()), dir };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// N modules, each importing the K before it, loaded as the graph runner loads the carve.
// Prints the milliseconds the whole load took.
const GRAPH_PROBE = `
const enc = new TextEncoder();
const N = Number(tjs.args[tjs.args.length - 2]), K = Number(tjs.args[tjs.args.length - 1]);
const t = performance.now();
for (let i = 0; i < N; i++) {
  let s = '';
  for (let j = 1; j <= K && i - j >= 0; j++) s += 'import "/graph/m' + (i - j) + '.js";\\n';
  s += 'export const v' + i + ' = ' + i + ';\\n';
  tjs.engine.deserialize(tjs.engine.serialize(tjs.engine.compile(enc.encode(s), '/graph/m' + i + '.js')));
}
console.log(JSON.stringify({ ms: performance.now() - t }));
`;

function loadMs(n, k) {
  return runFile(GRAPH_PROBE, [String(n), String(k)]).out.ms;
}

// THE BOUND, from measurement (darwin-arm64, 2026-11-24, best of 3 per size, N=1000, K=8):
//   before the patch  N 75-79 ms, 4N 1,450-1,660 ms: ratio 19.2-21.1 (above 16: the
//                     roundtrip's duplicates double the list, and a longer walk misses cache more)
//   after the patch   N 10.5-10.6 ms, 4N 44.7-46.3 ms: ratio 4.2-4.4
// A linear load is 4x; any per-import walk of all modules pushes it toward 16x and past.
// The cut at 8 leaves 2x over linear for noise and stays half of the quadratic floor.
const N = 1000;
const K = 8;
const RATIO_MAX = 8;
// Below this the small graph is too quick to time; grow N.
const SMALL_FLOOR_MS = 3;

test('loading 4N ES modules costs about 4x loading N, not 16x (module lookup is not a walk)', (t) => {
  if (skipUnlessTjs(t)) return;
  const best = (n) => Math.min(loadMs(n, K), loadMs(n, K), loadMs(n, K));
  const small = best(N);
  const big = best(4 * N);
  const said = `N=${N} K=${K}: ${small.toFixed(1)} ms; 4N: ${big.toFixed(1)} ms; ratio ${(big / small).toFixed(2)}`;
  assert.ok(small >= SMALL_FLOOR_MS, `the N-module graph loaded in under ${SMALL_FLOOR_MS} ms, too fast to time: grow N (${said})`);
  assert.ok(big / small <= RATIO_MAX,
    `module loading grew superlinearly in module count (bound ${RATIO_MAX}x for 4x the modules): `
    + `something walks every loaded module per import again (quickjs-ng-module-name-index.patch) (${said})`);
});

// Duplicate names resolve to the FIRST registered (the graph runner's compile + roundtrip
// makes two records per name, and the walk answered the first); a module the engine frees
// after a failed link leaves no stale entry: importing it again fails again, the same way,
// and the good modules beside it still load.
const SEMANTICS_PROBE = `
const enc = new TextEncoder();
const out = {};
const c = (src, name) => tjs.engine.compile(enc.encode(src), name);
// what the graph runner evaluates: a compiled module, round-tripped (a compile-only module
// object handed straight to evalBytecode aborts on an engine with or without the patch)
const rt = (src, name) => tjs.engine.deserialize(tjs.engine.serialize(c(src, name)));
c('export const v = 1;', '/dup/a.js');
c('export const v = 2;', '/dup/a.js');
rt('export const v = 3;', '/dup/a.js');
tjs.engine.evalBytecode(rt('import { v } from "/dup/a.js"; globalThis.__seen = v;', '/dup/user.js'));
await new Promise((r) => setTimeout(r, 0));
out.firstRegistered = globalThis.__seen;
const dir = tjs.cwd;
const w = async (n, s) => { const f = await tjs.open(dir + '/' + n, 'w'); await f.write(enc.encode(s)); await f.close(); };
await w('good.js', 'export const g = 7;');
await w('bad.js', 'import { missing } from "./good.js"; export const b = missing;');
await w('ok.js', 'import { g } from "./good.js"; export const o = g + 1;');
const errOf = async (spec) => { try { await import(spec); return 'no error'; } catch (e) { return e.constructor.name + ': ' + e.message; } };
out.bad1 = await errOf(dir + '/bad.js');
out.bad2 = await errOf(dir + '/bad.js');
out.ok = (await import(dir + '/ok.js')).o;
out.good = (await import(dir + '/good.js')).g;
const many = [];
for (let i = 0; i < 300; i++) many.push(c('export const x = ' + i + ';', '/many/m' + i + '.js'));
tjs.engine.evalBytecode(rt(Array.from({ length: 300 }, (_, i) => 'import { x as x' + i + ' } from "/many/m' + i + '.js";').join('\\n')
  + '\\nglobalThis.__sum = ' + Array.from({ length: 300 }, (_, i) => 'x' + i).join('+') + ';', '/many/user.js'));
await new Promise((r) => setTimeout(r, 0));
out.sum = globalThis.__sum;
console.log(JSON.stringify(out));
`;

test('the module index answers what the list walk answered (first registered; freed modules leave)', (t) => {
  if (skipUnlessTjs(t)) return;
  const { out } = runFile(SEMANTICS_PROBE);
  assert.strictEqual(out.firstRegistered, 1, 'a name registered twice resolves to the FIRST record, as the list walk did');
  assert.match(out.bad1, /missing/, `a module importing a missing binding fails to link: ${out.bad1}`);
  assert.strictEqual(out.bad2, out.bad1, 'importing the freed module again fails again, the same way (no stale index entry)');
  assert.strictEqual(out.ok, 8, 'a good module beside the failed one still loads');
  assert.strictEqual(out.good, 7);
  assert.strictEqual(out.sum, (299 * 300) / 2, 'past several index growths every name still resolves to its own module');
});
