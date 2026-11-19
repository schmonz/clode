'use strict';
// The bracketedLeadScrubPattern builder, for libexec/extract-claude-js.cjs's LEAD-SCRUB-POSSESSIVE
// hook: its verbatim 2.1.283 text (unit tests), and an oracle that runs the REAL carve's builder
// inside native Bun and the hooked one under quaude's engine, over one corpus
// (test/fidelity/lead-scrub-equivalence.test.cjs).
//
// WHAT THE BUILDER IS. `get lead()` (the artifact-lead scrubber, exported as
// artifactLeadScrubPattern) calls it with a CONSTANT list of 24 phrases (104 words, 554 letters at
// 2.1.278 through 2.1.283). It spells every word one letter at a time, and between letters it
// emits an ATOMIC run, `(?=([class]*))(?:\N)`: a lookahead captures the longest run, and the
// backreference consumes exactly it, so nothing can backtrack into it. Between words the same
// trick wraps a longer separator (mu: whitespace, then up to four joiners, each with its own
// whitespace). One capture group per separator: 559 for the real list. QuickJS allows 254
// (CAPTURE_COUNT_MAX 255 counts the whole match), JavaScriptCore and V8 accept 559, so under
// quaude `new RegExp` throws "too many captures", every time `lead` is read.
//
// EVERY NON-ASCII CHARACTER in this file is built from code points (tool hazard: a written
// `\u` escape can land as the literal character).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { census, rngBias, firstSighting, mulberry32 } = require('./shape-census.cjs');

// ---- the verbatim 2.1.283 text ----------------------------------------------------------------
// Byte for byte from the 2.1.283 darwin-arm64 carve (/$bunfs/root/chunk-v297v4sm.js, before the
// graph hooks run): the builder and the two helpers it calls, in module order. Every carve from
// 2.1.278 on (darwin, linux, linux-musl, win32; x64 and arm64) holds the same text under other
// minified names.
const ATOMIC_RUN_283 = 'function pRe(u,d){return`(?=([${u}]*))(?:\\\\${d})`}';
const ATOMIC_MU_283 = 'function mu(u){let d=`[${w}]*`,e="";for(let a=0;a<Q;a++)e=`(?:[${J}]${d}'
  + '${e})?`;return`(?=(${d}${e}))(?:\\\\${u})`}';
const BUILDER_283 = 'function _No(u){let d=0,e=()=>mu(++d),a=()=>pRe(`\\\\r\\\\n${_}`,++d),c=()=>`(?=[${w}'
  + '${J}])`+e(),n=()=>`(?=[${Y}]{0,${Q}}[${w}${Ipt}])`+e(),f=`0-9\\\\uff10-\\\\uff19\\\\u{1d7ce}'
  + '-\\\\u{1d7ff}\\\\u2070\\\\u00b9\\\\u00b2\\\\u00b3\\\\u2074-\\\\u2079\\\\u2080-\\\\u2089${[..."abcdef"].map(YV).join("")}'
  + '`,t=(s)=>{if(!/^[a-z]+$/.test(s))throw Error("bracketedLeadScrubPattern: words are lowercase ASCII");'
  + 'return[...s].map((E,g)=>(g===0?"":a())+`[${YV(E)}]`).join("")},o=(s)=>Array.from({length:s}'
  + ',(E,g)=>(g===0?"":a())+`[${f}]`).join("")+a()+`[${Ipt}]`,r=()=>o(8)+e()+o(4)+e()+o(4),'
  + 'b="(?![0-9A-Za-z_])",l=e(),p=u.map((s)=>{let E=s.map((g,R)=>(R===0?"":typeof g!=="string"?e()'
  + ':s[R-1]===mne?n():c())+(g===N4n?r():g===mne?Lu:t(g)+(s[R+1]===mne?b:""))).join("");'
  + 'return s.at(-1)===N4n?E:`${E}${b}`});return new RegExp(`[${Qfn}](?!\\\\\\\\)(?=${l}'
  + '(?:${p.join("|")}))`,"giu")}';
const MODULE_283 = `${ATOMIC_RUN_283};${ATOMIC_MU_283};${BUILDER_283}`;
// The CONTROLS: the same module with one helper's atomic run made a plain greedy group, which
// backtracking may shorten. A rewrite that loses atomicity looks like one of these; the corpus must
// tell each apart from the original. The group still CAPTURES, so the other helper's backreference
// numbers stay right (drop it and they point past the last group: "Invalid escape").
const NAIVE_RUN_283 = MODULE_283.replace('return`(?=([${u}]*))(?:\\\\${d})`}', 'return`([${u}]*)`}');
const NAIVE_MU_283 = MODULE_283.replace('return`(?=(${d}${e}))(?:\\\\${u})`}', 'return`(${d}${e})`}');

