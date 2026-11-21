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
// WHERE IT RUNS FOR REAL, as test/bun-slice-ansi-arity.test.cjs does: wherever
// CLODE_PROVIDER_BIN names a bundle with a CellSegmenter caller (2.1.278 adopted it) -- the
// suite's pinned provider since the pin moved to 2.1.283 (2026-09-26), CI's linux-x64-pty text
// step (the text oracle) and upstream-drift's newer-upstream step. On an older bundle (2.1.251,
// the pin before) it SKIPS saying so.
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
const { PROBE_SOURCE, WRAP_OPTIONS } = require('../../scripts/lib/text-probe.cjs');
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
    // 2.1.330 added `&&T[O]!==AYa`: a code whose close is one SGR (AYa = CSI + "28m", conceal's
    // close) is dropped. The close it drops is read from the binding nearest the method,
    // `AYa=<csi>(28,"m")`, and the probe must drop exactly that one (its HIDDEN_CLOSE).
    const t = /if\((\w+)\.test\((\w+)\)(?:&&(\w+)\[(\w+)\]!==([\w$]+))?\)\w+\.push\(\{type:"ansi",code:(\w+),endCode:(\w+)\[(\w+)\]\}\)/.exec(body);
    if (t === null || t[2] !== t[6] || (t[3] !== undefined && (t[3] !== t[7] || t[4] !== t[8]))) {
      findings.push(`ansiCodes() no longer keeps an open code by one regex test and pairs it with its close code: ${at}...`);
      continue;
    }
    const ph = /\bconst HIDDEN_CLOSE = '([^']*)';/.exec(probe);
    const probeDrop = ph && /u\[m\] !== HIDDEN_CLOSE/.test(probe) ? ph[1].replace(/\\x1b/g, '\x1b') : null;
    if (t[3] === undefined) {
      if (probeDrop !== null) findings.push(`ansiCodes() drops no close code, but the probe drops ${JSON.stringify(probeDrop)}: ${at}...`);
    } else {
      const cdefs = [...bundle.matchAll(new RegExp(`(?:^|[^\\w$.])${t[5].replace(/\$/g, '\\$')}=[\\w$]+\\((\\d+),"m"\\)`, 'g'))]
        .sort((a, b) => Math.abs(a.index - m.index) - Math.abs(b.index - m.index));
      const drop = cdefs.length ? `\x1b[${cdefs[0][1]}m` : null;
      if (drop === null) findings.push(`ansiCodes() drops a code whose close is ${t[5]}, whose SGR binding this scan cannot find`);
      else if (probeDrop !== drop) {
        findings.push(`ansiCodes() drops a code whose close is ${JSON.stringify(drop)}, but the probe drops `
          + `${JSON.stringify(probeDrop)}: copy it into PROBE_SOURCE's HIDDEN_CLOSE`);
      }
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

// The carve of CLODE_PROVIDER_BIN, decoded the way inspect-claude-bundle reads it; extracted
// ONCE and shared by every guard in this file (RAW), each applying its OWN presence check —
// text-probe-caller-style/-link need a CellSegmenter caller (adopted 2.1.278); text-probe-
// wrap-options (task 2) needs a Bun.wrapAnsi caller. A shared extraction with per-guard skip
// wording means an older pin skips each guard for the reason that is actually true of IT,
// not a borrowed reason from a different feature that happens to have landed nearby.
let RAW = null;
function fetchCarve() {
  if (RAW) return RAW;
  const bin = process.env.CLODE_PROVIDER_BIN;
  if (!bin || !fs.existsSync(bin)) {
    RAW = { skip: 'no CLODE_PROVIDER_BIN (point it at a real claude binary to run this gate)' };
    return RAW;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-caller-'));
  try {
    const cli = path.join(dir, 'cli.cjs');
    const ex = spawnSync(process.execPath, [EXTRACT, bin, cli], { encoding: 'utf8' });
    if (ex.status !== 0) throw new Error(`extract-claude-js could not carve ${bin}: ${(ex.stderr || '').slice(0, 400)}`);
    const decoded = decodeGraphRunner(cli);
    const bundle = decoded !== null ? decoded : fs.readFileSync(cli, 'latin1');
    RAW = { bundle, what: `the carve of ${bin}` };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return RAW;
}

function readCarve() {
  const c = fetchCarve();
  if ('skip' in c) return c;
  if (!c.bundle.includes('sgrCloseKeys')) {
    return { skip: `${c.what} has no CellSegmenter caller (the bundle adopted it in 2.1.278)` };
  }
  return { bundle: c.bundle, probe: PROBE_SOURCE, what: c.what };
}

// task 2's own read(): the same carve, its own presence check. `Bun.wrapAnsi(` is the literal
// this scan's own findWrapCallSites() anchors on (scanWrapOptions, below); if the carve has
// none at all, an older pin used npm wrap-ansi throughout and this gate has nothing to judge.
function readWrapCarve() {
  const c = fetchCarve();
  if ('skip' in c) return c;
  if (!c.bundle.includes('Bun.wrapAnsi(')) {
    return { skip: `${c.what} has no Bun.wrapAnsi( call at all (an older pin used npm wrap-ansi throughout)` };
  }
  return { bundle: c.bundle, what: c.what };
}

// The 2.1.278 carve's own caller, verbatim (the darwin-arm64 carve, 2026-09-25).
const CALLER_278 = 'ansiCodes(n){if(n===0)return[];let s=this.sgrKeys[n].split("\\x00"),u=this.sgrCloseKeys[n].split("\\x00"),f=[];'
  + 'for(let m=0;m<s.length;m++){let p=s[m];if(SC.test(p))f.push({type:"ansi",code:p,endCode:u[m]})}return f}}'
  + 'var SC=/^\\x1b\\[(?:\\d{1,3})(?:;5;\\d{1,3}|;2;\\d{1,3};\\d{1,3};\\d{1,3})?m$/;';
// The 2.1.330 caller, verbatim (darwin-arm64, 2026-11-21), its names kept but for the minifier's,
// with the SGR binding it reads from chunk-yrh4vxq4.js (`AYa=Jl(28,"m")`) beside it; for the control.
const CALLER = 'var AYa=Jl(28,"m");ansiCodes(h){if(h===0)return[];let v=this.sgrKeys[h].split("\\x00"),T=this.sgrCloseKeys[h].split("\\x00"),M=[];'
  + 'for(let O=0;O<v.length;O++){let L=v[O];if(DM.test(L)&&T[O]!==AYa)M.push({type:"ansi",code:L,endCode:T[O]})}return M}}'
  + 'var DM=/^\\x1b\\[(?:\\d{1,3})(?:;5;\\d{1,3}|;2;\\d{1,3};\\d{1,3};\\d{1,3})?m$/;';

guardTests(defineGuard({
  name: 'text-probe-caller-style',
  floor: 1,
  read: readCarve,
  scan: scanCallerStyle,
  // Two drifts: SC grown to accept a colon form (the probe would drop, as invisible, a style the
  // TUI now paints) and an ansiCodes() that stopped reading the close pool.
  control: () => ({
    bundle: CALLER.replace('(?:\\d{1,3})(?:', '(?:\\d{1,3})(?::\\d{1,3})?(?:')
      + 'class B{' + CALLER.replace('T=this.sgrCloseKeys[h].split("\\x00")', 'T=v').split('}}var DM=')[0] + '}}',
    probe: PROBE_SOURCE, what: 'synthetic control',
  }),
}));

test('the caller-style scan passes the 2.1.330 caller verbatim and names each drift', () => {
  const run = (bundle) => scanCallerStyle({ bundle, probe: PROBE_SOURCE, what: 'x' });
  assert.deepStrictEqual(run(CALLER).findings, [], 'the probe restates the 2.1.330 caller');
  assert.strictEqual(run(CALLER).examined, 1);
  assert.strictEqual(run(CALLER.replace('if(h===0)return[];', '')).findings.length, 1, 'index 0 no longer short-circuits');
  assert.strictEqual(run(CALLER.replace('code:L,endCode', 'code:v[0],endCode')).findings.length, 1, 'a test not on the open code');
  assert.strictEqual(run(CALLER.replace('var DM=', 'var XX=')).findings.length, 1, 'an SC this scan cannot find');
  assert.deepStrictEqual(run('var DM=/other/;' + ' '.repeat(5000) + CALLER).findings, [], 'another module\'s SC is not the caller\'s');
  // a probe that restates nothing: no SC, and no dropped close
  assert.strictEqual(scanCallerStyle({ bundle: CALLER, probe: 'no regex here', what: 'x' }).findings.length, 2);
  assert.strictEqual(run('').examined, 0, 'no caller at all examines nothing, which the floor reads as BROKEN');
});

// 2.1.330's one change: the caller drops a code whose close is SGR 28. The probe must drop the same close, read from
// the binding, never assumed; the 2.1.278 caller (no drop) is now drift against this probe, the way it really moved.
test('the caller-style scan reads the dropped close from its SGR binding and holds the probe to it', () => {
  const run = (bundle, probe = PROBE_SOURCE) => scanCallerStyle({ bundle, probe, what: 'x' });
  assert.match(run(CALLER_278).findings.join('\n'), /drops no close code, but the probe drops "\\u001b\[28m"/);
  assert.match(run(CALLER.replace('Jl(28,"m")', 'Jl(29,"m")')).findings.join('\n'), /drops a code whose close is "\\u001b\[29m", but the probe drops "\\u001b\[28m"/);
  assert.match(run(CALLER.replace('var AYa=', 'var ZZZ=')).findings.join('\n'), /whose SGR binding this scan cannot find/);
  assert.match(run(CALLER, PROBE_SOURCE.replace(' && u[m] !== HIDDEN_CLOSE', '')).findings.join('\n'), /but the probe drops null/);
  assert.strictEqual(run(CALLER.replace('T[O]!==AYa', 'T[0]!==AYa')).findings.length, 1, 'a drop not at the open code\'s index');
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

// THE WRAP-OPTIONS GATE (task 2, Bun.wrapAnsi = native). scripts/lib/text-probe.cjs's
// WRAP_OPTIONS is "the exact set of option objects the carve's wrap helper can pass to
// Bun.wrapAnsi" (measured once, 2026-09-26, against the 2.1.283 carve). If a future carve
// adds a call site with an option shape not in that set, the unit gate (text-diff-wrapansi)
// would go on judging cases the bundle never actually asks for, silently blind to the one it
// does. This is the restatement check, in the same shape as the two guards above it: read()
// the real carve, scan() every literal options object reaching the wrap helper, control() a
// carve whose one call site passes an option not in the set.
//
// WHY STRUCTURAL, NOT NAMED. The helper and its wrapper are unexported/module-private and
// minified (`X`/`zu` at 2.1.283, `X`/`Nf` at 2.1.278) — a name changes on every bundler run.
// findWrapCallSites() finds them by SHAPE instead: the direct caller is
// `function NAME(a,b,c){if(!SOMEVAR.test(a))return Bun.wrapAnsi(a,b,c);...}` (the ONLY thing
// this scan assumes stays true — measured at both 2.1.278 and 2.1.283); its wrapper is
// whatever function in the SAME module forwards the SAME three parameters into it. Every
// module (split on the bundler's own per-chunk `// Version: ` banner, present in each
// module's own source) that DEFINES that wrapper or IMPORTS its exact name is then scanned
// for calls to it; a call with any arity but 3 is not a forwarding call and is skipped rather
// than flagged, since a same-named 2-letter local in an unrelated scope is exactly the
// collision this file's other two guards avoid with "nearest definition" — here the risk runs
// the other way (an unrelated SAME-arity call could false-positive), so this scan additionally
// requires the calling module to define or import the wrapper's own name, not merely contain
// the substring.
function splitModules(bundle) {
  const re = /\/\/ Version: [^\n]*\n/g;
  const idxs = [];
  let m;
  while ((m = re.exec(bundle)) !== null) idxs.push(m.index);
  if (idxs.length === 0) return [bundle];
  idxs.push(bundle.length);
  const mods = [];
  for (let i = 0; i < idxs.length - 1; i++) mods.push(bundle.slice(idxs[i], idxs[i + 1]));
  return mods;
}

// The balanced-paren argument text starting at `text[openParenIdx] === '('`, or null if the
// text ends first. Strings are skipped whole so a `)` or `,` inside one is never mistaken for
// the call's own punctuation.
function findCallArgs(text, openParenIdx) {
  let depth = 0; let i = openParenIdx; const start = i + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < text.length && text[i] !== c) { if (text[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return text.slice(start, i); }
    i++;
  }
  return null;
}

// One call's argument list, split on its OWN top-level commas (nested (), [], {} and strings
// are not split on).
function splitTopArgs(argstr) {
  const parts = []; let depth = 0; let cur = ''; let i = 0;
  while (i < argstr.length) {
    const c = argstr[i];
    if (c === '"' || c === "'" || c === '`') {
      cur += c; i++;
      while (i < argstr.length && argstr[i] !== c) { if (argstr[i] === '\\') { cur += argstr[i]; i++; } cur += argstr[i]; i++; }
      if (i < argstr.length) { cur += argstr[i]; i++; }
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

// 2.1.330 respells the guard `if(a.search(V)===-1)` and adds a fourth parameter with a default (`r=!0`, its own
// recursion's flag; never options): both spellings are this shape, nothing else is.
const DIRECT_WRAP_CALLER = /function (\w+)\((\w+),(\w+),(\w+)(?:,\w+=![01])?\)\{if\((?:!(\w+)\.test\(\2\)|\2\.search\((\w+)\)===-1)\)return Bun\.wrapAnsi\(\2,\3,\4\);/;

// { xname, wrapperName, callSites: [ [arg0Text, arg1Text, arg2Text], ... ] }. xname/wrapperName
// null means the shape this scan expects was not found at all (the caller reads that as
// nothing to judge, never as zero violations).
function findWrapCallSites(bundle) {
  const mods = splitModules(bundle);
  let xname = null; let defModule = null;
  for (const mod of mods) {
    const dm = DIRECT_WRAP_CALLER.exec(mod);
    if (dm) { xname = dm[1]; defModule = mod; break; }
  }
  if (xname === null) return { xname: null, wrapperName: null, callSites: [] };
  const wrapperRe = new RegExp(`function (\\w+)\\((\\w+),(\\w+),(\\w+)\\)\\{[^}]*?\\b${xname}\\(\\2,\\3,\\4\\)`);
  const wm = wrapperRe.exec(defModule);
  if (!wm) return { xname, wrapperName: null, callSites: [] };
  const wrapperName = wm[1];
  const impNameRe = new RegExp(`import\\{[^}]*\\b${wrapperName}\\b[^}]*\\}from"[^"]*"`);
  const callRe = new RegExp(`(?<![\\w$])${wrapperName}\\(`, 'g');
  const callSites = [];
  for (const mod of mods) {
    const isDef = mod === defModule;
    if (!isDef && !impNameRe.test(mod.slice(0, 4000))) continue;   // neither defines nor imports it: not ours
    callRe.lastIndex = 0;
    let cm;
    while ((cm = callRe.exec(mod)) !== null) {
      if (mod.slice(Math.max(0, cm.index - 9), cm.index) === 'function ') continue;   // the definition itself
      const args = findCallArgs(mod, cm.index + wrapperName.length);
      if (args === null) continue;
      const parts = splitTopArgs(args);
      if (parts.length !== 3) continue;   // a same-named local of a different arity: not this wrapper
      // 2.1.330: `let K={trim:!0,hard:!0};...Au(A,N,K)` -- options passed by a binding are read from the binding's
      // own literal, the NEAREST `let|const|var NAME={...}` before the call in its module. One that is not found
      // stays the bare name, which the parser refuses (a finding), never a pass.
      const id = parts[2].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) {
        const defs = [...mod.slice(0, cm.index).matchAll(new RegExp(`(?:let|const|var)\\s+${id.replace(/\$/g, '\\$')}=(\\{[^{}]*\\})`, 'g'))];
        if (defs.length > 0) { parts[2] = defs[defs.length - 1][1]; parts.binding = id; }
      }
      callSites.push(parts);
    }
  }
  return { xname, wrapperName, callSites };
}

// A literal boolean the way this carve spells it: `!0`/`!1` (minified) or `true`/`false`.
function parseBool(tok) {
  const t = tok.trim();
  if (t === '!0' || t === 'true') return true;
  if (t === '!1' || t === 'false') return false;
  return null;
}

// `EXPR?.key??FALLBACK` / `EXPR.key??FALLBACK`: a caller-supplied boolean with a literal
// fallback (the `{hard:p?.hard??!1,...}` table-cell shape). Both its values are kept — the
// literal alone cannot say which the caller passes at runtime.
// 2.1.330 also passes `!NAME` (a boolean, both values) and a bare `NAME` (a parameter: both
// values, or undefined, which Bun.wrapAnsi reads as the key's default, so the key is ABSENT).
function parseDynamicBool(expr) {
  const e = expr.trim();
  if (/^![A-Za-z_$][\w$]*$/.test(e)) return { dynamic: true };
  if (/^[A-Za-z_$][\w$]*$/.test(e) && !['true', 'false', 'undefined', 'null'].includes(e)) return { dynamic: true, mayBeAbsent: true };
  const m = /^[\w$.]+\?\.\w+\?\?(.+)$/.exec(e) || /^[\w$.]+\.\w+\?\?(.+)$/.exec(e);
  if (!m) return null;
  const fallback = parseBool(m[1]);
  return fallback === null ? null : { dynamic: true, fallback };
}

// A `{...}` literal's own hard/trim/wordWrap keys, each a boolean or a dynamic-boolean
// (above). null: not this shape at all (an unknown key, a non-literal, anything this scan
// does not recognise) -- reported as its own finding by the caller, never silently skipped.
function parseOptionsLiteral(text) {
  const t = text.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  const body = t.slice(1, -1).trim();
  const out = {};
  if (body === '') return out;
  for (const part of splitTopArgs(body)) {
    const ci = part.indexOf(':');
    if (ci < 0) return null;
    const key = part.slice(0, ci).trim().replace(/^["']|["']$/g, '');
    if (!['hard', 'trim', 'wordWrap'].includes(key)) return null;
    const valText = part.slice(ci + 1).trim();
    const b = parseBool(valText);
    if (b !== null) { out[key] = b; continue; }
    const dyn = parseDynamicBool(valText);
    if (dyn === null) return null;
    out[key] = dyn;
  }
  return out;
}

// Every concrete {hard,trim,wordWrap} object a parsed literal can produce at runtime: a
// dynamic key expands to both its values, everything else is a straight cross product.
function expandOptions(parsed) {
  let variants = [{}];
  for (const key of Object.keys(parsed)) {
    const v = parsed[key];
    const ABSENT = Symbol('absent');
    const vals = (v && v.dynamic) ? [true, false, ...v.mayBeAbsent ? [ABSENT] : []] : [v];
    const next = [];
    for (const base of variants) for (const val of vals) next.push(val === ABSENT ? { ...base } : { ...base, [key]: val });
    variants = next;
  }
  return variants;
}

const optionsKey = (obj) => JSON.stringify(Object.keys(obj).sort().map((k) => [k, obj[k]]));
const inWrapOptions = (obj, wrapOptions) => wrapOptions.some((w) => optionsKey(w) === optionsKey(obj));

function scanWrapOptions({ bundle, wrapOptions, what }) {
  const found = findWrapCallSites(bundle);
  if (found.xname === null) {
    return { findings: ['no `function N(a,b,c){if(!V.test(a))return Bun.wrapAnsi(a,b,c);...}` caller found — '
      + 're-derive this scan\'s shape from the current carve'], examined: 0, note: `${what}: 0 call sites` };
  }
  if (found.wrapperName === null) {
    return { findings: [`found the direct caller '${found.xname}' but no wrapper forwarding its three arguments to it`],
      examined: 0, note: `${what}: 0 call sites` };
  }
  const findings = [];
  let examined = 0;
  const sites = new Map();   // each call site's options literal, as the carve spells it -> how many
  for (const parts of found.callSites) {
    examined++;
    const optText = parts.binding ? `${parts.binding}=${parts[2].trim()}` : parts[2].trim();
    sites.set(optText, (sites.get(optText) || 0) + 1);
    const parsed = parseOptionsLiteral(parts[2].trim());
    if (parsed === null) {
      findings.push(`could not parse the options passed to ${found.wrapperName}(): ${optText} — `
        + 'a literal this scan does not recognise; re-derive WRAP_OPTIONS by hand and teach the parser its shape');
      continue;
    }
    for (const v of expandOptions(parsed)) {
      if (!inWrapOptions(v, wrapOptions)) {
        findings.push(`${found.wrapperName}() called with options not in WRAP_OPTIONS: ${JSON.stringify(v)} (from ${optText})`);
      }
    }
  }
  const named = [...sites].map(([t, n]) => `${n} x ${t}`).join('; ');
  return { findings, examined, note: `${what}: ${examined} call site(s) to ${found.wrapperName}(): ${named}` };
}

// A minimal synthetic carve with the two functions this scan's shape needs, and one caller —
// WRAP_OK's caller passes only options in WRAP_OPTIONS (no finding); WRAP_BAD's passes
// `{wordWrap:false}`, which is not (one finding naming it). Both share the same helper/wrapper
// text as the real carve's shape, minified names included, so the structural regexes above are
// exercised the same way they are on the real thing.
const SYNTH_HELPER = 'function X(e,t,r){if(!z.test(e))return Bun.wrapAnsi(e,t,r);return e}var z=/x/;'
  + 'function zu(e,t,r){if(!(t>0))return e;let n=X(e,t,r);return n}';
const WRAP_OK = `${SYNTH_HELPER}function caller(a){return zu(a,10,{hard:true,trim:false})}`;
const WRAP_BAD = `${SYNTH_HELPER}function caller(a){return zu(a,10,{wordWrap:false})}`;

guardTests(defineGuard({
  name: 'text-probe-wrap-options',
  // 18, MEASURED 2026-11-20: the 2.1.283 carve has 18 call sites to the wrapper on both
  // macos-arm64 (`zu`) and linux-amd64 (`Gu`), the same options literals on both:
  //   4 x {trim:!0,hard:!0}   6 x {hard:!0,trim:!1}   4 x {trim:!1,hard:!0}   1 x {hard:!1,trim:!1}
  //   1 x {hard:!0}           1 x {hard:!0,trim:!0}   1 x {hard:p?.hard??!1,trim:!1,wordWrap:!0}
  // The verdict's note lists them the same way (options literal -> count), so a re-measure is a
  // read of the BROKEN message, not a hand count. Not yet run in CI at 18: it awaits its first
  // run on main. A floor of
  // 1 only caught a carve that lost every call site; one that lost most of them would have
  // passed, judging WRAP_OPTIONS against a fraction of what the bundle asks for. A bump that
  // legitimately drops call sites reads BROKEN until someone re-measures and moves this: loud
  // on purpose.
  floor: 18,
  read: readWrapCarve,
  scan: (i) => scanWrapOptions({ ...i, wrapOptions: WRAP_OPTIONS }),
  control: () => ({ bundle: WRAP_BAD, what: 'synthetic control' }),
}));

test('scanWrapOptions finds nothing when every call site\'s options are in WRAP_OPTIONS, and names the one that is not', () => {
  const ok = scanWrapOptions({ bundle: WRAP_OK, wrapOptions: WRAP_OPTIONS, what: 'x' });
  assert.deepStrictEqual(ok.findings, []);
  assert.strictEqual(ok.examined, 1);
  const bad = scanWrapOptions({ bundle: WRAP_BAD, wrapOptions: WRAP_OPTIONS, what: 'x' });
  assert.strictEqual(bad.findings.length, 1);
  assert.match(bad.findings[0], /\{"wordWrap":false\}/);
  assert.strictEqual(bad.examined, 1);
});

test('scanWrapOptions examines every real call site in the 2.1.283 shape and finds nothing', () => {
  const bundle = `${SYNTH_HELPER}function truncate(a,b,c){return zu(a,b,{trim:!0,hard:!0})}`
    + `function tableCell(a,b,p){return zu(a,b,{hard:p?.hard??!1,trim:!1,wordWrap:!0})}`
    + 'function preview(a,b){return zu(a,b,{hard:!0})}';
  const r = scanWrapOptions({ bundle, wrapOptions: WRAP_OPTIONS, what: 'x' });
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.examined, 3, 'the dynamic-hard call is one call site, both its values checked');
});

// readWrapCarve()'s own env-based skip (fetchCarve()'s cache is process-wide and shared with
// the two guards above, so this checks the pure function it wraps rather than mutating that
// shared cache mid-suite): a carve with no direct Bun.wrapAnsi caller at all names the reason
// rather than reading as zero violations, and its own scan examines nothing.
// 2.1.330's direct caller and wrapper, verbatim heads (darwin-arm64, 2026-11-21): `K(e,t,s,r=!0)` guarded by
// `e.search(Y)===-1`, and `Au` forwarding its three parameters into it.
test('scanWrapOptions reads the 2.1.330 caller shape (search guard, defaulted fourth parameter)', () => {
  const head = 'function K(e,t,s,r=!0){if(e.search(Y)===-1)return Bun.wrapAnsi(e,t,s);let i="";return K(e,t,s,!1)}'
    + 'function Au(e,t,s){if(!(t>0))return e;if(!e.includes("\\x1B["))return K(e,t,s);return e}';
  const r = scanWrapOptions({ bundle: `${head}function caller(a){return Au(a,10,{hard:!0,trim:!1})}`, wrapOptions: WRAP_OPTIONS, what: 'x' });
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.examined, 1);
  assert.match(r.note, /call site\(s\) to Au\(\)/);
  // a guard that is neither spelling, or a fourth parameter that could carry options, is not the shape
  for (const bad of [head.replace('e.search(Y)===-1', 'e.search(Y)!==-1'), head.replace('r=!0', 'r')]) {
    assert.strictEqual(scanWrapOptions({ bundle: bad, wrapOptions: WRAP_OPTIONS, what: 'x' }).examined, 0);
  }
});

test('a carve with no Bun.wrapAnsi caller at all names the reason and examines nothing', () => {
  const found = findWrapCallSites('var a = 1; function unrelated(){}');
  assert.strictEqual(found.xname, null);
  const r = scanWrapOptions({ bundle: 'var a = 1;', wrapOptions: WRAP_OPTIONS, what: 'x' });
  assert.strictEqual(r.examined, 0);
  assert.match(r.findings[0], /no `function/);
});
