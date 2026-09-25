'use strict';
// The build gate inside `scripts/lib/paint-probe.cjs`: the paint differential's probe program
// restates two numeric facts about the bundle's Bun.ant.CellSegmenter wrapper that phase 5's
// brief pinned by reading the carve (rp2.pretty.js:13704-13713) rather than deriving them at
// run time — because the probe assigns its OWN pool ids (see paint-probe.cjs's header), it
// cannot ask the bundle "what shift do you use" the way it can ask a live instance for a
// string. The two facts:
//   WORD PACKING  — jn(style,link,width) = style<<17 | link<<2 | width. The probe both ENCODES
//     (idFor(...) << 17 | idFor(...) << 2 | width, building a runWords()/setCell() word to hand
//     the segmenter) and DECODES (w >>> 17 for style, (w >>> 2) & 0x7fff for link, reading the
//     screen cell back) with 17 and 2 hardcoded.
//   DAMAGE PACKING — paint()/setCell()'s packed return is endColumn | x1<<20 | x2<<36, i.e.
//     x1 = floor(ret/1048576)%65536 and x2 = floor(ret/68719476736). The probe decodes exactly
//     those three constants when it records `ret`.
//
// WHY A GUARD. The probe derives a verdict from bytes (the structural regexes below `.exec`/
// `.test` the carve) and refuses (an empty corpus throws — see paint-probe.cjs), so the
// production-gate sweep (test/guards-population.cjs) counts it gate-shaped, same mechanism as
// scripts/lib/text-probe.cjs's own gate. If upstream ever widens the style pool past 32767
// entries (bumping the shift) or repacks the damage triple, this probe would go on decoding
// garbage while comparePaintResults quietly compares garbage to garbage-shaped garbage: two
// wrong numbers that happen to still not equal each other read as a real difference, but two
// wrong numbers that happen to equal by coincidence would read as agreement on a comparison
// that means nothing. This is the control.
//
// The literal relative require below is load-bearing for the production-gate population sweep,
// which derives "which guard controls this production gate" from that string.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert');
const { defineGuard, guardTests } = require('../guard.cjs');
const { PAINT_SOURCE } = require('../../scripts/lib/paint-probe.cjs');
const { decodeGraphRunner } = require('../../libexec/inspect-claude-bundle.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const EXTRACT = path.join(REPO, 'libexec', 'extract-claude-js.cjs');

// Resolve a token the discovery regex captured as either a decimal literal (`17`) or a
// module-scope identifier assigned one, e.g. `var sl=17,Bo=2,...` or `,Bo=2` mid-list — the
// two shapes the real carve uses for `jn`'s shift constants (they are shared with several other
// readers in the same module, per the contract, so the minifier keeps them as named vars
// instead of inlining them into jn() alone).
function resolveConst(bundle, tok) {
  if (/^\d+$/.test(tok)) return Number(tok);
  const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:var\\s+|[,;])${escaped}=(\\d+)`).exec(bundle);
  return m ? Number(m[1]) : null;
}

// packWord: a 3-parameter function whose entire body ORs three left-shifted/plain reads of its
// own params, in order — `function X(a,b,c){return a<<K0|b<<K1|c}`. The function's own name is
// itself a minified token (contract: jn/vs/sl/Bo are already minifier output, not source names)
// so it is never matched by name; the param-reuse backreferences are what make this specific
// (measured against the real 2.1.278 carve, 37MB decoded: exactly one match).
function scanWordPacking({ bundle, probe, what }) {
  const findings = [];
  const re = /function \w+\((\w+),(\w+),(\w+)\)\{return \1<<(\w+)\|\2<<(\w+)\|\3\}/g;
  let m, examined = 0;
  while ((m = re.exec(bundle)) !== null) {
    examined++;
    const at = bundle.slice(m.index, m.index + 100);
    const styleShift = resolveConst(bundle, m[4]);
    const linkShift = resolveConst(bundle, m[5]);
    if (styleShift === null) findings.push(`a packWord function's style-shift token '${m[4]}' could not be resolved to a number: ${at}...`);
    else if (styleShift !== 17) findings.push(`a packWord function shifts style by ${styleShift}, not 17 (scripts/lib/paint-probe.cjs encodes/decodes style at bit 17): ${at}...`);
    if (linkShift === null) findings.push(`a packWord function's link-shift token '${m[5]}' could not be resolved to a number: ${at}...`);
    else if (linkShift !== 2) findings.push(`a packWord function shifts link by ${linkShift}, not 2 (scripts/lib/paint-probe.cjs encodes/decodes link at bit 2): ${at}...`);
  }
  if (examined > 0) {
    for (const [needle, why] of [
      ['<< 17', 'the probe no longer encodes a style id at bit 17'],
      ['>>> 17', 'the probe no longer decodes a style id from bit 17'],
      ['<< 2)', 'the probe no longer encodes a link id at bit 2'],
      ['>>> 2) & 0x7fff', 'the probe no longer decodes a link id from bit 2'],
    ]) {
      if (!probe.includes(needle)) findings.push(`scripts/lib/paint-probe.cjs no longer contains "${needle}" (${why})`);
    }
  }
  return { findings, examined, note: `${what}: ${examined} packWord-shaped function(s)` };
}

