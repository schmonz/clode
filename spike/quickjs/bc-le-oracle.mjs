#!/usr/bin/env node
// The bytecode LE-identity oracle (canonical-LE plan, 2026-07-11).
//
// Serializes a fixed corpus under a given tjs binary and prints one
// deterministic sha256 line per item. The canonical-LE patch MUST be
// byte-invisible on little-endian hosts: run before the patch, run after,
// diff the output — any change is a bug. (On BE hosts the hashes are
// EXPECTED to equal the LE baseline after the patch — that is the point.)
//
// Usage: node spike/quickjs/bc-le-oracle.mjs <tjs-binary> [vendor-txiki-dir]
//   vendor dir defaults to spike/quickjs/vendor/txiki.js; its
//   src/bundles/js/core/*.js provide the real-world corpus (the esbuilt
//   bundles the engine actually boots), plus one inline stress source
//   covering wide strings, doubles, bigints, atoms, and branchy labels.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(new URL('../..', import.meta.url).pathname);
const tjsBin = process.argv[2];
const vendorTjs = process.argv[3] || path.join(repo, 'spike/quickjs/vendor/txiki.js');
if (!tjsBin || !fs.existsSync(tjsBin)) {
  console.error('usage: bc-le-oracle.mjs <tjs-binary> [vendor-txiki-dir]');
  process.exit(2);
}

const STRESS = `
// stress: wide strings, doubles, bigints, many atoms, labels/branches
const wide = "\\u00e9\\u4e2d\\u6587\\ud83d\\ude00 na\\u00efve fa\\u00e7ade";
const nums = [3.141592653589793, -0.0, 1e308, 5e-324, NaN, Infinity];
const big = 123456789012345678901234567890n * -42n;
function branchy(x) {
  outer: for (let i = 0; i < x; i++) {
    switch (i % 5) {
      case 0: continue outer;
      case 1: if (i > 10) break outer; else continue;
      case 2: try { throw new Error(wide + i); } catch (e) { void e; } break;
      default: x += nums[i % nums.length] || 0;
    }
  }
  return { x, wide, big, nested: { a: [1, [2, [3]]], b: new Map() } };
}
export default branchy;
`;

// Corpus rule: compile() resolves imports EAGERLY, so items must be free
// of import statements (the engine's own bundles import tjs:internal/* and
// are compile-privileged — unusable here). Large plain-CJS files compile
// fine as modules (require() is just a runtime call) and exercise big atom
// tables, long functions, and every common opcode family.
const corpus = [];
const candidates = ['libexec/node-shim/loader.cjs'];
// The realest corpus there is: an esbuilt clode-main bundle (the exact
// payload class the fuse serializes). Pick the newest tag dir that has one.
const buildDir = path.join(repo, 'build');
if (fs.existsSync(buildDir)) {
  for (const tag of fs.readdirSync(buildDir).sort()) {
    const b = path.join('build', tag, 'clode-main.bundle.cjs');
    if (fs.existsSync(path.join(repo, b))) candidates.push(b);
  }
}
for (const rel of candidates) {
  const p = path.join(repo, rel);
  if (fs.existsSync(p) && !/^\s*import[\s{"']/m.test(fs.readFileSync(p, 'utf8'))) {
    corpus.push({ name: rel, file: p });
  }
}
corpus.push({ name: 'stress(inline)', text: STRESS });
void vendorTjs;

// The tjs-side worker: read source path (or inline b64) from env, compile as
// a module, serialize, print hex. Hex keeps the transport trivially exact.
const WORKER = `
const enc = new TextEncoder();
let bytes;
if (tjs.env.BC_ORACLE_FILE) {
  bytes = await tjs.readFile(tjs.env.BC_ORACLE_FILE);
} else {
  bytes = enc.encode(atob(tjs.env.BC_ORACLE_B64));
}
const bc = tjs.engine.serialize(tjs.engine.compile(bytes, tjs.env.BC_ORACLE_NAME));
let hex = '';
for (const b of bc) hex += b.toString(16).padStart(2, '0');
console.log('BC:' + bc.length + ':' + hex);
`;

let failures = 0;
for (const item of corpus) {
  const env = { ...process.env, BC_ORACLE_NAME: `/oracle/${item.name}` };
  if (item.file) env.BC_ORACLE_FILE = item.file;
  else env.BC_ORACLE_B64 = Buffer.from(item.text, 'utf8').toString('base64');
  try {
    const out = execFileSync(tjsBin, ['eval', WORKER], { env, encoding: 'utf8' });
    const m = out.match(/^BC:(\d+):([0-9a-f]+)$/m);
    if (!m || Number(m[1]) * 2 !== m[2].length) throw new Error(`bad worker output: ${out.slice(0, 120)}`);
    const hash = createHash('sha256').update(Buffer.from(m[2], 'hex')).digest('hex');
    console.log(`sha256(${item.name}) bytes=${m[1]} ${hash}`);
  } catch (e) {
    failures++;
    console.log(`FAIL(${item.name}) ${String(e.message || e).split('\n')[0]}`);
  }
}
process.exit(failures ? 1 : 0);
