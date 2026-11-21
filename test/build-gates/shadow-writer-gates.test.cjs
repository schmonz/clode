'use strict';
// The build gate over libexec/bun-shim.cjs's shell-snapshot shadow REWRITE: it reads the
// PINNED carve's own WRITER — the code that generates the grep/find/rg shadow functions
// Claude Code writes into `~/.claude/shell-snapshots/*.sh` — and runs what that writer
// actually writes through the real parseShadow/collectShadows/rewriteSnapshot. A future
// carve whose writer changes its argument-list spelling, or stops baking in a shadow's
// flags, goes red HERE, the day it lands on `next` (upstream-drift.yml), rather than
// silently shipping a clode that drops every one of upstream's flags again.
//
// WHY THIS RATCHET EXISTS (0b, the design's task 0; see
// .superpowers/sdd/2026-09-27-grep-native/design.md and
// .superpowers/sdd/2026-09-26-netbsd-fixes/report.md "F4"). Every carve from 2.1.185 to
// 2.1.283 writes each shadow's trailing argument list as `${1+"$@"}`. Our OWN test
// fixtures (test/fixtures/snapshot-execpath.sh, snapshot-installpath.sh) spelled it the
// older `"$@"`, which is not what any real carve on the dev box ever wrote (recorded in
// BACKLOG: the fixtures' "2.1.179"/"2.1.185" labels do not match what 2.1.185 itself
// writes). The parser only recognised `"$@"` until 2026-09-27 (SHADOW_ARG_SPELLINGS),
// so against every real snapshot it silently read "no flags": the Bash tool's grep
// searched .gitignored files, find ran without its regex type, and the skew probe had
// nothing to probe. F4 (6e34eae) fixed the parser and added ONE verbatim 2.1.283 fixture
// (test/fixtures/snapshot-2.1.283.sh) — but a fixture is a snapshot of ONE carve, frozen
// at commit time; it cannot notice the NEXT carve changing the spelling again. This gate
// reads the writer LIVE, from whatever carve CLODE_PROVIDER_BIN names, so the day
// upstream's writer changes shape, this goes red before a fixture would ever be updated.
//
// WHERE THE WRITER LIVES (2.1.283, both darwin-arm64 and linux-amd64 carves; graph.json,
// decoded the way inspect-claude-bundle reads it — see readCarve() below). One shared
// template function, minified `dbe` on darwin-arm64 and `tbe` on linux-amd64 (SAME
// source, different minifier output — the reason this scan finds it BY STRUCTURE, never
// by either name):
//
//     function dbe(e,n,r=[],s=[]){
//       let g=r.length>0?`${r.join(" ")} \${1+"$@"}`:'${1+"$@"}', ...
//       return [`function ${e} {`,...,
//         `    ARGV0=${n} "$_cc_bin" ${g}`,          // zsh (and msys/cygwin/win32)
//         ...
//         `    (exec -a ${n} "$_cc_bin" ${g})`,      // bash
//         ...].join(`\n`)
//     }
//
// invoked once per shadow: `dbe("find","bfs",["-S","dfs","-regextype","findutils-default"])`,
// `dbe("grep","ugrep",["-G","--ignore-files","--hidden","-I",...lAn.map(e=>`--exclude-dir=${e}`)],
// [...])`, and `dbe("rg",e.argv0)` (rg's applet argument is a RUNTIME expression — Claude's
// own embedded-rg argv0 — never a literal; rg never carries upstream flags either way,
// by clode's own design: CLODE_SHADOWS.rg.entry, bun-shim.cjs).
//
// 2.1.330 (re-pinned 2026-11-21, upstream-drift.yml red since 2026-10-23 with "0 writer
// candidates"): the writer (`UUt`) no longer holds the ARGV0=/exec -a lines; it spreads a helper,
// `BUt(bin,applet,tail,windowsFlag)`, once per binary it tries. With the feature flag
// tengu_playful_dusk off the binary is `"$_cc_bin"` and the output is the 2.1.283 shape; with it on,
// the applet runs on the RUNNING binary and then the install path, each a shell-quoted word. The
// scan finds the helper by structure, runs its body for each binary, and requires the flagged
// variant to read as the same flags (bun-shim.cjs _SHADOW_BIN learned the word shapes for it).
//
// THE EXTRACTION RULE, by structure, never by minified names (dbe/tbe/whatever the next
// carve's minifier picks; same discipline as reset-patch-gates.test.cjs and
// text-probe-gates.test.cjs's wrap-options scan in this same directory):
//   1. WRITER: a `function NAME(p1,p2,p3=[],p4=[]){...}` (arity + the last two params'
//      empty-array defaults — a shape a minifier preserves even as it renames everything)
//      whose body contains `"$_cc_bin"`, `ARGV0=` AND `exec -a ` (SHADOW_KEEPS_THE_SHELL's
//      own two shell invocation idioms, bun-shim.cjs — real shell syntax a minifier never
//      touches). Not found exactly once -> BROKEN (examined 0), never a skip: this is not
//      a missing precondition, it is upstream restructuring code this gate exists to watch.
//   2. THE SPELLING: inside the writer, `LHS=COND.length>0?` TEMPLATE `:` STRING, where
//      COND is the writer's own 3rd parameter. The TEMPLATE and STRING are extracted as
//      SOURCE TEXT and literally evaluated (`new Function`) — not re-typed by this scan —
//      so the computed argument tail is exactly what the writer itself would compute, for
//      any flags array, with no risk of this scan's OWN guess of the formula drifting from
//      the carve's.
//   3. THE TWO INVOCATION LINES: backtick templates in the writer's body containing
//      `"$_cc_bin"` together with `ARGV0=` (zsh) or `exec -a ` (bash) — also extracted as
//      source text and evaluated (with the writer's own applet/tail values filled in),
//      never hand-retyped.
//   4. CALL SITES: every `WRITERNAME("shadowname", applet, flags?, guard?)` in the carve
//      whose first argument is a string literal naming a shadow bun-shim.cjs's own
//      CLODE_SHADOWS table knows (grep/find/rg — read from there, never restated). The
//      flags argument is resolved to a flat string array: a plain string-literal array, OR
//      one whose elements include `...IDENT.map((p)=>\`prefix${p}suffix\`)` spreads (grep's
//      `--exclude-dir=` list), resolved against IDENT's own nearest literal array
//      definition. Anything this resolver does not recognise is a finding naming the raw
//      text, never a silent partial read.
// Each shadow found exactly once (by call site) counts as `examined` (floor 3 — one per
// CLODE_SHADOWS entry); 0 or 2+ call sites for a shadow leaves it unexamined (BROKEN via
// the floor, not a finding — the same split reset-patch-gates.test.cjs draws between
// "structurally absent" and "structurally present but wrong"). What IS examined is run,
// as real generated shell text, through the REAL parseShadow/collectShadows/
// rewriteSnapshot (libexec/bun-shim.cjs, imported — never reimplemented): an unrecognised
// spelling, an applet that does not match CLODE_SHADOWS, or (for grep/find, which are NOT
// CLODE_SHADOWS.*.entry) a shadow with no baked-in flags are each a finding naming the
// shadow. rewriteSnapshot() must not throw over the whole synthesized snapshot, and
// collectShadows() must see exactly as many shadows as were synthesized.
//
// WHY A GUARD. This scan derives its verdict from bytes (structural regexes over the
// carve, `new Function` evaluation of source text extracted by those regexes) and refuses
// (BROKEN) rather than silently reading "no violations" when its own anchors move, so the
// production-gate sweep (test/guards-population.cjs) counts it gate-shaped. The literal
// relative require below is load-bearing for that sweep, which derives "which guard
// controls this production gate" from that string.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert');
const { defineGuard, guardTests } = require('../guard.cjs');
const { rgShadowFunction } = require('../../libexec/rg-entry.cjs');
const { parseShadow, collectShadows, rewriteSnapshot, SHADOW_ARG_SPELLINGS, CLODE_SHADOWS } =
  require('../../libexec/bun-shim.cjs');