// Stand-ins for the module-level names the builder reads (the real ones are long Unicode classes;
// the oracle below uses those). Chosen so BOTH atomic separators are OBSERVABLE, which the real
// classes make true only for the joiner separator: `_` (the letter separator's class) holds `x`,
// which a word can spell next, and the joiner class J holds `:`, on which the span may end.
const STUBS = Object.freeze({
  w: ' \\t', J: '\\-:', Y: ':', Q: 4, Ipt: '\\-', _: 'x',
  YV: (l) => l + l.toUpperCase(),
  Lu: '[^\\]\\r\\n]{0,9}?[a-z:]',
  Qfn: '\\[',
  mne: Symbol('LEAD_SPAN'),
  N4n: Symbol('LEAD_HEX_ID'),
});

// The builder a module text defines, with the stand-ins bound.
function loadBuilder(moduleText, stubs = STUBS) {
  const names = Object.keys(stubs);
  return new Function(...names, `${moduleText};return _No;`)(...names.map((k) => stubs[k]));
}

// A list with every token kind the real one has: plain words, a span (then words), a hex id.
function sampleSpec(stubs = STUBS) {
  const S = stubs.mne, H = stubs.N4n;
  return [['axe'], ['artifact', S, 'owned', 'by', 'you'], ['artifact', H], ['this', 'version', 'has', S, 'files']];
}

// Inputs where the two atomic separators decide the answer, and ones where they do not.
function sampleCorpus() {
  const out = [];
  const leads = ['', ' ', ':', ' : ', '-:-', '\t-', ':::::', '::::: ', '\\'];
  const bodies = ['axe', 'ax', 'aXe', 'axxe', 'a\rxe', 'artifact x owned by you', 'artifact: owned by you',
    'artifact::x owned by you', 'artifact:-:-:x owned by you', 'artifact:-:-:-:x owned by you',
    'artifact : x : owned - by you', 'artifact 0123abcd-4567-89ef-', 'artifact 0123abcd-:4567--89ef-',
    'artifact 0123abcd4567-89ef-', 'this version has page: files', 'this version has: files',
    'this  version has x x files', 'Artifact X Owned By You'];
  for (const l of leads) for (const b of bodies) out.push(`[${l}${b}`, `text [${l}${b}] more`);
  return out;
}

function captures(re) { return new RegExp(`${re.source}|`, re.flags).exec('').length - 1; }

// Every match (index and length) and what the bundle's neutralizer makes of the input.
function matchesOver(re, corpus) {
  return corpus.map((s) => {
    re.lastIndex = 0;
    const idx = [];
    for (let m; (m = re.exec(s)) !== null;) { idx.push(`${m.index}:${m[0].length}`); if (!m[0].length) re.lastIndex++; }
    re.lastIndex = 0;
    return `${idx.join(',')}|${s.replace(re, (u) => `${u}\\`)}`;
  });
}

// ---- the oracle: the REAL carve ----------------------------------------------------------------

// The carve's module sources BEFORE the graph hooks, as extractGraphToFile hands them to
// transformGraph (test/bun-graph-plan.test.cjs plans the same way).
function preHookSources(bin) {
  const { loadGraph, loadGraphFull } = require('../libexec/bun-graph.cjs');
  const { planGraph } = require('../libexec/bun-graph-plan.cjs');
  return planGraph(loadGraph(bin), loadGraphFull(bin).entryName).sources;
}

// The builder module in a carve, what it is called and what its free names are called, and the
// list `get lead` hands it. null when the carve has no builder the hook can read.
function findBuilder(sources) {
  const { LEAD_SCRUB_SHAPES } = require('../libexec/extract-claude-js.cjs');
  for (const [name, text] of Object.entries(sources)) {
    const m = [...text.matchAll(LEAD_SCRUB_SHAPES.builder)];
    if (m.length !== 1) continue;
    const mu = [...text.matchAll(LEAD_SCRUB_SHAPES.mu)][0];
    const names = { ...m[0].groups, ...(mu ? mu.groups : {}) };
    const exported = exportsOf(text);
    return { module: name, text, names, symbols: { hex: exported[names.HEXID], span: exported[names.SPAN] } };
  }
  return null;
}

