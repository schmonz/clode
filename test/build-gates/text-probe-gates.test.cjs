'use strict';
// The build gate inside `scripts/lib/text-probe.cjs`: the text differential's probe program,
// whose segmenter rows carry each cell's style AS THE BUNDLE'S CALLER PAINTS IT, restating the
// caller's own ansiCodes(): run index 0 is no style; otherwise the run's sgrKeys entry split on
// NUL, each open code kept only when the bundle's SC regex accepts it, paired with the
// sgrCloseKeys entry at the same place.
//
// WHY A GUARD. The probe derives a verdict from bytes (SC.test) and refuses (an empty corpus
// throws), so the production-gate sweep (test/guards-population.cjs) counted it gate-shaped the
// day the style column landed (2026-09-25), and it was right to: the column is a RESTATEMENT of
// the caller. If an upstream bump changes what ansiCodes() accepts or how it reads the pools,
// test/fidelity/text-differential.test.cjs would go on comparing a style the TUI no longer
// paints, green while judging the wrong thing. This is the control: the restatement must still
// be what the carved bundle says.
//
// WHAT IS PROVEN (text-probe-caller-style; text-probe-caller-link, at the end, does the same for
// the link column). read(): the carve of CLODE_PROVIDER_BIN, decoded the way
// inspect-claude-bundle reads it. scan(): every ansiCodes() method in it (floor 1) short-circuits
// index 0, splits both pools at the same index, tests the open code with a regex whose literal is
// EXACTLY the one the probe spells, and pairs it with its close code. control(): a bundle whose SC
// has grown to accept colon forms, and one whose ansiCodes() no longer reads the close pool.
//
// WHERE IT RUNS FOR REAL, as test/bun-slice-ansi-arity.test.cjs does: the suite's
// CLODE_PROVIDER_BIN is the pinned provider, whose bundle has no CellSegmenter caller yet (2.1.278
// adopted it), so there it SKIPS saying so; CI's linux-x64-pty text step (the text oracle) and
// upstream-drift's newer-upstream step run it.
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
const { PROBE_SOURCE } = require('../../scripts/lib/text-probe.cjs');
const { decodeGraphRunner } = require('../../libexec/inspect-claude-bundle.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const EXTRACT = path.join(REPO, 'libexec', 'extract-claude-js.cjs');

// The regex literal starting at `at` (its opening `/`), or null: runs to the first `/` outside a
// character class and not escaped, then takes the flags.
function regexLiteral(text, at) {
  if (text[at] !== '/') return null;
  let inClass = false;
  for (let i = at + 1; i < text.length && text[i] !== '\n'; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      let j = i + 1;
      while (j < text.length && /[a-z]/.test(text[j])) j++;
      return text.slice(at, j);
    }
  }
  return null;
}

