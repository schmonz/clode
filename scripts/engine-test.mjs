#!/usr/bin/env node
'use strict';
/* engine-test — run node:test-shaped test files ON THE ENGINE (txiki/quickjs),
 * one child per file, and (with --compare) run the SAME file under host node so
 * a divergence is attributable.
 *
 * This is a PARALLEL entry point. It does not touch `npm test` (test/run.mjs).
 *
 *   node scripts/engine-test.mjs test/jsutil.test.cjs [...]
 *   node scripts/engine-test.mjs --compare test/jsutil.test.cjs
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function tjsPath() {
  if (process.env.CLODE_TJS) return process.env.CLODE_TJS;
  const { tjsBin } = require(path.join(ROOT, 'scripts/platform-tag.cjs'));
  return tjsBin(ROOT);
}

const args = process.argv.slice(2);
const compare = args.includes('--compare');
const verbose = args.includes('--verbose');
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) { console.error('usage: engine-test.mjs [--compare] [--verbose] <file.test.cjs> ...'); process.exit(64); }

const TJS = tjsPath();
if (!fs.existsSync(TJS)) { console.error(`engine-test: no engine at ${TJS} (set CLODE_TJS)`); process.exit(2); }

const LOADER = path.join(ROOT, 'libexec/node-shim/loader.cjs');
const RUN = path.join(ROOT, 'test/engine/run.cjs');

// CLODE_* leak: an inherited CLODE_CLAUDE_BIN (or a warm store) silently changes
// what a test measures. Scrub the ones that steer behaviour and point the store
// at throwaway dirs.
const scrub = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLODE_')));
const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'clode-enginetest-'));
const ENV = {
  ...scrub,
  CLODE_OFFLINE: '1',
  CLODE_DEPS: path.join(TMP, 'deps'),
  CLODE_CACHE: path.join(TMP, 'cache'),
  CLODE_TJS: TJS,
};

function parse(out) {
  const g = (re) => { const m = out.match(re); return m ? Number(m[1]) : null; };
  return {
    tests: g(/^# tests (\d+)$/m), pass: g(/^# pass (\d+)$/m),
    fail: g(/^# fail (\d+)$/m), skip: g(/^# skip (\d+)$/m),
    result: (out.match(/^# RESULT (\w+)$/m) || [])[1] || null,
  };
}

const rows = [];
for (const f of files) {
  const abs = path.resolve(ROOT, f);
  const e = spawnSync(TJS, ['run', LOADER, RUN, abs],
    { encoding: 'utf8', cwd: ROOT, env: ENV, timeout: Number(process.env.ENGINE_TEST_TIMEOUT || 120000) });
  const eOut = (e.stdout || '') + (e.stderr || '');
  const es = parse(eOut);
  const row = { file: f, engine: { ...es, status: e.status, out: eOut } };

  if (compare) {
    const n = spawnSync(process.execPath, ['--test', '--test-reporter=tap', abs],
      { encoding: 'utf8', cwd: ROOT, env: ENV, timeout: Number(process.env.ENGINE_TEST_TIMEOUT || 120000) });
    const nOut = (n.stdout || '') + (n.stderr || '');
    row.node = {
      tests: Number((nOut.match(/^# tests (\d+)$/m) || [])[1] ?? NaN),
      pass: Number((nOut.match(/^# pass (\d+)$/m) || [])[1] ?? NaN),
      fail: Number((nOut.match(/^# fail (\d+)$/m) || [])[1] ?? NaN),
      skip: Number((nOut.match(/^# skipped (\d+)$/m) || [])[1] ?? NaN),
      status: n.status, out: nOut,
    };
  }
  rows.push(row);

  const eSum = es.tests === null
    ? `ENGINE-CRASH(status=${e.status})`
    : `${es.pass}/${es.tests} pass, ${es.fail} fail, ${es.skip} skip`;
  const nSum = row.node ? `  |  node: ${row.node.pass}/${row.node.tests} pass, ${row.node.fail} fail, ${row.node.skip} skip` : '';
  console.log(`${(es.result === 'PASS' ? 'PASS' : 'FAIL').padEnd(4)} ${f.padEnd(46)} engine: ${eSum}${nSum}`);
  if (verbose || es.result !== 'PASS') {
    for (const line of eOut.split('\n')) if (/^(not ok|  error:|  stack:|# FATAL|SyntaxError|Error:|node-shim:)/.test(line)) console.log('      ' + line);
  }
}

const bad = rows.filter((r) => r.engine.result !== 'PASS');
console.log(`\n== ${rows.length} files, ${rows.length - bad.length} PASS, ${bad.length} FAIL on the engine ==`);
if (process.env.ENGINE_TEST_JSON) fs.writeFileSync(process.env.ENGINE_TEST_JSON, JSON.stringify(rows, null, 1));
process.exit(bad.length ? 1 : 0);