// local name -> exported name, from the module's one trailing export list.
function exportsOf(text) {
  const ex = /export\{([^}]*)\};?\s*$/.exec(text);
  const out = {};
  for (const x of ex ? ex[1].split(',') : []) {
    const [local, exported = local] = x.split(' as ').map((y) => y.trim());
    out[local] = exported;
  }
  return out;
}

// The phrase list the carve's `get lead` passes to the builder, with the two symbols named by
// the builder module's EXPORT names ({ sym }), so any engine can bind them.
function leadList(sources, builder) {
  const esc = (s) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
  const fromBuilder = new RegExp(`import\\{([^}]*)\\}from"${esc(builder.module)}";`);
  for (const text of Object.values(sources)) {
    const at = text.indexOf('get lead(){');
    if (at < 0) continue;
    const imp = fromBuilder.exec(text);
    if (!imp) continue;
    const localToExported = {};
    for (const spec of imp[1].split(',')) {
      const [exported, local = exported] = spec.split(' as ').map((x) => x.trim());
      localToExported[local] = exported;
    }
    const call = /\?\?=([\w$]+)\(\[\[/.exec(text.slice(at, at + 200));
    if (!call || localToExported[call[1]] === undefined) continue;
    // The literal: from `[[` to its matching `]]`, strings and identifiers only.
    const start = at + call.index + call[0].length - 2;
    let depth = 0, i = start, inStr = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === '[') depth++; else if (c === ']' && --depth === 0) break;
    }
    const literal = text.slice(start, i + 1);
    const idents = [...new Set(literal.replace(/"(?:[^"\\]|\\.)*"/g, '').match(/[A-Za-z_$][\w$]*/g) || [])];
    const bind = idents.map((id) => ({ sym: localToExported[id] }));
    if (bind.some((b) => b.sym === undefined)) continue;
    return new Function(...idents, `return ${literal};`)(...bind);
  }
  return null;
}

// The module as a function body: its imports become undefined bindings (the builder calls none),
// its export list the returned object, plus the builder itself and the free names it reads.
function moduleAsFunctionBody(text, names) {
  let body = text.replace(/import\{([^}]*)\}from"[^"]*";/g,
    (m, list) => `var ${list.split(',').map((x) => x.split(' as ').pop().trim()).join(',')};`)
    .replace(/import"[^"]*";/g, '');
  const ex = /export\{([^}]*)\};?\s*$/.exec(body);
  if (!ex) throw new Error('lead-scrub oracle: the builder module does not end in one export list');
  const pairs = ex[1].split(',').map((x) => {
    const [local, exported = local] = x.split(' as ').map((y) => y.trim());
    return `${JSON.stringify(exported)}:${local}`;
  });
  const free = ['W', 'J', 'CTL', 'Y', 'IPT', 'YV', 'LU', 'OPEN'].map((k) => `${k}:${names[k]}`).join(',');
  body = `${body.slice(0, ex.index)}return{${pairs.join(',')},__builder:${names.NO},__free:{${free}}};`;
  if (/(?:^|[;}])\s*(?:import\s*[{"*]|export\s*[{*]|export\s+(?:default|function|const|let|var|class)\b)/.test(body)) {
    throw new Error('lead-scrub oracle: a module-level import or export form this oracle does not convert');
  }
  return body;
}

// Engine-neutral program (node, quaude's shim under tjs, native Bun's preload): build the lead
// pattern from a module body and run it over a corpus the way the bundle does (an exec loop, which
// is what matchAll iterates, and the neutralizer's replace), one record per input.
const EVALUATE = `function evaluateLead(body, list, corpus) {
  const M = new Function(body)();
  const spec = list.map((p) => p.map((g) => typeof g === 'string' ? g : M[g.sym]));
  let re;
  try { re = M.__builder(spec); } catch (e) { return { error: String(e) }; }
  const res = corpus.map((s) => {
    re.lastIndex = 0;
    const idx = [];
    for (let m; (m = re.exec(s)) !== null;) { idx.push(m.index + ':' + m[0].length); if (!m[0].length) re.lastIndex++; }
    re.lastIndex = 0;
    const r = s.replace(re, (u) => u + '\\\\');
    let h = 0x811c9dc5;
    for (let i = 0; i < r.length; i++) { h ^= r.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return idx.join(',') + '|' + r.length + '|' + h.toString(16);
  });
  return { captures: new RegExp(re.source + '|', re.flags).exec('').length - 1, sourceLength: re.source.length, res };
}`;

// JSON with every non-ASCII code unit escaped. quaude's fs reads text through a TextDecoder that
// drops U+FEFF even mid-text (BACKLOG.md), and the corpus holds U+FEFF on purpose.
function asciiJson(v) {
  return JSON.stringify(v).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// The truth: native Bun runs the carve's own builder.
function runNativeLead(bin, body, list, corpus) {
  const { runInNative } = require('../scripts/lib/native-oracle.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-native-'));
  try {
    const f = path.join(dir, 'in.json');
    fs.writeFileSync(f, asciiJson({ body, list, corpus }));
    return runInNative(bin, `const fs = require('fs');\n${EVALUATE}\n`
      + `const i = JSON.parse(fs.readFileSync(input, 'utf8'));\nreturn evaluateLead(i.body, i.list, i.corpus);`,
    { input: f, timeoutMs: 600000 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The subject: quaude's engine and shim run a module body.
function runQuaudeLead(body, list, corpus) {
  const { runLoader } = require('./node-shim-helper.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-quaude-'));
  try {
    const f = path.join(dir, 'in.json'), o = path.join(dir, 'out.json'), prog = path.join(dir, 'run.cjs');
    fs.writeFileSync(f, asciiJson({ body, list, corpus }));
    fs.writeFileSync(prog, `const fs = require('fs');\n${EVALUATE}\n`
      + `const i = JSON.parse(fs.readFileSync(${JSON.stringify(f)}, 'utf8'));\n`
      + `fs.writeFileSync(${JSON.stringify(o)}, JSON.stringify(evaluateLead(i.body, i.list, i.corpus)));\n`);
    const r = runLoader(prog, [], { timeout: 600000 });
    let out = '';
    try { out = fs.readFileSync(o, 'utf8'); } catch { /* absent */ }
    if (!out) throw new Error(`quaude's engine wrote no result (exit ${r.status}): ${String(r.stderr).slice(0, 400)}`);
    return JSON.parse(out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---- the corpus, from the carve's own classes ---------------------------------------------------
// Deterministic. Five parts: the inputs measured reaching the pattern on real turns; every phrase
// rendered plainly; phrases spelled with confusables, invisible characters and joiners, then
// mutated; separators before a span built from the only joiners a span may END on (measured over
// every code point at 2.1.283: U+02D0 and U+A4FD), where atomicity decides the answer; and a few
// large inputs.
function buildCorpus(free, list, symbols, sizes = { structured: 3000, targeted: 3000, random: 1000, large: [65536, 262144] }) {
  // mulberry32 (test/shape-census.cjs's, the same function this file held inline: the corpus is byte-for-byte unchanged)
  const rnd = mulberry32(CORPUS_SEED);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const ch = String.fromCodePoint;
  const pool = [];
  for (const [lo, hi] of [[0, 0x36f], [0x370, 0x4ff], [0x589, 0x61c], [0x640, 0x640], [0x6dd, 0x70f], [0x7fa, 0x8e2],
    [0x115f, 0x1160], [0x1400, 0x1400], [0x1680, 0x1680], [0x16ec, 0x16ec], [0x17b4, 0x17b5], [0x1803, 0x180f],
    [0x1d00, 0x1eff], [0x2000, 0x2bff], [0x2c60, 0x2c8f], [0x2e00, 0x2e7f], [0x3000, 0x303f], [0x30a0, 0x30a0],
    [0x30fb, 0x30ff], [0x3164, 0x3164], [0xa4ee, 0xa4ff], [0xa780, 0xa7ff], [0xab70, 0xab7f], [0xfe00, 0xfe6f],
    [0xfeff, 0xfeff], [0xff00, 0xffef], [0xfff0, 0xfffd], [0x110bd, 0x110bd], [0x13430, 0x13442], [0x1bca0, 0x1bca3],
    [0x1d173, 0x1d17a], [0x1d400, 0x1d7ff], [0x1f300, 0x1f320], [0xe0000, 0xe007f], [0xe0100, 0xe0110]]) {
    for (let c = lo; c <= hi; c++) if (c < 0xd800 || c > 0xdfff) pool.push(c);
  }
  const members = (cls) => { const re = new RegExp(`^[${cls}]$`, 'iu'); return pool.map((c) => ch(c)).filter((c) => re.test(c)); };
  const DIGITS = `0-9\\uff10-\\uff19\\u{1d7ce}-\\u{1d7ff}\\u2070\\u00b9\\u00b2\\u00b3\\u2074-\\u2079\\u2080-\\u2089${[...'abcdef'].map(free.YV).join('')}`;
  const OPEN = members(free.OPEN), WS = members(free.W), CTL = members(`\\r\\n${free.CTL}`), JOIN = members(free.J);
  const Y = members(free.Y), IPT = members(free.IPT), DIG = members(DIGITS);
  const spanAlone = new RegExp(`^(?:${free.LU})$`, 'iu');
  const J_TERM = JOIN.filter((c) => spanAlone.test(c));
  const conf = {};
  for (const l of 'abcdefghijklmnopqrstuvwxyz') conf[l] = members(free.YV(l));
  const MISC = ['a', 'Z', '0', '9', '_', '\\', '"', "'", ')', ']', '(', '.', ',', '!', '?', ' ', '\n', 'x', ch(0x2019), ch(0xe9), ch(0x1f600), ch(0x4e2d)];
  const ALPHA = [...OPEN, ...WS, ...CTL, ...JOIN, ...DIG, ...MISC, ...Object.values(conf).flat()];
  const run = (set, max) => { let s = ''; for (let n = int(0, max); n > 0; n--) s += pick(set); return s; };
  const letter = (l) => (rnd() < 0.6 ? (rnd() < 0.8 ? l : l.toUpperCase()) : pick(conf[l]));
  const between = () => (rnd() < 0.75 ? '' : rnd() < 0.85 ? run(CTL, 3) : pick([...WS, ...JOIN, 'x']));
  const joinerTerm = () => (J_TERM.length && rnd() < 0.45 ? pick(J_TERM) : pick(JOIN));
  const sep = (kind) => {
    const r = rnd();
    if (r < 0.05) return '';
    if (r < 0.1) return pick(MISC);
    let s = kind === 'n' && rnd() < 0.5 ? run(Y, 5) : '';
    s += run(WS, 3);
    for (let n = rnd() < 0.6 ? int(0, 6) : 0; n > 0; n--) s += (kind === 'span' ? joinerTerm() : pick(JOIN)) + (rnd() < 0.5 ? run(WS, 2) : '');
    return s || (kind !== 'lead' && rnd() < 0.7 ? ' ' : '');
  };
  const word = (w) => [...w].map((l, i) => (i ? between() : '') + letter(l)).join('');
  const hexrun = (n) => { let s = ''; for (let i = 0; i < n; i++) s += (i ? between() : '') + (rnd() < 0.7 ? pick([...'0123456789abcdefABCDEF']) : pick(DIG)); return s + between() + (rnd() < 0.9 ? pick(IPT) : pick(MISC)); };
  const hex = () => hexrun(rnd() < 0.85 ? 8 : int(2, 10)) + sep('e') + hexrun(rnd() < 0.85 ? 4 : int(2, 6)) + sep('e') + hexrun(rnd() < 0.85 ? 4 : int(2, 6));
  const span = () => { let s = ''; for (let n = pick([0, 1, 3, 10, 40, 118, 119, 120, 121]); n > 0; n--) s += rnd() < 0.85 ? pick([...'abcdefghij klmnop QRST 123']) : pick([...OPEN, '\n', ...WS, ...JOIN]); return s + pick(['x', 'Q', '7', '"', ')', ch(0x2019), ']', ' ', '', ...J_TERM]); };
  const phrase = (p, target) => {
    let s = pick(OPEN) + (rnd() < 0.05 ? '\\' : '') + sep('lead');
    p.forEach((g, i) => {
      if (i) s += typeof g !== 'string' ? sep(target ? 'span' : 'e') : typeof p[i - 1] !== 'string' ? sep('n') : sep('c');
      s += typeof g === 'string' ? (target ? g : word(g)) : g.sym === symbols.hex ? hex() : span();
    });
    return s + pick(['', ' ', ']', 'x', '_', '0', '.', '\n', ...WS, ...J_TERM]);
  };
  const mutate = (s) => { const a = [...s]; for (let k = pick([0, 0, 0, 1, 1, 2, 3]); k > 0 && a.length; k--) { const j = int(0, a.length - 1), op = rnd(); if (op < 0.33) a.splice(j, 1); else if (op < 0.66) a.splice(j, 0, pick(ALPHA)); else a[j] = pick(ALPHA); } return a.join(''); };
  const parts = { measured: [ch(0x2014), 'TASKDONE', 'PLAIN-ANSWER', 'SUBDIFF-ANSWER-77', ''], plain: [], structured: [], targeted: [], random: [], large: [] };
  for (const p of list) {
    parts.plain.push(`[${p.map((g) => (typeof g === 'string' ? g : g.sym === symbols.hex ? '0123abcd-45ef-6789-' : 'My Page')).join(' ')}]`);
    parts.plain.push(`see ${ch(0xff3b)}${p.map((g) => (typeof g === 'string' ? g.toUpperCase() : g.sym === symbols.hex ? '0123abcd-45ef-6789-' : 'x')).join('  -  ')}${ch(0xff3d)} now`);
  }
  for (let i = 0; i < sizes.structured; i++) {
    let s = run(ALPHA, rnd() < 0.5 ? 0 : 8);
    for (let k = rnd() < 0.85 ? 1 : int(2, 4); k > 0; k--) s += mutate(phrase(pick(list), false)) + run(ALPHA, 3);
    parts.structured.push(s);
  }
  const withSpan = list.filter((p) => p.some((g) => typeof g !== 'string' && g.sym === symbols.span));
  for (let i = 0; i < sizes.targeted; i++) parts.targeted.push(phrase(pick(withSpan.length ? withSpan : list), true));
  for (let i = 0; i < sizes.random; i++) { let s = ''; for (let n = int(1, 200); n > 0; n--) s += rnd() < 0.1 ? pick(OPEN) : pick(ALPHA); parts.random.push(s); }
  for (const size of sizes.large) {
    let s = '';
    while (s.length < size) s += (rnd() < 0.3 ? mutate(phrase(pick(list), false)) : run(ALPHA, 40)) + '\n';
    parts.large.push(s.slice(0, size));
  }
  return { parts, joinerTerminators: J_TERM.map((c) => c.codePointAt(0)) };
}

// THE CORPUS'S SHAPE CENSUS (observability Task 4): run by test/fidelity/lead-scrub-equivalence.test.cjs over the corpus
// it really builds from the carve's classes, so its findings join that guard's. The shapes are the ones the paragraph
// above buildCorpus names. Floors from the 2.1.283 corpus measured 2026-11-19 (see each `why`): a floor written as a
// fraction of today's count is a regression tripwire on a deterministic count (the seeds are fixed), not a coverage
// requirement
// (the two large inputs are a requirement).
const CORPUS_SEED = 20260927;
function corpusCensus(parts, joinerTerminators) {
  const inputs = Object.values(parts).flat();
  const jt = new Set(joinerTerminators);
  const shapes = [
    { shape: 'a distinct input', min: 6000, has: firstSighting((x) => x), why: 'every one of the 7,055 measured is distinct; a cycling RNG repeats' },
    { shape: 'a joiner a span may end on (U+02D0, U+A4FD)', min: 800, has: (x) => [...x].some((c) => jt.has(c.codePointAt(0))),
      why: 'the only place the joiner separator\'s atomicity is observable; a third of the 2,594 measured' },
    { shape: 'a non-ASCII letter (a confusable)', min: 2000, has: (x) => /\p{L}/u.test(x.replace(/[\x00-\x7f]/g, '')), why: 'a third of the 6,058 measured' },
    { shape: 'an invisible format character', min: 2200, has: (x) => /\p{Cf}/u.test(x), why: 'a third of the 6,841 measured' },
    { shape: 'a line break inside an input', min: 200, has: (x) => /[\r\n]/.test(x), why: 'a third of the 660 measured (the pattern\'s classes hold \\r and \\n)' },
    { shape: 'an input of 64 KiB or more', min: 2, has: (x) => x.length >= 65536, why: 'the two large inputs buildCorpus always makes (65,536 and 262,144)' },
  ];
  return [census('lead-scrub corpus', shapes, inputs), rngBias('lead-scrub corpus RNG', () => { const r = mulberry32(CORPUS_SEED); return (m) => Math.floor(r() * m); },
    // floor(rnd() * a.length) over the pools, and rnd() < p for p in 0.05 .. 0.9
    [2, 10, 20, 100, 1000])];
}

module.exports = {
  corpusCensus,
  ATOMIC_RUN_283, ATOMIC_MU_283, BUILDER_283, MODULE_283, NAIVE_RUN_283, NAIVE_MU_283, STUBS,
  loadBuilder, sampleSpec, sampleCorpus, captures, matchesOver,
  preHookSources, findBuilder, leadList, moduleAsFunctionBody, runNativeLead, runQuaudeLead, buildCorpus, asciiJson,
};