const { decodeGraphRunner } = require('../../libexec/inspect-claude-bundle.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const EXTRACT = path.join(REPO, 'libexec', 'extract-claude-js.cjs');

// ---- structural, string-aware helpers (own copies: splitTopArgs/parseStringLiteral echo
// text-probe-gates.test.cjs's, matchBrace echoes bun-shim.cjs's own — this repo's
// convention is a build-gates file resolves its own inputs; see reset-patch-gates.test.cjs) --

// The balanced `{...}` body starting at `text[openIdx]==='{'`, strings/templates skipped
// whole (a `}` inside a string must never end the block early).
function matchBrace(text, openIdx) {
  let depth = 0, quote = null;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}
// Same, for a balanced `(...)`.
function matchParen(text, openIdx) {
  let depth = 0, quote = null;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}
// One call's argument list, split on its own TOP-LEVEL commas (nested (), [], {} and
// strings are not split on).
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
// A single/double-quoted string literal's VALUE, or undefined if `tok` isn't one.
function parseStringLiteral(tok) {
  const t = tok.trim();
  if ((t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0] && t.length >= 2) {
    try {
      return JSON.parse(t[0] === "'"
        ? '"' + t.slice(1, -1).replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"') + '"'
        : t);
    } catch (e) { return undefined; }
  }
  return undefined;
}
// A backtick template with EXACTLY one `${PARAM}` hole -> { prefix, suffix }, or null.
function oneHoleTemplate(tok, paramName) {
  const t = tok.trim();
  if (t[0] !== '`' || t[t.length - 1] !== '`') return null;
  const inner = t.slice(1, -1);
  const holes = [...inner.matchAll(/\$\{([^}]*)\}/g)];
  if (holes.length !== 1 || holes[0][1].trim() !== paramName) return null;
  return { prefix: inner.slice(0, holes[0].index), suffix: inner.slice(holes[0].index + holes[0][0].length) };
}
// `...IDENT.map((PARAM)=>TEMPLATE)` -> { ident, paramName, template }, or null.
function parseSpreadMap(tok) {
  const m = /^\.\.\.(\w+)\.map\(\(?(\w+)\)?=>(.+)\)$/.exec(tok.trim());
  return m ? { ident: m[1], paramName: m[2], template: m[3] } : null;
}
// The NEAREST `var|let|const IDENT=[...]` pure-string-literal array before `beforeIdx`
// (minified names repeat per module — the same "nearest definition" convention as
// text-probe-gates.test.cjs's scanCallerStyle), resolved recursively. The declaration may be a
// later declarator of a list: 2.1.330 writes `var xFo="...",CAi=[".git",...]`.
function findArrayDef(wholeText, ident, beforeIdx) {
  const re = new RegExp('(?:(?:var|let|const)\\s+|,)' + ident.replace(/\$/g, '\\$') + '\\s*=\\s*(\\[[^\\]]*\\])', 'g');
  let best = null, bestDist = Infinity, mm;
  while ((mm = re.exec(wholeText)) !== null) {
    const d = Math.abs(mm.index - beforeIdx);
    if (d < bestDist) { bestDist = d; best = mm[1]; }
  }
  return best === null ? null : resolveArrayLiteral(best, wholeText, beforeIdx);
}
// A `[...]` literal resolved to a flat array of concrete strings, or null when an element
// is a shape this resolver does not recognise: a plain string literal, or a
// `...IDENT.map((p)=>\`prefix${p}suffix\`)` spread of another resolvable literal array
// (grep's `--exclude-dir=` list). Never a silent partial read.
function resolveArrayLiteral(tok, wholeText, atIdx) {
  const t = tok.trim();
  if (t[0] !== '[' || t[t.length - 1] !== ']') return null;
  const inner = t.slice(1, -1).trim();
  if (inner === '') return [];
  const out = [];
  for (const part of splitTopArgs(inner)) {
    const lit = parseStringLiteral(part);
    if (lit !== undefined) { out.push(lit); continue; }
    const sm = parseSpreadMap(part);
    if (sm) {
      const base = findArrayDef(wholeText, sm.ident, atIdx);
      if (base === null) return null;
      const hole = oneHoleTemplate(sm.template, sm.paramName);
      if (hole === null) return null;
      for (const v of base) out.push(hole.prefix + v + hole.suffix);
      continue;
    }
    return null;
  }
  return out;
}