// The damage-triple decode: `let f=Math.floor(IDENT/D1)%D2,m=Math.floor(IDENT/D3)` — the SAME
// ident divided twice, the first floor mod'd, the second not (B0's damage rect and F0's
// atlasRecorder branch both do this over the same packed return; measured: exactly 2 matches on
// the real carve, 0 false positives from unrelated floor/mod code elsewhere in the 37MB bundle
// — a looser `Math.floor(x/N)%M...Math.floor(x/P)` regex without the `let a=...,b=` prefix and
// shared ident matched a THIRD, unrelated site).
function scanDamagePacking({ bundle, probe, what }) {
  const findings = [];
  const re = /let \w+=Math\.floor\((\w+)\/(\d+)\)%(\d+),\w+=Math\.floor\(\1\/(\d+)\)/g;
  let m, examined = 0;
  while ((m = re.exec(bundle)) !== null) {
    examined++;
    const at = bundle.slice(m.index, m.index + 100);
    const [, , div1, mod, div2] = m;
    if (Number(div1) !== 1048576) findings.push(`a damage-decode site divides by ${div1}, not 1048576, before the mod (paint-probe.cjs's \`ret % 1048576\`): ${at}...`);
    if (Number(mod) !== 65536) findings.push(`a damage-decode site mods by ${mod}, not 65536 (paint-probe.cjs's \`% 65536\`): ${at}...`);
    if (Number(div2) !== 68719476736) findings.push(`a damage-decode site's second division is by ${div2}, not 68719476736 (paint-probe.cjs's \`/ 68719476736\`): ${at}...`);
  }
  if (examined > 0) {
    for (const [needle, why] of [
      ['% 1048576', 'the probe no longer reads the end column with % 1048576'],
      ['/ 1048576) % 65536', 'the probe no longer decodes damage x1 as floor(ret/1048576)%65536'],
      ['/ 68719476736)', 'the probe no longer decodes damage x2 as floor(ret/68719476736)'],
    ]) {
      if (!probe.includes(needle)) findings.push(`scripts/lib/paint-probe.cjs no longer contains "${needle}" (${why})`);
    }
  }
  return { findings, examined, note: `${what}: ${examined} damage-decode site(s)` };
}

