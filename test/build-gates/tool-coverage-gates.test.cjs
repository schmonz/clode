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
// A DRIVER (test/**/*.cjs|mjs and scripts/**/*.cjs|mjs|js; two files skipped by name,
// DRIVER_SCAN_SKIP) is a call `assertFailsOnMissingOutput(check, USE)` (Task 1's control) where
//   - USE is declared in that file as an object literal whose `name:` is a string literal: the
//     tool it drives, or an alias of it ('Task' drives Agent);
//   - check is declared in that file and reads the tool_result BY THAT OBJECT'S ID:
//     toolResult(x, USE.id) or toolResultText(x, USE.id), or the id's own spelling in USE (`ID`);
//   - the mock scripts that same object: cannedToolUseSSE(USE.name, ...)/toolUseSSE(USE.name, ...),
//     a mock rule `tool: USE`, or USE passed to a same-file function whose parameter is scripted
//     that way (driveBashTurn(bin, DENY)).
//   A driver CAN SKIP when its test is declared skipped (test.skip, a `{ skip }`/`{ todo }`
//   option), or when a skip( call follows the control inside its test (outside a test: to the end
//   of the top-level statement). A precondition skip belongs BEFORE the control; one after it can
//   depend on the outcome, which is how agentic-tools' Grep row reads a refusal as a skip.
//
// THE VERDICT, per registered tool, and on the table:
//   - driven by a driver that cannot skip: OK; also exempted: a finding (remove the exemption);
//   - only by drivers that can skip, or not at all: a finding, unless EXEMPTIONS names it;
//   - EXEMPTIONS: one entry per tool, exactly { tool, reason, date, until }; a non-empty reason;
//     YYYY-MM-DD dates, date <= until; past `until` (UTC date) it is a finding; a tool the carve
//     does not register, or an alias, is a finding.
//   examined = the tools registered; floor = TOOL_FLOOR.
//
// WHAT IT DOES NOT SEE, stated:
//   - whether a driver's turn runs quaude, naude or native: every driver in the tree runs quaude
//     (the map in the report), but the rule reads only the test's source;
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
const MODULE_HEADER = /import\.meta\.require = globalThis\.__quaudeRequire; import\.meta\.url = "file:\/\/([^"]+)";/g;
function splitModules(text) {
  const hits = [...text.matchAll(MODULE_HEADER)];
  const out = new Map();
  hits.forEach((h, k) => out.set(h[1], text.slice(h.index, k + 1 < hits.length ? hits[k + 1].index : text.length)));
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
      if (!args || args.length !== 2) { rejected.push({ ...at, why: 'the control is not called as (check, toolUse)' }); continue; }
      const [check, use] = args;
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
      drivers.push({ ...at, name, use, check, skips: skipOf(text, m, code, x.index, lineOf) });
    }
  }
  return { drivers, rejected, scanned, skipped };
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
// THE VERDICT
// ==========================================================================
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (s) => typeof s === 'string' && ISO_DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const EXEMPTION_KEYS = ['tool', 'reason', 'date', 'until'];

// The table's own shape, dates and expiry; needs no carve.
function checkExemptionTable(exemptions, today) {
  const out = [];
  const count = new Map();
  exemptions.forEach((e, k) => {
    const who = typeof e.tool === 'string' && e.tool ? e.tool : `exemption #${k + 1}`;
    const extra = Object.keys(e).filter((key) => !EXEMPTION_KEYS.includes(key));
    if (extra.length) out.push(`${who}: unknown key(s) ${extra.join(', ')}; an exemption is { ${EXEMPTION_KEYS.join(', ')} }`);
    if (typeof e.reason !== 'string' || !e.reason.trim()) out.push(`${who}: no reason; an exemption says why the tool is not driven`);
    const dOk = isIsoDate(e.date), uOk = isIsoDate(e.until);
    if (!dOk) out.push(`${who}: date "${e.date}" is not a YYYY-MM-DD date`);
    if (!uOk) out.push(`${who}: until "${e.until}" is not a YYYY-MM-DD date`);
    if (dOk && uOk && e.until < e.date) out.push(`${who}: until ${e.until} is before its date ${e.date}`);
    else if (uOk && today > e.until) {
      out.push(`${who}: its exemption expired on ${e.until} (recorded ${e.date}: "${e.reason}"); drive the tool, `
        + 'or renew the exemption with a new reason, date and until');
    }
    count.set(who, (count.get(who) || 0) + 1);
  });
  for (const [who, n] of count) if (n > 1) out.push(`${who}: exempted ${n} times; one entry per tool`);
  return out;
}