// The body of the block whose `{` is at `open` (strings skipped), or null when the text ends first.
function blockBody(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

function scanCallerStyle({ bundle, probe, what }) {
  const findings = [];
  const p = /\bconst SC = \//.exec(probe);
  const probeSc = p ? regexLiteral(probe, p.index + p[0].length - 1) : null;
  if (probeSc === null) findings.push('scripts/lib/text-probe.cjs spells no `const SC = /.../` — its style column no longer restates the caller');
  const re = /\bansiCodes\((\w+)\)\{/g;
  let m, examined = 0;
  while ((m = re.exec(bundle)) !== null) {
    examined++;
    const n = m[1];
    const body = blockBody(bundle, m.index + m[0].length - 1);
    const at = bundle.slice(m.index, m.index + 160);
    if (body === null) { findings.push(`an ansiCodes() whose body never ends: ${at}...`); continue; }
    const want = [
      [`if(${n}===0)return[]`, 'run index 0 is no style'],
      [`this.sgrKeys[${n}].split(`, 'the open keys are the sgrKeys entry, split'],
      [`this.sgrCloseKeys[${n}].split(`, 'the close keys are the sgrCloseKeys entry at the same index, split'],
    ];
    for (const [needle, why] of want) {
      if (!body.includes(needle)) findings.push(`ansiCodes() no longer does "${needle}" (${why}); re-derive the probe's style column from it: ${at}...`);
    }
    const t = /if\((\w+)\.test\((\w+)\)\)\w+\.push\(\{type:"ansi",code:(\w+),endCode:\w+\[\w+\]\}\)/.exec(body);
    if (t === null || t[2] !== t[3]) {
      findings.push(`ansiCodes() no longer keeps an open code by one regex test and pairs it with its close code: ${at}...`);
      continue;
    }
    // Minified names repeat across a carve's modules, so the definition read is the one
    // NEAREST this method (its module's), not the first in the file.
    const defs = [];
    const dre = new RegExp(`(?:^|[^\\w$.])${t[1].replace(/\$/g, '\\$')}=/`, 'g');
    let d;
    while ((d = dre.exec(bundle)) !== null) defs.push(d.index + d[0].length - 1);
    const near = defs.sort((a, b) => Math.abs(a - m.index) - Math.abs(b - m.index))[0];
    const bundleSc = near === undefined ? null : regexLiteral(bundle, near);
    if (bundleSc === null) findings.push(`ansiCodes() tests ${t[1]}, whose regex literal this scan cannot find`);
    else if (probeSc !== null && bundleSc !== probeSc) {
      findings.push(`the bundle's SC is ${bundleSc} but the probe filters with ${probeSc}: the text gate would judge a style `
        + 'the TUI does not paint; copy the bundle\'s regex into PROBE_SOURCE and re-run the gate');
    }
  }
  return { findings, examined, note: `${what}: ${examined} ansiCodes() method(s)` };
}

// The carve of CLODE_PROVIDER_BIN, decoded the way inspect-claude-bundle reads it; carved once
// for both guards below.
let CARVE = null;
function readCarve() {
  if (CARVE) return CARVE;
  const bin = process.env.CLODE_PROVIDER_BIN;
  if (!bin || !fs.existsSync(bin)) return { skip: 'no CLODE_PROVIDER_BIN (point it at a real claude binary to run this gate)' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-caller-'));
  try {
    const cli = path.join(dir, 'cli.cjs');
    const ex = spawnSync(process.execPath, [EXTRACT, bin, cli], { encoding: 'utf8' });
    if (ex.status !== 0) throw new Error(`extract-claude-js could not carve ${bin}: ${(ex.stderr || '').slice(0, 400)}`);
    const decoded = decodeGraphRunner(cli);
    const bundle = decoded !== null ? decoded : fs.readFileSync(cli, 'latin1');
    if (!bundle.includes('sgrCloseKeys')) CARVE = { skip: `the carve of ${bin} has no CellSegmenter caller (the bundle adopted it in 2.1.278)` };
    else CARVE = { bundle, probe: PROBE_SOURCE, what: `the carve of ${bin}` };
    return CARVE;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The 2.1.278 carve's own caller, verbatim (the darwin-arm64 carve, 2026-09-25), for the control.
const CALLER = 'ansiCodes(n){if(n===0)return[];let s=this.sgrKeys[n].split("\\x00"),u=this.sgrCloseKeys[n].split("\\x00"),f=[];'
  + 'for(let m=0;m<s.length;m++){let p=s[m];if(SC.test(p))f.push({type:"ansi",code:p,endCode:u[m]})}return f}}'
  + 'var SC=/^\\x1b\\[(?:\\d{1,3})(?:;5;\\d{1,3}|;2;\\d{1,3};\\d{1,3};\\d{1,3})?m$/;';

guardTests(defineGuard({
  name: 'text-probe-caller-style',
  floor: 1,
  read: readCarve,
  scan: scanCallerStyle,
  // Two drifts: SC grown to accept a colon form (the probe would drop, as invisible, a style the
  // TUI now paints) and an ansiCodes() that stopped reading the close pool.
  control: () => ({
    bundle: CALLER.replace('(?:\\d{1,3})(?:', '(?:\\d{1,3})(?::\\d{1,3})?(?:')
      + 'class B{' + CALLER.replace('u=this.sgrCloseKeys[n].split("\\x00")', 'u=s').split('}}var SC=')[0] + '}}',
    probe: PROBE_SOURCE, what: 'synthetic control',
  }),
}));

test('the caller-style scan passes the 2.1.278 caller verbatim and names each drift', () => {
  const run = (bundle) => scanCallerStyle({ bundle, probe: PROBE_SOURCE, what: 'x' });
  assert.deepStrictEqual(run(CALLER).findings, [], 'the probe restates the 2.1.278 caller');
  assert.strictEqual(run(CALLER).examined, 1);
  assert.strictEqual(run(CALLER.replace('if(n===0)return[];', '')).findings.length, 1, 'index 0 no longer short-circuits');
  assert.strictEqual(run(CALLER.replace('code:p,endCode', 'code:s[0],endCode')).findings.length, 1, 'a test not on the open code');
  assert.strictEqual(run(CALLER.replace('var SC=', 'var XX=')).findings.length, 1, 'an SC this scan cannot find');
  assert.deepStrictEqual(run('var SC=/other/;' + ' '.repeat(5000) + CALLER).findings, [], 'another module\'s SC is not the caller\'s');
  assert.strictEqual(scanCallerStyle({ bundle: CALLER, probe: 'no regex here', what: 'x' }).findings.length, 1);
  assert.strictEqual(run('').examined, 0, 'no caller at all examines nothing, which the floor reads as BROKEN');
});

// THE LINK COLUMN (CellSegmenter phase 4). The probe's rows also carry each cell's hyperlink,
// restating the caller's runWords(): the run's second slot is an index into `uris`, 0 is no link
// (it interns nothing), and any other is the uris entry, interned into the screen's
// hyperlinkPool. If upstream changes that read, text-diff-segmenter would go on comparing a link
// the TUI no longer paints. scan(): every runWords() method (floor 1) reads the link index from
// runs[2j+1], skips 0 and interns this.uris at that index, and the probe spells the same read.
const PROBE_LINK = ["const linkOf = (p) => (p === 0 ? '' : n.uris[p]);", 'linkOf(runs[2 * (w >> 10) + 1])'];

function scanCallerLink({ bundle, probe, what }) {
  const findings = [];
  for (const needle of PROBE_LINK) {
    if (!probe.includes(needle)) findings.push(`scripts/lib/text-probe.cjs no longer spells "${needle}": its link column no longer restates runWords()`);
  }
  const re = /\brunWords\((\w+)\)\{/g;
  let m, examined = 0;
  while ((m = re.exec(bundle)) !== null) {
    examined++;
    const body = blockBody(bundle, m.index + m[0].length - 1);
    const at = bundle.slice(m.index, m.index + 160);
    if (body === null) { findings.push(`a runWords() whose body never ends: ${at}...`); continue; }
    const r = /let (\w+)=this\.runs\[2\*(\w+)\+1\]/.exec(body);
    if (r === null) { findings.push(`runWords() no longer reads a run's link index from runs[2j+1]; re-derive the probe's link column from it: ${at}...`); continue; }
    const want = [
      [`if(${r[1]}!==0)`, 'link index 0 is no link'],
      [`.intern(this.uris[${r[1]}])`, 'any other is the uris entry at that index, interned'],
    ];
    for (const [needle, why] of want) {
      if (!body.includes(needle)) findings.push(`runWords() no longer does "${needle}" (${why}); re-derive the probe's link column from it: ${at}...`);
    }
  }
  return { findings, examined, note: `${what}: ${examined} runWords() method(s)` };
}

// The 2.1.278 carve's runWords(), verbatim but for the reordered branch (the darwin-arm64 carve,
// 2026-09-25), for the control.
const CALLER_LINK = 'runWords(n){let s=this.count;if(s===0)return this.words;if(this.hyperlinkPool!==n)this.hyperlinkPool=n,'
  + 'this.linkIds.fill(0);let u=this.cells[2*s-1]>>>Og;let f=u+1;this.words=Bs(this.words,f,0);for(let m=0;m<f;m++)'
  + '{let p=this.runs[2*m+1],S=0;if(p!==0){if(this.linkIds=Bs(this.linkIds,p+1,this.linkIds.length),S=this.linkIds[p],'
  + 'S===0)S=n.intern(this.uris[p])+1,this.linkIds[p]=S;S-=1}this.words[m]=jn(this.styleId(this.runs[2*m]),S,0)}return this.words}';

guardTests(defineGuard({
  name: 'text-probe-caller-link',
  floor: 1,
  read: readCarve,
  scan: scanCallerLink,
  // A runWords() that reads the uris one entry along (a drift the text gate would not see: it
  // would compare the link the probe reads, not the one painted).
  control: () => ({ bundle: CALLER_LINK.replace('n.intern(this.uris[p])', 'n.intern(this.uris[p-1])'), probe: PROBE_SOURCE, what: 'synthetic control' }),
}));

test('the caller-link scan passes the 2.1.278 caller verbatim and names each drift', () => {
  const run = (bundle) => scanCallerLink({ bundle, probe: PROBE_SOURCE, what: 'x' });
  assert.deepStrictEqual(run(CALLER_LINK).findings, [], 'the probe restates the 2.1.278 caller');
  assert.strictEqual(run(CALLER_LINK).examined, 1);
  assert.strictEqual(run(CALLER_LINK.replace('if(p!==0)', 'if(p>=0)')).findings.length, 1, 'index 0 no longer skipped');
  assert.strictEqual(run(CALLER_LINK.replace('this.runs[2*m+1]', 'this.runs[2*m]')).findings.length, 1, 'the link index read elsewhere');
  assert.strictEqual(scanCallerLink({ bundle: CALLER_LINK, probe: 'no link column', what: 'x' }).findings.length, 2);
  assert.strictEqual(run('').examined, 0, 'no caller at all examines nothing, which the floor reads as BROKEN');
});