// The carve of CLODE_PROVIDER_BIN, decoded the way inspect-claude-bundle reads it — same
// pattern as test/build-gates/text-probe-gates.test.cjs's readCarve, a separate copy per guard
// file by this repo's convention (each build-gates file resolves its own inputs).
let CARVE = null;
function readCarve() {
  if (CARVE) return CARVE;
  const bin = process.env.CLODE_PROVIDER_BIN;
  if (!bin || !fs.existsSync(bin)) return { skip: 'no CLODE_PROVIDER_BIN (point it at a real claude binary to run this gate)' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-probe-gate-'));
  try {
    const cli = path.join(dir, 'cli.cjs');
    const ex = spawnSync(process.execPath, [EXTRACT, bin, cli], { encoding: 'utf8' });
    if (ex.status !== 0) throw new Error(`extract-claude-js could not carve ${bin}: ${(ex.stderr || '').slice(0, 400)}`);
    const decoded = decodeGraphRunner(cli);
    const bundle = decoded !== null ? decoded : fs.readFileSync(cli, 'latin1');
    if (!bundle.includes('sgrCloseKeys')) CARVE = { skip: `the carve of ${bin} has no CellSegmenter caller (the bundle adopted it in 2.1.278)` };
    else CARVE = { bundle, probe: PAINT_SOURCE, what: `the carve of ${bin}` };
    return CARVE;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The 2.1.278 carve's own text, verbatim (darwin-arm64, 2026-09-25, extracted fresh for this
// gate rather than trusted from an older scratch file): the packWord function and the two
// call sites that decode its packed return the same way.
const WORD_CALLER = 'var sl=17,Bo=2,Pr=32767,gn=3,dx=(1<<32-sl)-1,Pd=dx>>>1,fx=Pd>>>1;function jn(n,s,u){return n<<sl|s<<Bo|u}';
const DAMAGE_CALLER = 'function B0(n,s,u){let f=Math.floor(u/1048576)%65536,m=Math.floor(u/68719476736);if(f>=m)return;'
  + 'let p={x:f,y:s,width:m-f,height:1};n.damage=n.damage?rl(n.damage,p):p}'
  + 'function F0(n,s,u,f){let m=f.paint(n.cells,n.width,s,u,n.hyperlinkPool);B0(n,u,m);'
  + 'let p=n.atlasRecorder;if(p.recording){let S=Math.floor(m/1048576)%65536,C=Math.floor(m/68719476736);}}';

guardTests(defineGuard({
  name: 'paint-probe-word-packing',
  floor: 1,
  read: readCarve,
  scan: scanWordPacking,
  // A packWord whose style shift moved from 17 to 18 (e.g. a style pool wider than 32767
  // entries) — the probe would go on packing/unpacking at the old bit and silently compare
  // garbage to garbage.
  control: () => ({ bundle: WORD_CALLER.replace('sl=17', 'sl=18'), probe: PAINT_SOURCE, what: 'synthetic control' }),
}));

test('the word-packing scan passes the 2.1.278 carve verbatim and names each drift', () => {
  const run = (bundle) => scanWordPacking({ bundle, probe: PAINT_SOURCE, what: 'x' });
  assert.deepStrictEqual(run(WORD_CALLER).findings, [], 'the probe restates the 2.1.278 packWord shifts');
  assert.strictEqual(run(WORD_CALLER).examined, 1);
  assert.strictEqual(run(WORD_CALLER.replace('sl=17', 'sl=18')).findings.length, 1, 'a style shift that moved');
  assert.strictEqual(run(WORD_CALLER.replace('Bo=2', 'Bo=3')).findings.length, 1, 'a link shift that moved');
  assert.strictEqual(scanWordPacking({ bundle: WORD_CALLER, probe: 'no shifts here', what: 'x' }).findings.length, 4, 'the probe itself stopped restating both shifts');
  assert.strictEqual(run('').examined, 0, 'no packWord function at all examines nothing, which the floor reads as BROKEN');
});

guardTests(defineGuard({
  name: 'paint-probe-damage-packing',
  floor: 1,
  read: readCarve,
  scan: scanDamagePacking,
  // A damage decode whose mod moved from 65536 to 65537 — the probe would go on decoding a
  // damage rectangle one bit wider than native's, and the differential's "damage rectangles
  // must be EXACTLY equal to native" (constraints.md) would be judging against a wrong shape.
  control: () => ({ bundle: DAMAGE_CALLER.replace(/%65536/g, '%65537'), probe: PAINT_SOURCE, what: 'synthetic control' }),
}));

test('the damage-packing scan passes the 2.1.278 carve verbatim and names each drift', () => {
  const run = (bundle) => scanDamagePacking({ bundle, probe: PAINT_SOURCE, what: 'x' });
  assert.deepStrictEqual(run(DAMAGE_CALLER).findings, [], 'the probe restates the 2.1.278 damage decode');
  assert.strictEqual(run(DAMAGE_CALLER).examined, 2);
  assert.strictEqual(run(DAMAGE_CALLER.replace(/%65536/g, '%65537')).findings.length, 2, 'a mod that moved at both sites');
  assert.strictEqual(run(DAMAGE_CALLER.replace(/1048576/g, '1048577')).findings.length, 2, 'a divisor that moved at both sites');
  assert.strictEqual(scanDamagePacking({ bundle: DAMAGE_CALLER, probe: 'no damage decode here', what: 'x' }).findings.length, 3, 'the probe itself stopped restating the packing');
  assert.strictEqual(run('').examined, 0, 'no damage-decode site at all examines nothing, which the floor reads as BROKEN');
});