function scanCoverage({ carve, what, sources, exemptions, today }) {
  const reg = extractRegistry(carve);
  const { tools } = reg;
  const findings = [...reg.findings];
  const byAlias = new Map();
  for (const [name, t] of tools) for (const a of t.aliases) if (a) byAlias.set(a, name);
  const d = findDrivers(sources);
  const drivenBy = new Map();
  const foreign = [];
  for (const x of d.drivers) {
    const name = tools.has(x.name) ? x.name : byAlias.get(x.name);
    if (!name) { foreign.push(x); continue; }
    if (!drivenBy.has(name)) drivenBy.set(name, { firm: [], skipping: [] });
    drivenBy.get(name)[x.skips ? 'skipping' : 'firm'].push(x);
  }
  findings.push(...checkExemptionTable(exemptions, today));
  const exempt = new Map();
  for (const e of exemptions) {
    if (typeof e.tool !== 'string') continue;
    if (tools.has(e.tool)) exempt.set(e.tool, e);
    else if (byAlias.has(e.tool)) findings.push(`${e.tool}: exempted, but ${e.tool} is an alias of ${byAlias.get(e.tool)}; exempt the tool by its name`);
    else if (tools.size) findings.push(`${e.tool}: exempted, but the carve does not register a tool of that name (${what}); remove the exemption`);
  }
  const at = (xs) => xs.map((x) => `${x.file}:${x.line}`).sort().join(', ');
  let firm = 0, skipping = 0;
  for (const name of [...tools.keys()].sort()) {
    const dv = drivenBy.get(name) || { firm: [], skipping: [] };
    const e = exempt.get(name);
    if (dv.firm.length) {
      firm++;
      if (e) findings.push(`${name}: exempted (${e.date}, until ${e.until}) but driven by ${at(dv.firm)}; remove the exemption`);
      continue;
    }
    if (dv.skipping.length) skipping++;
    if (e) continue;
    if (dv.skipping.length) {
      findings.push(`${name}: its only driver(s) can skip on their own outcome (${dv.skipping.map((x) => `${x.file}:${x.line}, ${x.skips}`).join('; ')}), `
        + 'so a broken tool reads as a skip, never a failure: make the driver assert, or exempt the tool by name with that reason');
    } else {
      findings.push(`${name}: no end-to-end test drives it and judges its tool_result, and it has no exemption. Drive it `
        + '(a live check whose assertFailsOnMissingOutput control shares its tool_use object with the mock; '
        + 'scripts/lib/tool-result.cjs), or exempt it by name in EXEMPTIONS with a reason, a date and an until');
    }
  }
  const files = new Set(d.drivers.map((x) => x.file)).size;
  return { findings, examined: tools.size, tools, drivers: d, drivenBy, foreign,
    note: `${what}: ${reg.note}; ${firm} driven, ${skipping} driven only by a driver that can skip, ${exempt.size} `
      + `exempted; ${d.drivers.length} driver(s) in ${files} file(s), ${d.scanned + d.skipped} file(s) scanned, `
      + `${d.skipped} of them skipped by name` };
}