// SHADOW_NAMES: the shadows the parser recognises, read from bun-shim.cjs's OWN table —
// never restated as a literal list here (the "Decisions" rule: the gate consumes the one
// place this is stated, it does not keep a second copy that could drift from it).
const SHADOW_NAMES = Object.keys(CLODE_SHADOWS);

// A `function NAME(p1,p2,p3=[],p4=[])` whose body invokes "$_cc_bin" via both ARGV0= and
// exec -a (SHADOW_KEEPS_THE_SHELL's own two idioms) -- the writer, found by ARITY +
// DEFAULTS + SHELL SYNTAX, never by name. Every match in the whole carve is returned; the
// caller decides what "not exactly one" means.
const WRITER_SIG = /function\s+(\w+)\(\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*=\s*\[\]\s*,\s*(\w+)\s*=\s*\[\]\s*\)\s*\{/g;
// 2.1.330 MOVED THE INVOCATION LINES INTO A HELPER the writer calls once per binary it tries
// (`function BUt(e,o,r,g){if(g)return[\`  ARGV0=\${o} \${e} \${r}\`];return[...,\`    (exec -a \${o}
// \${e} \${r})\`,...]}`, called as `...BUt('"$_cc_bin"',o,h,k)` and, behind a feature flag, as
// `...BUt(Q,o,h,k)` / `...BUt(X,o,h,k)` with Q/X shell-quoted binary paths). So a writer is either
// the pre-2.1.330 one, whose OWN body holds both idioms on "$_cc_bin", or one that names `_cc_bin`
// and spreads a 4-parameter helper whose body holds both idioms. Found by structure, as before.
const HELPER_SIG = (name) => new RegExp('function\\s+' + name.replace(/\$/g, '\\$')
  + '\\(\\s*(\\w+)\\s*,\\s*(\\w+)\\s*,\\s*(\\w+)\\s*,\\s*(\\w+)\\s*\\)\\s*\\{', 'g');
function findInvocationHelper(bundle, body) {
  const called = [...new Set([...body.matchAll(/\.\.\.([\w$]+)\(/g)].map((c) => c[1]))];
  const found = [];
  for (const name of called) {
    const defs = [...bundle.matchAll(HELPER_SIG(name))];
    if (defs.length !== 1) continue;
    const openIdx = defs[0].index + defs[0][0].length - 1;
    const endIdx = matchBrace(bundle, openIdx);
    if (endIdx === -1) continue;
    const hbody = bundle.slice(openIdx + 1, endIdx - 1);
    if (hbody.includes('ARGV0=') && hbody.includes('exec -a ')) {
      found.push({ name, params: [defs[0][1], defs[0][2], defs[0][3], defs[0][4]], body: hbody });
    }
  }
  return found.length === 1 ? found[0] : null;
}
function findWriterCandidates(bundle) {
  const out = [];
  const re = new RegExp(WRITER_SIG.source, 'g');
  let m;
  while ((m = re.exec(bundle)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const endIdx = matchBrace(bundle, openIdx);
    if (endIdx === -1) continue;
    const body = bundle.slice(openIdx + 1, endIdx - 1);
    const params = [m[2], m[3], m[4], m[5]];
    if (body.includes('"$_cc_bin"') && body.includes('ARGV0=') && body.includes('exec -a ')) {
      out.push({ name: m[1], params, body, helper: null });
    } else if (body.includes('_cc_bin')) {
      const helper = findInvocationHelper(bundle, body);
      if (helper) out.push({ name: m[1], params, body, helper });
    }
  }
  return out;
}

// The writer's own `LHS = COND.length>0 ? TEMPLATE : STRING` ternary (COND is the
// writer's own 3rd parameter — the flags array): { gVar, computeTail(flags) }, where
// computeTail is the TEMPLATE/STRING pair LITERALLY EVALUATED from the extracted source
// (new Function), never a formula this scan re-derives by hand. Null if the shape isn't
// there.
function findSpellingTernary(w) {
  const re = /(\w+)=(\w+)\.length>0\?(`(?:[^`\\]|\\.)*`):('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/;
  const tm = re.exec(w.body);
  if (!tm || tm[2] !== w.params[2]) return null;
  let tailFn;
  try { tailFn = new Function(w.params[2], 'return (' + tm[0].slice(tm[0].indexOf('=') + 1) + ')'); }
  catch (e) { return null; }
  return { gVar: tm[1], computeTail: (flags) => tailFn(flags || []) };
}

// The writer's two invocation-line templates: a backtick template containing `"$_cc_bin"`
// together with `ARGV0=` (zsh/msys/win32) or `exec -a ` (bash) — raw SOURCE, evaluated
// later with concrete (applet, tail) values, never hand-retyped.
function findInvocationTemplates(body) {
  const re = /`((?:[^`\\]|\\.)*)`/g;
  const out = [];
  let mm;
  while ((mm = re.exec(body)) !== null) {
    if (!mm[1].includes('"$_cc_bin"')) continue;
    if (mm[1].includes('ARGV0=')) out.push({ kind: 'zsh', src: mm[0] });
    else if (mm[1].includes('exec -a ')) out.push({ kind: 'exec', src: mm[0] });
  }
  return out;
}

// The helper's invocation lines (2.1.330+): it returns the zsh/msys `ARGV0=${APPLET} ${BIN} ${TAIL}`
// lines and the bash `(exec -a ${APPLET} ${BIN} ${TAIL})` line (or, when its fourth parameter, a
// Windows-only feature flag, is set, the ARGV0 line alone). Which parameter is the applet, the
// binary and the tail is READ from the ARGV0 template's own order, never assumed, and the helper's
// WHOLE BODY is then run (fourth parameter false, as everywhere but that Windows branch) so each
// line is exactly what it returns. Null if the shape is not there.
function helperInvocations(helper) {
  const order = /ARGV0=\$\{(\w+)\} \$\{(\w+)\} \$\{(\w+)\}/.exec(helper.body);
  if (!order) return null;
  const [, a, b, t] = order;
  if (![a, b, t].every((p) => helper.params.includes(p))) return null;
  let run;
  try { run = new Function(...helper.params, helper.body); } catch (e) { return null; }
  const lines = (applet, bin, tail) => {
    const out = run(...helper.params.map((p) => (p === a ? applet : p === b ? bin : p === t ? tail : false)));
    return Array.isArray(out) ? out : [];
  };
  const pick = (re) => (applet, bin, tail) => lines(applet, bin, tail).find((l) => re.test(l));
  const probe = lines('APPLET', 'BIN', 'TAIL');
  if (!probe.some((l) => /ARGV0=/.test(l)) || !probe.some((l) => /exec -a /.test(l))) return null;
  return { zsh: pick(/ARGV0=/), exec: pick(/exec -a /) };
}

// The binaries a 2.1.330+ writer hands its helper, read from its own calls: a string literal (the
// `"$_cc_bin"` local) is taken as written; a binding (a shell-quoted path, built at run time from
// the running binary and the install dir) is stood in for by the two word shapes upstream's
// quoter writes: a bare path, and a single-quoted one with a space and an apostrophe.
const QUOTED_BIN_STAND_INS = ['/home/user/.local/bin/claude', "'/home/user/O'\"'\"'Brien Apps/claude'"];
function helperBins(w) {
  const re = new RegExp('\\.\\.\\.' + w.helper.name.replace(/\$/g, '\\$') + '\\(', 'g');
  const literal = new Set(), bound = new Set();
  let c;
  while ((c = re.exec(w.body)) !== null) {
    const openIdx = c.index + c[0].length - 1;
    const closeIdx = matchParen(w.body, openIdx);
    if (closeIdx === -1) continue;
    const first = splitTopArgs(w.body.slice(openIdx + 1, closeIdx - 1))[0];
    const lit = parseStringLiteral(first);
    if (lit !== undefined) literal.add(lit); else bound.add(first.trim());
  }
  return { literal: [...literal], bound: [...bound] };
}

// A flagged (2.1.330+) shadow body, in the writer's own branch shape: try each binary word in
// turn, else fall back to the real command.
function buildFlaggedShadowBody(name, branches) {
  const lines = [`function ${name} {`];
  branches.forEach(({ bin, zshLine, execLine }, i) => {
    lines.push(`  ${i === 0 ? 'if' : 'elif'} [[ -x ${bin} ]]; then`, `  if [[ -n \${ZSH_VERSION:-} ]]; then`,
      `    ${zshLine.trim()}`, '  else', `    ${execLine.trim()}`, '  fi');
  });
  lines.push(`  else command ${name} \${1+"$@"}; fi`, '}');
  return lines.join('\n');
}

// Every `WRITERNAME("shadowName", applet, flags?, guard?)` call site: `applet`/`flags` as
// raw arg text, `flags` NOT yet resolved (the caller resolves it, needing its own index
// for findArrayDef's "nearest definition").
function findCallSites(bundle, writerName, shadowName) {
  const callRe = new RegExp('(?<![\\w$])' + writerName.replace(/\$/g, '\\$') + '\\(', 'g');
  const hits = [];
  let c;
  while ((c = callRe.exec(bundle)) !== null) {
    if (bundle.slice(Math.max(0, c.index - 9), c.index) === 'function ') continue;   // the definition itself
    const openIdx = c.index + writerName.length;
    const closeIdx = matchParen(bundle, openIdx);
    if (closeIdx === -1) continue;
    const parts = splitTopArgs(bundle.slice(openIdx + 1, closeIdx - 1));
    if (parts.length < 2 || parts.length > 4) continue;
    if (parseStringLiteral(parts[0]) !== shadowName) continue;
    hits.push({ index: c.index, parts });
  }
  return hits;
}

// Build the shell text ONE shadow's `function NAME { ... }` body would be, from the
// writer's own invocation-line templates filled with concrete (applet, tail) values —
// enough for parseShadow to read (it needs `_cc_bin` in the body and an
// ARGV0=/exec -a ... "$_cc_bin" <flags> <spelling> line; it does not need the writer's
// binary-path-resolution lines, which are a different concern with its own tests).
function buildShadowBody(name, zshLine, execLine) {
  return [
    `function ${name} {`,
    `  local _cc_bin="\${CLAUDE_CODE_EXECPATH:-}"`,
    `  if [[ -n \${ZSH_VERSION:-} ]]; then`,
    `    ${zshLine}`,
    `  else`,
    `    ${execLine}`,
    `  fi`,
    `}`,
  ].join('\n');
}

function scanShadowWriter({ bundle, what }) {
  const findings = [];
  const candidates = findWriterCandidates(bundle);
  if (candidates.length !== 1) {
    findings.push(`the shell-snapshot shadow writer (a function(e,n,r=[],s=[]) whose body invokes `
      + `"$_cc_bin" via ARGV0=/exec -a) was found ${candidates.length} time(s) in ${what}, not exactly once`);
    return { findings, examined: 0, note: `${what}: ${candidates.length} writer candidate(s)` };
  }
  const w = candidates[0];
  const tern = findSpellingTernary(w);
  if (!tern) {
    findings.push(`the writer in ${what} no longer branches on its flags parameter's .length with a `
      + `\`?TEMPLATE:SPELLING\` ternary — re-derive this scan's shape from the current carve`);
    return { findings, examined: 0, note: `${what}: writer found, spelling ternary not found` };
  }
  // fillInvocation(kind, applet, tail, bin): one invocation line, evaluated from the carve's own
  // template source. bins: every binary the writer runs its applet as ("$_cc_bin" first).
  let fillInvocation, bins, words = [];
  if (!w.helper) {
    const templates = findInvocationTemplates(w.body);
    const zsh = templates.find((t) => t.kind === 'zsh');
    const exec = templates.find((t) => t.kind === 'exec');
    if (!zsh || !exec) {
      findings.push(`the writer in ${what} no longer builds both an ARGV0= (zsh) and an (exec -a ...) `
        + `(bash) invocation line on "$_cc_bin" — re-derive this scan's shape from the current carve`);
      return { findings, examined: 0, note: `${what}: writer found, invocation lines not found` };
    }
    const nVar = w.params[1];
    const src = { zsh: zsh.src, exec: exec.src };
    fillInvocation = (kind, appletVal, tailVal) => new Function(nVar, tern.gVar, 'return (' + src[kind] + ')')(appletVal, tailVal);
    bins = ['"$_cc_bin"'];
  } else {
    const inv = helperInvocations(w.helper);
    const hb = helperBins(w);
    if (!inv || !hb.literal.includes('"$_cc_bin"')) {
      findings.push(`the writer in ${what} spreads ${w.helper.name}(), but ${inv ? 'never hands it "$_cc_bin"' : 'its ARGV0=/exec -a '
        + 'templates are not `${applet} ${bin} ${tail}`'} — re-derive this scan's shape from the current carve`);
      return { findings, examined: 0, note: `${what}: writer and helper found, invocation shape not read` };
    }
    fillInvocation = (kind, appletVal, tailVal, bin = '"$_cc_bin"') => inv[kind](appletVal, bin, tailVal);
    bins = hb.literal;
    words = hb.bound.length > 0 ? QUOTED_BIN_STAND_INS : [];
  }

  let examined = 0;
  const shadowTexts = [];
  for (const name of SHADOW_NAMES) {
    const known = CLODE_SHADOWS[name];
    const hits = findCallSites(bundle, w.name, name);
    if (hits.length !== 1) {
      findings.push(`the ${name} shadow call site (${w.name}("${name}", ...)) occurs ${hits.length} `
        + `time(s) in ${what}, not exactly once`);
      continue;
    }
    const { parts } = hits[0];
    const appletLiteral = parseStringLiteral(parts[1]);
    // rg's applet argument is a runtime expression (Claude's own embedded-rg argv0), never
    // a literal: stand in the applet name bun-shim.cjs itself requires for this shadow
    // (CLODE_SHADOWS[name].applet) — exactly what rewriteSnapshot's own
    // `known.applet===parsed.applet` check enforces at parse time, so this is testing the
    // real integration point, not guessing a runtime value this scan cannot see.
    const appletVal = appletLiteral !== undefined ? appletLiteral : known.applet;
    const flags = parts.length >= 3 ? resolveArrayLiteral(parts[2], bundle, hits[0].index) : [];
    if (flags === null) {
      findings.push(`could not read the ${name} shadow's flags array in ${what} (an element shape this `
        + `scan does not recognise) — re-derive resolveArrayLiteral from the current carve`);
      continue;
    }
    examined++;
    const tail = tern.computeTail(flags);
    const body = buildShadowBody(name, fillInvocation('zsh', appletVal, tail), fillInvocation('exec', appletVal, tail));
    shadowTexts.push(body);
    // The flagged variant (2.1.330+): the applet run on shell-quoted binary WORDS. It must read as
    // the same flags as the "$_cc_bin" body; otherwise every upstream flag is dropped whenever the
    // flag is on (the F4 failure mode, one feature flag away).
    if (words.length > 0) {
      const flagged = buildFlaggedShadowBody(name, words.map((bin) => ({
        bin, zshLine: fillInvocation('zsh', appletVal, tail, bin), execLine: fillInvocation('exec', appletVal, tail, bin) })));
      const fp = parseShadow(flagged.slice(flagged.indexOf('{') + 1, flagged.lastIndexOf('}')));
      const pp = parseShadow(body.slice(body.indexOf('{') + 1, body.lastIndexOf('}')));
      if (!fp || fp.unparsed || !pp || fp.flags !== pp.flags || fp.applet !== pp.applet) {
        findings.push(`the ${name} shadow's flagged variant in ${what} (the applet run on a quoted binary word) does `
          + `not read as its "$_cc_bin" body does: ${JSON.stringify(fp)} against ${JSON.stringify(pp)}`);
      }
    }
    const parsed = parseShadow(body.slice(body.indexOf('{') + 1, body.lastIndexOf('}')));
    if (!parsed) {
      findings.push(`the ${name} shadow this scan built from ${what} is not recognised as an upstream `
        + `multiplexer shadow at all — re-derive parseShadow's presence check or this scan's body shape`);
      continue;
    }
    if (parsed.unparsed) {
      findings.push(`the ${name} shadow's argument spelling in ${what} is not one SHADOW_ARG_SPELLINGS `
        + `knows (${parsed.unparsed}); known spellings: ${SHADOW_ARG_SPELLINGS.join(', ')}`);
      continue;
    }
    if (parsed.applet !== known.applet) {
      findings.push(`the ${name} shadow in ${what} calls "${parsed.applet}", not the "${known.applet}" `
        + `bun-shim.cjs's CLODE_SHADOWS expects`);
      continue;
    }
    // rg (grep-native Task 10c): quaude's rg shadow is the writer's own rg function run against this binary as rg
    // (libexec/rg-entry.cjs rgShadowFunction), so it must run each of the writer's own invocation lines, verbatim.
    if (known.entry) {
      const ours = rgShadowFunction('/x').split('\n');
      for (const line of [fillInvocation('zsh', appletVal, tail), fillInvocation('exec', appletVal, tail)]) {
        if (!ours.includes(line)) {
          findings.push(`the ${name} shadow in ${what} runs \`${line.trim()}\`, and quaude's rg function (rg-entry.cjs `
            + 'rgShadowFunction) does not: it no longer mirrors the writer');
        }
      }
    }
    if (!known.entry && parsed.flags === '') {
      findings.push(`the ${name} shadow in ${what} carries no flags — upstream's ${name} always bakes `
        + `some in; a writer that stopped would silently run ${known.applet} bare`);
    }
  }
  // Integration: the whole synthesized snapshot, through the REAL rewriteSnapshot/
  // collectShadows (never reimplemented) — the same two entry points bun-shim.cjs's own
  // snapshot-refresh hook calls (see rewriteSnapshot's call site, buildShadow's neighbour).
  if (shadowTexts.length > 0) {
    const snapshotText = shadowTexts.join('\n');
    try { rewriteSnapshot(snapshotText); }
    catch (e) { findings.push(`rewriteSnapshot() rejected the shadows this scan built from ${what}: ${e.message}`); }
    const collected = collectShadows(snapshotText);
    if (collected.length !== shadowTexts.length) {
      findings.push(`collectShadows() saw ${collected.length} shadow(s) in ${what}'s synthesized snapshot, `
        + `expected ${shadowTexts.length}`);
    }
  }
  return { findings, examined, note: `${what}: ${examined} of ${SHADOW_NAMES.length} shadow(s) examined`
    + (w.helper ? `; invocation helper ${w.helper.name}(), binaries ${[...bins, ...(words.length ? ['(quoted words)'] : [])].join(', ')}` : '') };
}

// The carve of CLODE_PROVIDER_BIN, decoded the way inspect-claude-bundle reads it -- the
// same pattern as paint-probe-gates.test.cjs's/reset-patch-gates.test.cjs's readCarve, a
// separate copy per guard file by this repo's convention (BACKLOG records the fifth copy;
// "one shared carve reader" stays an open, separate item — not this task's job).
function readCarve() {
  const bin = process.env.CLODE_PROVIDER_BIN;
  if (!bin || !fs.existsSync(bin)) return { skip: 'no CLODE_PROVIDER_BIN (point it at a real claude binary to run this gate)' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-writer-gate-'));
  try {
    const cli = path.join(dir, 'cli.cjs');
    const ex = spawnSync(process.execPath, [EXTRACT, bin, cli], { encoding: 'utf8' });
    if (ex.status !== 0) throw new Error(`extract-claude-js could not carve ${bin}: ${(ex.stderr || '').slice(0, 400)}`);
    const decoded = decodeGraphRunner(cli);
    const bundle = decoded !== null ? decoded : fs.readFileSync(cli, 'latin1');
    return { bundle, what: `the carve of ${bin}` };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

guardTests(defineGuard({
  name: 'shadow-writer-from-carve',
  floor: 3,   // grep, find, rg
  read: readCarve,
  scan: scanShadowWriter,
  // A writer whose spelling is no longer one SHADOW_ARG_SPELLINGS knows — exactly the F4
  // failure mode (upstream moved from `${1+"$@"}` and clode's parser did not follow).
  control: () => ({
    bundle: CARVE_2_1_283
      .replace('} \\${1+"$@"}`', '} \\${9+"$@"}`')
      .replace(":'${1+\"$@\"}'", ":'${9+\"$@\"}'"),
    what: 'synthetic control',
  }),
}));

// The verbatim 2.1.283 writer (darwin-arm64 carve, 2026-09-27: `dbe`/`aAn`/`dAn`/`lAn`,
// graph.json decoded) — dAn() omits its `uw()` presence guard's own body and the pkill
// writer that follows it; neither is read by this scan. Confirmed byte-identical in shape
// (only the writer's own name differs, `tbe`) against the linux-amd64 2.1.283 carve too.
const CARVE_2_1_283 = "function dbe(e,n,r=[],s=[]){let g=r.length>0?`${r.join(\" \")} \\${1+\"$@\"}`:'${1+\"$@\"}',h=H()===\"windows\",b=LX(zW(),h?\"claude.exe\":\"claude\"),w=h?QT(b):b,D=s.length>0?[\"  local _cc_a\",'  for _cc_a in ${1+\"$@\"}; do',`    case \"$_cc_a\" in ${s.join(\"|\")}) command ${e} \\${1+\"$@\"}; return ;; esac`,\"  done\"]:[];return[`function ${e} {`,...D,`  local _cc_bin=\"\\${${ube}:-}\"`,`  [[ -x $_cc_bin ]] || _cc_bin=${qr([w])}`,`  if [[ ! -x $_cc_bin ]]; then command ${e} \\${1+\"$@\"}; return; fi`,\"  if [[ -n ${ZSH_VERSION:-} ]]; then\",`    ARGV0=${n} \"$_cc_bin\" ${g}`,'  elif [[ \"$OSTYPE\" == \"msys\" ]] || [[ \"$OSTYPE\" == \"cygwin\" ]] || [[ \"$OSTYPE\" == \"win32\" ]]; then',`    ARGV0=${n} \"$_cc_bin\" ${g}`,\"  else\",`    (exec -a ${n} \"$_cc_bin\" ${g})`,\"  fi\",\"}\"].join(`\n`)}function aAn(){let e=Q4();if(e.argv0)return{type:\"function\",snippet:dbe(\"rg\",e.argv0)};let n=qr([e.rgPath]),r=e.rgArgs.map((g)=>qr([g]));return{type:\"alias\",snippet:e.rgArgs.length>0?`${n} ${r.join(\" \")}`:n}}var lAn=[\".git\",\".svn\",\".hg\",\".bzr\",\".jj\",\".sl\"];function dAn(){if(!uw())return null;return[\"unalias find 2>/dev/null || true\",\"unalias grep 2>/dev/null || true\",dbe(\"find\",\"bfs\",[\"-S\",\"dfs\",\"-regextype\",\"findutils-default\"]),dbe(\"grep\",\"ugrep\",[\"-G\",\"--ignore-files\",\"--hidden\",\"-I\",...lAn.map((e)=>`--exclude-dir=${e}`)],[\"-*-filter*\",\"-*-pager*\",\"-*-view*\",\"-*-format-open*\",\"-*-config*\",\"---*\",\"-@*\",\"-*-save-config*\",\"-[Zz]*\",\"-[!-]*[Zz]*\",\"--null\",\"--null-data\"])].join(`\n`)}";

// A MINIMAL synthetic writer (its own name, `W`, deliberately different from the real
// carve's minified names, to prove this scan finds it by shape) with exactly ONE shadow
// call site, for the two "one finding" scenarios brief step 2 names precisely.
const MINIMAL_WRITER =
  'function W(e,n,r=[],s=[]){let g=r.length>0?`${r.join(" ")} \\${1+"$@"}`:\'${1+"$@"}\';'
  + 'return[`function ${e} {`,`  local _cc_bin="${x}"`,'
  + '"  if [[ -n ${ZSH_VERSION:-} ]]; then",`    ARGV0=${n} "$_cc_bin" ${g}`,'
  + '"  else",`    (exec -a ${n} "$_cc_bin" ${g})`,"  fi","}"].join(`\\n`)}';

test('shadow-writer-gates step 2: red-then-green scenarios named in the brief', () => {
  // (a) a synthetic writer using an unknown argument spelling -> the grep finding, plus a
  // named "occurs 0 time(s)" finding for each of find and rg, which this bundle never calls.
  const unknownSpelling = MINIMAL_WRITER.replace('\\${1+"$@"}`', '\\${9+"$@"}`') + 'W("grep","ugrep",["-G"]);';
  const a = scanShadowWriter({ bundle: unknownSpelling, what: 'x' });
  assert.strictEqual(a.findings.length, 3, a.findings.join('\n'));
  assert.match(a.findings[0], /grep shadow's argument spelling.*not one SHADOW_ARG_SPELLINGS knows/);
  assert.match(a.findings[1], /find shadow call site .* occurs 0 time\(s\) in x, not exactly once/);
  assert.match(a.findings[2], /rg shadow call site .* occurs 0 time\(s\) in x, not exactly once/);

  // (b) a writer whose grep has no flags -> the no-flags finding, plus the same two
  // "occurs 0 time(s)" findings for the shadows this bundle never calls.
  const noFlags = MINIMAL_WRITER + 'W("grep","ugrep",[]);';
  const b = scanShadowWriter({ bundle: noFlags, what: 'x' });
  assert.strictEqual(b.findings.length, 3, b.findings.join('\n'));
  assert.match(b.findings[0], /grep shadow in x carries no flags/);
  assert.match(b.findings[1], /find shadow call site .* occurs 0 time\(s\) in x, not exactly once/);
  assert.match(b.findings[2], /rg shadow call site .* occurs 0 time\(s\) in x, not exactly once/);

  // (c) the real 2.1.283 writer -> no findings, all 3 shadows examined.
  const c = scanShadowWriter({ bundle: CARVE_2_1_283, what: 'x' });
  assert.deepStrictEqual(c.findings, []);
  assert.strictEqual(c.examined, 3);
});

// The 2.1.330 writer, verbatim from the darwin-arm64 binary (test/fixtures/shadow-writer-2.1.330.js:
// BUt, UUt, RAi and AAi with its CAi list): the invocation lines moved into the BUt() helper, and a
// feature-flagged branch runs the applet on shell-quoted binary WORDS instead of "$_cc_bin".
const CARVE_2_1_330 = fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'shadow-writer-2.1.330.js'), 'latin1');

test('scanShadowWriter: the real 2.1.330 writer (invocation helper, flagged binary words) reads all three shadows', () => {
  const r = scanShadowWriter({ bundle: CARVE_2_1_330, what: 'x' });
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.examined, 3);
  assert.match(r.note, /invocation helper BUt\(\), binaries "\$_cc_bin", \(quoted words\)/);
  // A helper that stops putting the binary between applet and tail is a shape this scan cannot read: refused, not passed.
  const reordered = CARVE_2_1_330.split('ARGV0=${o} ${e} ${r}').join('ARGV0=${o} ${r} ${e}');
  assert.notStrictEqual(reordered, CARVE_2_1_330);
  const bad = scanShadowWriter({ bundle: reordered, what: 'x' });
  assert.ok(bad.findings.length > 0, 'a reordered invocation must be a finding');
  // A writer that stops handing the helper "$_cc_bin" is refused too.
  const noLocal = CARVE_2_1_330.split('BUt(\'"$_cc_bin"\',o,h,k)').join('BUt(X,o,h,k)');
  assert.notStrictEqual(noLocal, CARVE_2_1_330);
  assert.strictEqual(scanShadowWriter({ bundle: noLocal, what: 'x' }).examined, 0);
});

test('scanShadowWriter: structural absence is BROKEN territory (examined 0), never a silent pass', () => {
  const empty = scanShadowWriter({ bundle: '', what: 'x' });
  assert.strictEqual(empty.examined, 0);
  assert.strictEqual(empty.findings.length, 1);
  assert.match(empty.findings[0], /found 0 time\(s\)/);

  const twoWriters = MINIMAL_WRITER + MINIMAL_WRITER.replace('function W(', 'function V(') + 'V("grep","ugrep",["-G"]);';
  const twice = scanShadowWriter({ bundle: twoWriters, what: 'x' });
  assert.strictEqual(twice.examined, 0);
  assert.strictEqual(twice.findings.length, 1);
  assert.match(twice.findings[0], /found 2 time\(s\)/);
});

test('scanShadowWriter: a shadow present for one call site but missing for another is only PARTLY examined', () => {
  // find and rg present, grep absent entirely: examined stays at 2, and a named finding
  // says which shadow's call site went missing.
  const partial = MINIMAL_WRITER
    .replace('function W(', 'function Z(')
    + 'Z("find","bfs",["-S","dfs"]);Z("rg",e.argv0);';
  const r = scanShadowWriter({ bundle: partial, what: 'x' });
  assert.strictEqual(r.examined, 2);
  assert.strictEqual(r.findings.length, 1);
  assert.match(r.findings[0], /grep shadow call site .* occurs 0 time\(s\) in x, not exactly once/);
});

// grep-native Task 10c: a writer whose rg invocation is not the one quaude's rg function runs (here: native's rg
// gaining a baked-in flag) is a finding naming rg, so quaude's Bash `rg` cannot drift from native's unseen.
test('scanShadowWriter: an rg invocation quaude\'s rg function does not run is a finding naming rg', () => {
  const same = scanShadowWriter({ bundle: CARVE_2_1_283, what: 'x' });
  assert.deepStrictEqual(same.findings, []);
  assert.strictEqual(same.examined, 3);
  const drifted = CARVE_2_1_283.replaceAll('`    ARGV0=${n} "$_cc_bin" ${g}`', '`    ARGV0=${n} "$_cc_bin" --no-config ${g}`')
    .replace('`    (exec -a ${n} "$_cc_bin" ${g})`', '`    (exec -a ${n} "$_cc_bin" --no-config ${g})`');
  const r = scanShadowWriter({ bundle: drifted, what: 'x' });
  const mirror = (line) => `the rg shadow in x runs \`${line}\`, and quaude's rg function (rg-entry.cjs rgShadowFunction) does not: `
    + 'it no longer mirrors the writer';
  assert.deepStrictEqual(r.findings, [mirror('ARGV0=rg "$_cc_bin" --no-config ${1+"$@"}'), mirror('(exec -a rg "$_cc_bin" --no-config ${1+"$@"})')]);
});

test('resolveArrayLiteral: grep\'s spread-map --exclude-dir list resolves against the NEAREST array definition', () => {
  const bundle = 'var lAn=[".git",".svn"];' + MINIMAL_WRITER.replace('function W(', 'function Y(')
    + 'Y("grep","ugrep",["-G",...lAn.map((e)=>`--exclude-dir=${e}`)]);';
  const r = scanShadowWriter({ bundle, what: 'x' });
  // grep resolves clean; find and rg are never called in this bundle, so each gets a named
  // "occurs 0 time(s)" finding (the same shape as the step-2 (a)/(b) scenarios above).
  assert.strictEqual(r.findings.length, 2, r.findings.join('\n'));
  assert.match(r.findings[0], /find shadow call site .* occurs 0 time\(s\) in x, not exactly once/);
  assert.match(r.findings[1], /rg shadow call site .* occurs 0 time\(s\) in x, not exactly once/);
  assert.strictEqual(r.examined, 1);
});
