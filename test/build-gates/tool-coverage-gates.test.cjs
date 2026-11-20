'use strict';
// RATCHET 0c (grep-native plan, Task 3): EVERY TOOL THE PINNED CARVE CAN REGISTER IS DRIVEN END
// TO END, OR EXEMPTED BY NAME.
//
// WHAT HAPPENED. The Grep and Glob tools were broken in every clode release (2.1.185..2.1.283):
// files and count mode said "No files found" where native found files, content mode and Glob said
// "Install ripgrep" (report-grep.md, 2026-09-27). Nothing noticed, because nothing drove them.
// upstream registers them only when Grep or Glob is named in --tools/--allowedTools
// (searchToolsOptIn), under CLAUDE_CODE_ENTRYPOINT=local-agent, or with no Bash (Windows without
// Git Bash), and no live check ever asked for them. This gate makes the undriven tools a list
// someone has to read: every tool the carve can register has a driver, or an entry in EXEMPTIONS
// that says why not and until when.
//
// THE REGISTRY, by structure, never by minified names (read from the CLODE_PROVIDER_BIN carve):
//   ANCHOR. The one object `{getAllBaseTools:F,getTools:G,assembleToolPool:H}` in the carve: the
//   minifier keeps property names. Not found exactly once: a finding, and nothing is counted
//   (BROKEN through the floor).
//   MODULES. The decoded carve splits back into its /$bunfs chunks at the header line
//   extract-claude-js writes on each. A name resolves only inside its chunk: a definition there
//   (`function X(`, or `X=` after var/let/const or a comma, module level first), or its
//   `import{a as X}from"chunk"` and that chunk's `export{b as a}`, or a star import
//   (`__clodeReqN.Name`). Bytes are code or not by lexicalCodeMask (libexec/scc-merge.cjs).
//   getAllBaseTools (F) must be `let a=...,b=...; return [...]`. Each array element resolves to
//   tools: an identifier; a builder call whose first argument is an object literal with a `name:`
//   key (the name read through `...X` spreads of object literals, as the Monitor tool needs, and
//   resolved to a string, possibly in another chunk; `aliases:` read the same way); `...C?[A]:[]`
//   (both arms read; an arm guarded by a binding the build compiled to null is dead);
//   `...[A,B].filter(f)`; `...(X?.()??[])`; a spread of an array binding; a call of a function
//   whose body is only `if(C)return X` and `return X` statements; an IIFE; a wrapper call whose
//   arguments agree on ONE tool name (the Artifact tool is `lr(HEAD, () => ArtifactTool)`). An
//   element that resolves to anything else is a finding naming it, never skipped.
//   getTools (G): any identifier in its body (not its own parameters or locals) that resolves to a
//   tool getAllBaseTools lacks joins the registry. At 2.1.283 it adds none.
//   OUTSIDE getAllBaseTools: a builder call `X=F({...})` whose object has a top-level
//   mapToolResultToToolResultBlockParam (the Tool interface's own method name) and a name that
//   resolves joins the registry when anything else in its chunk names X or exports it
//   (SubagentHandback, ObserverReport, the MCP template `mcp`). One nothing names cannot register
//   (TestingPermission, dead code at 2.1.283), and a factory's object (name from a parameter) has
//   no name of its own; both are counted in the note, not the registry.
//   Measured 2026-09-28: 90 tools on the darwin-arm64 carve and 90 on linux-amd64, the same names
//   (87 + 0 + 3). The floor is 90.
//
// CELLS (the observability plan's Task 1, user doctrine 2026-10-05: "Job 0 is always to be able to
// observe our current state more accurately than yesterday"). A tool is never driven as a whole:
// it is driven per CELL, tool x mode x engine. Bash driven in a -p turn on darwin said nothing
// about Bash with the sandbox enabled (it failed OPEN until 8b088ef), and Grep driven on darwin
// said nothing about Grep on Linux (every call was refused until 0204b54). Both were cells no job
// ran.
//   MODES, read from the pinned carve where it can say (each a finding when its anchor is not
//   found exactly once, so a re-shaped carve is never read as "no modes"):
//     permission:<m>  each mode of the carve's own list, the array behind `Cannot set permission
//                     mode: must be one of ${X.join(", ")}` (2.1.283: acceptEdits, auto,
//                     bypassPermissions, default, dontAsk, plan), less `default`, which is the
//                     baseline below. bypassPermissions is also --dangerously-skip-permissions.
//     sandbox:on      the settings schema's sandbox object, `{enabled:...,failIfUnavailable:...
//     sandbox:required  .describe("Exit with an error at startup if sandbox.enabled is true...`:
//                     enabled, and enabled with failIfUnavailable.
//     shell:<s>       the shells the Bash tool's discovery tries by name, the one
//                     `(C?["bash","zsh"]:["zsh","bash"]).flatMap(` (2.1.283: bash, zsh).
//     the opt-ins     the tools a launch registers only when --tools/--allowedTools names them:
//                     the list handed to the setter of launchOptions.replaceSearchToolsOptIn
//                     (searchToolsOptIn: Glob, Grep) and of replaceTodoToolsOptIn.
//   DECIDED HERE, where the carve cannot settle it (observability Task 1; one factor at a time,
//   so the matrix stays one row per behaviour, not a product of every flag):
//     print           the BASELINE: a -p turn in the default permission mode with the tool named
//                     in --allowedTools (how every live check runs; for an opt-in tool the same
//                     naming is its opt-in), no sandbox, whatever shell the turn inherits. A
//                     control without a declaration declares this.
//     interactive     a pty turn instead of -p, otherwise the baseline.
//     unlisted        -p with the tool NOT named in --allowedTools: the permission path a -p turn
//                     takes without a grant. Not a cell of a SEARCH opt-in tool, which is not
//                     registered then (while Bash is). The todo opt-in is not such a gate: the
//                     carve also enables those tools by model (`uU()`: the opt-in, OR the model's
//                     family), so `unlisted` stays a cell of theirs.
//     the others are the baseline with ONE thing changed. sandbox:* and shell:* are cells of the
//     Bash tool only: the sandbox wraps the Bash tool's commands and the shell is its
//     interpreter; no other tool runs either.
//   ENGINES: the three shipping engines, darwin-arm64, linux-x64-musl and netbsd-arm64 (each must
//   be one of scripts/tjs-legs.mjs's publishedRunTargets()). Every other published run-target is
//   one dated exemption (OTHER_ENGINES_EXEMPTION), outside the matrix.
//   DRIVEN, per cell: a driver (below) declares the tool and the mode, and a CI JOB in CELL_JOBS
//   runs the driver's file on the cell's engine. Where a test merely exists drives nothing. A job
//   counts only when .github/workflows/ci.yml has it, downloads the engine's tjs artifact
//   (tjs-<engine>), names each claimed file, runs its tests under test/cell-reporter.mjs, and
//   runs this file with CLODE_CELL_JOB=<job>: that run (the guard cells-ran-in-ci-job, below)
//   fails the job unless every test that runs a claimed driver's control PASSED in that job, on a
//   host of that engine. A failed or unreported test always fails it; a SKIPPED one fails it unless
//   another passing test in the job drives each of that driver's cells (one branch of a host fact:
//   agentic-sandbox-fail-closed's fail-closed and D2 tests). So the static claim here and what the
//   job did are held together on every push. (Comments in ci.yml are stripped before any of this
//   is read: a comment naming a file is not a step running it.)
//   A DECLARED MODE must be spelled in the driver's file (MODE_EVIDENCE: the permission flag, a
//   sandbox settings literal, SHELL), or it is a finding and drives nothing.
//   EXEMPTIONS are per cell: { tool, reason, date, until }, optionally narrowed by `modes` and
//   `engines`; a cell both driven and exempted is a finding, as is one neither driven nor
//   exempted. The dates are the every-tool plan's phases (UNTIL_PHASE_A/B/C), carried as set.
//
// A DRIVER (test/**/*.cjs|mjs and scripts/**/*.cjs|mjs|js; two files skipped by name,
// DRIVER_SCAN_SKIP) is a call `assertFailsOnMissingOutput(check, USE[, MODES])` (Task 1's control,
// MODES a mode or an array of modes as string literals, `print` when absent) where
//   - USE is declared in that file as an object literal whose `name:` is a string literal: the
//     tool it drives, or an alias of it ('Task' drives Agent);
//   - check is declared in that file and reads the tool_result BY THAT OBJECT'S ID:
//     toolResult(x, USE.id) or toolResultText(x, USE.id), or the id's own spelling in USE (`ID`);
//   - the mock scripts that same object: cannedToolUseSSE(USE.name, ...)/toolUseSSE(USE.name, ...),
//     a mock rule `tool: USE`, or USE passed to a same-file function whose parameter is scripted
//     that way (driveBashTurn(bin, DENY)).
//   ITS TESTS: the test(...)/it(...) call holding the control (by its line, which is what
//   node:test reports), or, for a control inside a top-level function, every test that calls that
//   function (agentic-grep-glob's controls()). A driver with none cannot be claimed by a job.
//   A test that spells `quaudeSkip` (outside a comment or string) is NOT one of its tests: it runs
//   test/tool-driver.cjs's turn on native alone, so it drives no quaude cell, whatever control it
//   calls (tools-local's native instrument). Such tests are listed apart (nativeOnly).
//   A driver CAN SKIP when its test is declared skipped (test.skip, a `{ skip }`/`{ todo }`
//   option), or when a skip( call follows the control inside its test (outside a test: to the end
//   of the top-level statement). That is shown on the map; it no longer decides the verdict,
//   because a claimed driver's skip in its job fails that job (agentic-tools' Grep row read a
//   refusal as a skip until the grep-native plan's Task 11; BACKLOG, "every-tool-driven reads the
//   end to end's drivers as FIRM").
//
// THE VERDICT, per cell (examined = the cells; floor = CELL_FLOOR):
//   - driven by a claimed driver in a valid job: OK; also exempted: a finding (narrow the
//     exemption);
//   - neither driven nor exempted: a finding, one per tool x mode, naming its engines;
//   - EXEMPTIONS: { tool, reason, date, until } plus optional `modes`/`engines` arrays; a
//     non-empty reason; YYYY-MM-DD dates, date <= until; past `until` (UTC date) it is a finding
//     naming its phase; a tool the carve does not register, an alias, a mode or engine that is not
//     one of the tool's cells, or two entries covering one cell, is a finding;
//   - a declared mode that is not a cell of the tool, a claimed driver with no test, a job
//     CELL_JOBS names that ci.yml does not run as above, or a claimed file with no driver.
//
// WHAT IT DOES NOT SEE, stated:
//   - whether a driver's turn runs quaude, naude or native: every driver in the tree runs quaude
//     (the map in the report), but the rule reads only the test's source; agentic-grep-glob's
//     controls() also runs in its native instrument, so both tests must pass in the job;
//   - whether a driver's turn really is in the mode it declares: MODE_EVIDENCE checks the file
//     spells the flag, settings or SHELL somewhere outside a comment, not that this turn passes
//     them; print, interactive and unlisted are not checked at all;
//   - CI's outcome: driven means "a job enforces it on every push", not "the last run was green";
//   - a driver whose tool_use object, check or scripting lives in another file;
//   - a tool registered by a path none of the three above reaches: a plain object literal returned
//     by a function (the MCP authentication stubs and the unknown-tool placeholder, whose names
//     are computed per server or call), or a tool whose builder takes no object literal;
//   - isEnabled(): a registered tool may be off at run time; the exemption reasons record the
//     gates read from the 2.1.283 carve, and nothing re-reads them;
//   - a skip( spelled another way (a `return` that skips the asserts, a skip in a helper the test
//     calls after the control).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { defineGuard, guardTests, checkGate, BROKEN, VIOLATION, OK } = require('../guard.cjs');
const { lexicalCodeMask } = require('../../libexec/scc-merge.cjs');
const { decodeGraphRunner } = require('../../libexec/inspect-claude-bundle.cjs');
const { discoverFilesByExt } = require('../source-scan.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const EXTRACT = path.join(REPO, 'libexec', 'extract-claude-js.cjs');
// The extractor's own helpers (a chunk's name from its url; the fixtures' headers), borrowed, not controlled: loaded
// through EXTRACT, not a require() literal, which guards-population would read as this guard controlling
// extract-claude-js (bun-ant-surface-gate.test.cjs, same).
const { moduleNameOfMetaUrl, moduleWithMeta } = require(EXTRACT);
const posixRel = (f) => path.relative(REPO, f).split(path.sep).join('/');

// ==========================================================================
// MASKED TEXT. Which bytes are code is the merger's own lexer's call (lexicalCodeMask,
// libexec/scc-merge.cjs: 1 = code; strings, template text, regex bodies and comments are 0), so a
// bracket or a comma inside a string never moves a boundary this scan draws.
// ==========================================================================
const masked = (src) => ({ src, mask: lexicalCodeMask(src) });
const esc = (id) => id.replace(/\$/g, '\\$');

// The end of the expression that starts at `i`: the first CODE byte at bracket depth 0 that is one
// of `stops`, or an unmatched closer, or the end of the text. -1 when the brackets do not balance.
function endOf(m, i, stops) {
  const { src, mask } = m;
  let d = 0;
  for (let j = i; j < src.length; j++) {
    if (!mask[j]) continue;
    const c = src[j];
    if (d === 0 && stops.includes(c)) return j;
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') { if (d === 0) return j; d--; }
  }
  return d === 0 ? src.length : -1;
}
// Just past the bracket that closes the one at `open`, or -1.
function closeOf(m, open) {
  const e = endOf(m, open + 1, '');
  return e >= 0 && e < m.src.length ? e + 1 : -1;
}
// A list split at its top-level `sep`s (the inside of a bracket, or a block's statements); null
// when it does not lex.
function splitTop(text, sep = ',') {
  const m = masked(text);
  const parts = [];
  for (let i = 0; ;) {
    const e = endOf(m, i, sep);
    if (e < 0 || (e < text.length && text[e] !== sep)) return null;
    parts.push(text.slice(i, e).trim());
    if (e >= text.length) break;
    i = e + 1;
  }
  return parts.filter((p) => p !== '');
}
// `COND?YES:NO` at the top level of `text` (not `?.` or `??`), or null.
function splitTernary(text) {
  const m = masked(text);
  const isQ = (j) => text[j] === '?' && text[j + 1] !== '.' && text[j + 1] !== '?' && text[j - 1] !== '?';
  let d = 0, q = -1, nest = 0;
  for (let j = 0; j < text.length; j++) {
    if (!m.mask[j]) continue;
    const c = text[j];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d--;
    else if (d === 0 && isQ(j)) { if (q < 0) q = j; else nest++; }
    else if (d === 0 && c === ':' && q >= 0) {
      if (nest > 0) { nest--; continue; }
      return { cond: text.slice(0, q).trim(), yes: text.slice(q + 1, j).trim(), no: text.slice(j + 1).trim() };
    }
  }
  return null;
}
// The parts of an object literal `{...}` (null when it does not lex), and one top-level key's
// value, a method or getter counting as present.
const objectParts = (obj) => splitTop(obj.slice(1, -1));
const KEY_RE = (key) => new RegExp(`^(?:async\\s+)?(?:get\\s+)?${esc(key)}\\s*([:(])`);

// ==========================================================================
// THE CARVE: modules, and what one binding means
// ==========================================================================
// extract-claude-js prefixes every /$bunfs chunk with this line, so the decoded carve splits back
// into its modules there. Each chunk has its own minified namespace (`bwe` is the MCP template in
// one chunk and an error predicate in another), so a name is only ever resolved inside its module
// or through that module's own import/export clauses.
// The module's NAME (the spelling its importers' `from"..."` use) is read back from the url by the
// extractor's own inverse: a win32 carve's url is file:///B:/~BUN/..., its name B:/~BUN/....
const MODULE_HEADER = /import\.meta\.require = globalThis\.__quaudeRequire; import\.meta\.url = ("file:\/\/[^"]+");/g;
function splitModules(text) {
  const hits = [...text.matchAll(MODULE_HEADER)];
  const out = new Map();
  hits.forEach((h, k) => out.set(moduleNameOfMetaUrl(JSON.parse(h[1])), text.slice(h.index, k + 1 < hits.length ? hits[k + 1].index : text.length)));
  return out;
}
function parseModule(src) {
  const m = masked(src);
  const code = (i) => m.mask[i] === 1;
  const spec = (s) => /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(s);
  const imports = new Map(), stars = new Map(), exports = new Map();
  for (const x of src.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    if (!code(x.index)) continue;
    for (const s of x[1].split(',')) { const a = spec(s); if (a) imports.set(a[2] || a[1], { from: x[2], name: a[1] }); }
  }
  for (const x of src.matchAll(/\bimport\s*\*\s*as\s+([\w$]+)\s+from\s*"([^"]+)"/g)) if (code(x.index)) stars.set(x[1], x[2]);
  for (const x of src.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    if (!code(x.index)) continue;
    for (const s of x[1].split(',')) { const a = spec(s); if (a) exports.set(a[2] || a[1], a[1]); }
  }
  return { src, m, imports, stars, exports, depth: null };
}
function depthOf(mod) {
  if (!mod.depth) {
    const { src, m } = mod;
    const d = new Int32Array(src.length);
    for (let i = 0, k = 0; i < src.length; i++) {
      d[i] = k;
      if (!m.mask[i]) continue;
      const c = src.charCodeAt(i);
      if (c === 40 || c === 91 || c === 123) k++;
      else if (c === 41 || c === 93 || c === 125) k--;
    }
    mod.depth = d;
  }
  return mod.depth;
}
// Every definition of `id` in a module: `function id(`, or `id=` after var/let/const or a comma.
// A comma also precedes a default parameter (`(e,r=[])`), so module-level definitions (bracket
// depth 0) win whenever there are any; when there are none the list is marked `nested`, and an
// import of the same name wins over it.
function definitionsOf(mod, id) {
  const { src, m } = mod;
  const out = [];
  for (const x of src.matchAll(new RegExp(`(?<![\\w$.])function\\s*\\*?\\s*${esc(id)}\\s*\\(`, 'g'))) {
    if (!m.mask[x.index]) continue;
    const open = x.index + x[0].length - 1;
    const pe = closeOf(m, open);
    if (pe < 0 || src[pe] !== '{') continue;
    const be = closeOf(m, pe);
    if (be < 0) continue;
    out.push({ kind: 'function', at: x.index, params: src.slice(open + 1, pe - 1), body: src.slice(pe + 1, be - 1) });
  }
  for (const x of src.matchAll(new RegExp(`(?:\\b(?:var|let|const)\\s+|,)${esc(id)}=(?![=>])`, 'g'))) {
    const at = x.index + x[0].length - id.length - 1;
    if (!m.mask[at]) continue;
    const start = x.index + x[0].length;
    const end = endOf(m, start, ',;');
    if (end < 0) continue;
    out.push({ kind: 'value', at, text: src.slice(start, end).trim() });
  }
  const d = depthOf(mod);
  const top = out.filter((o) => d[o.at] === 0);
  return top.length ? top : Object.assign(out, { nested: true });
}

// VALUES the resolver hands back: a tool { name, aliases, gates }, a list of tools, null (a
// binding the build compiled out), a string, a function (not yet called), or unknown (with why).
const UNKNOWN = (why) => ({ kind: 'unknown', why });
const toolsOf = (v) => (v.kind === 'tool' ? [v] : v.kind === 'list' ? v.items : []);
const gated = (v, gate) => toolsOf(v).map((t) => ({ ...t, gates: [...t.gates, gate] }));
function namesOf(v) {
  if (v.kind === 'tool' || v.kind === 'list') return toolsOf(v).map((t) => t.name);
  return v.kind === 'null' ? [] : null;
}

class Resolver {
  constructor(text) { this.modules = splitModules(text); this.parsed = new Map(); }
  mod(name) {
    if (!this.parsed.has(name)) {
      const src = this.modules.get(name);
      this.parsed.set(name, src === undefined ? null : parseModule(src));
    }
    return this.parsed.get(name);
  }
  ident(modName, id, seen, locals) {
    if (locals && locals.has(id)) return this.expr(modName, locals.get(id), seen);
    if (id === 'null' || id === 'undefined') return { kind: 'null' };
    const key = `${modName}#${id}`;
    if (seen.has(key)) return UNKNOWN(`${id} refers to itself`);
    seen = new Set(seen).add(key);
    const mod = this.mod(modName);
    if (!mod) return UNKNOWN(`no module ${modName}`);
    const defs = definitionsOf(mod, id);
    const imp = mod.imports.get(id);
    if (!defs.length || (defs.nested && imp)) {
      return imp ? this.exported(imp.from, imp.name, seen) : UNKNOWN(`${id} is neither defined nor imported in ${modName}`);
    }
    const vals = defs.map((d) => (d.kind === 'function'
      ? { kind: 'fn', mod: modName, params: d.params, body: d.body }
      : this.expr(modName, d.text, seen)));
    const known = vals.filter((v) => v.kind !== 'unknown');
    if (!known.length) return vals[0];
    const sig = JSON.stringify(known[0]);
    return known.every((v) => JSON.stringify(v) === sig) ? known[0]
      : UNKNOWN(`${id} has ${known.length} different definitions in ${modName}`);
  }
  exported(modName, name, seen) {
    const mod = this.mod(modName);
    if (!mod) return UNKNOWN(`no module ${modName}`);
    const local = mod.exports.get(name);
    return local === undefined ? UNKNOWN(`${modName} does not export ${name}`) : this.ident(modName, local, seen);
  }
  // Where an identifier's value is spelled (following imports), without evaluating it.
  locate(modName, id, hops = 0) {
    const mod = this.mod(modName);
    if (!mod || hops > 8) return null;
    const all = definitionsOf(mod, id);
    const imp = mod.imports.get(id);
    const defs = all.nested && imp ? [] : all.filter((d) => d.kind === 'value');
    if (defs.length) return defs.length === 1 ? { mod: modName, text: defs[0].text } : null;
    const from = imp && this.mod(imp.from);
    const local = from && from.exports.get(imp.name);
    return local === undefined || !from ? null : this.locate(imp.from, local, hops + 1);
  }
  // One top-level key of an object literal, looking through `...X` spreads of object literals
  // (the Monitor tool is `Ft({...De, ...})`, its name in De). -> { mod, text } or null.
  objectKey(modName, obj, key, depth = 0) {
    const parts = objectParts(obj);
    if (!parts) return null;
    for (const p of parts) {
      const k = KEY_RE(key).exec(p);
      if (k && k[1] === ':') return { mod: modName, text: p.slice(k[0].length).trim() };
    }
    if (depth > 4) return null;
    for (const p of parts) {
      const sp = /^\.\.\.([\w$]+)$/.exec(p);
      const loc = sp && this.locate(modName, sp[1]);
      if (!loc || loc.text[0] !== '{') continue;
      const r = this.objectKey(loc.mod, loc.text, key, depth + 1);
      if (r) return r;
    }
    return null;
  }
  // A builder call's (or a plain object's) tool, or null when the object names none.
  toolFromObject(modName, obj, seen, gate) {
    const nm = this.objectKey(modName, obj, 'name');
    if (!nm) return null;
    const nv = this.expr(nm.mod, nm.text, seen);
    if (nv.kind !== 'string') return UNKNOWN(`its name \`${nm.text}\` resolves to ${nv.kind}${nv.why ? ` (${nv.why})` : ''}`);
    const al = this.objectKey(modName, obj, 'aliases');
    let aliases = [];
    if (al && this.expr(al.mod, al.text, seen).kind !== 'null') {        // the Artifact head: aliases:void 0
      const els = al.text[0] === '[' ? splitTop(al.text.slice(1, -1)) : null;
      aliases = els ? els.map((el) => { const v = this.expr(al.mod, el, seen); return v.kind === 'string' ? v.value : null; }) : [null];
    }
    return { kind: 'tool', name: nv.value, aliases, gates: gate ? [gate] : [] };
  }
  // A function value, called with no arguments. Its body must be `if(C)return X` and `return X`
  // statements only: anything else is a function this scan does not read.
  call(v, seen) {
    if (v.kind === 'null') return { kind: 'null' };
    if (v.kind !== 'fn') return UNKNOWN(`a call of a ${v.kind}`);
    if (v.expr !== undefined) return this.expr(v.mod, v.expr, seen);
    const stmts = splitTop(v.body, ';');
    if (!stmts || !stmts.length) return UNKNOWN('a function body that does not lex');
    const items = [];
    for (const s of stmts) {
      let cond = null, ret = s;
      if (/^if\s*\(/.test(s)) {
        const m = masked(s);
        const open = s.indexOf('(');
        const close = closeOf(m, open);
        if (close < 0) return UNKNOWN(`a statement this scan does not read: ${s.slice(0, 80)}`);
        cond = s.slice(open + 1, close - 1);
        ret = s.slice(close).trim();
      }
      const r = /^return\b\s*/.exec(ret);
      if (!r) return UNKNOWN(`a function whose body is more than returns: ${s.slice(0, 80)}`);
      const rest = ret.slice(r[0].length);
      const val = rest === '' ? { kind: 'null' } : this.expr(v.mod, rest, seen);
      if (val.kind === 'unknown') return val;
      items.push(...(cond ? gated(val, `returned when ${cond}`) : toolsOf(val)));
    }
    return { kind: 'list', items };
  }
  expr(modName, text, seen, locals) {
    const t = text.trim();
    let m;
    if (t === 'null' || t === 'void 0' || t === 'undefined') return { kind: 'null' };
    if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return { kind: 'string', value: JSON.parse(t) };
    if (/^'(?:[^'\\]|\\.)*'$/.test(t)) return { kind: 'string', value: JSON.parse(`"${t.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`) };
    if (/^`[^`$\\]*`$/.test(t)) return { kind: 'string', value: t.slice(1, -1) };
    if (/^[\w$]+$/.test(t)) return this.ident(modName, t, seen, locals);
    if ((m = /^([\w$]+)\.([\w$]+)$/.exec(t))) {
      const mod = this.mod(modName);
      if (mod && mod.stars.has(m[1])) return this.exported(mod.stars.get(m[1]), m[2], seen);
      if (m[2] === 'name') {
        const base = this.ident(modName, m[1], seen, locals);
        return base.kind === 'tool' ? { kind: 'string', value: base.name } : UNKNOWN(`${t}: ${m[1]} is ${base.kind}`);
      }
      return UNKNOWN(`the member ${t}`);
    }
    const tm = masked(t);
    if (t[0] === '[' && closeOf(tm, 0) === t.length) {
      const els = splitTop(t.slice(1, -1));
      if (!els) return UNKNOWN('an array that does not lex');
      const items = [];
      for (const el of els) {
        const v = this.element(modName, el, seen, locals);
        if (v.kind === 'unknown') return v;
        items.push(...toolsOf(v));
      }
      return { kind: 'list', items };
    }
    if ((m = /^(?:async\s*)?(?:\(([^()]*)\)|([\w$]+))\s*=>\s*/.exec(t))) {
      const rest = t.slice(m[0].length);
      const params = (m[1] || m[2] || '').trim();
      if (rest[0] === '{' && closeOf(masked(rest), 0) === rest.length) return { kind: 'fn', mod: modName, params, body: rest.slice(1, -1) };
      return { kind: 'fn', mod: modName, params, expr: rest };
    }
    if (t[0] === '(') {
      const c = closeOf(tm, 0);
      if (c === t.length - 2 && t.endsWith('()')) return this.call(this.expr(modName, t.slice(1, c - 1), seen, locals), seen);
      if (c === t.length) {
        const parts = splitTop(t.slice(1, -1));
        return parts && parts.length ? this.expr(modName, parts[parts.length - 1], seen, locals) : UNKNOWN(`the sequence ${t.slice(0, 80)}`);
      }
    }
    if ((m = /^([\w$]+(?:\.[\w$]+)*)\(/.exec(t)) && closeOf(tm, m[0].length - 1) === t.length) {
      const callee = m[1];
      const argText = t.slice(m[0].length, -1);
      const args = splitTop(argText);
      if (!args) return UNKNOWN(`the call ${callee}(...) does not lex`);
      if (args.length && args[0][0] === '{') {
        const tool = this.toolFromObject(modName, args[0], seen);
        if (tool) return tool;
      }
      if (!args.length) return this.call(this.expr(modName, callee, seen, locals), seen);
      // A wrapper (the Artifact tool is `lr(HEAD, () => ArtifactTool)`): the one tool its
      // arguments resolve to, when they agree on one name.
      const found = [];
      for (const a of args) {
        let v = this.expr(modName, a, seen, locals);
        if (v.kind === 'fn' && v.params === '') v = this.call(v, seen);
        found.push(...toolsOf(v));
      }
      const names = [...new Set(found.map((x) => x.name))];
      return names.length === 1 ? { ...found[0], gates: [...found[0].gates, `through ${callee}(...)`] }
        : UNKNOWN(`the call ${callee}(...), whose arguments name ${names.length} tool(s)`);
    }
    if (t[0] === '{' && closeOf(tm, 0) === t.length) {
      const tool = this.toolFromObject(modName, t, seen);
      if (tool) return tool;
    }
    return UNKNOWN(`an expression this scan does not read: ${t.slice(0, 80)}`);
  }
  // One element of an array literal, possibly a spread.
  element(modName, el, seen, locals) {
    if (!el.startsWith('...')) return this.expr(modName, el, seen, locals);
    const body = el.slice(3).trim();
    const tern = splitTernary(body);
    if (tern) {
      if (/^[\w$]+$/.test(tern.cond) && this.ident(modName, tern.cond, seen, locals).kind === 'null') {
        return { kind: 'list', items: [] };      // `...X?[X]:[]` with X compiled out to null
      }
      const yes = this.expr(modName, tern.yes, seen, locals);
      if (yes.kind === 'unknown') return yes;
      const no = this.expr(modName, tern.no, seen, locals);
      if (no.kind === 'unknown') return no;
      return { kind: 'list', items: [...gated(yes, `when ${tern.cond}`), ...gated(no, `unless ${tern.cond}`)] };
    }
    const fm = /^([\s\S]*)\.filter\(/.exec(body);
    if (fm && closeOf(masked(body), fm[0].length - 1) === body.length) {
      const base = fm[1].trim();
      const opt = /^\(([\w$]+)\?\.\(\)\?\?\[\]\)$/.exec(base);         // (X?.()??[])
      const v = opt ? this.call(this.ident(modName, opt[1], seen, locals), seen) : this.expr(modName, base, seen, locals);
      if (v.kind === 'unknown') return v;
      return { kind: 'list', items: gated(v, `kept by .filter(${body.slice(fm[0].length, -1)})`) };
    }
    return this.expr(modName, body, seen, locals);
  }
}

// ==========================================================================
// THE REGISTRY
// ==========================================================================
const ANCHOR = /\{getAllBaseTools:([\w$]+),getTools:([\w$]+),assembleToolPool:([\w$]+)\}/g;
const MAP_RESULT = 'mapToolResultToToolResultBlockParam';
const JS_WORDS = new Set(['return', 'if', 'else', 'let', 'const', 'var', 'new', 'typeof', 'void', 'null', 'undefined',
  'true', 'false', 'function', 'async', 'await', 'this', 'in', 'of', 'for', 'while', 'do', 'switch', 'case', 'break',
  'continue', 'throw', 'try', 'catch', 'finally', 'instanceof', 'delete', 'yield', 'class', 'extends', 'super']);

// The names a function declares for itself: its parameters, and inside its body every
// let/const/var name (destructured ones included), arrow, function and catch parameter.
function localNames(params, body) {
  const own = new Set();
  const addPattern = (p) => { for (const n of p.replace(/=[\s\S]*$/, '').matchAll(/[A-Za-z_$][\w$]*/g)) own.add(n[0]); };
  const addList = (s) => { for (const p of (splitTop(s) || [])) addPattern(p.replace(/^\.\.\./, '')); };
  addList(params);
  const m = masked(body);
  for (const x of body.matchAll(/\b(?:let|const|var)\s+/g)) {
    if (!m.mask[x.index]) continue;
    const start = x.index + x[0].length;
    const end = endOf(m, start, ';');
    for (const p of (splitTop(body.slice(start, end < 0 ? body.length : end)) || [])) addPattern(p.replace(/\s+(?:of|in)\s[\s\S]*$/, ''));
  }
  for (const x of body.matchAll(/\(([^()]*)\)\s*=>|([\w$]+)\s*=>|\bfunction\s*[\w$]*\s*\(([^)]*)\)|\bcatch\s*\(([\w$]+)\)/g)) {
    if (!m.mask[x.index]) continue;
    if (x[2]) own.add(x[2]); else addList(x[1] ?? x[3] ?? x[4] ?? '');
  }
  return own;
}

// A function's body, whether a declaration or an arrow value.
function functionBody(R, modName, id) {
  const mod = R.mod(modName);
  const defs = definitionsOf(mod, id);
  if (defs.length !== 1) return null;
  const d = defs[0];
  if (d.kind === 'function') return { params: d.params, body: d.body };
  const v = R.expr(modName, d.text, new Set());
  return v.kind === 'fn' && v.body !== undefined ? { params: v.params, body: v.body } : null;
}

function extractRegistry(text) {
  const R = new Resolver(text);
  const findings = [];
  const tools = new Map();
  const counts = { 'getAllBaseTools': 0, 'getTools': 0, 'outside getAllBaseTools': 0 };
  const add = (t, source) => {
    const had = tools.get(t.name);
    if (had) { had.gates.push(...t.gates.filter((g) => !had.gates.includes(g))); return; }
    tools.set(t.name, { name: t.name, aliases: t.aliases, gates: [...t.gates], source });
    counts[source]++;
  };
  const note = (extra) => `${tools.size} tool(s): ${counts.getAllBaseTools} in getAllBaseTools, ${counts.getTools} added `
    + `by getTools, ${counts['outside getAllBaseTools']} registered outside getAllBaseTools${extra || ''}`;

  // 1. The anchor: the registry object's three property names, which a minifier keeps.
  const anchors = [];
  for (const [name, src] of R.modules) {
    if (!src.includes('getAllBaseTools:')) continue;
    const mod = R.mod(name);
    for (const x of src.matchAll(ANCHOR)) if (mod.m.mask[x.index]) anchors.push({ name, x });
  }
  if (anchors.length !== 1) {
    findings.push(`the tool registry's anchor ({getAllBaseTools:F,getTools:G,assembleToolPool:H}) was found `
      + `${anchors.length} time(s), not exactly once`);
    return { tools, findings, note: note() };
  }
  const { name: home, x: anchor } = anchors[0];

  // 2. getAllBaseTools: `let a=...,b=...;return[...]`, every element resolved.
  const base = functionBody(R, home, anchor[1]);
  const stmts = base && splitTop(base.body, ';');
  const ret = stmts && stmts.length && /^return\s*\[/.test(stmts[stmts.length - 1]) ? stmts[stmts.length - 1] : null;
  const locals = new Map();
  let shapeOk = !!ret;
  for (const s of (stmts || []).slice(0, -1)) {
    const dm = /^(?:let|const|var)\s+/.exec(s);
    const decls = dm && splitTop(s.slice(dm[0].length));
    if (!decls) { shapeOk = false; break; }
    for (const dcl of decls) { const a = /^([\w$]+)=([\s\S]+)$/.exec(dcl); if (a) locals.set(a[1], a[2]); else shapeOk = false; }
  }
  const arr = ret && ret.slice(ret.indexOf('['));
  const elements = shapeOk && arr && splitTop(arr.slice(1, -1));
  if (!elements) {
    findings.push(`getAllBaseTools (${anchor[1]}) is no longer \`let ...; return [...]\` in ${home}: re-derive this scan`);
    return { tools, findings, note: note() };
  }
  for (const el of elements) {
    const v = R.element(home, el, new Set(), locals);
    if (v.kind === 'unknown') {
      findings.push(`the carve's getAllBaseTools element \`${el}\` does not resolve to tools (${v.why}); `
        + 're-derive the resolver rather than leave a registered tool uncounted');
      continue;
    }
    for (const t of toolsOf(v)) add(t, 'getAllBaseTools');
  }

  // 3. getTools: a tool object it names that getAllBaseTools does not list joins the registry.
  const gt = functionBody(R, home, anchor[2]);
  if (!gt) findings.push(`getTools (${anchor[2]}) is not one function in ${home}: re-derive this scan`);
  else {
    const own = localNames(gt.params, gt.body);
    const gm = masked(gt.body);
    const seenIds = new Set();
    for (const x of gt.body.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*(?![\w$])/g)) {
      const id = x[0];
      if (!gm.mask[x.index] || own.has(id) || JS_WORDS.has(id) || seenIds.has(id)) continue;
      seenIds.add(id);
      const v = R.ident(home, id, new Set());
      for (const t of toolsOf(v)) if (!tools.has(t.name)) add({ ...t, gates: [...t.gates, 'added by getTools'] }, 'getTools');
    }
  }

  // 4. Outside getAllBaseTools: a builder call on an object with a top-level
  //    mapToolResultToToolResultBlockParam (the Tool interface's own method name), whose name
  //    resolves and whose binding something references (SubagentHandback, ObserverReport).
  const dead = [], computed = [];
  for (const [name, src] of R.modules) {
    if (!src.includes(MAP_RESULT)) continue;
    const mod = R.mod(name);
    for (const x of src.matchAll(/(?<![\w$.])([\w$]+)=([\w$]+)\(\{/g)) {
      if (!mod.m.mask[x.index]) continue;
      const open = x.index + x[0].length - 1;
      const close = closeOf(mod.m, open);
      if (close < 0) continue;
      const obj = src.slice(open, close);
      if (!obj.includes(MAP_RESULT)) continue;
      const parts = objectParts(obj);
      if (!parts || !parts.some((p) => KEY_RE(MAP_RESULT).test(p))) continue;
      const v = R.expr(name, `${x[2]}(${obj})`, new Set());
      if (v.kind !== 'tool') {
        // A factory's object (`l=Ft({name:e.name,...})`, e its parameter) has no name of its own: its
        // instances are registered, and counted, where they are made. Any other name that does not
        // resolve is a resolver gap, and a tool this scan would otherwise never count.
        const nm = R.objectKey(name, obj, 'name');
        const baseId = nm && /^([\w$]+)(?:\.[\w$]+)*$/.exec(nm.text);
        const local = baseId && /neither defined nor imported/.test(R.ident(nm.mod, baseId[1], new Set()).why || '');
        if (local) computed.push(`${x[1]}@${name}`);
        else {
          findings.push(`a tool object (${x[1]} in ${name}) outside getAllBaseTools has a name this scan cannot read `
            + `(${v.why || v.kind}); re-derive the resolver rather than leave a registered tool uncounted`);
        }
        continue;
      }
      if (tools.has(v.name)) continue;
      const uses = [...src.matchAll(new RegExp(`(?<![\\w$.])${esc(x[1])}(?![\\w$])`, 'g'))].filter((u) => mod.m.mask[u.index]);
      const exported = [...mod.exports.values()].includes(x[1]);
      if (uses.length > 1 || exported) add(v, 'outside getAllBaseTools');
      else dead.push(v.name);
    }
  }
  for (const [name, t] of tools) {
    if (t.aliases.includes(null)) findings.push(`${name}: an alias of this tool does not resolve to a string; re-derive the resolver`);
  }
  return { tools, findings, note: note(`; ${dead.length} dead tool object(s) (${dead.sort().join(', ') || 'none'}); `
    + `${computed.length} builder object(s) whose name is computed (a factory's)`) };
}

// ==========================================================================
// THE MODES, read from the carve
// ==========================================================================
const PERMISSION_ANCHOR = /Cannot set permission mode: must be one of \$\{([\w$]+)\.join\(/g;
const SANDBOX_ANCHOR = /\{enabled:[^{},]*,failIfUnavailable:[^{}]*?\.describe\("Exit with an error at startup if sandbox\.enabled is true/g;
const SHELLS_ANCHOR = /\?\[("\w+"(?:,"\w+")+)\]:\[("\w+"(?:,"\w+")+)\]\)\.flatMap\(/g;
const OPT_IN_SETTER = (method) => new RegExp(`function ([\\w$]+)\\(([\\w$]+)\\)\\{[\\w$.()]*\\.launchOptions\\.${method}\\(\\2\\)\\}`, 'g');
const OPT_INS = [['search', 'replaceSearchToolsOptIn'], ['todo', 'replaceTodoToolsOptIn']];

// Every match of `re` across the carve's modules, in code unless `code` is false: [{ name, x }].
function codeMatches(R, re, needle, code = true) {
  const out = [];
  for (const [name, src] of R.modules) {
    if (needle && !src.includes(needle)) continue;
    const mod = code ? R.mod(name) : null;
    for (const x of src.matchAll(re)) if (!code || mod.m.mask[x.index]) out.push({ name, x });
  }
  return out;
}
// The strings (or tool names) an array expression lists, following identifiers and spreads to
// their definitions; null, with why, when an element is not one.
function stringsOf(R, modName, text, depth = 0) {
  const t = text.trim();
  if (depth > 6) return { why: `${t.slice(0, 60)} nests too deep` };
  if (/^[\w$]+$/.test(t)) {
    const loc = R.locate(modName, t);
    return loc ? stringsOf(R, loc.mod, loc.text, depth + 1) : { why: `${t} has no one definition` };
  }
  if (t[0] !== '[' || closeOf(masked(t), 0) !== t.length) return { why: `${t.slice(0, 60)} is not an array` };
  const els = splitTop(t.slice(1, -1));
  if (!els) return { why: 'an array that does not lex' };
  const out = [];
  for (const el of els) {
    if (el.startsWith('...')) {
      const r = stringsOf(R, modName, el.slice(3), depth + 1);
      if (!r.list) return r;
      out.push(...r.list);
      continue;
    }
    const v = R.expr(modName, el, new Set());
    if (v.kind === 'string') out.push(v.value);
    else if (v.kind === 'tool') out.push(v.name);
    else return { why: `the element ${el} is ${v.kind}${v.why ? ` (${v.why})` : ''}` };
  }
  return { list: out };
}

function extractModes(text) {
  const R = new Resolver(text);
  const findings = [];
  const once = (hits, what) => {
    if (hits.length === 1) return hits[0];
    findings.push(`${what} was found ${hits.length} time(s) in the carve, not exactly once; re-derive the mode axis`);
    return null;
  };
  // Permission modes: the carve's own list of the modes --permission-mode takes.
  let permission = [];
  // (The anchor is template text, not code: read raw.)
  const p = once(codeMatches(R, PERMISSION_ANCHOR, 'Cannot set permission mode', false),
    'the permission-mode list (`Cannot set permission mode: must be one of ${X.join(...)}`)');
  if (p) {
    const r = stringsOf(R, p.name, p.x[1]);
    if (!r.list) findings.push(`the permission-mode list ${p.x[1]} does not resolve to strings (${r.why})`);
    else if (!r.list.includes('default')) findings.push(`the permission-mode list has no "default" (${r.list.join(', ')}): the baseline is gone`);
    else permission = r.list.filter((m) => m !== 'default').sort();
  }
  // The sandbox: enabled, and enabled with failIfUnavailable.
  const sandbox = once(codeMatches(R, SANDBOX_ANCHOR, 'failIfUnavailable'), 'the settings schema\'s sandbox object '
    + '({enabled, failIfUnavailable: "Exit with an error at startup if sandbox.enabled is true ..."})') ? ['on', 'required'] : [];
  // The Bash tool's shells, by name.
  let shells = [];
  const sh = once(codeMatches(R, SHELLS_ANCHOR, '.flatMap('), 'the Bash tool\'s shell discovery (`C?["bash","zsh"]:["zsh","bash"]).flatMap(`)');
  if (sh) {
    const a = JSON.parse(`[${sh.x[1]}]`).sort(), b = JSON.parse(`[${sh.x[2]}]`).sort();
    if (JSON.stringify(a) !== JSON.stringify(b)) findings.push(`the shell discovery's two orders name different shells (${a} / ${b})`);
    else shells = a;
  }
  // The opt-in tools: what each launch-option setter is handed `LIST.some(...)` of.
  const optIn = {};
  for (const [key, method] of OPT_INS) {
    optIn[key] = [];
    const setter = once(codeMatches(R, OPT_IN_SETTER(method), method), `the setter of launchOptions.${method}`);
    if (!setter) continue;
    const F = setter.x[1];
    const calls = codeMatches(R, new RegExp(`(?<![\\w$.])${esc(F)}\\(`, 'g'), `${F}(`)
      .filter(({ name, x }) => name !== setter.name || x.index !== setter.x.index + 'function '.length);
    const lists = [];
    for (const { name, x } of calls) {
      const mod = R.mod(name);
      const open = x.index + x[0].length - 1;
      const close = closeOf(mod.m, open);
      const arg = close < 0 ? '' : mod.src.slice(open + 1, close - 1);
      const sm = /^([\s\S]+)\.some\(/.exec(arg);
      if (!sm) continue;
      const r = stringsOf(R, name, sm[1]);
      if (!r.list) { findings.push(`the ${key} opt-in list ${sm[1]} does not resolve to tool names (${r.why})`); continue; }
      lists.push(r.list);
    }
    if (lists.length !== 1) findings.push(`the ${key} opt-in (${F}(LIST.some(...))) was called ${lists.length} time(s), not once`);
    else optIn[key] = [...new Set(lists[0])].sort();
  }
  const note = `modes from the carve: permission ${permission.join('/') || 'none'}; sandbox ${sandbox.join('/') || 'none'}; `
    + `shells ${shells.join('/') || 'none'}; opt-in ${Object.entries(optIn).map(([k, v]) => `${k} ${v.join('/') || 'none'}`).join(', ')}`;
  return { permission, sandbox, shells, optIn, findings, note };
}

// The cells' mode axis, from what the carve says. A mode `only` a tool has, or that a search
// opt-in tool lacks (`unlisted`).
const BASH = 'Bash';
function modeAxis(md) {
  return [
    { mode: 'print' },
    { mode: 'interactive' },
    { mode: 'unlisted', notOptIn: true },
    ...md.permission.map((m) => ({ mode: `permission:${m}` })),
    ...md.sandbox.map((s) => ({ mode: `sandbox:${s}`, only: BASH })),
    ...md.shells.map((s) => ({ mode: `shell:${s}`, only: BASH })),
  ];
}
function modesOf(tool, axis, optIn) {
  return axis.filter((a) => (!a.only || a.only === tool) && !(a.notOptIn && optIn.has(tool))).map((a) => a.mode);
}

// ==========================================================================
// THE DRIVERS
// ==========================================================================
// Skipped by name (counted as skipped, never read): each would read as drivers of tools it drives
// nothing of.
const DRIVER_SCAN_SKIP = new Map([
  ['test/build-gates/tool-coverage-gates.test.cjs', 'this gate: its fixtures are synthetic drivers of synthetic tools'],
  ['test/build-gates/live-checks-gates.test.cjs', "Task 1's gate: its unit tests run the control over synthetic "
    + 'tool calls that no mock ever scripts'],
]);
const EMITTER_OF = (use) => new RegExp(`(?<![\\w$.])(?:cannedToolUseSSE|toolUseSSE)\\s*\\(\\s*${esc(use)}\\.name\\b`, 'g');
const RULE_OF = (use) => new RegExp(`(?<![\\w$.])tool\\s*:\\s*${esc(use)}(?![\\w$.(])`, 'g');

function findDrivers(sources) {
  const drivers = [], rejected = [];
  let scanned = 0, skipped = 0;
  for (const { file, text } of sources) {
    if (DRIVER_SCAN_SKIP.has(file)) { skipped++; continue; }
    scanned++;
    if (!text.includes('assertFailsOnMissingOutput')) continue;
    const m = masked(text);
    const code = (re) => [...text.matchAll(re)].filter((x) => m.mask[x.index]);
    const lineOf = (i) => text.slice(0, i).split('\n').length;
    // The value of the nearest `const|let|var NAME = ...` (or `function NAME(...) {...}`) before
    // `pos`, else the first after it: { start, end }.
    const declOf = (name, pos) => {
      const hits = code(new RegExp(`(?<![\\w$.])(?:(?:const|let|var)\\s+${esc(name)}\\s*=(?!=)|function\\s*${esc(name)}\\s*\\()`, 'g'));
      const h = hits.filter((x) => x.index < pos).pop() || hits[0];
      if (!h) return null;
      if (h[0].startsWith('function')) {
        const po = h.index + h[0].length - 1;
        const pe = closeOf(m, po);
        const bo = pe < 0 ? -1 : text.indexOf('{', pe);
        const be = bo < 0 ? -1 : closeOf(m, bo);
        return be < 0 ? null : { start: h.index, end: be, fn: true };
      }
      const start = h.index + h[0].length;
      const end = endOf(m, start, ',;');
      return end < 0 ? null : { start, end };
    };
    const slice = (d) => text.slice(d.start, d.end).trim();
    for (const x of code(/(?<![\w$.])assertFailsOnMissingOutput\s*\(/g)) {
      if (/function\s*$/.test(text.slice(Math.max(0, x.index - 16), x.index))) continue;
      const at = { file, line: lineOf(x.index) };
      const open = x.index + x[0].length - 1;
      const close = closeOf(m, open);
      const args = close < 0 ? null : splitTop(text.slice(open + 1, close - 1));
      if (!args || (args.length !== 2 && args.length !== 3)) {
        rejected.push({ ...at, why: 'the control is not called as (check, toolUse[, modes])' });
        continue;
      }
      const [check, use, modesText] = args;
      const modes = modesText === undefined ? ['print'] : literalModes(modesText);
      if (!modes) {
        rejected.push({ ...at, why: `the modes (${modesText}) are not a string literal or an array of string literals` });
        continue;
      }
      if (!/^[\w$]+$/.test(use)) {
        rejected.push({ ...at, why: 'the tool_use is not a named object (an inline one cannot be the one the mock scripts)' });
        continue;
      }
      if (!/^[\w$]+$/.test(check)) { rejected.push({ ...at, why: 'the check is not a named function' }); continue; }
      // The tool_use object: its name (a string literal) and how its id is spelled.
      const ud = declOf(use, x.index);
      const obj = ud && slice(ud);
      const parts = obj && obj[0] === '{' ? objectParts(obj) : null;
      const part = (k) => { const p = parts && parts.find((q) => new RegExp(`^${k}\\s*:`).test(q)); return p ? p.replace(/^\w+\s*:\s*/, '') : null; };
      const nameText = part('name');
      const name = nameText && /^(['"])[^'"\\]*\1$/.test(nameText) ? nameText.slice(1, -1) : null;
      if (!name) { rejected.push({ ...at, why: `${use} is not declared in this file as { name: '<tool>', ... }` }); continue; }
      const idText = part('id');
      // The check must read the tool_result by that id: toolResult(Text)(x, USE.id) or (x, <its id>).
      const cd = declOf(check, x.index);
      const ids = new Set([`${use}.id`, ...(idText && /^(?:[\w$.]+|'[^']*'|"[^"]*")$/.test(idText) ? [idText] : [])]);
      const reads = cd && code(/(?<![\w$.])toolResult(?:Text)?\s*\(/g).some((r) => {
        if (r.index < cd.start || r.index >= cd.end) return false;
        const rc = closeOf(m, r.index + r[0].length - 1);
        const ra = rc < 0 ? null : splitTop(text.slice(r.index + r[0].length, rc - 1));
        return !!ra && ra.length === 2 && ids.has(ra[1]);
      });
      if (!reads) { rejected.push({ ...at, why: `the check (${check}) never reads the tool_result of ${use}.id` }); continue; }
      if (!scriptedIn(text, code, use)) {
        rejected.push({ ...at, why: `the check (${check}) reads the tool_result of ${use}.id, but ${use} is never scripted to a mock` });
        continue;
      }
      const ran = testsOf(text, m, code, x.index, lineOf);
      drivers.push({ ...at, name, use, check, modes, unmeasured: unmeasuredModes(text, modes, m),
        tests: ran.filter((t) => !t.nativeOnly).map(({ name: n, line }) => ({ name: n, line })),
        nativeOnly: ran.filter((t) => t.nativeOnly).map(({ name: n, line }) => ({ name: n, line })),
        skips: skipOf(text, m, code, x.index, lineOf) });
    }
  }
  return { drivers, rejected, scanned, skipped };
}

// A control's modes: 'mode' or ['mode', ...], string literals only. null when not.
function literalModes(t) {
  const one = (s) => (/^(['"])[\w:-]+\1$/.test(s) ? s.slice(1, -1) : null);
  if (t[0] !== '[') { const v = one(t); return v ? [v] : null; }
  const els = t.endsWith(']') ? splitTop(t.slice(1, -1)) : null;
  const vs = els && els.map(one);
  return vs && vs.length && vs.every(Boolean) ? [...new Set(vs)] : null;
}

// A DECLARED MODE, MEASURED (fix round 1): what a driver's file must spell, in code or a string
// (never only in a comment), for a declaration to count. Mechanical and per file, not per turn: it
// catches a literal that names a mode the file never sets up, not a turn that drops the flag.
//   permission:<m>       `--permission-mode` then <m> (or `--permission-mode=<m>`); bypassPermissions
//                        also `--dangerously-skip-permissions`
//   sandbox:on           a settings literal `sandbox: { ... enabled: true ... }`
//   sandbox:required     the same with `failIfUnavailable: true`
//   shell:<s>            SHELL set to a value spelling <s> (`SHELL: '/bin/bash'`, `SHELL: bash`, SHELL=bash)
// print, interactive and unlisted are not measured here (recorded in WHAT IT DOES NOT SEE).
function uncommented(text, m) {
  const out = text.split('');
  for (let i = 0; i < text.length; i++) {
    if (m.mask[i] || (i && !m.mask[i - 1])) continue;
    if (text[i] !== '/' || (text[i + 1] !== '/' && text[i + 1] !== '*')) continue;
    for (let j = i; j < text.length && !m.mask[j]; j++) if (out[j] !== '\n') out[j] = ' ';
  }
  return out.join('');
}
const SANDBOX_ON_LITERAL = /\bsandbox['"]?\s*:\s*\{[^{}]*\benabled['"]?\s*:\s*true\b[^{}]*\}/;
const MODE_EVIDENCE = (mode) => {
  const [axis, v] = mode.split(':');
  if (axis === 'permission') {
    const flag = new RegExp(`--permission-mode['"]?(?:\\s*,\\s*['"]|=|\\s+)${esc(v)}\\b`);
    return { what: `--permission-mode ${v}${v === 'bypassPermissions' ? ' or --dangerously-skip-permissions' : ''}`,
      test: (t) => flag.test(t) || (v === 'bypassPermissions' && t.includes('--dangerously-skip-permissions')) };
  }
  if (mode === 'sandbox:on') return { what: 'a sandbox settings literal with enabled: true', test: (t) => SANDBOX_ON_LITERAL.test(t) };
  if (mode === 'sandbox:required') {
    return { what: 'a sandbox settings literal with enabled: true and failIfUnavailable: true',
      test: (t) => [...t.matchAll(new RegExp(SANDBOX_ON_LITERAL.source, 'g'))].some((x) => /\bfailIfUnavailable['"]?\s*:\s*true\b/.test(x[0])) };
  }
  if (axis === 'shell') {
    const set = new RegExp(`\\bSHELL['"]?\\s*[:=]\\s*[^,;\\n}]*\\b${esc(v)}\\b`);
    return { what: `SHELL set to ${v}`, test: (t) => set.test(t) };
  }
  return null;
};
// The declared modes the file gives no evidence of: [{ mode, what }].
function unmeasuredModes(text, modes, m = masked(text)) {
  const t = uncommented(text, m);
  return modes.map((mode) => ({ mode, ev: MODE_EVIDENCE(mode) })).filter((x) => x.ev && !x.ev.test(t))
    .map((x) => ({ mode: x.mode, what: x.ev.what }));
}

// The tests that run the control at `pos`, as node:test reports them ({ name, line }): the
// innermost test(...)/it(...) holding it; or, when none does, every test that calls the top-level
// function holding it (one level: agentic-grep-glob's controls()). [] when neither.
function testsOf(text, m, code, pos, lineOf) {
  const calls = code(/(?<![\w$.])(?:test|it)(?:\.\w+)?\s*\(/g).map((t) => {
    const open = t.index + t[0].length - 1;
    const close = closeOf(m, open);
    const first = close < 0 ? null : (splitTop(text.slice(open + 1, close - 1)) || [])[0];
    const lit = first && /^(['"`])([\s\S]*)\1$/.exec(first);
    const name = lit && !(lit[1] === '`' && lit[2].includes('${')) ? lit[2].replace(/\\(['"`\\])/g, '$1') : null;
    // A test whose code spells quaudeSkip runs its turn on native alone (test/tool-driver.cjs).
    const nativeOnly = close > 0 && [...text.slice(t.index, close).matchAll(/(?<![\w$.])quaudeSkip\b/g)]
      .some((q) => m.mask[t.index + q.index]);
    return { start: t.index, end: close, name, line: lineOf(t.index), nativeOnly };
  }).filter((t) => t.end > 0);
  const holding = (p) => calls.filter((t) => t.start < p && p < t.end).sort((a, b) => b.start - a.start)[0];
  const own = holding(pos);
  if (own) return [{ name: own.name, line: own.line, nativeOnly: own.nativeOnly }];
  const fns = [
    ...code(/(?<![\w$.])function\s*\*?\s*([\w$]+)\s*\(/g),
    ...code(/(?<![\w$.])(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/g),
  ].map((f) => {
    const after = f.index + f[0].length;
    let end;
    if (f[0].endsWith('=>')) {          // an arrow: a block body, or an expression to its end
      const ws = /^\s*/.exec(text.slice(after))[0].length;
      end = text[after + ws] === '{' ? closeOf(m, after + ws) : endOf(m, after, ',;');
    } else {
      const pe = closeOf(m, after - 1);
      const bo = pe < 0 ? -1 : text.indexOf('{', pe);
      end = bo < 0 ? -1 : closeOf(m, bo);
    }
    return { name: f[1], start: f.index, end };
  }).filter((f) => f.start < pos && pos < f.end).sort((a, b) => b.start - a.start);
  const fn = fns[fns.length - 1];
  if (!fn) return [];
  const out = new Map();
  for (const c of code(new RegExp(`(?<![\\w$.])${esc(fn.name)}\\s*\\(`, 'g'))) {
    if (c.index === fn.start || (c.index > fn.start && c.index < fn.end)) continue;
    const t = holding(c.index);
    if (t) out.set(t.line, { name: t.name, line: t.line, nativeOnly: t.nativeOnly });
  }
  return [...out.values()].sort((a, b) => a.line - b.line);
}

// The mock scripts USE: `cannedToolUseSSE(USE.name, ...)` / `toolUseSSE(USE.name, ...)`, a mock
// rule `tool: USE`, or USE handed to a same-file function whose parameter is scripted that way
// (quaude-naude-updateguard's driveBashTurn(bin, DENY)).
function scriptedIn(text, code, use) {
  if (code(EMITTER_OF(use)).length || code(RULE_OF(use)).length) return true;
  for (const e of code(/(?<![\w$.])(?:cannedToolUseSSE|toolUseSSE)\s*\(\s*([\w$]+)\.name\b/g)) {
    const param = e[1];
    const defs = [
      ...code(/(?<![\w$.])function\s*\*?\s*([\w$]+)\s*\(([^)]*)\)/g),
      ...code(/(?<![\w$.])(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g),
    ];
    for (const d of defs) {
      const params = d[2].split(',').map((p) => p.replace(/=[\s\S]*$/, '').trim());
      const k = params.indexOf(param);
      if (k < 0) continue;
      for (const c of code(new RegExp(`(?<![\\w$.])${esc(d[1])}\\s*\\(`, 'g'))) {
        if (c.index === d.index || /function\s*$/.test(text.slice(Math.max(0, c.index - 16), c.index))) continue;
        const mm = masked(text);
        const cc = closeOf(mm, c.index + c[0].length - 1);
        const args = cc < 0 ? null : splitTop(text.slice(c.index + c[0].length, cc - 1));
        if (args && args[k] === use) return true;
      }
    }
  }
  return false;
}

// Can the driver skip on its own outcome? Inside a test(...)/it(...) call: a test declared skipped
// (`test.skip`, `test.todo`, a `{ skip }`/`{ todo }` option), or any skip( call AFTER the control
// (a precondition skip belongs before it). Outside one: a skip( call after the control, to the end
// of the top-level statement holding it. -> null, or why.
function skipOf(text, m, code, pos, lineOf) {
  let end = -1, declared = false;
  for (const t of code(/(?<![\w$.])(?:test|it)(\.\w+)?\s*\(/g)) {
    const open = t.index + t[0].length - 1;
    const close = closeOf(m, open);
    if (!(t.index < pos && pos < close) || (end >= 0 && close > end)) continue;
    end = close;
    const args = splitTop(text.slice(open + 1, close - 1)) || [];
    declared = t[1] === '.skip' || t[1] === '.todo'
      || args.slice(0, -1).some((a) => a[0] === '{' && (objectParts(a) || []).some((p) => /^(?:skip|todo)\s*:/.test(p)));
  }
  if (declared) return 'the test is declared skipped';
  if (end < 0) {
    let d = 0;
    for (let j = 0; j < pos; j++) if (m.mask[j]) { const c = text[j]; if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--; }
    for (end = pos; end < text.length && d > 0; end++) {
      if (!m.mask[end]) continue;
      const c = text[end];
      if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--;
    }
  }
  const s = code(/(?<![\w$])skip\s*\(/g).find((x) => x.index > pos && x.index < end);
  return s ? `a skip after the control, line ${lineOf(s.index)}` : null;
}

// ==========================================================================
// THE CI JOBS: where a driver actually runs, per engine
// ==========================================================================
// The jobs of .github/workflows/ci.yml, each job's own block of text (its key at two spaces), with
// comments stripped (a `#` at a line's start or after whitespace, YAML's and the shell's), so a
// comment that names a file or a flag never stands in for a step that runs it. A `#` inside a
// quoted string after a space is stripped too: that can only lose a match, never invent one.
const stripComments = (yaml) => yaml.replace(/(^|[ \t])#.*$/gm, '$1');
function jobBlocks(yaml) {
  const out = new Map();
  yaml = stripComments(yaml);
  const at = [...yaml.matchAll(/^ {2}([\w-]+):[ \t]*$/gm)];
  at.forEach((h, k) => out.set(h[1], yaml.slice(h.index, k + 1 < at.length ? at[k + 1].index : yaml.length)));
  return out;
}
// Which CELL_JOBS entries ci.yml really runs as a cell job: the job exists, downloads its engine's
// tjs artifact, runs its tests under the cell reporter, and checks them with CLODE_CELL_JOB=<job>.
// -> { valid: [entries], findings }
function checkJobs({ workflow, jobs, sources, engines }) {
  const findings = [];
  const valid = [];
  const blocks = jobBlocks(workflow || '');
  const files = new Set(sources.map((s) => s.file));
  const seen = new Set();
  for (const j of jobs) {
    if (seen.has(j.job)) { findings.push(`CELL_JOBS names ${j.job} twice; one entry per job`); continue; }
    seen.add(j.job);
    const why = [];
    if (!engines.includes(j.engine)) why.push(`its engine ${j.engine} is not a shipping engine (${engines.join(', ')})`);
    const b = blocks.get(j.job);
    if (!b) why.push('ci.yml has no such job');
    else {
      if (!b.includes(`name: tjs-${j.engine}`)) why.push(`it downloads no tjs-${j.engine} artifact`);
      if (!b.includes('test/cell-reporter.mjs')) why.push('it runs no test under test/cell-reporter.mjs');
      if (!new RegExp(`CLODE_CELL_JOB[=:]\\s*['"]?${esc(j.job)}['"]?(?![\\w-])`).test(b)) {
        why.push(`it never checks its cells (CLODE_CELL_JOB=${j.job} node --test ${posixRel(__filename)})`);
      }
    }
    if (why.length) { findings.push(`CELL_JOBS ${j.job} (${j.engine}) drives no cell: ${why.join('; ')}`); continue; }
    // A claimed file that is gone, or that the job's text never names, is a finding; the job's other
    // files still drive their cells. (Naming is the static half: the job's own check is what proves
    // the file's tests ran.)
    const kept = [];
    for (const f of j.files) {
      if (!files.has(f)) findings.push(`CELL_JOBS ${j.job} claims ${f}, which is not in the tree`);
      else if (!b.includes(f)) findings.push(`CELL_JOBS ${j.job} claims ${f}, which the job never names in ci.yml`);
      else kept.push(f);
    }
    valid.push({ ...j, files: kept });
  }
  return { valid, findings };
}

// ==========================================================================
// THE VERDICT
// ==========================================================================
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (s) => typeof s === 'string' && ISO_DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const EXEMPTION_KEYS = ['tool', 'modes', 'engines', 'reason', 'date', 'until'];
const PHASE_OF = (until) => PHASES.get(until) || null;
const cellsTag = (e) => `${e.modes ? ` x ${e.modes.join('/')}` : ''}${e.engines ? ` @ ${e.engines.join('/')}` : ''}`;

// The table's own shape, dates and expiry; needs no carve.
function checkExemptionTable(exemptions, today, { keys = EXEMPTION_KEYS, who: whoOf = (e) => e.tool } = {}) {
  const out = [];
  const count = new Map();
  exemptions.forEach((e, k) => {
    const name = whoOf(e);
    const who = typeof name === 'string' && name ? `${name}${cellsTag(e)}` : `exemption #${k + 1}`;
    const extra = Object.keys(e).filter((key) => !keys.includes(key));
    if (extra.length) out.push(`${who}: unknown key(s) ${extra.join(', ')}; an exemption is { ${keys.join(', ')} }`);
    for (const key of ['modes', 'engines']) {
      if (key in e && !(Array.isArray(e[key]) && e[key].length && e[key].every((v) => typeof v === 'string' && v))) {
        out.push(`${who}: ${key} must be a non-empty array of names (leave it out for all of them)`);
      }
    }
    if (typeof e.reason !== 'string' || !e.reason.trim()) out.push(`${who}: no reason; an exemption says why the cells are not driven`);
    const dOk = isIsoDate(e.date), uOk = isIsoDate(e.until);
    if (!dOk) out.push(`${who}: date "${e.date}" is not a YYYY-MM-DD date`);
    if (!uOk) out.push(`${who}: until "${e.until}" is not a YYYY-MM-DD date`);
    if (dOk && uOk && e.until < e.date) out.push(`${who}: until ${e.until} is before its date ${e.date}`);
    else if (uOk && today > e.until) {
      const phase = PHASE_OF(e.until);
      out.push(`${who}: its exemption expired on ${e.until}${phase ? ` (${phase}'s deadline)` : ''} (recorded ${e.date}: `
        + `"${e.reason}"); drive the cells, or renew the exemption with a new reason, date and until`);
    }
    count.set(who, (count.get(who) || 0) + 1);
  });
  for (const [who, n] of count) if (n > 1) out.push(`${who}: exempted ${n} times; one entry per set of cells`);
  return out;
}

const cellKey = (tool, mode, engine) => `${tool}|${mode}|${engine}`;

function scanCoverage({ carve, what, sources, exemptions, today, workflow, jobs, engines, published, enginesExemption }) {
  const reg = extractRegistry(carve);
  const md = extractModes(carve);
  const { tools } = reg;
  const findings = [...reg.findings, ...md.findings];
  const byAlias = new Map();
  for (const [name, t] of tools) for (const a of t.aliases) if (a) byAlias.set(a, name);

  // The engines: the shipping three are published run-targets; every other one is exempted.
  for (const e of engines) if (!published.includes(e)) findings.push(`${e}: a shipping engine that scripts/tjs-legs.mjs does not publish`);
  findings.push(...checkExemptionTable([enginesExemption], today, { keys: ['engines', 'reason', 'date', 'until'],
    who: () => 'every other published engine' }).map((f) => f.replace(/ @ [^:]*:/, ':')));
  const others = published.filter((e) => !engines.includes(e));

  // The cells.
  const axis = modeAxis(md);
  const optIn = new Set(md.optIn.search);
  const modesByTool = new Map([...tools.keys()].map((t) => [t, modesOf(t, axis, optIn)]));
  let cells = 0;
  for (const ms of modesByTool.values()) cells += ms.length * engines.length;

  // The drivers, and the jobs that run them.
  const d = findDrivers(sources);
  const jb = checkJobs({ workflow, jobs, sources, engines });
  findings.push(...jb.findings);
  const driven = new Map();                      // cellKey -> [{ driver, job }]
  const foreign = [];
  const declared = new Map();                    // tool -> drivers
  for (const x of d.drivers) {
    const name = tools.has(x.name) ? x.name : byAlias.get(x.name);
    if (!name) { foreign.push(x); continue; }
    if (!declared.has(name)) declared.set(name, []);
    declared.get(name).push(x);
    const own = modesByTool.get(name);
    const bad = x.modes.filter((mo) => !own.includes(mo));
    if (bad.length) findings.push(`${x.file}:${x.line}: declares ${bad.join(', ')} for ${name}, not among its cells' modes (${own.join(', ')})`);
    for (const u of x.unmeasured) {
      findings.push(`${x.file}:${x.line}: declares ${u.mode} for ${name}, but the file never spells ${u.what} (outside a comment); `
        + 'that cell is not driven by it');
    }
    const unmet = new Set(x.unmeasured.map((u) => u.mode));
    for (const j of jb.valid) {
      if (!j.files.includes(x.file)) continue;
      if (!x.tests.length) {
        findings.push(`${x.file}:${x.line}: ${j.job} claims this driver of ${name}, but no test(...) runs its control`
          + `${x.nativeOnly.length ? ` on quaude (test(s) at line ${x.nativeOnly.map((n) => n.line).join(', ')} spell quaudeSkip: native alone)` : ''}, so the job `
          + 'cannot report that it ran');
        continue;
      }
      for (const mo of x.modes) {
        if (!own.includes(mo) || unmet.has(mo)) continue;
        const k = cellKey(name, mo, j.engine);
        if (!driven.has(k)) driven.set(k, []);
        driven.get(k).push({ driver: x, job: j.job });
      }
    }
  }
  for (const j of jb.valid) {
    for (const f of j.files) if (!d.drivers.some((x) => x.file === f)) findings.push(`CELL_JOBS ${j.job} claims ${f}, which holds no driver`);
  }

  // The exemptions, per cell.
  findings.push(...checkExemptionTable(exemptions, today));
  const exempt = new Map();                      // cellKey -> entry
  for (const e of exemptions) {
    if (typeof e.tool !== 'string') continue;
    if (!tools.has(e.tool)) {
      if (byAlias.has(e.tool)) findings.push(`${e.tool}: exempted, but ${e.tool} is an alias of ${byAlias.get(e.tool)}; exempt the tool by its name`);
      else if (tools.size) findings.push(`${e.tool}: exempted, but the carve does not register a tool of that name (${what}); remove the exemption`);
      continue;
    }
    const own = modesByTool.get(e.tool);
    const ms = Array.isArray(e.modes) ? e.modes : own;
    const es = Array.isArray(e.engines) ? e.engines : engines;
    const badM = ms.filter((mo) => !own.includes(mo)), badE = es.filter((en) => !engines.includes(en));
    if (badM.length || badE.length) {
      findings.push(`${e.tool}${cellsTag(e)}: exempts ${[...badM, ...badE].join(', ')}, not among its cells (modes ${own.join(', ')}; `
        + `engines ${engines.join(', ')})`);
    }
    for (const mo of ms) {
      for (const en of es) {
        if (!own.includes(mo) || !engines.includes(en)) continue;
        const k = cellKey(e.tool, mo, en);
        if (exempt.has(k)) findings.push(`${e.tool} x ${mo} @ ${en}: exempted by two entries; one entry per cell`);
        else exempt.set(k, e);
      }
    }
  }

  // The verdict, cell by cell; undriven, unexempted cells reported one line per tool x mode.
  const where = (xs) => [...new Set(xs.map((x) => `${x.job}: ${x.driver.file}:${x.driver.line}`))].sort().join(', ');
  let nDriven = 0, nExempt = 0, nNone = 0;
  const matrix = [];
  for (const name of [...tools.keys()].sort()) {
    const rows = [];
    for (const mo of modesByTool.get(name)) {
      const none = [], states = [];
      for (const en of engines) {
        const k = cellKey(name, mo, en);
        const dv = driven.get(k), e = exempt.get(k);
        if (dv) {
          nDriven++;
          states.push(`${en} DRIVEN (${[...new Set(dv.map((x) => x.job))].join(', ')})`);
          if (e) findings.push(`${name} x ${mo} @ ${en}: exempted (${e.date}, until ${e.until}) but driven by ${where(dv)}; narrow the exemption`);
        } else if (e) {
          nExempt++;
          states.push(`${en} ${today > e.until ? 'EXPIRED' : 'exempt'} until ${e.until}`);
        } else {
          nNone++;
          none.push(en);
          states.push(`${en} NONE`);
        }
      }
      if (none.length) {
        findings.push(`${name} x ${mo}: on ${none.join(', ')} no CI job drives it (CELL_JOBS) and no exemption covers it`);
      }
      rows.push({ mode: mo, states });
    }
    const whole = rows.every((r) => r.states.every((s) => / exempt(?:ed)? until | EXPIRED until /.test(s)))
      && new Set(rows.flatMap((r) => r.states.map((s) => s.replace(/^\S+ /, '')))).size === 1;
    if (whole && !declared.has(name)) matrix.push(`${name}: every cell ${rows[0].states[0].replace(/^\S+ /, '')}`);
    else for (const r of rows) matrix.push(`${name} x ${r.mode}: ${r.states.join('; ')}`);
  }
  const files = new Set(d.drivers.map((x) => x.file)).size;
  return { findings, examined: cells, tools, drivers: d, declared, driven, foreign, matrix, jobs: jb.valid,
    note: `${what}: ${reg.note}; ${md.note}; ${cells} cell(s) over ${engines.join(', ')} (${others.length} other published `
      + `engine(s) exempted as one): ${nDriven} driven, ${nExempt} exempted, ${nNone} neither; ${jb.valid.length} CI job(s) `
      + `report cells; ${d.drivers.length} driver(s) in ${files} file(s), ${d.scanned + d.skipped} file(s) scanned, `
      + `${d.skipped} of them skipped by name` };
}

// ==========================================================================
// THE JOB'S OWN RUN: did every claimed driver's test pass, in this job, on this engine?
// ==========================================================================
// `records`: what test/cell-reporter.mjs wrote ({ type, file (repo-relative), line, name, skip,
// todo }); `host`: { platform, arch } of the job's runner. -> { findings, examined, ran }
const ENGINE_HOST = (engine) => {
  const [os, arch] = engine.split('-');
  return { platform: os, arch };
};
function checkJobRan({ job, jobs, sources, records, host }) {
  const findings = [];
  const entry = jobs.find((j) => j.job === job);
  if (!entry) return { findings: [`CLODE_CELL_JOB=${job} is not a job CELL_JOBS names (${jobs.map((j) => j.job).join(', ')})`], examined: 0, ran: [] };
  const want = ENGINE_HOST(entry.engine);
  if (host.platform !== want.platform || host.arch !== want.arch) {
    findings.push(`${job} claims ${entry.engine}, but runs on ${host.platform}-${host.arch}`);
  }
  const d = findDrivers(sources.filter((s) => entry.files.includes(s.file)));
  // A test reported more than once (two runs of the file in one job) passed only if every report did.
  const outcomes = new Map();
  for (const r of records) {
    const k = `${r.file}:${r.line}`;
    const o = r.type === 'test:fail' ? 'failed' : r.skip !== undefined ? `skipped (${r.skip})` : r.todo !== undefined ? `todo (${r.todo})` : 'passed';
    outcomes.set(k, [...(outcomes.get(k) || []), o]);
  }
  const result = new Map([...outcomes].map(([k, os]) => [k, os.find((o) => o !== 'passed') || 'passed']));
  const ran = [];
  for (const f of entry.files) if (!d.drivers.some((x) => x.file === f)) findings.push(`${f}: claimed by ${job}, but holds no driver`);
  // A FAILED or unreported test is always a finding. A SKIPPED one is a finding unless every cell its
  // driver declares is driven by another driver whose tests all passed in this job: a test that
  // judges one branch of a host fact (agentic-sandbox-fail-closed's fail-closed and D2 tests) skips
  // where the other branch applies, and the cell is still judged; the fail-closed test's sandbox:on
  // controls have no such twin, so its skip fails the job.
  const judged = d.drivers.filter((x) => x.tests.length).map((x) => ({ x,
    bad: x.tests.map((t) => [t, result.get(`${x.file}:${t.line}`) || 'not run']).filter(([, o]) => o !== 'passed') }));
  const passedCells = new Set();
  for (const { x, bad } of judged) if (!bad.length) for (const mo of x.modes) passedCells.add(`${x.name}|${mo}`);
  for (const x of d.drivers) if (!x.tests.length) findings.push(`${x.file}:${x.line}: no test(...) runs this ${x.name} control, so nothing reports it`);
  for (const { x, bad } of judged) {
    const tag = `${x.file}:${x.line} (${x.name} x ${x.modes.join('/')} @ ${entry.engine})`;
    if (!bad.length) { ran.push(`${x.name} x ${x.modes.join('/')} @ ${entry.engine} <- ${x.file}:${x.line}`); continue; }
    const onlySkips = bad.every(([, o]) => o.startsWith('skipped'));
    const alone = x.modes.filter((mo) => !passedCells.has(`${x.name}|${mo}`));
    if (onlySkips && !alone.length) continue;
    findings.push(`${tag}: ${bad.map(([t, o]) => `test "${t.name}" (line ${t.line}) ${o}`).join('; ')} in ${job}; a cell is driven `
      + `only where its test passes${onlySkips ? ` (no other passing test here drives ${alone.map((mo) => `${x.name} x ${mo}`).join(', ')})` : ''}`);
  }
  const cells = [...new Set(ran)];
  return { findings, examined: d.drivers.length, ran: cells,
    note: `${job} on ${entry.engine}: ${cells.length} of ${d.drivers.length} claimed driver(s) ran (${cells.join('; ') || 'none'})` };
}

// ==========================================================================
// THE EXEMPTIONS: the undriven cells, as a dated to-do list
// ==========================================================================
// Measured 2026-09-28 on the 2.1.283 carves (darwin-arm64 and linux-amd64 register the same 90
// tools): 87 in getAllBaseTools, none added by getTools, and 3 registered outside it
// (SubagentHandback, ObserverReport, and the MCP template `mcp`). Measured 2026-11-18 on the
// darwin-arm64 2.1.283 carve, those 90 tools have 722 tool x mode pairs (87 with the 8 common
// modes, Glob and Grep 7 without `unlisted`, Bash 12 with sandbox:on/required and shell:bash/zsh),
// so 2166 cells over the three shipping engines. Less is BROKEN until someone re-measures.
const CELL_FLOOR = 2166;
// The engines a release claims (observability plan Task 1): each a cell column.
const SHIPPING_ENGINES = ['darwin-arm64', 'linux-x64-musl', 'netbsd-arm64'];
// Each gate below is read from the tool's registry element or its isEnabled() in that carve.
// THE DEADLINES are the every-tool plan's phases (.superpowers/sdd/2026-09-28-every-tool-driven,
// design "Phases and deadlines"; its ledger's ruling E1 set Phase A's), carried here as set, never
// re-dated by this file except by the user's ruling: Phase A (the 18 local tools, before the
// release) 2026-10-15, MOVED to 2026-12-15 by USER RULING 2026-11-18 (it lapsed unmet; the ruling
// also gives the 117 cells that were neither driven nor exempted when this gate first counted cells
// a Phase A exemption to the same date, PHASE_A_CELLS below: every-tool Phase A drives them), Phase B
// (24 tools with their own needs; 23 are listed by name there, and they are these) 2026-11-30,
// Phase C (claude.ai, remote, MCP, and WebSearch) 2026-12-31. The 13 tools the plan puts in no
// phase (9 runner operators, 4 relay stubs) keep the quarterly re-decision UNTIL_REVIEW they had.
// A lapsed phase is a finding by name, and the user re-dates it. (Grep and Glob were exempted here
// until the grep-native plan's Task 11 drove them, 2026-10-05: test/fidelity/agentic-grep-glob.test.cjs,
// every output mode against native, and agentic-tools' Grep rows, which no longer skip.)
const RECORDED = '2026-09-28';
const UNTIL_PHASE_A = '2026-12-15';          // was 2026-10-15; USER RULING 2026-11-18
const UNTIL_PHASE_B = '2026-11-30';
const UNTIL_PHASE_C = '2026-12-31';
const UNTIL_REVIEW = '2026-12-31';
const PHASES = new Map([[UNTIL_PHASE_A, 'every-tool Phase A'], [UNTIL_PHASE_B, 'every-tool Phase B'],
  [UNTIL_PHASE_C, 'every-tool Phase C (or the quarterly review)']]);
// Every published engine but the three: one entry, outside the matrix (no cell is counted for
// them, and a job run on one is not a cell job). Recorded with this gate; its until is the
// quarterly re-decision the table already uses.
const OTHER_ENGINES_EXEMPTION = { engines: ['*'], reason: 'not a shipping engine: the release claims darwin-arm64, '
  + 'linux-x64-musl and netbsd-arm64 (observability plan Task 1); the others are build legs whose fidelity tier '
  + 'scripts/tjs-legs.mjs records, and no job here drives a tool on them as a cell', date: '2026-11-18', until: UNTIL_REVIEW };
// THE JOBS that drive cells: each runs its files' tests under test/cell-reporter.mjs on its engine,
// then this file with CLODE_CELL_JOB=<job> (checkJobRan). Measured before claiming: each file's
// drivers pass, never skip, in that job (its own skip-count assertion, or its step's comment).
const CELL_JOBS = [
  { job: 'node-shim-oracle', engine: 'linux-x64-musl', files: ['test/node-shim-agentic.test.cjs'] },
  { job: 'node-shim-oracle-darwin', engine: 'darwin-arm64', files: ['test/node-shim-agentic.test.cjs'] },
  { job: 'native-builder-oracle', engine: 'linux-x64-musl', files: ['test/clode-native.test.cjs'] },
  { job: 'linux-x64-pty', engine: 'linux-x64-musl', files: ['test/quaude-build.test.cjs',
    'test/fidelity/agentic-grep-glob.test.cjs', 'test/fidelity/agentic-sandbox-fail-closed.test.cjs',
    'test/fidelity/tools-local.test.cjs'] },
];
const LOCAL = 'deferred, no plan yet: it runs on this machine, so a canned-mock turn could drive it, and no live check '
  + 'judges its tool_result';
const INTERACTIVE = 'deferred, no plan yet: disabled in a non-interactive (-p) session without a permission-prompt tool, '
  + 'which is how every live check runs, so a driver needs a pty turn (test/e2e-pty.cjs)';
const FLAG_OFF = (flag, what) => `deferred, no plan yet: ${what}, enabled only by the GrowthBook flag ${flag} (default off), `
  + 'which a canned mock does not serve';
const CLAUDE_AI = (what) => `deferred, no plan yet: ${what}; a claude.ai feature, gated on account, organisation-policy or `
  + 'session state that no live check reproduces under a canned mock';
const REMOTE = (what) => `deferred, no plan yet: ${what}; enabled only in a remote or bridged session (CLAUDE_CODE_REMOTE, `
  + 'a REPL bridge, a remote environment), which a local mock turn is not';
const MCP = (what) => `deferred, no plan yet: ${what}; needs a connected MCP server, and the one MCP live check `
  + '(test/fidelity/agentic-mcp-ws.test.cjs) is skipped (MCP_WS_DEFERRED)';
const RUNNER = 'deferred, no plan yet: a self-hosted runner operator tool, registered only with the '
  + 'wizardOperatorToolsEnabled launch option';
const RELAY = (what) => `deferred, no plan yet: a relay stub that asks the user to enable ${what}; enabled only with a `
  + 'device relay, which no live check sets up';
// The cells of the driven tools that no job drives yet (USER RULING 2026-11-18, above): every cell of
// `tool` in `modes` but the `driven` ones (`mode@engine`), as per-cell Phase A exemptions, recorded
// the day of the ruling. The modes are the 2.1.283 carve's (THE MODES); a mode the carve drops, or a
// cell a job starts driving, is a finding here, so this list narrows as Phase A lands.
const COMMON_MODES = ['print', 'interactive', 'unlisted', 'permission:acceptEdits', 'permission:auto',
  'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan'];
const SEARCH_MODES = COMMON_MODES.filter((mo) => mo !== 'unlisted');
const BASH_MODES = [...COMMON_MODES, 'sandbox:on', 'sandbox:required', 'shell:bash', 'shell:zsh'];
const PHASE_A_CELL = 'every-tool Phase A (cells): not yet driven in this mode on this engine. The tool is driven '
  + 'only where CELL_JOBS says (a -p turn in the default mode on linux-x64-musl and darwin-arm64, plus the sandbox, '
  + 'bash and bypassPermissions rows on musl); no driver yet runs it interactively, unlisted, in the other permission '
  + 'modes, with sandbox.failIfUnavailable or under zsh, and no CI job runs a quaude on netbsd-arm64';
const PHASE_A_CELLS = (tool, modes, driven, reason = PHASE_A_CELL) => modes.flatMap((mode) => {
  const engines = SHIPPING_ENGINES.filter((en) => !driven.includes(`${mode}@${en}`));
  if (!engines.length) return [];
  return [{ tool, modes: [mode], ...(engines.length < SHIPPING_ENGINES.length ? { engines } : {}), reason,
    date: '2026-11-18', until: UNTIL_PHASE_A }];
});
const LOCAL_CELLS = 'every-tool Phase A (cells): driven only in a -p turn in the default mode on linux-x64-musl '
  + '(test/fidelity/tools-local.test.cjs, in linux-x64-pty: the one job with both a built quaude and a native that runs; '
  + 'node-shim-oracle-darwin stages a minimised carve that cannot run as native); no driver yet runs it interactively, '
  + 'unlisted or in the other permission modes, and no CI job runs a quaude on darwin-arm64 against a running native or '
  + 'on netbsd-arm64';
const EXEMPTIONS = [
  // The undriven cells of the five driven tools (USER RULING 2026-11-18).
  ...PHASE_A_CELLS('Agent', COMMON_MODES, [], 'every-tool Phase A (cells): its one driver, '
    + 'test/fidelity/agentic-subagent-diff.test.cjs, runs in no CI job (CELL_JOBS), so no cell of it is driven; Phase A '
    + 'puts it in one, and the other modes and netbsd-arm64 follow as for every tool'),
  ...PHASE_A_CELLS('Bash', BASH_MODES, ['print@darwin-arm64', 'print@linux-x64-musl', 'permission:bypassPermissions@linux-x64-musl',
    'sandbox:on@linux-x64-musl', 'shell:bash@linux-x64-musl']),
  ...PHASE_A_CELLS('Edit', COMMON_MODES, ['print@darwin-arm64', 'print@linux-x64-musl']),
  ...PHASE_A_CELLS('Glob', SEARCH_MODES, ['print@linux-x64-musl']),
  ...PHASE_A_CELLS('Grep', SEARCH_MODES, ['print@linux-x64-musl']),
  // Read, Write and NotebookEdit: driven in a -p turn on linux-x64-musl (test/fidelity/tools-local.test.cjs, every-tool
  // Task 2, judged against native in linux-x64-pty, the one job with a built quaude and a native that runs). Their
  // other cells are the Phase A remainder, as for the five above.
  ...PHASE_A_CELLS('Read', COMMON_MODES, ['print@linux-x64-musl'], LOCAL_CELLS),
  ...PHASE_A_CELLS('Write', COMMON_MODES, ['print@linux-x64-musl'], LOCAL_CELLS),
  ...PHASE_A_CELLS('NotebookEdit', COMMON_MODES, ['print@linux-x64-musl'], LOCAL_CELLS),
  // Local tools a canned mock could drive today: the to-do list proper.
  { tool: 'TaskStop', reason: `${LOCAL} (it stops a background task; aliases KillShell, KillBash)`, date: RECORDED, until: UNTIL_PHASE_A },
  { tool: 'TaskCreate', reason: `${LOCAL} (the task list; registered unless CLAUDE_CODE_ENABLE_TASKS=false)`, date: RECORDED, until: UNTIL_PHASE_A },
  { tool: 'TaskGet', reason: `${LOCAL} (the task list; registered unless CLAUDE_CODE_ENABLE_TASKS=false)`, date: RECORDED, until: UNTIL_PHASE_A },
  { tool: 'TaskUpdate', reason: `${LOCAL} (the task list; registered unless CLAUDE_CODE_ENABLE_TASKS=false)`, date: RECORDED, until: UNTIL_PHASE_A },
  { tool: 'TaskList', reason: `${LOCAL} (the task list; registered unless CLAUDE_CODE_ENABLE_TASKS=false)`, date: RECORDED, until: UNTIL_PHASE_A },
  { tool: 'TodoWrite', reason: 'deferred, no plan yet: a local tool, but enabled only when the Task* tools are off '
    + '(CLAUDE_CODE_ENABLE_TASKS=false), and no live check turns them off', date: RECORDED, until: UNTIL_PHASE_B },
  { tool: 'Skill', reason: `${LOCAL} (it needs a skill on disk)`, date: RECORDED, until: UNTIL_PHASE_A },
  { tool: 'EnterWorktree', reason: `${LOCAL} (it needs a git repository)`, date: RECORDED, until: UNTIL_PHASE_A },
  { tool: 'ExitWorktree', reason: `${LOCAL} (it needs a git repository)`, date: RECORDED, until: UNTIL_PHASE_A },
  { tool: 'CronCreate', reason: `${LOCAL} (scheduled prompts; on unless CLAUDE_CODE_DISABLE_CRON, GrowthBook `
    + 'tengu_kairos_cron defaults on)', date: RECORDED, until: UNTIL_PHASE_A },
  { tool: 'CronDelete', reason: `${LOCAL} (scheduled prompts; on unless CLAUDE_CODE_DISABLE_CRON, GrowthBook `
    + 'tengu_kairos_cron defaults on)', date: RECORDED, until: UNTIL_PHASE_A },
  { tool: 'CronList', reason: `${LOCAL} (scheduled prompts; on unless CLAUDE_CODE_DISABLE_CRON, GrowthBook `
    + 'tengu_kairos_cron defaults on)', date: RECORDED, until: UNTIL_PHASE_A },
  { tool: 'ScheduleWakeup', reason: `${LOCAL} (the dynamic /loop's pacing)`, date: RECORDED, until: UNTIL_PHASE_A },
  { tool: 'ReportFindings', reason: `${LOCAL} (structured code-review findings)`, date: RECORDED, until: UNTIL_PHASE_A },
  { tool: 'Workflow', reason: `${LOCAL} (alias RunWorkflow)`, date: RECORDED, until: UNTIL_PHASE_A },
  { tool: 'ListAgents', reason: `${LOCAL} (agent teams, on by default; an empty list is still a tool_result; alias `
    + 'ListPeers)', date: RECORDED, until: UNTIL_PHASE_A },
  { tool: 'SendMessage', reason: 'deferred, no plan yet: agent teams; a driver needs a teammate session to address',
    date: RECORDED, until: UNTIL_PHASE_B },
  { tool: 'SubagentHandback', reason: 'deferred, no plan yet: registered outside getAllBaseTools, for a subagent to '
    + 'report back with; agentic-subagent-diff drives Agent, but its subagent answers in text and never calls this tool',
    date: RECORDED, until: UNTIL_PHASE_B },
  { tool: 'ObserverReport', reason: 'deferred, no plan yet: registered outside getAllBaseTools, for an observer agent only',
    date: RECORDED, until: UNTIL_PHASE_B },
  { tool: 'LSP', reason: "deferred, no plan yet: code intelligence through a configured language server (a plugin's LSP), "
    + 'which no live check sets up', date: RECORDED, until: UNTIL_PHASE_B },
  { tool: 'PowerShell', reason: 'deferred, no plan yet: registered on Windows (without Git Bash, or by the GrowthBook flag '
    + 'tengu_cobalt_ridge) or by CLAUDE_CODE_USE_POWERSHELL_TOOL, and needs PowerShell; no live check runs on the Windows '
    + 'legs', date: RECORDED, until: UNTIL_PHASE_B },
  { tool: 'WebFetch', reason: 'deferred, no plan yet: it fetches a URL and asks the model to read the page, so a driver '
    + 'needs a local HTTP server and a mock that answers that second request', date: RECORDED, until: UNTIL_PHASE_B },
  { tool: 'WebSearch', reason: "deferred, no plan yet: the search runs server-side (the API's web_search tool, for "
    + 'first-party and some cloud providers), so a canned mock would have to answer as that server tool',
    date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'ToolSearch', reason: 'deferred, no plan yet: registered only in tool-search mode (ENABLE_TOOL_SEARCH, or a '
    + 'first-party endpoint that defers tools)', date: RECORDED, until: UNTIL_PHASE_B },
  // Off in every -p turn.
  { tool: 'AskUserQuestion', reason: INTERACTIVE, date: RECORDED, until: UNTIL_PHASE_B },
  { tool: 'ExitPlanMode', reason: INTERACTIVE, date: RECORDED, until: UNTIL_PHASE_B },
  { tool: 'EnterPlanMode', reason: `${INTERACTIVE} (its isEnabled is ExitPlanMode's)`, date: RECORDED, until: UNTIL_PHASE_B },
  { tool: 'ProposeGoal', reason: 'deferred, no plan yet: off in every non-interactive (-p) session and in a remote '
    + 'workspace, and behind the GrowthBook flag tengu_propose_goal (default off)', date: RECORDED, until: UNTIL_PHASE_B },
  // Off by default behind a GrowthBook flag.
  { tool: 'GetTask', reason: FLAG_OFF('tengu_violin_rosin', 'a local tool (it checks on a background shell)'),
    date: RECORDED, until: UNTIL_PHASE_B },
  { tool: 'Monitor', reason: FLAG_OFF('tengu_amber_sentinel', "a local tool (it streams a process's output)"),
    date: RECORDED, until: UNTIL_PHASE_B },
  { tool: 'PushNotification', reason: FLAG_OFF('tengu_kairos_push_notifications', "a notification to the user's "
    + 'terminal or phone'), date: RECORDED, until: UNTIL_PHASE_B },
  { tool: 'SendFile', reason: FLAG_OFF('tengu_send_file', 'files to another Claude Code session (agent teams)'),
    date: RECORDED, until: UNTIL_PHASE_B },
  { tool: 'EndConversation', reason: 'deferred, no plan yet: enabled only for the models and entrypoints a GrowthBook '
    + 'config lists (default off)', date: RECORDED, until: UNTIL_PHASE_B },
  // claude.ai features.
  { tool: 'Projects', reason: CLAUDE_AI("the session's claude.ai project (allow_projects_tool, CLAUDE_PROJECT_UUID)"),
    date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'DesignSync', reason: CLAUDE_AI('claude.ai/design sync (allow_design_sync)'), date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'ClaudeDesign', reason: CLAUDE_AI('claude.ai/design projects (allow_design_sync, and a GrowthBook flag, default off)'),
    date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'Artifact', reason: CLAUDE_AI('claude.ai-hosted artifact pages'), date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'ArtifactComments', reason: CLAUDE_AI('an artifact add-on'), date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'ArtifactData', reason: CLAUDE_AI('an artifact add-on'), date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'ArtifactCheck', reason: CLAUDE_AI('an artifact add-on'), date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'AppifactRepl', reason: CLAUDE_AI('appifact SDK against an artifact, remote_cowork entrypoint only'),
    date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'RemoteTrigger', reason: CLAUDE_AI('scheduled cloud agent routines (claude.ai OAuth scopes, allow_remote_sessions)'),
    date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'SearchPlugins', reason: CLAUDE_AI('the plugin and skill directory'), date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'SearchSkills', reason: CLAUDE_AI('the plugin and skill directory'), date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'SuggestPluginInstall', reason: CLAUDE_AI('the plugin and skill directory'), date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'SuggestSkills', reason: CLAUDE_AI('the plugin and skill directory'), date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'ListPlugins', reason: CLAUDE_AI('the plugin and skill directory'), date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'ListSkills', reason: CLAUDE_AI('the plugin and skill directory'), date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'ShareOnboardingGuide', reason: CLAUDE_AI('team onboarding share links (allow_team_onboarding, and the '
    + 'GrowthBook flag tengu_flint_harbor_share, default off)'), date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'memory_list', reason: 'deferred, no plan yet: memory stores, enabled only in the "tools" memory mode',
    date: RECORDED, until: UNTIL_PHASE_B },
  { tool: 'memory_read', reason: 'deferred, no plan yet: memory stores, enabled only in the "tools" memory mode',
    date: RECORDED, until: UNTIL_PHASE_B },
  { tool: 'memory_write', reason: 'deferred, no plan yet: memory stores, enabled only in the "tools" memory mode',
    date: RECORDED, until: UNTIL_PHASE_B },
  // Remote and bridged sessions.
  { tool: 'SearchMcpRegistry', reason: REMOTE('MCP connectors (CLAUDE_CODE_REMOTE with a first-party endpoint)'),
    date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'SuggestConnectors', reason: REMOTE('MCP connectors (CLAUDE_CODE_REMOTE with a first-party endpoint)'),
    date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'ListConnectors', reason: REMOTE('MCP connectors (CLAUDE_CODE_REMOTE with a first-party endpoint)'),
    date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'ShowOnboardingRolePicker', reason: REMOTE('the Cowork onboarding role picker (CLAUDE_CODE_REMOTE)'),
    date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'ReadNotifications', reason: REMOTE('queued external notifications (CLAUDE_CODE_REMOTE, or a session condition '
    + 'not decoded here)'), date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'FetchInboxMessage', reason: REMOTE('relayed inbox messages (a REPL or supervised bridge)'), date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'propose_skills', reason: REMOTE('skill proposals (CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE)'), date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'SendUserFile', reason: REMOTE('files to the user (first-party, allow_send_file)'), date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'SendUserMessage', reason: 'deferred, no plan yet: the brief channel to the user (alias Brief), enabled by '
    + 'pewter_owl_tool (an env var or a flag) or a brief or bridge mode', date: RECORDED, until: UNTIL_PHASE_B },
  { tool: 'Poll', reason: 'deferred, no plan yet: waits for queued harness events; enabled by session conditions not '
    + 'decoded here', date: RECORDED, until: UNTIL_PHASE_B },
  { tool: 'SendFeedback', reason: 'deferred, no plan yet: drafts a feedback report; enabled by a feedback setting not '
    + 'decoded here', date: RECORDED, until: UNTIL_PHASE_B },
  // MCP.
  { tool: 'ListMcpResourcesTool', reason: MCP("it lists an MCP server's resources (alias ListMcpResources)"),
    date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'ReadMcpResourceTool', reason: MCP('it reads one MCP resource (alias ReadMcpResource)'), date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'ReadMcpResourceDirTool', reason: MCP('it lists an MCP directory resource (alias ReadMcpResourceDir)'),
    date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'RefreshMcpTools', reason: MCP('it re-syncs MCP tool lists (and CLAUDE_CODE_ENABLE_REFRESH_MCP_TOOLS)'),
    date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'WaitForMcpServers', reason: MCP('it waits for MCP servers still connecting'), date: RECORDED, until: UNTIL_PHASE_C },
  { tool: 'mcp', reason: MCP('the template every MCP server tool is copied from under its own mcp__server__tool name; '
    + 'the name "mcp" itself never reaches the model'), date: RECORDED, until: UNTIL_PHASE_C },
  // Self-hosted runner operators, and relay stubs.
  { tool: 'self_hosted_runner_get_pool', reason: RUNNER, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'self_hosted_runner_list_runners', reason: RUNNER, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'self_hosted_runner_list_sessions', reason: RUNNER, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'self_hosted_runner_list_secrets', reason: RUNNER, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'self_hosted_runner_spawn_local', reason: RUNNER, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'self_hosted_runner_read_health', reason: RUNNER, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'self_hosted_runner_read_metrics', reason: RUNNER, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'self_hosted_runner_tail_log', reason: RUNNER, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'self_hosted_runner_requeue_session', reason: RUNNER, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'enable__mcp__claude-in-chrome', reason: RELAY('Claude in Chrome'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'enable__mcp__remote-devices__Claude_Browser', reason: RELAY('a remote browser'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'enable__mcp__remote-devices__computer', reason: RELAY('remote computer use'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'request_computer', reason: RELAY('this computer'), date: RECORDED, until: UNTIL_REVIEW },
];

// ==========================================================================
// READING THE REAL INPUTS
// ==========================================================================
// The carve of CLODE_PROVIDER_BIN, decoded the way inspect-claude-bundle reads it: the sixth copy of
// this reader in test/build-gates (BACKLOG.md, "readCarve has ... copies"), by the same convention.
function readCarve() {
  const bin = process.env.CLODE_PROVIDER_BIN;
  if (!bin || !fs.existsSync(bin)) return { skip: 'no CLODE_PROVIDER_BIN (point it at a real claude binary to run this gate)' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-coverage-gate-'));
  try {
    const cli = path.join(dir, 'cli.cjs');
    const ex = spawnSync(process.execPath, [EXTRACT, bin, cli], { encoding: 'utf8' });
    if (ex.status !== 0) throw new Error(`extract-claude-js could not carve ${bin}: ${(ex.stderr || '').slice(0, 400)}`);
    const decoded = decodeGraphRunner(cli);
    return { text: decoded !== null ? decoded : fs.readFileSync(cli, 'latin1'), what: `the carve of ${bin}` };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function readSources() {
  const files = [
    ...discoverFilesByExt(path.join(REPO, 'test'), ['.cjs', '.mjs']),
    ...discoverFilesByExt(path.join(REPO, 'scripts'), ['.cjs', '.mjs', '.js']),
  ];
  return files.map((f) => ({ file: posixRel(f), text: fs.readFileSync(f, 'utf8') }));
}
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'ci.yml');
const readWorkflow = () => fs.readFileSync(WORKFLOW, 'utf8');
// The published engines are an INPUT here: this gate does not guard scripts/tjs-legs.mjs, so it is
// named by path, not by the relative require literal guards-population reads as "a guard of it".
const readPublished = () => require(path.join(REPO, 'scripts', 'tjs-legs.mjs')).publishedRunTargets();
let INPUTS = null;
function readInputs() {
  if (!INPUTS) {
    const c = readCarve();
    INPUTS = 'skip' in c ? c : { carve: c.text, what: c.what, sources: readSources(), exemptions: EXEMPTIONS,
      today: new Date().toISOString().slice(0, 10), workflow: readWorkflow(), jobs: CELL_JOBS, engines: SHIPPING_ENGINES,
      published: readPublished(), enginesExemption: OTHER_ENGINES_EXEMPTION };
  }
  return INPUTS;
}
// A CI cell job's own run (CLODE_CELL_JOB names the job, CLODE_CELL_RAN the directory its
// test/cell-reporter.mjs runs wrote their .jsonl into).
function readJobRun() {
  const job = process.env.CLODE_CELL_JOB;
  if (!job) return { skip: 'not a CI cell job (CLODE_CELL_JOB unset): a job in CELL_JOBS runs this with its reporter output' };
  const dir = process.env.CLODE_CELL_RAN;
  const records = [];
  if (dir && fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
      for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        if (!l.trim()) continue;
        const r = JSON.parse(l);
        records.push({ ...r, file: path.isAbsolute(r.file || '') ? posixRel(r.file) : r.file });
      }
    }
  }
  return { job, jobs: CELL_JOBS, sources: readSources(), records, host: { platform: process.platform, arch: process.arch } };
}

// ==========================================================================
// FIXTURES
// ==========================================================================
const lines = (...ls) => ls.join('\n');
// A chunk's header as the extractor writes it (its own first line, url and directory included), so a
// fixture never spells a url the extractor would not: a win32 name B:/~BUN/root/x.js gets file:///B:/....
const HDR = (name) => moduleWithMeta(name, '').replace(/\n$/, '');
const NOOP_RESULT = 'mapToolResultToToolResultBlockParam(e,n){return{tool_use_id:n,content:e}}';

// A code-split carve in the shapes the 2.1.283 carve spells its registry with: tool objects built
// by a builder call whose `name:` is a string constant in ANOTHER chunk (import{...}from), a tool
// reached through a star import (`__clodeReq0.MonitorTool`) whose name sits in an object it
// SPREADS (the Monitor tool is `Ft({...De, ...})`), an alias list, a tool behind a function that
// returns null under a condition (`Ms`, ClaudeDesign's shape), conditional and filtered spreads,
// a `null` binding (a tool the build compiled out), and a tool object registered OUTSIDE
// getAllBaseTools (SubagentHandback) beside a dead one nothing references (TestingPermission).
// Its mode anchors (MINI_MODE_CHUNK) spell the 2.1.283 shapes: the permission list behind its
// refusal's template, the sandbox settings object, the shell discovery's two orders, and the two
// opt-in setters with their one call each.
const MINI_MODE_CHUNK = [
  HDR('/$bunfs/root/chunk-modes.js'),
  'import{ro,$r,at}from"/$bunfs/root/chunk-names.js";',
  'var zL=["acceptEdits","bypassPermissions","default","plan"],Ts=[...zL],kne=`Cannot set permission mode: must be one of ${zL.join(", ")}`;',
  'var Emn=f(()=>u({enabled:O().optional(),failIfUnavailable:O().optional().describe("Exit with an error at startup if '
    + 'sandbox.enabled is true but the sandbox cannot start")}));',
  'async function Sh(n){let s=n?.includes("bash"),D=(s?["bash","zsh"]:["zsh","bash"]).flatMap((W)=>[W]);return D}',
  'function jzr(e){n().host.launchOptions.replaceSearchToolsOptIn(e)}function Gzr(e){n().host.launchOptions.replaceTodoToolsOptIn(e)}',
  'var jDn=[at];function Lo(T,Q){jzr([ro,$r].some(Q)),Gzr(jDn.some(Q))}',
].join('\n');
function miniCarve({ extra = '', extraElement = '', getToolsBody = 'let n=Jw();if(uw())n=[...n,M0,L0];return n',
  outside = '', modes = MINI_MODE_CHUNK } = {}) {
  return lines(
    modes,
    HDR('/$bunfs/root/chunk-names.js'),
    'var Ue="Bash",$r="Grep",ro="Glob",at="Read";',
    'export{Ue,$r,ro,at};',
    HDR('/$bunfs/root/chunk-tools.js'),
    'import{Ue,$r,ro,at}from"/$bunfs/root/chunk-names.js";',
    `var Qs=Ft({name:Ue,searchHint:"execute shell commands",async call(e){return{data:e}},${NOOP_RESULT}}),`
      + `M0=Ft({name:ro,${NOOP_RESULT}}),L0=Ft({name:$r,${NOOP_RESULT}}),u_=Ft({name:at,${NOOP_RESULT}});`,
    'export{Qs,M0,L0,u_};',
    HDR('/$bunfs/root/chunk-lazy.js'),
    `var De={name:"Monitor",searchHint:"watch a process"},xe=Ft({...De,${NOOP_RESULT}});`,
    'export{xe as MonitorTool};',
    HDR('/$bunfs/root/chunk-subagent.js'),
    `var oKt=Ft({name:"SubagentHandback",${NOOP_RESULT}}),xc=Ft({name:"TestingPermission",${NOOP_RESULT}});`,
    `function Fa(e){let l=Ft({name:e.name,${NOOP_RESULT}});return l}${outside}`,
    'export{oKt,Fa};',
    HDR('/$bunfs/root/chunk-registry.js'),
    'import * as __clodeReq0 from "/$bunfs/root/chunk-lazy.js";',
    'import{Qs,M0,L0,u_}from"/$bunfs/root/chunk-tools.js";',
    `var uVt=Ft({name:"Agent",aliases:["Task"],${NOOP_RESULT}}),fr=__clodeReq0.MonitorTool,Sr=null,`
      + `Ms=()=>{if(It())return null;return uVt}${extra};`,
    'function Jw(){let e=Ms();return[...e?[e]:[],...wa()?[Qs]:[],...[M0,L0].filter((n)=>!pfe().has(n.name)),'
      + `u_,...fr?[fr]:[],...Sr?[Sr]:[],...[]${extraElement}]}`,
    `var f0=(e,r)=>{${getToolsBody}};`,
    'var Q2={getAllBaseTools:Jw,getTools:f0,assembleToolPool:f0};',
  );
}
const ZEBRA = { extra: `,Zz=Ft({name:"Zebra",${NOOP_RESULT}})`, extraElement: ',Zz' };
const MINI_TOOLS = ['Agent', 'Bash', 'Glob', 'Grep', 'Monitor', 'Read', 'SubagentHandback'];

// Test sources that drive tools, in the shapes the tree's live checks use (Task 1): the control
// shares ONE tool_use object with the mock; the judgment reads the tool_result by that object's id.
const DRIVER_SOURCES = [
  { file: 'test/synthetic/drivers.test.cjs', text: lines(
    "const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('./mock-anthropic-helper.cjs');",
    "const { toolResultText, assertFailsOnMissingOutput } = require('../scripts/lib/tool-result.cjs');",
    "const TASK = { name: 'Task', input: { prompt: 'x' }, id: 'toolu_task' };",
    "const answered = (m) => toolResultText(m, TASK.id).includes('ANSWER');",
    'async function drive(bin, use) {',
    '  const mock = await startMockAnthropic({',
    "    respond: (body) => body.includes(use.id) ? cannedSSE('DONE') : cannedToolUseSSE(use.name, use.input, use.id),",
    '  });',
    '  return mock;',
    '}',
    "test('bash, scripted in place', async (t) => {",
    "  if (!bin) { t.skip('no bin'); return; }",
    "  const BASH = { name: 'Bash', input: { command: 'echo X-$((6*7))' }, id: 'toolu_b' };",
    "  const said = (m) => toolResultText(m, BASH.id).includes('X-42');",
    '  assertFailsOnMissingOutput(said, BASH);',
    '  const mock = await startMockAnthropic({ respond: () => cannedToolUseSSE(BASH.name, BASH.input, BASH.id) });',
    '  assert.ok(said(mock));',
    '});',
    "test('read, through a helper, judged by the id it was given', async (t) => {",
    "  const ID = 'toolu_r';",
    "  const READ = { name: 'Read', input: { file_path: '/x' }, id: ID };",
    "  const read = (m) => toolResultText(m, ID).includes('CONTENT');",
    '  assertFailsOnMissingOutput(read, READ);',
    '  const mock = await drive(bin, READ);',
    '  assert.ok(read(mock));',
    '});',
    "test('task, by its alias', async (t) => {",
    '  assertFailsOnMissingOutput(answered, TASK);',
    '  const mock = await drive(bin, TASK);',
    '  assert.ok(answered(mock));',
    '});',
    "test('grep, which skips on its own outcome', async (t) => {",
    "  const GREP = { name: 'Grep', input: { pattern: 'x' }, id: 'toolu_g' };",
    "  const found = (m) => toolResultText(m, GREP.id).includes('TAIL');",
    '  assertFailsOnMissingOutput(found, GREP);',
    '  const mock = await startMockAnthropic({ respond: () => cannedToolUseSSE(GREP.name, GREP.input, GREP.id) });',
    "  if (/refused/.test(r.stderr)) { t.skip('refused'); return; }",
    '  assert.ok(found(mock));',
    '});',
    // Declared modes, a control in a top-level helper that a test calls, and a script of steps.
    "const SBX = { name: 'Bash', input: { command: 'echo S-$((6*7))' }, id: 'toolu_s' };",
    "const sandboxed = (m) => toolResultText(m, SBX.id).includes('S-42');",
    'const step = (USE) => ({ use: USE, emit: () => cannedToolUseSSE(USE.name, USE.input, USE.id) });',
    'const SCRIPT = [step(SBX)];',
    'function controls() {',
    "  assertFailsOnMissingOutput(sandboxed, SBX, ['sandbox:on', 'shell:bash']);",
    '}',
    "test('bash, sandboxed, its control in a helper', async (t) => {",
    '  controls();',
    '});',
    // What makes those two declarations measured (MODE_EVIDENCE).
    'const SETTINGS = { sandbox: { enabled: true } };',
    "const ENV = { SHELL: '/bin/bash' };",
  ) },
  // A floor-probe-shaped row: the mock rule `{ tool: USE }` scripts it.
  { file: 'scripts/synthetic-probe.mjs', text: lines(
    'const CHECKS = [',
    '  {',
    "    row: 'X1',",
    '    async fn(sbx) {',
    "      const ID = 'toolu_floor_bash';",
    "      const BASH = { name: 'Bash', input: { command: 'echo F-$((6*7))' }, id: ID };",
    "      const carried = (m) => toolResultText(m, ID).includes('F-42');",
    '      assertFailsOnMissingOutput(carried, BASH);',
    "      const mock = await startMock([{ match: ID, text: 'done' }, { tool: BASH }]);",
    '      return { ok: carried(mock) };',
    '    },',
    '  },',
    '];',
  ) },
];
// Near misses: each LOOKS like a driver of a tool and drives nothing, so none may count.
const NEAR_MISS_SOURCES = [
  { file: 'test/synthetic/near-misses.test.cjs', text: lines(
    "test('write, judged on the disk only', async (t) => {",
    "  const mock = await startMockAnthropic({ respond: () => cannedToolUseSSE('Write', { file_path: f, content: 'x' }, 'toolu_w') });",
    '  assert.ok(fs.existsSync(f));',
    '});',
    "test('the check reads another id', async (t) => {",
    "  const EDIT = { name: 'Edit', input: {}, id: 'toolu_e' };",
    "  const edited = (m) => toolResultText(m, 'toolu_other').includes('updated');",
    '  assertFailsOnMissingOutput(edited, EDIT);',
    '  const mock = await startMockAnthropic({ respond: () => cannedToolUseSSE(EDIT.name, EDIT.input, EDIT.id) });',
    '  assert.ok(edited(mock));',
    '});',
    "test('the object is controlled but never scripted', async (t) => {",
    "  const GLOB = { name: 'Glob', input: { pattern: '*' }, id: 'toolu_gl' };",
    "  const listed = (m) => toolResultText(m, GLOB.id).includes('a.txt');",
    '  assertFailsOnMissingOutput(listed, GLOB);',
    "  const mock = await startMockAnthropic({ respond: () => cannedToolUseSSE('Glob', { pattern: '*' }, 'toolu_gl') });",
    '  assert.ok(listed(mock));',
    '});',
    "test('the tool_use is inline in the control', async (t) => {",
    "  const ok = (m) => toolResultText(m, 'toolu_n').includes('cell');",
    "  assertFailsOnMissingOutput(ok, { name: 'NotebookEdit', input: {}, id: 'toolu_n' });",
    '});',
    "test('modes that are not a literal', async (t) => {",
    "  const ED2 = { name: 'Edit', input: {}, id: 'toolu_e2' };",
    "  const ok2 = (m) => toolResultText(m, ED2.id).includes('updated');",
    '  assertFailsOnMissingOutput(ok2, ED2, MODES);',
    '  const mock = await startMockAnthropic({ respond: () => cannedToolUseSSE(ED2.name, ED2.input, ED2.id) });',
    '});',
    "test('a test declared skipped', { skip: DEFERRED }, async (t) => {",
    "  const MON = { name: 'Monitor', input: {}, id: 'toolu_m' };",
    "  const watched = (m) => toolResultText(m, MON.id).includes('line');",
    '  assertFailsOnMissingOutput(watched, MON);',
    '  const mock = await startMockAnthropic({ respond: () => cannedToolUseSSE(MON.name, MON.input, MON.id) });',
    '  assert.ok(watched(mock));',
    '});',
  ) },
];
// The cells the mini carve's modes give: 3 permission modes, the sandbox, bash and zsh; Glob and
// Grep are its search opt-ins (no `unlisted`).
const MINI_MODES = ['print', 'interactive', 'unlisted', 'permission:acceptEdits', 'permission:bypassPermissions', 'permission:plan'];
const MINI_BASH = [...MINI_MODES, 'sandbox:on', 'sandbox:required', 'shell:bash', 'shell:zsh'];
const miniModes = (tool) => (tool === 'Bash' ? MINI_BASH : ['Glob', 'Grep'].includes(tool) ? MINI_MODES.filter((m) => m !== 'unlisted') : MINI_MODES);
const MINI_CELLS = MINI_TOOLS.reduce((n, t) => n + miniModes(t).length, 0) * SHIPPING_ENGINES.length;
const FX_JOB = 'fixture-job';
const FX_ENGINE = 'linux-x64-musl';
const FX_OTHERS = SHIPPING_ENGINES.filter((e) => e !== FX_ENGINE);
const FX_JOBS = [{ job: FX_JOB, engine: FX_ENGINE, files: ['test/synthetic/drivers.test.cjs'] }];
const fxWorkflow = ({ check = `CLODE_CELL_JOB=${FX_JOB}`, files = 'test/synthetic/drivers.test.cjs' } = {}) => lines(
  'name: ci',
  'jobs:',
  '  other-job:',
  '    runs-on: ubuntu-latest',
  `  ${FX_JOB}:`,
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/download-artifact@v8.0.1',
  '        with:',
  `          name: tjs-${FX_ENGINE}`,
  `      - run: node --test --test-reporter=./test/cell-reporter.mjs --test-reporter-destination=x.jsonl ${files}`,
  `      - run: ${check} node --test test/build-gates/tool-coverage-gates.test.cjs`,
);
// Every cell of `tool` but the ones `keep` names (`mode@engine`), as exemption entries.
function exemptAllBut(tool, keep, reason = 'deferred: not driven in the fixture', until = '2026-12-31') {
  const out = [];
  const kept = new Set(keep);
  for (const mode of miniModes(tool)) {
    const engines = SHIPPING_ENGINES.filter((e) => !kept.has(`${mode}@${e}`));
    if (engines.length) out.push({ tool, modes: [mode], ...(engines.length < SHIPPING_ENGINES.length ? { engines } : {}), reason, date: '2026-09-28', until });
  }
  return out;
}
const PLAN_REASON = 'deferred: the Grep and Glob = native plan (fixture)';
// The fixture job drives, on linux-x64-musl: Agent (as Task), Bash print, sandbox:on and
// shell:bash, Grep and Read print.
const FIXTURE_EXEMPTIONS = [
  { tool: 'Glob', reason: PLAN_REASON, date: '2026-09-28', until: '2026-10-12' },
  ...exemptAllBut('Grep', [`print@${FX_ENGINE}`], PLAN_REASON, '2026-10-12'),
  { tool: 'Monitor', reason: 'deferred: gated off by default (fixture)', date: '2026-09-28', until: '2026-12-31' },
  { tool: 'SubagentHandback', reason: 'deferred: subagents only (fixture)', date: '2026-09-28', until: '2026-12-31' },
  ...exemptAllBut('Agent', [`print@${FX_ENGINE}`]),
  ...exemptAllBut('Bash', [`print@${FX_ENGINE}`, `sandbox:on@${FX_ENGINE}`, `shell:bash@${FX_ENGINE}`]),
  ...exemptAllBut('Read', [`print@${FX_ENGINE}`]),
];
const FX_ENGINES_EXEMPTION = { engines: ['*'], reason: 'not shipping (fixture)', date: '2026-09-28', until: '2026-12-31' };
const fixtureInputs = (over = {}) => ({ carve: miniCarve(), what: 'the synthetic carve',
  sources: [...DRIVER_SOURCES, ...NEAR_MISS_SOURCES], exemptions: FIXTURE_EXEMPTIONS, today: '2026-09-28',
  workflow: fxWorkflow(), jobs: FX_JOBS, engines: SHIPPING_ENGINES, published: [...SHIPPING_ENGINES, 'haiku-x64'],
  enginesExemption: FX_ENGINES_EXEMPTION, ...over });
// A run of the fixture job: each test of drivers.test.cjs, as test/cell-reporter.mjs records it.
const FX_TESTS = [11, 19, 27, 32, 47];          // the test(...) lines of drivers.test.cjs's drivers
const fxRecords = (over = {}) => FX_TESTS.map((line) => ({ type: 'test:pass', file: 'test/synthetic/drivers.test.cjs', line,
  name: `t${line}`, nesting: 0, ...(over[line] || {}) }));
const fxJobRun = (over = {}) => ({ job: FX_JOB, jobs: FX_JOBS, sources: DRIVER_SOURCES, records: fxRecords(),
  host: { platform: 'linux', arch: 'x64' }, ...over });

// ==========================================================================
// THE REGISTRY
// ==========================================================================
test('extractRegistry reads every shape the 2.1.283 registry spells, across chunks', () => {
  const r = extractRegistry(miniCarve());
  assert.deepStrictEqual(r.findings, []);
  assert.deepStrictEqual([...r.tools.keys()].sort(), MINI_TOOLS);
  assert.deepStrictEqual(r.tools.get('Agent').aliases, ['Task']);
  assert.strictEqual(r.tools.get('Monitor').source, 'getAllBaseTools', 'the name read through the object spread');
  assert.strictEqual(r.tools.get('SubagentHandback').source, 'outside getAllBaseTools');
  assert.ok(!r.tools.has('TestingPermission'), 'a tool object nothing references cannot register');
  assert.match(r.note, /1 dead tool object\(s\) \(TestingPermission\); 1 builder object\(s\) whose name is computed/);
});

test('extractRegistry counts a tool only getTools names, even one listed between commas', () => {
  const r = extractRegistry(miniCarve({
    extra: `,Wx=Ft({name:"Walrus",${NOOP_RESULT}})`,
    getToolsBody: 'let n=Jw(),w=null;if(uw())n=[...n,M0,Wx,L0].filter((v)=>v!==w);return n',
  }));
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.tools.get('Walrus').source, 'getTools');
  assert.match(r.note, /1 added by getTools/);
});

test('extractRegistry names an outside tool object whose name it cannot read, and a factory is not one', () => {
  const r = extractRegistry(miniCarve({ outside: `var Qq=Ft({name:Nope.label,${NOOP_RESULT}});export{Qq};`.replace('export{Qq};', '')
    + 'var Nope={label:1};' }));
  assert.strictEqual(r.findings.length, 1, r.findings.join('\n'));
  assert.match(r.findings[0], /^a tool object \(Qq in \/\$bunfs\/root\/chunk-subagent\.js\) outside getAllBaseTools has a name this scan cannot read/);
  assert.deepStrictEqual([...r.tools.keys()].sort(), MINI_TOOLS, 'the factory Fa\'s object is not a tool of its own');
});

test('extractRegistry never reads a missing or doubled anchor as an empty registry', () => {
  const none = extractRegistry(miniCarve().replace('getAllBaseTools:Jw', 'baseTools:Jw'));
  assert.strictEqual(none.tools.size, 0);
  assert.match(none.findings[0], /found 0 time\(s\)/);
  const twice = extractRegistry(miniCarve() + '\nvar Q3={getAllBaseTools:Jw,getTools:f0,assembleToolPool:f0};');
  assert.strictEqual(twice.tools.size, 0);
  assert.match(twice.findings[0], /found 2 time\(s\)/);
});

test('extractRegistry names an element it cannot read, and does not count it', () => {
  const r = extractRegistry(miniCarve({ extraElement: ',...Unk.flatMap((e)=>e)' }));
  assert.strictEqual(r.findings.length, 1, r.findings.join('\n'));
  assert.match(r.findings[0], /getAllBaseTools element `\.\.\.Unk\.flatMap\(\(e\)=>e\)` does not resolve/);
  assert.deepStrictEqual([...r.tools.keys()].sort(), MINI_TOOLS);
});

// A win32 carve names its chunks B:/~BUN/root/x.js, and the extractor's url for one is
// file:///B:/~BUN/root/x.js. Reading the chunk's name off that url by stripping "file://" kept the
// extra '/', no import matched, and the windows-latest gate examined 4 tools of the pinned carve
// (CI 44443821699): the same carve spelled the win32 way reads the same registry and modes.
// The win32 spelling of the fixture, as the extractor writes it (moduleWithMeta: the url gains a '/' before
// the drive; the import specifiers and the directory do not).
const WIN32 = (t) => t.replaceAll('file:///$bunfs/root/', 'file:///B:/~BUN/root/').replaceAll('/$bunfs/root', 'B:/~BUN/root');
test('a win32-named carve (B:/~BUN/root/...) reads the same registry and modes as a POSIX one', () => {
  const w = WIN32(miniCarve());
  assert.ok(w.includes('import.meta.url = "file:///B:/~BUN/root/chunk-names.js"'), 'the fixture carries the win32 url the extractor writes');
  const r = extractRegistry(w), p = extractRegistry(miniCarve());
  assert.deepStrictEqual(r.findings, []);
  assert.deepStrictEqual([...r.tools.keys()].sort(), MINI_TOOLS);
  assert.deepStrictEqual([...r.tools.entries()].map(([k, v]) => [k, v.source, v.aliases]), [...p.tools.entries()].map(([k, v]) => [k, v.source, v.aliases]));
  assert.deepStrictEqual(extractModes(w), extractModes(miniCarve()));
});

// THE CLASS, ON THE REAL CARVE, ON EVERY HOST (fix round 1 of CI 44443821699). Only windows-latest reads a win32 carve,
// so a reader that misnames win32 chunks is otherwise seen there alone. The pinned carve in hand, spelled the way a
// win32 carve spells its chunks (WIN32: measured against the real 2.1.283 win32-x64 decode, its urls
// file:///B:/~BUN/root/x.js and its imports from"B:/~BUN/root/x.js"), must read the same registry and modes.
// WHAT IT DOES NOT PROVE. The rewrite is textual and blunt: it rewrites EVERY "/$bunfs/root" literal in the carve,
// not only the chunk headers and import specifiers, so a string that names that path for another reason is rewritten
// too and no longer reads as a real win32 carve would. It does not model Bun's build-time platform folding either: a
// win32 carve was built with process.platform/arch constant-folded to win32, so its code differs from this POSIX one
// in places no spelling change reaches. It checks the chunk-NAME class only; the windows-latest gates, reading a real
// win32 carve, remain the check for everything else.
test('the pinned carve spelled the win32 way (B:/~BUN/root/...) reads the same registry and modes', (t) => {
  const c = readInputs();
  if ('skip' in c) { t.skip(c.skip); return; }
  if (!c.carve.includes('file:///$bunfs/root/')) { t.skip('the carve is already a win32 one: every-tool-driven itself reads it'); return; }
  const w = WIN32(c.carve);
  assert.ok(w.includes('import.meta.url = "file:///B:/~BUN/root/') && w.includes('from"B:/~BUN/root/'), 'the win32 spelling took');
  const a = extractRegistry(c.carve), b = extractRegistry(w);
  assert.ok(a.tools.size > 50, `the POSIX carve's registry: ${a.tools.size} tools`);
  assert.deepStrictEqual([...b.tools.keys()].sort(), [...a.tools.keys()].sort());
  assert.deepStrictEqual(b.findings, a.findings);
  assert.deepStrictEqual(extractModes(w), extractModes(c.carve));
});

// ==========================================================================
// THE MODES
// ==========================================================================
test('extractModes reads every mode the carve spells', () => {
  const r = extractModes(miniCarve());
  assert.deepStrictEqual(r.findings, []);
  assert.deepStrictEqual(r.permission, ['acceptEdits', 'bypassPermissions', 'plan']);
  assert.deepStrictEqual(r.sandbox, ['on', 'required']);
  assert.deepStrictEqual(r.shells, ['bash', 'zsh']);
  assert.deepStrictEqual(r.optIn, { search: ['Glob', 'Grep'], todo: ['Read'] });
});

test('extractModes never reads a missing or doubled anchor as "no such mode"', () => {
  const chunk = MINI_MODE_CHUNK;
  const gone = extractModes(miniCarve({ modes: chunk.replace('Cannot set permission mode', 'Cannot set mode')
    .replace('failIfUnavailable:', 'failWhenMissing:').replace('.flatMap(', '.map(') }));
  assert.strictEqual(gone.findings.length, 3, gone.findings.join('\n'));
  assert.match(gone.findings.join('\n'), /permission-mode list .* found 0 time/);
  assert.match(gone.findings.join('\n'), /sandbox object .* found 0 time/);
  assert.match(gone.findings.join('\n'), /shell discovery .* found 0 time/);
  const twice = extractModes(miniCarve({ modes: `${chunk}\n${HDR('/$bunfs/root/chunk-modes2.js')}\nvar Q9=(s?["bash","zsh"]:["zsh","bash"]).flatMap((W)=>[W]);` }));
  assert.match(twice.findings.join('\n'), /shell discovery .* found 2 time/);
  const noDefault = extractModes(miniCarve({ modes: chunk.replace('"default",', '') }));
  assert.match(noDefault.findings.join('\n'), /no "default"/);
  const optOut = extractModes(miniCarve({ modes: chunk.replace('jzr([ro,$r].some(Q)),', '') }));
  assert.match(optOut.findings.join('\n'), /the search opt-in \(jzr\(LIST\.some\(\.\.\.\)\)\) was called 0 time/);
});

test('the mode axis: print, interactive and unlisted for every tool but the search opt-ins; sandbox and shells for Bash', () => {
  const axis = modeAxis(extractModes(miniCarve()));
  const optIn = new Set(['Glob', 'Grep']);
  for (const t of MINI_TOOLS) assert.deepStrictEqual(modesOf(t, axis, optIn), miniModes(t), t);
});

// ==========================================================================
// THE DRIVERS
// ==========================================================================
test('findDrivers finds each driver shape the tree uses, and no near miss', () => {
  const d = findDrivers([...DRIVER_SOURCES, ...NEAR_MISS_SOURCES]);
  const got = d.drivers.map((x) => `${x.name}@${x.file}:${x.line} ${x.modes.join('/')}${x.skips ? ` skips (${x.skips})` : ''}`).sort();
  assert.deepStrictEqual(got, [
    'Bash@scripts/synthetic-probe.mjs:8 print',
    'Bash@test/synthetic/drivers.test.cjs:15 print',
    'Bash@test/synthetic/drivers.test.cjs:45 sandbox:on/shell:bash',
    'Grep@test/synthetic/drivers.test.cjs:35 print skips (a skip after the control, line 37)',
    'Monitor@test/synthetic/near-misses.test.cjs:32 print skips (the test is declared skipped)',
    'Read@test/synthetic/drivers.test.cjs:23 print',
    'Task@test/synthetic/drivers.test.cjs:28 print',
  ]);
  const why = d.rejected.map((x) => `${x.file}:${x.line} ${x.why}`).sort();
  assert.deepStrictEqual(why, [
    'test/synthetic/near-misses.test.cjs:15 the check (listed) reads the tool_result of GLOB.id, but GLOB is never scripted to a mock',
    'test/synthetic/near-misses.test.cjs:21 the tool_use is not a named object (an inline one cannot be the one the mock scripts)',
    'test/synthetic/near-misses.test.cjs:26 the modes (MODES) are not a string literal or an array of string literals',
    'test/synthetic/near-misses.test.cjs:8 the check (edited) never reads the tool_result of EDIT.id',
  ]);
});

test('a test that spells quaudeSkip drives no quaude cell (control): only its sibling that runs quaude counts', () => {
  const src = (both) => [{ file: 'test/synthetic/native-only.test.cjs', text: lines(
    "const { driveTool } = require('./tool-driver.cjs');",
    "const { toolResultText, assertFailsOnMissingOutput } = require('../scripts/lib/tool-result.cjs');",
    "const READ = { name: 'Read', input: { file_path: '/x' }, id: 'toolu_r' };",
    "const read = (m) => toolResultText(m, READ.id).includes('LINE');",
    'function controls() { assertFailsOnMissingOutput(read, READ); }',
    ...(both ? ["test('quaude', async () => {", '  controls();', '  const r = await driveTool({ tool: READ });',
      '  assert.ok(read(r.quaude.raw));', '});'] : []),
    "test('native alone', async () => {", '  controls();',
    "  const r = await driveTool({ tool: READ, quaudeSkip: 'native alone' });", '  assert.ok(read(r.native.raw));', '});',
  ) }];
  const only = findDrivers(src(false)).drivers[0];
  assert.deepStrictEqual(only.tests, [], 'a quaudeSkip-only driver has no test that drives quaude');
  assert.deepStrictEqual(only.nativeOnly.map((t) => t.name), ['native alone']);
  const both = findDrivers(src(true)).drivers[0];
  assert.deepStrictEqual(both.tests.map((t) => t.name), ['quaude']);
  // claimed by a job, the quaudeSkip-only driver is a finding that says why, and drives no cell
  const jobs = [{ ...FX_JOBS[0], files: ['test/synthetic/native-only.test.cjs'] }];
  const r = scanCoverage(fixtureInputs({ sources: src(false), jobs, workflow: fxWorkflow({ files: 'test/synthetic/native-only.test.cjs' }) }));
  assert.match(r.findings.join('\n'), /native-only\.test\.cjs:5: fixture-job claims this driver of Read, but no test\(\.\.\.\) runs its control on quaude \(test\(s\) at line 6 spell quaudeSkip/);
  assert.ok(![...r.driven.keys()].some((k) => /Read/.test(k)), 'no Read cell is driven');
});

test('findDrivers names the tests that run each control, by the line node:test reports', () => {
  const d = findDrivers(DRIVER_SOURCES);
  const tests = (line) => d.drivers.find((x) => x.file === 'test/synthetic/drivers.test.cjs' && x.line === line).tests;
  assert.deepStrictEqual(tests(15), [{ name: 'bash, scripted in place', line: 11 }]);
  assert.deepStrictEqual(tests(45), [{ name: 'bash, sandboxed, its control in a helper', line: 47 }], 'through the helper it calls');
  assert.deepStrictEqual(d.drivers.find((x) => x.file === 'scripts/synthetic-probe.mjs').tests, [], 'no test runs a script row');
});

// ==========================================================================
// THE VERDICT
// ==========================================================================
test('scanCoverage: the fixture carve, its job and its exemptions cover every cell', () => {
  const r = scanCoverage(fixtureInputs());
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.examined, MINI_CELLS);
  assert.deepStrictEqual([...r.driven.keys()].sort(), [
    `Agent|print|${FX_ENGINE}`, `Bash|print|${FX_ENGINE}`, `Bash|sandbox:on|${FX_ENGINE}`, `Bash|shell:bash|${FX_ENGINE}`,
    `Grep|print|${FX_ENGINE}`, `Read|print|${FX_ENGINE}`]);
});

test('step 3 (a): a carve with one more tool, and no driver or exemption, is a finding per mode, naming every engine', () => {
  const r = scanCoverage(fixtureInputs({ carve: miniCarve(ZEBRA) }));
  assert.strictEqual(r.findings.length, MINI_MODES.length, r.findings.join('\n'));
  for (const [k, f] of r.findings.entries()) {
    assert.strictEqual(f, `Zebra x ${MINI_MODES[k]}: on ${SHIPPING_ENGINES.join(', ')} no CI job drives it (CELL_JOBS) and no exemption covers it`);
  }
  assert.strictEqual(r.examined, MINI_CELLS + MINI_MODES.length * SHIPPING_ENGINES.length);
});

// RED FIRST, in the fixture's terms: the two escapes the observability plan names. Bash with the
// sandbox enabled failed OPEN (8b088ef) while every Bash driver ran without it; Grep refused every
// call on Linux (0204b54) while its driver ran on darwin only. Each is a cell no job ran.
test('the escapes: Bash x sandbox:on with only a print driver, and Grep with no job on its engine, are uncovered cells', () => {
  const noSandbox = DRIVER_SOURCES.map((s) => ({ ...s, text: s.text.replace("['sandbox:on', 'shell:bash']", "'shell:bash'") }));
  const r = scanCoverage(fixtureInputs({ sources: noSandbox }));
  assert.deepStrictEqual(r.findings, [`Bash x sandbox:on: on ${FX_ENGINE} no CI job drives it (CELL_JOBS) and no exemption covers it`]);
  const darwinOnly = [{ ...FX_JOBS[0], engine: 'darwin-arm64' }];
  const g = scanCoverage(fixtureInputs({ jobs: darwinOnly, workflow: fxWorkflow().replace(`tjs-${FX_ENGINE}`, 'tjs-darwin-arm64') }));
  assert.match(g.findings.join('\n'), new RegExp(`^Grep x print: on ${FX_ENGINE} no CI job drives it`, 'm'));
  assert.match(g.findings.join('\n'), /^Grep x print @ darwin-arm64: exempted .* but driven by fixture-job/m);
});

test('a job ci.yml does not run as a cell job drives nothing, and says why', () => {
  const r = scanCoverage(fixtureInputs({ workflow: fxWorkflow({ check: 'true' }) }));
  assert.match(r.findings[0], /^CELL_JOBS fixture-job \(linux-x64-musl\) drives no cell: it never checks its cells \(CLODE_CELL_JOB=fixture-job/);
  assert.strictEqual(r.driven.size, 0);
  const gone = checkJobs({ workflow: fxWorkflow(), jobs: [{ job: 'nope', engine: 'haiku-x64', files: ['test/none.cjs'] }],
    sources: DRIVER_SOURCES, engines: SHIPPING_ENGINES });
  assert.deepStrictEqual(gone.findings, ['CELL_JOBS nope (haiku-x64) drives no cell: its engine haiku-x64 is not a shipping engine '
    + '(darwin-arm64, linux-x64-musl, netbsd-arm64); ci.yml has no such job']);
  const lost = checkJobs({ workflow: fxWorkflow(), jobs: [{ ...FX_JOBS[0], files: [...FX_JOBS[0].files, 'test/none.cjs',
    'test/synthetic/near-misses.test.cjs'] }], sources: [...DRIVER_SOURCES, ...NEAR_MISS_SOURCES], engines: SHIPPING_ENGINES });
  assert.deepStrictEqual(lost.findings, ['CELL_JOBS fixture-job claims test/none.cjs, which is not in the tree',
    'CELL_JOBS fixture-job claims test/synthetic/near-misses.test.cjs, which the job never names in ci.yml']);
  assert.deepStrictEqual(lost.valid.map((j) => j.files), [FX_JOBS[0].files], 'the job\'s other files still drive their cells');
  // A comment is not a step: naming the file, the reporter or the check only in a comment drives nothing.
  const commented = fxWorkflow().replace(/^(\s+- run: node --test .*)$/m, '      # $1');
  const c = checkJobs({ workflow: commented, jobs: FX_JOBS, sources: DRIVER_SOURCES, engines: SHIPPING_ENGINES });
  assert.deepStrictEqual(c.findings, ['CELL_JOBS fixture-job (linux-x64-musl) drives no cell: it runs no test under test/cell-reporter.mjs']);
});

test('a test whose only driver can skip drives its cell where a job runs it; the job\'s run is what refuses the skip', () => {
  const r = scanCoverage(fixtureInputs());
  assert.ok(r.driven.has(`Grep|print|${FX_ENGINE}`));
  const skipped = checkJobRan(fxJobRun({ records: fxRecords({ 32: { skip: 'refused' } }) }));
  assert.deepStrictEqual(skipped.findings, ['test/synthetic/drivers.test.cjs:35 (Grep x print @ linux-x64-musl): test "grep, which '
    + 'skips on its own outcome" (line 32) skipped (refused) in fixture-job; a cell is driven only where its test passes '
    + '(no other passing test here drives Grep x print)']);
});

test('a declared mode the tool has no cell for, and a claimed driver no test runs, are findings', () => {
  const src = DRIVER_SOURCES.map((s) => ({ ...s, text: s.text.replace('assertFailsOnMissingOutput(read, READ);', "assertFailsOnMissingOutput(read, READ, 'shell:bash');") }));
  const r = scanCoverage(fixtureInputs({ sources: src }));
  assert.match(r.findings.join('\n'), /^test\/synthetic\/drivers\.test\.cjs:23: declares shell:bash for Read, not among its cells' modes/m);
  const jobs = [{ ...FX_JOBS[0], files: [...FX_JOBS[0].files, 'scripts/synthetic-probe.mjs'] }];
  const p = scanCoverage(fixtureInputs({ jobs, workflow: fxWorkflow({ files: jobs[0].files.join(' ') }) }));
  assert.match(p.findings.join('\n'), /^scripts\/synthetic-probe\.mjs:8: fixture-job claims this driver of Bash, but no test\(\.\.\.\) runs its control/m);
});

test('a declared mode is measured: a file that never spells its flag, settings or SHELL is a finding, and drives no such cell', () => {
  const ev = (text, modes) => unmeasuredModes(text, modes).map((u) => u.mode);
  assert.deepStrictEqual(ev("run(['-p', '--dangerously-skip-permissions'])", ['permission:bypassPermissions']), []);
  assert.deepStrictEqual(ev("run(['-p', '--permission-mode', 'plan'])", ['permission:plan', 'permission:acceptEdits']), ['permission:acceptEdits']);
  assert.deepStrictEqual(ev("run('--permission-mode=dontAsk')", ['permission:dontAsk']), []);
  assert.deepStrictEqual(ev("run(['--dangerously-skip-permissions'])", ['permission:plan']), ['permission:plan']);
  assert.deepStrictEqual(ev('const S = { sandbox: { enabled: true } };', ['sandbox:on', 'sandbox:required']), ['sandbox:required']);
  assert.deepStrictEqual(ev("const S = { 'sandbox': { 'enabled': true, failIfUnavailable: true } };", ['sandbox:required']), []);
  assert.deepStrictEqual(ev('const S = { sandbox: { enabled: false } };', ['sandbox:on']), ['sandbox:on']);
  assert.deepStrictEqual(ev("env = { SHELL: bash }; // SHELL=zsh", ['shell:bash', 'shell:zsh']), ['shell:zsh'], 'a comment is not evidence');
  assert.deepStrictEqual(ev('/* sandbox: { enabled: true } */ x()', ['sandbox:on']), ['sandbox:on'], 'nor is a block comment');
  assert.deepStrictEqual(ev('x()', ['print', 'interactive', 'unlisted']), [], 'those three are not measured');
  // The control: the fixture's sandboxed Bash driver with its settings and SHELL only in comments.
  const src = DRIVER_SOURCES[0];
  const stripped = { ...src, text: src.text.replace('const SETTINGS =', '// const SETTINGS =').replace('const ENV =', '// const ENV =') };
  const r = scanCoverage(fixtureInputs({ sources: [stripped, ...DRIVER_SOURCES.slice(1), ...NEAR_MISS_SOURCES] }));
  assert.deepStrictEqual(r.findings.map((f) => f.replace(/ \(CELL_JOBS\).*/, '')), [
    'test/synthetic/drivers.test.cjs:45: declares sandbox:on for Bash, but the file never spells a sandbox settings literal with enabled: true (outside a comment); that cell is not driven by it',
    'test/synthetic/drivers.test.cjs:45: declares shell:bash for Bash, but the file never spells SHELL set to bash (outside a comment); that cell is not driven by it',
    'Bash x sandbox:on: on linux-x64-musl no CI job drives it',
    'Bash x shell:bash: on linux-x64-musl no CI job drives it',
  ]);
});

test('step 3 (b): an exemption past its `until` date is a finding naming its phase', () => {
  const r = scanCoverage(fixtureInputs({ today: '2026-10-12' }));
  assert.deepStrictEqual(r.findings, [], 'on its until date the exemption still holds');
  const late = scanCoverage(fixtureInputs({ today: '2026-10-13' }));
  // Glob's one entry, and each of Grep's per-cell entries (every Grep cell but print @ linux-x64-musl): exactly those.
  assert.deepStrictEqual(late.findings.map((f) => f.slice(0, f.indexOf(': '))), ['Glob',
    'Grep x print @ darwin-arm64/netbsd-arm64', 'Grep x interactive', 'Grep x permission:acceptEdits',
    'Grep x permission:bypassPermissions', 'Grep x permission:plan'], late.findings.join('\n'));
  assert.match(late.findings[0], /^Glob: its exemption expired on 2026-10-12 \(recorded 2026-09-28: "deferred: the Grep and Glob/);
  for (const f of late.findings.slice(1)) assert.match(f, /^Grep x [^ ]+(?: @ [^ ]+)?: its exemption expired on 2026-10-12 \(recorded 2026-09-28/);
  const phase = checkExemptionTable([{ tool: 'Read', reason: 'x', date: '2026-09-28', until: UNTIL_PHASE_A }], '2026-12-16');
  assert.match(phase[0], /^Read: its exemption expired on 2026-12-15 \(every-tool Phase A's deadline\)/);
});

test('an exemption must not cover a driven cell, may only name a registered tool, and one entry per cell', () => {
  const bash = { tool: 'Bash', reason: 'deferred: no reason at all', date: '2026-09-28', until: '2026-12-31' };
  const r = scanCoverage(fixtureInputs({ exemptions: [...FIXTURE_EXEMPTIONS.filter((e) => e.tool !== 'Bash'), bash] }));
  assert.deepStrictEqual(r.findings.map((f) => f.replace(/ \(.*/, '')), [
    `Bash x print @ ${FX_ENGINE}: exempted`, `Bash x sandbox:on @ ${FX_ENGINE}: exempted`, `Bash x shell:bash @ ${FX_ENGINE}: exempted`]);
  assert.match(r.findings[0], /but driven by fixture-job: test\/synthetic\/drivers\.test\.cjs:15; narrow the exemption$/);
  const gone = { ...bash, tool: 'Zebra' };
  const g = scanCoverage(fixtureInputs({ exemptions: [...FIXTURE_EXEMPTIONS, gone] }));
  assert.strictEqual(g.findings.length, 1, g.findings.join('\n'));
  assert.match(g.findings[0], /^Zebra: exempted, but the carve does not register a tool of that name/);
  const alias = { ...bash, tool: 'Task' };
  const a = scanCoverage(fixtureInputs({ exemptions: [...FIXTURE_EXEMPTIONS, alias] }));
  assert.match(a.findings.join('\n'), /^Task: exempted, but Task is an alias of Agent/m);
  const twice = scanCoverage(fixtureInputs({ exemptions: [...FIXTURE_EXEMPTIONS, { ...bash, tool: 'Monitor', modes: ['print'] }] }));
  assert.match(twice.findings.join('\n'), /^Monitor x print @ darwin-arm64: exempted by two entries/m);
  const odd = scanCoverage(fixtureInputs({ exemptions: [...FIXTURE_EXEMPTIONS, { ...bash, tool: 'Read', modes: ['shell:zsh'], engines: ['haiku-x64'] }] }));
  assert.match(odd.findings.join('\n'), /^Read x shell:zsh @ haiku-x64: exempts shell:zsh, haiku-x64, not among its cells/m);
});

test('checkExemptionTable refuses a malformed, doubled or expired entry', () => {
  const ok = { tool: 'X', reason: 'deferred: a real reason', date: '2026-09-28', until: '2026-12-31' };
  assert.deepStrictEqual(checkExemptionTable([ok], '2026-09-28'), []);
  const bad = checkExemptionTable([
    { ...ok, reason: '' },
    { ...ok, tool: 'Y', date: '2026-9-28' },
    { ...ok, tool: 'Z', until: '2026-02-30' },
    { ...ok, tool: 'W', date: '2026-12-31', until: '2026-10-01' },
    { ...ok, tool: 'V', extra: 1 },
    ok,
    { ...ok, tool: 'U', modes: [] },
  ], '2026-09-28');
  assert.deepStrictEqual(bad.map((f) => f.replace(/:.*/, '')), ['X', 'Y', 'Z', 'W', 'V', 'U x ', 'X']);
  assert.match(bad[0], /no reason/);
  assert.match(bad[1], /date "2026-9-28" is not a YYYY-MM-DD date/);
  assert.match(bad[2], /until "2026-02-30" is not a YYYY-MM-DD date/);
  assert.match(bad[3], /until 2026-10-01 is before its date 2026-12-31/);
  assert.match(bad[4], /unknown key\(s\) extra/);
  assert.match(bad[5], /modes must be a non-empty array/);
  assert.match(bad[6], /exempted 2 times/);
});

test('the other engines are one dated exemption, and a shipping engine must be published', () => {
  const late = scanCoverage(fixtureInputs({ enginesExemption: { ...FX_ENGINES_EXEMPTION, date: '2026-09-01', until: '2026-09-27' } }));
  assert.match(late.findings.join('\n'), /^every other published engine: its exemption expired on 2026-09-27/m);
  const unpublished = scanCoverage(fixtureInputs({ published: ['darwin-arm64', 'linux-x64-musl'] }));
  assert.match(unpublished.findings.join('\n'), /^netbsd-arm64: a shipping engine that scripts\/tjs-legs\.mjs does not publish/m);
});

// LAPSED DEADLINES ARE TRUE RED. On 2026-11-18 every-tool Phase A's 2026-10-15 has passed, so
// this is red until the user re-dates Phase A or its 18 tools are driven (observability Task 1's
// ruling: carry the dates as set, never re-date them here).
test('the EXEMPTIONS table is well-formed and unexpired, with or without a carve', () => {
  assert.deepStrictEqual(checkExemptionTable(EXEMPTIONS, new Date().toISOString().slice(0, 10)), []);
});

test('every CELL_JOBS entry is a cell job in ci.yml, with or without a carve', () => {
  const r = checkJobs({ workflow: readWorkflow(), jobs: CELL_JOBS, sources: readSources(), engines: SHIPPING_ENGINES });
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.valid.length, CELL_JOBS.length);
});

test('the floor is BROKEN, never clean, when the carve has fewer cells than were measured', () => {
  const r = checkGate({ name: 'fixture', floor: CELL_FLOOR, read: () => fixtureInputs(), scan: scanCoverage });
  assert.strictEqual(r.verdict, BROKEN, r.message);
  assert.match(r.message, new RegExp(`examined ${MINI_CELLS}, floor is ${CELL_FLOOR}`));
  void VIOLATION; void OK;
});

guardTests(defineGuard({
  name: 'every-tool-driven',
  floor: CELL_FLOOR,
  read: readInputs,
  scan: scanCoverage,
  // The failure this ratchet exists for: the carve registers one more tool, and nothing drives it.
  control: () => fixtureInputs({ carve: miniCarve(ZEBRA) }),
}));

// ==========================================================================
// THE JOB'S OWN RUN
// ==========================================================================
test('checkJobRan: every claimed driver\'s test passed, on the job\'s engine', () => {
  const r = checkJobRan(fxJobRun());
  assert.deepStrictEqual(r.findings, []);
  assert.deepStrictEqual(r.ran, [
    'Bash x print @ linux-x64-musl <- test/synthetic/drivers.test.cjs:15',
    'Read x print @ linux-x64-musl <- test/synthetic/drivers.test.cjs:23',
    'Task x print @ linux-x64-musl <- test/synthetic/drivers.test.cjs:28',
    'Grep x print @ linux-x64-musl <- test/synthetic/drivers.test.cjs:35',
    'Bash x sandbox:on/shell:bash @ linux-x64-musl <- test/synthetic/drivers.test.cjs:45',
  ]);
});

test('checkJobRan refuses a failed, skipped or missing test, a run on another engine, and an unknown job', () => {
  const failed = checkJobRan(fxJobRun({ records: fxRecords({ 47: { type: 'test:fail' } }) }));
  assert.deepStrictEqual(failed.findings, ['test/synthetic/drivers.test.cjs:45 (Bash x sandbox:on/shell:bash @ linux-x64-musl): test '
    + '"bash, sandboxed, its control in a helper" (line 47) failed in fixture-job; a cell is driven only where its test passes']);
  const missing = checkJobRan(fxJobRun({ records: fxRecords().filter((x) => x.line !== 11) }));
  assert.match(missing.findings[0], /:15 \(Bash x print @ linux-x64-musl\): test "bash, scripted in place" \(line 11\) not run in fixture-job/);
  const twice = checkJobRan(fxJobRun({ records: [...fxRecords(), { ...fxRecords()[0], skip: 'second run' }] }));
  assert.match(twice.findings[0], /\(line 11\) skipped \(second run\) in fixture-job; a cell is driven only where its test passes \(no other passing test here drives Bash x print\)$/,
    'a test run twice passes only if both runs pass');
  // A skip whose every cell another passing driver drives here (one branch of a host fact) is no finding;
  // the same skip with the twin's test failed is.
  const twin = { file: 'test/synthetic/twin.test.cjs', text: lines(
    "const T = { name: 'Bash', input: { command: 'echo T-$((6*7))' }, id: 'toolu_t' };",
    "const ok = (m) => toolResultText(m, T.id).includes('T-42');",
    "test('one branch', async (t) => {",
    "  if (branch) { t.skip('the other branch'); return; }",
    '  assertFailsOnMissingOutput(ok, T);',
    '  await startMockAnthropic({ respond: () => cannedToolUseSSE(T.name, T.input, T.id) });',
    '});',
  ) };
  const twinJobs = [{ ...FX_JOBS[0], files: [...FX_JOBS[0].files, twin.file] }];
  const twinRun = (rec) => checkJobRan(fxJobRun({ jobs: twinJobs, sources: [...DRIVER_SOURCES, twin], records: [...fxRecords(), rec] }));
  assert.deepStrictEqual(twinRun({ type: 'test:pass', file: twin.file, line: 3, name: 'one branch', nesting: 0, skip: 'the other branch' }).findings, []);
  assert.match(twinRun({ type: 'test:fail', file: twin.file, line: 3, name: 'one branch', nesting: 0 }).findings[0],
    /twin\.test\.cjs:5 \(Bash x print @ linux-x64-musl\): test "one branch" \(line 3\) failed in fixture-job; a cell is driven only where its test passes$/,
    'a failure is never excused by a twin');
  const host = checkJobRan(fxJobRun({ host: { platform: 'darwin', arch: 'arm64' } }));
  assert.deepStrictEqual(host.findings, ['fixture-job claims linux-x64-musl, but runs on darwin-arm64']);
  assert.match(checkJobRan(fxJobRun({ job: 'nope' })).findings[0], /^CLODE_CELL_JOB=nope is not a job CELL_JOBS names/);
});

guardTests(defineGuard({
  name: 'cells-ran-in-ci-job',
  floor: 1,
  read: readJobRun,
  scan: checkJobRan,
  // The failure this exists for: a claimed driver's test skipped in its job, so the cell ran nowhere.
  control: () => fxJobRun({ records: fxRecords({ 11: { skip: 'no quaude' } }) }),
}));

// What the job's log shows (the guard prints only on failure): the cells it ran.
test('cells-ran-in-ci-job: the cells this CI job ran, listed', (t) => {
  const inputs = readJobRun();
  if ('skip' in inputs) { t.skip(inputs.skip); return; }
  const r = checkJobRan(inputs);
  t.diagnostic(r.note);
  for (const line of r.ran) t.diagnostic(line);
});

test('the cell matrix and the driver map, as the gate reads them', (t) => {
  const inputs = readInputs();
  if ('skip' in inputs) { t.skip(inputs.skip); return; }
  const r = scanCoverage(inputs);
  t.diagnostic(r.note);
  for (const line of r.matrix) t.diagnostic(line);
  for (const [name, ds] of [...r.declared].sort()) {
    for (const x of ds) {
      t.diagnostic(`${name} <- ${x.file}:${x.line} (${x.use}; ${x.modes.join('/')}; tests ${x.tests.map((s) => s.line).join(',') || 'none'})`
        + `${x.skips ? `, can skip: ${x.skips}` : ''}`);
    }
  }
  for (const x of r.foreign) t.diagnostic(`(not a registered tool) ${x.name} <- ${x.file}:${x.line}${x.skips ? `, can skip: ${x.skips}` : ''}`);
  for (const x of r.drivers.rejected) t.diagnostic(`(not a driver) ${x.file}:${x.line}: ${x.why}`);
});