// ==========================================================================
// THE EXEMPTIONS: the undriven tools, as a dated to-do list
// ==========================================================================
// Measured 2026-09-28 on the 2.1.283 carves (darwin-arm64 and linux-amd64 register the same 90
// tools): 87 in getAllBaseTools, none added by getTools, and 3 registered outside it
// (SubagentHandback, ObserverReport, and the MCP template `mcp`). Less nothing: a carve that
// registers fewer is BROKEN until someone re-measures.
const TOOL_FLOOR = 90;
// Each gate below is read from the tool's registry element or its isEnabled() in that carve.
// UNTIL_TASK_11 is when the grep-native plan expects its Task 11 to have driven Grep and Glob
// (the design estimated three days for the whole plan from 2026-09-27; tasks 1-3 alone took two,
// so this allows about four times that). Task 11 deletes both entries; if it has not by then,
// the gate goes red and says the plan slipped. UNTIL_REVIEW is a quarterly re-decision for the
// rest: drive the tool, or renew its entry with a new reason and date.
const RECORDED = '2026-09-28';
const UNTIL_TASK_11 = '2026-10-12';
const UNTIL_REVIEW = '2026-12-31';
const GREP_GLOB_PLAN = 'deferred: the "Grep and Glob = native" plan (.superpowers/sdd/2026-09-27-grep-native); its Task 11 '
  + "drives this tool end to end against native's embedded rg and removes this entry. Until then quaude's rg translation "
  + 'answers wrongly in every mode (BACKLOG.md, "The Grep tool in quaude"). Registered only when named in --tools or '
  + '--allowedTools (searchToolsOptIn), under CLAUDE_CODE_ENTRYPOINT=local-agent, or with no Bash (Windows without Git Bash)';
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
const EXEMPTIONS = [
  // The plan's own two.
  { tool: 'Grep', reason: `${GREP_GLOB_PLAN}. Its one driver, agentic-tools' Grep row, skips on the rg --json refusal`,
    date: RECORDED, until: UNTIL_TASK_11 },
  { tool: 'Glob', reason: `${GREP_GLOB_PLAN}. Nothing drives it`, date: RECORDED, until: UNTIL_TASK_11 },
  // Local tools a canned mock could drive today: the to-do list proper.
  { tool: 'Read', reason: `${LOCAL}. floor-probe B4 and node-shim-agentic's Edit row script Read only to satisfy `
    + 'read-before-edit, and judge nothing it returns', date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'Write', reason: `${LOCAL}. agentic-tools' Write row and floor-probe C1 judge the file on disk, `
    + 'never the tool_result', date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'NotebookEdit', reason: LOCAL, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'TaskStop', reason: `${LOCAL} (it stops a background task; aliases KillShell, KillBash)`, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'TaskCreate', reason: `${LOCAL} (the task list; registered unless CLAUDE_CODE_ENABLE_TASKS=false)`, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'TaskGet', reason: `${LOCAL} (the task list; registered unless CLAUDE_CODE_ENABLE_TASKS=false)`, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'TaskUpdate', reason: `${LOCAL} (the task list; registered unless CLAUDE_CODE_ENABLE_TASKS=false)`, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'TaskList', reason: `${LOCAL} (the task list; registered unless CLAUDE_CODE_ENABLE_TASKS=false)`, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'TodoWrite', reason: 'deferred, no plan yet: a local tool, but enabled only when the Task* tools are off '
    + '(CLAUDE_CODE_ENABLE_TASKS=false), and no live check turns them off', date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'Skill', reason: `${LOCAL} (it needs a skill on disk)`, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'EnterWorktree', reason: `${LOCAL} (it needs a git repository)`, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ExitWorktree', reason: `${LOCAL} (it needs a git repository)`, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'CronCreate', reason: `${LOCAL} (scheduled prompts; on unless CLAUDE_CODE_DISABLE_CRON, GrowthBook `
    + 'tengu_kairos_cron defaults on)', date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'CronDelete', reason: `${LOCAL} (scheduled prompts; on unless CLAUDE_CODE_DISABLE_CRON, GrowthBook `
    + 'tengu_kairos_cron defaults on)', date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'CronList', reason: `${LOCAL} (scheduled prompts; on unless CLAUDE_CODE_DISABLE_CRON, GrowthBook `
    + 'tengu_kairos_cron defaults on)', date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ScheduleWakeup', reason: `${LOCAL} (the dynamic /loop's pacing)`, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ReportFindings', reason: `${LOCAL} (structured code-review findings)`, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'Workflow', reason: `${LOCAL} (alias RunWorkflow)`, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ListAgents', reason: `${LOCAL} (agent teams, on by default; an empty list is still a tool_result; alias `
    + 'ListPeers)', date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'SendMessage', reason: 'deferred, no plan yet: agent teams; a driver needs a teammate session to address',
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'SubagentHandback', reason: 'deferred, no plan yet: registered outside getAllBaseTools, for a subagent to '
    + 'report back with; agentic-subagent-diff drives Agent, but its subagent answers in text and never calls this tool',
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ObserverReport', reason: 'deferred, no plan yet: registered outside getAllBaseTools, for an observer agent only',
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'LSP', reason: "deferred, no plan yet: code intelligence through a configured language server (a plugin's LSP), "
    + 'which no live check sets up', date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'PowerShell', reason: 'deferred, no plan yet: registered on Windows (without Git Bash, or by the GrowthBook flag '
    + 'tengu_cobalt_ridge) or by CLAUDE_CODE_USE_POWERSHELL_TOOL, and needs PowerShell; no live check runs on the Windows '
    + 'legs', date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'WebFetch', reason: 'deferred, no plan yet: it fetches a URL and asks the model to read the page, so a driver '
    + 'needs a local HTTP server and a mock that answers that second request', date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'WebSearch', reason: "deferred, no plan yet: the search runs server-side (the API's web_search tool, for "
    + 'first-party and some cloud providers), so a canned mock would have to answer as that server tool',
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ToolSearch', reason: 'deferred, no plan yet: registered only in tool-search mode (ENABLE_TOOL_SEARCH, or a '
    + 'first-party endpoint that defers tools)', date: RECORDED, until: UNTIL_REVIEW },
  // Off in every -p turn.
  { tool: 'AskUserQuestion', reason: INTERACTIVE, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ExitPlanMode', reason: INTERACTIVE, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'EnterPlanMode', reason: `${INTERACTIVE} (its isEnabled is ExitPlanMode's)`, date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ProposeGoal', reason: 'deferred, no plan yet: off in every non-interactive (-p) session and in a remote '
    + 'workspace, and behind the GrowthBook flag tengu_propose_goal (default off)', date: RECORDED, until: UNTIL_REVIEW },
  // Off by default behind a GrowthBook flag.
  { tool: 'GetTask', reason: FLAG_OFF('tengu_violin_rosin', 'a local tool (it checks on a background shell)'),
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'Monitor', reason: FLAG_OFF('tengu_amber_sentinel', "a local tool (it streams a process's output)"),
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'PushNotification', reason: FLAG_OFF('tengu_kairos_push_notifications', "a notification to the user's "
    + 'terminal or phone'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'SendFile', reason: FLAG_OFF('tengu_send_file', 'files to another Claude Code session (agent teams)'),
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'EndConversation', reason: 'deferred, no plan yet: enabled only for the models and entrypoints a GrowthBook '
    + 'config lists (default off)', date: RECORDED, until: UNTIL_REVIEW },
  // claude.ai features.
  { tool: 'Projects', reason: CLAUDE_AI("the session's claude.ai project (allow_projects_tool, CLAUDE_PROJECT_UUID)"),
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'DesignSync', reason: CLAUDE_AI('claude.ai/design sync (allow_design_sync)'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ClaudeDesign', reason: CLAUDE_AI('claude.ai/design projects (allow_design_sync, and a GrowthBook flag, default off)'),
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'Artifact', reason: CLAUDE_AI('claude.ai-hosted artifact pages'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ArtifactComments', reason: CLAUDE_AI('an artifact add-on'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ArtifactData', reason: CLAUDE_AI('an artifact add-on'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ArtifactCheck', reason: CLAUDE_AI('an artifact add-on'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'AppifactRepl', reason: CLAUDE_AI('appifact SDK against an artifact, remote_cowork entrypoint only'),
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'RemoteTrigger', reason: CLAUDE_AI('scheduled cloud agent routines (claude.ai OAuth scopes, allow_remote_sessions)'),
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'SearchPlugins', reason: CLAUDE_AI('the plugin and skill directory'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'SearchSkills', reason: CLAUDE_AI('the plugin and skill directory'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'SuggestPluginInstall', reason: CLAUDE_AI('the plugin and skill directory'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'SuggestSkills', reason: CLAUDE_AI('the plugin and skill directory'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ListPlugins', reason: CLAUDE_AI('the plugin and skill directory'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ListSkills', reason: CLAUDE_AI('the plugin and skill directory'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ShareOnboardingGuide', reason: CLAUDE_AI('team onboarding share links (allow_team_onboarding, and the '
    + 'GrowthBook flag tengu_flint_harbor_share, default off)'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'memory_list', reason: 'deferred, no plan yet: memory stores, enabled only in the "tools" memory mode',
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'memory_read', reason: 'deferred, no plan yet: memory stores, enabled only in the "tools" memory mode',
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'memory_write', reason: 'deferred, no plan yet: memory stores, enabled only in the "tools" memory mode',
    date: RECORDED, until: UNTIL_REVIEW },
  // Remote and bridged sessions.
  { tool: 'SearchMcpRegistry', reason: REMOTE('MCP connectors (CLAUDE_CODE_REMOTE with a first-party endpoint)'),
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'SuggestConnectors', reason: REMOTE('MCP connectors (CLAUDE_CODE_REMOTE with a first-party endpoint)'),
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ListConnectors', reason: REMOTE('MCP connectors (CLAUDE_CODE_REMOTE with a first-party endpoint)'),
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ShowOnboardingRolePicker', reason: REMOTE('the Cowork onboarding role picker (CLAUDE_CODE_REMOTE)'),
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ReadNotifications', reason: REMOTE('queued external notifications (CLAUDE_CODE_REMOTE, or a session condition '
    + 'not decoded here)'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'FetchInboxMessage', reason: REMOTE('relayed inbox messages (a REPL or supervised bridge)'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'propose_skills', reason: REMOTE('skill proposals (CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE)'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'SendUserFile', reason: REMOTE('files to the user (first-party, allow_send_file)'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'SendUserMessage', reason: 'deferred, no plan yet: the brief channel to the user (alias Brief), enabled by '
    + 'pewter_owl_tool (an env var or a flag) or a brief or bridge mode', date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'Poll', reason: 'deferred, no plan yet: waits for queued harness events; enabled by session conditions not '
    + 'decoded here', date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'SendFeedback', reason: 'deferred, no plan yet: drafts a feedback report; enabled by a feedback setting not '
    + 'decoded here', date: RECORDED, until: UNTIL_REVIEW },
  // MCP.
  { tool: 'ListMcpResourcesTool', reason: MCP("it lists an MCP server's resources (alias ListMcpResources)"),
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ReadMcpResourceTool', reason: MCP('it reads one MCP resource (alias ReadMcpResource)'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'ReadMcpResourceDirTool', reason: MCP('it lists an MCP directory resource (alias ReadMcpResourceDir)'),
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'RefreshMcpTools', reason: MCP('it re-syncs MCP tool lists (and CLAUDE_CODE_ENABLE_REFRESH_MCP_TOOLS)'),
    date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'WaitForMcpServers', reason: MCP('it waits for MCP servers still connecting'), date: RECORDED, until: UNTIL_REVIEW },
  { tool: 'mcp', reason: MCP('the template every MCP server tool is copied from under its own mcp__server__tool name; '
    + 'the name "mcp" itself never reaches the model'), date: RECORDED, until: UNTIL_REVIEW },
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
let INPUTS = null;
function readInputs() {
  if (!INPUTS) {
    const c = readCarve();
    INPUTS = 'skip' in c ? c : { carve: c.text, what: c.what, sources: readSources(), exemptions: EXEMPTIONS,
      today: new Date().toISOString().slice(0, 10) };
  }
  return INPUTS;
}

// ==========================================================================
// FIXTURES
// ==========================================================================
const lines = (...ls) => ls.join('\n');
const HDR = (name) => `import.meta.require = globalThis.__quaudeRequire; import.meta.url = "file://${name}";`;
const NOOP_RESULT = 'mapToolResultToToolResultBlockParam(e,n){return{tool_use_id:n,content:e}}';

// A code-split carve in the shapes the 2.1.283 carve spells its registry with: tool objects built
// by a builder call whose `name:` is a string constant in ANOTHER chunk (import{...}from), a tool
// reached through a star import (`__clodeReq0.MonitorTool`) whose name sits in an object it
// SPREADS (the Monitor tool is `Ft({...De, ...})`), an alias list, a tool behind a function that
// returns null under a condition (`Ms`, ClaudeDesign's shape), conditional and filtered spreads,
// a `null` binding (a tool the build compiled out), and a tool object registered OUTSIDE
// getAllBaseTools (SubagentHandback) beside a dead one nothing references (TestingPermission).
function miniCarve({ extra = '', extraElement = '', getToolsBody = 'let n=Jw();if(uw())n=[...n,M0,L0];return n',
  outside = '' } = {}) {
  return lines(
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
    "test('a test declared skipped', { skip: DEFERRED }, async (t) => {",
    "  const MON = { name: 'Monitor', input: {}, id: 'toolu_m' };",
    "  const watched = (m) => toolResultText(m, MON.id).includes('line');",
    '  assertFailsOnMissingOutput(watched, MON);',
    '  const mock = await startMockAnthropic({ respond: () => cannedToolUseSSE(MON.name, MON.input, MON.id) });',
    '  assert.ok(watched(mock));',
    '});',
  ) },
];
const PLAN_REASON = 'deferred: the Grep and Glob = native plan (fixture)';
const FIXTURE_EXEMPTIONS = [
  { tool: 'Glob', reason: PLAN_REASON, date: '2026-09-28', until: '2026-10-12' },
  { tool: 'Grep', reason: PLAN_REASON, date: '2026-09-28', until: '2026-10-12' },
  { tool: 'Monitor', reason: 'deferred: gated off by default (fixture)', date: '2026-09-28', until: '2026-12-31' },
  { tool: 'SubagentHandback', reason: 'deferred: subagents only (fixture)', date: '2026-09-28', until: '2026-12-31' },
];
const fixtureInputs = (over = {}) => ({ carve: miniCarve(), what: 'the synthetic carve',
  sources: [...DRIVER_SOURCES, ...NEAR_MISS_SOURCES], exemptions: FIXTURE_EXEMPTIONS, today: '2026-09-28', ...over });

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

// ==========================================================================
// THE DRIVERS
// ==========================================================================
test('findDrivers finds each driver shape the tree uses, and no near miss', () => {
  const d = findDrivers([...DRIVER_SOURCES, ...NEAR_MISS_SOURCES]);
  const got = d.drivers.map((x) => `${x.name}@${x.file}:${x.line}${x.skips ? ` skips (${x.skips})` : ''}`).sort();
  assert.deepStrictEqual(got, [
    'Bash@scripts/synthetic-probe.mjs:8',
    'Bash@test/synthetic/drivers.test.cjs:15',
    'Grep@test/synthetic/drivers.test.cjs:35 skips (a skip after the control, line 37)',
    'Monitor@test/synthetic/near-misses.test.cjs:26 skips (the test is declared skipped)',
    'Read@test/synthetic/drivers.test.cjs:23',
    'Task@test/synthetic/drivers.test.cjs:28',
  ]);
  const why = d.rejected.map((x) => `${x.file}:${x.line} ${x.why}`).sort();
  assert.deepStrictEqual(why, [
    'test/synthetic/near-misses.test.cjs:15 the check (listed) reads the tool_result of GLOB.id, but GLOB is never scripted to a mock',
    'test/synthetic/near-misses.test.cjs:21 the tool_use is not a named object (an inline one cannot be the one the mock scripts)',
    'test/synthetic/near-misses.test.cjs:8 the check (edited) never reads the tool_result of EDIT.id',
  ]);
});

// ==========================================================================
// THE VERDICT
// ==========================================================================
test('scanCoverage: the fixture carve, its drivers and its exemptions cover every tool', () => {
  const r = scanCoverage(fixtureInputs());
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.examined, MINI_TOOLS.length);
});

test('step 3 (a): a carve with one more tool, and no driver or exemption, is exactly one finding', () => {
  const r = scanCoverage(fixtureInputs({ carve: miniCarve(ZEBRA) }));
  assert.strictEqual(r.findings.length, 1, r.findings.join('\n'));
  assert.match(r.findings[0], /^Zebra: no end-to-end test drives it/);
  assert.strictEqual(r.examined, MINI_TOOLS.length + 1);
});

test('step 3 (b): an exemption past its `until` date is a finding', () => {
  const r = scanCoverage(fixtureInputs({ today: '2026-10-12' }));
  assert.deepStrictEqual(r.findings, [], 'on its until date the exemption still holds');
  const late = scanCoverage(fixtureInputs({ today: '2026-10-13' }));
  assert.strictEqual(late.findings.length, 2, late.findings.join('\n'));
  assert.match(late.findings[0], /^Glob: its exemption expired on 2026-10-12 \(recorded 2026-09-28: "deferred: the Grep and Glob/);
  assert.match(late.findings[1], /^Grep: its exemption expired on 2026-10-12/);
});

test('a tool whose only driver skips on its own outcome needs an exemption', () => {
  const r = scanCoverage(fixtureInputs({ exemptions: FIXTURE_EXEMPTIONS.filter((e) => e.tool !== 'Grep') }));
  assert.strictEqual(r.findings.length, 1, r.findings.join('\n'));
  assert.match(r.findings[0], /^Grep: its only driver\(s\) can skip .*test\/synthetic\/drivers\.test\.cjs:35/);
});

test('an exemption must be removed once its tool is driven, and may only name a registered tool', () => {
  const bash = { tool: 'Bash', reason: 'deferred: no reason at all', date: '2026-09-28', until: '2026-12-31' };
  const r = scanCoverage(fixtureInputs({ exemptions: [...FIXTURE_EXEMPTIONS, bash] }));
  assert.strictEqual(r.findings.length, 1, r.findings.join('\n'));
  assert.match(r.findings[0], /^Bash: exempted .* but driven by scripts\/synthetic-probe\.mjs:8, test\/synthetic\/drivers\.test\.cjs:15; remove the exemption/);
  const gone = { ...bash, tool: 'Zebra' };
  const g = scanCoverage(fixtureInputs({ exemptions: [...FIXTURE_EXEMPTIONS, gone] }));
  assert.strictEqual(g.findings.length, 1, g.findings.join('\n'));
  assert.match(g.findings[0], /^Zebra: exempted, but the carve does not register a tool of that name/);
  const alias = { ...bash, tool: 'Task' };
  const a = scanCoverage(fixtureInputs({ exemptions: [...FIXTURE_EXEMPTIONS, alias] }));
  assert.match(a.findings.join('\n'), /^Task: exempted, but Task is an alias of Agent/m);
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
  ], '2026-09-28');
  assert.deepStrictEqual(bad.map((f) => f.replace(/:.*/, '')), ['X', 'Y', 'Z', 'W', 'V', 'X']);
  assert.match(bad[0], /no reason/);
  assert.match(bad[1], /date "2026-9-28" is not a YYYY-MM-DD date/);
  assert.match(bad[2], /until "2026-02-30" is not a YYYY-MM-DD date/);
  assert.match(bad[3], /until 2026-10-01 is before its date 2026-12-31/);
  assert.match(bad[4], /unknown key\(s\) extra/);
  assert.match(bad[5], /exempted 2 times/);
});

test('the EXEMPTIONS table is well-formed and unexpired, with or without a carve', () => {
  assert.deepStrictEqual(checkExemptionTable(EXEMPTIONS, new Date().toISOString().slice(0, 10)), []);
});

// Task 11 deletes this test together with the two entries. Its Grep driver must then assert with
// no skip after its control, or the gate still reads Grep as driven only by a driver that can skip.
test('Grep and Glob are exempted by this plan until the end of its Task 11, which removes them', () => {
  const plan = EXEMPTIONS.filter((e) => e.tool === 'Grep' || e.tool === 'Glob');
  assert.deepStrictEqual(plan.map((e) => e.tool).sort(), ['Glob', 'Grep']);
  for (const e of plan) {
    assert.match(e.reason, /2026-09-27-grep-native/);
    assert.match(e.reason, /Task 11/);
    assert.strictEqual(e.until, plan[0].until);
  }
});

test('the floor is BROKEN, never clean, when the carve registers fewer tools than were measured', () => {
  const r = checkGate({ name: 'fixture', floor: TOOL_FLOOR, read: () => fixtureInputs(), scan: scanCoverage });
  assert.strictEqual(r.verdict, BROKEN, r.message);
  assert.match(r.message, new RegExp(`examined ${MINI_TOOLS.length}, floor is ${TOOL_FLOOR}`));
  void VIOLATION; void OK;
});

guardTests(defineGuard({
  name: 'every-tool-driven',
  floor: TOOL_FLOOR,
  read: readInputs,
  scan: scanCoverage,
  // The failure this ratchet exists for: the carve registers one more tool, and nothing drives it.
  control: () => fixtureInputs({ carve: miniCarve(ZEBRA) }),
}));

test('the driver map, as the gate reads it', (t) => {
  const inputs = readInputs();
  if ('skip' in inputs) { t.skip(inputs.skip); return; }
  const r = scanCoverage(inputs);
  t.diagnostic(r.note);
  for (const [name, dv] of [...r.drivenBy].sort()) {
    for (const x of [...dv.firm, ...dv.skipping]) t.diagnostic(`${name} <- ${x.file}:${x.line} (${x.use})${x.skips ? `, can skip: ${x.skips}` : ''}`);
  }
  for (const x of r.foreign) t.diagnostic(`(not a registered tool) ${x.name} <- ${x.file}:${x.line}${x.skips ? `, can skip: ${x.skips}` : ''}`);
  for (const x of r.drivers.rejected) t.diagnostic(`(not a driver) ${x.file}:${x.line}: ${x.why}`);
});
