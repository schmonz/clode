'use strict';
// bundle-spawn-scan: every place a test SPAWNS THE BUNDLE, found by WHAT IS SPAWNED, and the environment that spawn
// hands it (grep-native Task 10b fix round 2, ruling G32; the guard is test/bundle-home-hermetic.test.cjs).
//
// WHAT "THE BUNDLE" IS. A few SEEDS name it, and everything else is DERIVED from them:
//   - the environment variables that hold its binaries (CLODE_PROVIDER_BIN and its platform kin, CLODE_CLAUDE_BIN,
//     CLODE_QUAUDE, CLODE_QUAUDE_EXE, CLODE_NAUDE);
//   - a path whose leaf is its staged entry or a built product: `cli.cjs`, `quaude`, `naude`, `quaude.exe`,
//     `naude.exe`, `quaude-from-native`.
// A small symbolic evaluator follows values through every JS file under test/: bindings (const/let/var, destructuring,
// for-of, `x.push(...)`), helper functions (their parameters bound to the call's arguments, in this file or one it
// requires), `path.join`/`path.resolve`, object and array literals with their spreads, `a || b`, `a ? b : c`.
// So providerBin(), stageCli(...).cli, builtQuaude().path, quaudeExe() and every wrapper of them are DERIVED to be the
// bundle; none is listed.
//
// WHAT A BUNDLE SPAWN IS. A child_process spawn (spawn, spawnSync, execFile, execFileSync, fork, exec, execSync, and
// any local name bound to one of them) whose COMMAND is the bundle, or whose argv runs it: the SCRIPT position (the
// first argument that is not an option, `run`, or the tjs loader: `node cli.cjs`, `tjs run loader.cjs cli.cjs`), or
// the command line after a `--` (a pty driver's). A function whose spawn's command or script is one of its own
// parameters is a LAUNCHER at that parameter (runNative(bin), bootP(cli), doctor(bin), runQuaudeModel(cli),
// capture(sbx, { cmd: [bin] })...), and a call of a launcher that hands it the bundle is a bundle spawn too, judged with
// the launcher's parameters bound to that call's arguments.
//
// WHAT IS JUDGED: the env the bundle gets, followed the same way (plus Object.assign and member writes such as
// `env.HOME = x`, `delete env.HOME`). It must give the bundle a HOME that is not the developer's and, when it spreads
// process.env (which may carry an ambient CLAUDE_CONFIG_DIR), a CLAUDE_CONFIG_DIR of its own. A finding:
//   - no env (the child inherits the real HOME);
//   - HOME, USERPROFILE or CLAUDE_CONFIG_DIR taken from process.env or os.homedir(), in any spelling;
//   - a process.env spread AFTER the throwaway home (it restores the real one);
//   - an env built from nothing that sets no HOME (the bundle then asks the OS for the real one);
//   - an env the evaluator cannot follow (build it so it can be read: that is the point).
// Comments are stripped first; string and template contents are masked from the structural matching, so code quoted
// inside a string (a carve snippet, a fixture) is never read as code.
const path = require('node:path');
const { stripComments } = require('./strip-comments.cjs');

const SEED_VAR = /^CLODE_(?:PROVIDER_BIN|DARWIN_PROVIDER_BIN|LINUX_PROVIDER_BIN|CLAUDE_BIN|QUAUDE|QUAUDE_EXE|NAUDE|NAUDE_BIN)$/;
const SEED_LEAF = /(?:^|[/\\])(?:cli\.cjs|quaude|naude|quaude\.exe|naude\.exe|quaude-from-native)$/;
const SPAWN_FNS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']);
const NODE_VALUE_FLAGS = new Set(['--require', '-r', '--import', '--loader', '--experimental-loader', '--conditions', '-C']);
const NODE_NO_SCRIPT = new Set(['-e', '--eval', '-p', '--print']);
const HOME_KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR'];
const REAL_HOME = /process\.env\s*(?:\.\s*(?:HOME|USERPROFILE|CLAUDE_CONFIG_DIR)\b|\[\s*['"`](?:HOME|USERPROFILE|CLAUDE_CONFIG_DIR)['"`]\s*\])|(?<![\w$])(?:os\s*\.\s*)?homedir\s*\(/;
const KEYWORDS = new Set(('break case catch class const continue debugger default delete do else export extends finally for '
  + 'function if import in instanceof let new return super switch this throw try typeof var void while with yield async await '
  + 'of null undefined true false').split(' '));

// ---- lexing ---------------------------------------------------------------------------------------------------------
const OPEN = { '(': ')', '[': ']', '{': '}' };
function skipString(t, i) {
  const q = t[i];
  for (let j = i + 1; j < t.length; j++) {
    if (t[j] === '\\') { j++; continue; }
    if (q === '`' && t[j] === '$' && t[j + 1] === '{') { j = matchClose(t, j + 1); continue; }
    if (t[j] === q) return j + 1;
    if (q !== '`' && t[j] === '\n') return j;
  }
  return t.length;
}
function matchClose(t, i) {
  const stack = [OPEN[t[i]]];
  for (let j = i + 1; j < t.length; j++) {
    const c = t[j];
    if (c === '"' || c === '\'' || c === '`') { j = skipString(t, j) - 1; continue; }
    if (OPEN[c]) stack.push(OPEN[c]);
    else if (c === ')' || c === ']' || c === '}') { stack.pop(); if (!stack.length) return j; }
  }
  return t.length;
}
// string and template CONTENTS blanked (quotes kept), lengths kept: structure is matched here, values sliced from t
function maskStrings(t) {
  const out = t.split('');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c !== '"' && c !== '\'' && c !== '`') continue;
    const e = skipString(t, i);
    for (let j = i + 1; j < e - 1; j++) if (out[j] !== '\n') out[j] = ' ';
    i = e - 1;
  }
  return out.join('');
}
function splitTop(s, sep = ',') {
  const out = [];
  let depth = 0, from = 0;
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === '\'' || c === '`') { j = skipString(s, j) - 1; continue; }
    if (OPEN[c]) depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === sep && depth === 0) { out.push(s.slice(from, j)); from = j + 1; }
  }
  out.push(s.slice(from));
  return out.map((x) => x.trim()).filter((x) => x !== '');
}
function exprEnd(t, i) {
  for (let j = i; j < t.length; j++) {
    const c = t[j];
    if (c === '"' || c === '\'' || c === '`') { j = skipString(t, j) - 1; continue; }
    if (OPEN[c]) { j = matchClose(t, j); continue; }
    if (c === ')' || c === ']' || c === '}' || c === ';' || c === ',') return j;
    if (c === '\n') {
      const before = t.slice(i, j).trimEnd();
      const after = t.slice(j + 1);
      if (/[=+\-*/%&|^!<>?:,(]$/.test(before)) continue;
      if (/^\s*(?:[.?:+\-*/%&|^,)\]}]|\?\?|\|\||&&)/.test(after)) continue;
      return j;
    }
  }
  return t.length;
}
const lineOf = (t, i) => t.slice(0, i).split('\n').length;
const short = (s) => JSON.stringify(String(s).replace(/\s+/g, ' ').slice(0, 90));
const unquote = (s) => s.slice(1, -1);
const isStr = (s) => /^(['"])(?:\\.|(?!\1)[^\\\n])*\1$/.test(s) || /^`[^`]*`$/.test(s);

// ---- one file -------------------------------------------------------------------------------------------------------
function parseNames(pat) {
  pat = pat.trim();
  if (pat[0] === '[') return splitTop(pat.slice(1, -1)).map((x, index) => ({ name: x.replace(/=[\s\S]*$/, '').replace(/^\.\.\./, '').trim(), index }));
  if (pat[0] === '{') {
    return splitTop(pat.slice(1, -1)).map((x) => {
      const m = /^(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?/.exec(x);
      return m ? { name: m[2] || m[1], key: m[1] } : null;
    }).filter(Boolean);
  }
  const m = /^([A-Za-z_$][\w$]*)/.exec(pat);
  return m ? [{ name: m[1] }] : [];
}
function parseFile(file, src) {
  const t = stripComments(src), mk = maskStrings(t);
  const bindings = [], members = [], fns = [], calls = [], requires = new Map();
  for (const m of mk.matchAll(/\b(?:const|let|var)\s+(?=[[{A-Za-z_$])/g)) {
    const p = m.index + m[0].length;
    const patEnd = (mk[p] === '[' || mk[p] === '{') ? matchClose(mk, p) + 1 : p + /^[A-Za-z_$][\w$]*/.exec(mk.slice(p))[0].length;
    const rest = mk.slice(patEnd);
    const eq = /^\s*=(?![=>])\s*/.exec(rest), of = /^\s+of\s+/.exec(rest);
    if (!eq && !of) continue;
    const rs = patEnd + (eq || of)[0].length;
    const re = of ? matchClose(mk, mk.lastIndexOf('(', m.index)) : exprEnd(mk, rs);
    const rhs = t.slice(rs, re);
    for (const n of parseNames(t.slice(p, patEnd))) bindings.push({ name: n.name, at: m.index, rhs, rhsAt: rs, key: n.key, index: n.index, elem: !!of });
    const req = /^require\(\s*(['"`])([^'"`]+)\1\s*\)$/.exec(rhs.trim());
    if (req) for (const n of parseNames(t.slice(p, patEnd))) requires.set(n.name, { spec: req[2], key: n.key || null });
  }
  for (const m of mk.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])/g)) {
    if (KEYWORDS.has(m[1]) || /\b(?:const|let|var)\s+$/.test(mk.slice(Math.max(0, m.index - 12), m.index))) continue;
    const prev = mk.slice(0, m.index).trimEnd().slice(-1);
    if (prev === '(' || prev === ',' || prev === '{' || prev === '[') continue;
    const rs = m.index + m[0].length;
    bindings.push({ name: m[1], at: m.index, rhs: t.slice(rs, exprEnd(mk, rs)), rhsAt: rs });
  }
  for (const m of mk.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\.push\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    bindings.push({ name: m[1], at: m.index, rhs: `[${t.slice(open + 1, matchClose(mk, open))}]`, rhsAt: open, push: true });
  }
  for (const m of mk.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(['"`])\s*\3?)\s*=(?![=>])\s*/g)) {
    // x.KEY = v (and x['KEY'] = v: the key is read from the unmasked text)
    let key = m[2];
    if (!key) { const k = /\[\s*['"`]([A-Za-z_$][\w$]*)['"`]\s*\]/.exec(t.slice(m.index, m.index + m[0].length + 40)); key = k && k[1]; }
    if (!key) continue;
    const rs = m.index + m[0].length;
    members.push({ name: m[1], at: m.index, key, value: t.slice(rs, exprEnd(mk, rs)) });
  }
  for (const m of mk.matchAll(/\bdelete\s+([A-Za-z_$][\w$]*)\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[)/g)) {
    const k = m[2] || ((/\[\s*['"`]([A-Za-z_$][\w$]*)['"`]/.exec(t.slice(m.index, m.index + 80)) || [])[1]);
    if (k) members.push({ name: m[1], at: m.index, key: k, del: true });
  }
  for (const m of mk.matchAll(/\bObject\.assign\s*\(\s*([A-Za-z_$][\w$]*)\s*,/g)) {
    const open = mk.indexOf('(', m.index);
    members.push({ name: m[1], at: m.index, assign: splitTop(t.slice(open + 1, matchClose(mk, open))).slice(1) });
  }
  const fnAt = (name, at, paramsText, bodyStart) => {
    const params = splitTop(paramsText).map((x, i) => {
      x = x.replace(/^\.\.\./, '');
      if (x[0] === '{') return { i, keys: parseNames(x.replace(/=\s*\{\s*\}\s*$/, '')) };
      const n = /^([A-Za-z_$][\w$]*)/.exec(x);
      return { i, name: n ? n[1] : null };
    });
    let body, exprBody = false;
    if (mk[bodyStart] === '{') body = t.slice(bodyStart, matchClose(mk, bodyStart) + 1);
    else { body = t.slice(bodyStart, exprEnd(mk, bodyStart)); exprBody = true; }
    const returns = exprBody ? [{ expr: body, at: bodyStart }] : [...mk.slice(bodyStart, bodyStart + body.length).matchAll(/\breturn\b[ \t]*/g)].map((r) => {
      const s = bodyStart + r.index + r[0].length;
      return { expr: t.slice(s, exprEnd(mk, s)), at: s };
    }).filter((r) => r.expr.trim());
    const f = { name, at, params, bodyAt: bodyStart, end: bodyStart + body.length, returns, file };
    fns.push(f);
    for (const q of params) {
      if (q.keys) for (const k of q.keys) bindings.push({ name: k.name, at: bodyStart, param: { fn: f, i: q.i, key: k.key } });
      else if (q.name) bindings.push({ name: q.name, at: bodyStart, param: { fn: f, i: q.i } });
    }
  };
  for (const m of mk.matchAll(/\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/g)) {
    const open = m.index + m[0].length - 1, close = matchClose(mk, open);
    const bodyStart = close + 1 + mk.slice(close + 1).search(/\S/);
    if (mk[bodyStart] !== '{') continue;
    let name = m[1];
    if (!name) { const b = /([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?$/.exec(mk.slice(Math.max(0, m.index - 80), m.index)); name = b ? b[1] : null; }
    fnAt(name, m.index, t.slice(open + 1, close), bodyStart);
  }
  for (const m of mk.matchAll(/(?:(?<![\w$])(?:async\s*)?(\((?:[^()]|\([^()]*\))*\))|(?<![\w$.])([A-Za-z_$][\w$]*))\s*=>\s*/g)) {
    const paramsText = m[1] ? t.slice(m.index + m[0].indexOf('(') + 1, m.index + m[0].indexOf('(') + m[1].length - 1) : m[2];
    const b = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?$/.exec(mk.slice(Math.max(0, m.index - 80), m.index));
    fnAt(b ? b[1] : null, m.index, paramsText, m.index + m[0].length);
  }
  for (const m of mk.matchAll(/(?<![\w$])((?:[A-Za-z_$][\w$]*\s*\.\s*)*)([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (KEYWORDS.has(m[2]) || /\bfunction\s*\*?\s*$/.test(mk.slice(Math.max(0, m.index - 12), m.index))) continue;
    const open = m.index + m[0].length - 1;
    calls.push({ name: m[2], qual: m[1].replace(/\s/g, ''), at: m.index, argsAt: open + 1, args: splitTop(t.slice(open + 1, matchClose(mk, open))) });
  }
  return { file, t, mk, bindings, members, fns, calls, requires };
}

// ---- the evaluator ----------------------------------------------------------------------------------------------------
// Values: bundle | param {fn, i, key} | array {items} | object {items} | processEnv | absent | lit {s} | opaque {why}.
// items: [{ x, f, at, stack }] (x an element or property source, spreads as `...e`).
function analyze(files) {
  const parsed = new Map(files.map(({ file, src }) => [file, parseFile(file, src)]));
  const P = (f) => parsed.get(f);
  const enclosing = (p, at) => {
    let best = null;
    for (const f of p.fns) if (f.bodyAt <= at && at < f.end && (!best || f.bodyAt > best.bodyAt)) best = f;
    return best;
  };
  const resolve = (p, name, at) => {
    let best = null;
    for (const b of p.bindings) {
      if (b.name !== name || b.push) continue;
      if (b.param && !(b.param.fn.bodyAt <= at && at < b.param.fn.end)) continue;
      if (b.at <= at && (!best || b.at >= best.at)) best = b;
    }
    return best || p.bindings.find((b) => b.name === name && !b.param && !b.push) || null;
  };
  const requiredFile = (p, spec) => {
    if (!/^\.\.?\//.test(spec)) return null;
    let r = path.posix.normalize(path.posix.join(path.posix.dirname(p.file), spec));
    for (const c of [r, `${r}.cjs`, `${r}.js`, `${r}/index.cjs`]) if (parsed.has(c)) return c;
    return null;
  };
  // the function a call names: local, or one a required module exports by that name
  const fnFor = (p, name, qual) => {
    if (qual) {
      const obj = qual.replace(/\.$/, '').split('.')[0];
      const rq = p.requires.get(obj);
      if (rq && !rq.key) { const f = requiredFile(p, rq.spec); return f ? P(f).fns.find((g) => g.name === name) || null : null; }
      return null;
    }
    const local = p.fns.find((g) => g.name === name);
    if (local) return local;
    const rq = p.requires.get(name);
    if (rq && rq.key) { const f = requiredFile(p, rq.spec); return f ? P(f).fns.find((g) => g.name === rq.key) || null : null; }
    return null;
  };
  const isCpPrimitive = (p, c) => {
    if (!SPAWN_FNS.has(c.name)) return false;
    if (c.qual) {
      const obj = c.qual.replace(/\.$/, '');
      if (/^require\(/.test(obj)) return true;
      const rq = p.requires.get(obj);
      if (rq && /^(?:node:)?child_process$/.test(rq.spec) && !rq.key) return true;
      const b = resolve(p, obj, c.at);
      return !!(b && !b.param && /child_process/.test(b.rhs));
    }
    const rq = p.requires.get(c.name);
    if (rq && /^(?:node:)?child_process$/.test(rq.spec)) return true;
    const b = resolve(p, c.name, c.at);
    return !!(b && !b.param && /child_process/.test(b.rhs));
  };
  const memo = new Map();
  function ev(p, expr, at, stack, depth = 0) {
    expr = String(expr).trim().replace(/^await\s+/, '');
    if (depth > 24) return { kind: 'opaque', why: 'too deep' };
    if (!expr) return { kind: 'absent' };
    if (OPEN[expr[0]] === ')' && matchClose(expr, 0) === expr.length - 1) return ev(p, expr.slice(1, -1), at + 1, stack, depth + 1);
    const tern = topTernary(expr);
    if (tern) {
      const a = ev(p, tern[1], at, stack, depth + 1), b = ev(p, tern[2], at, stack, depth + 1);
      return pick(a, b);
    }
    const or = topOr(expr);
    if (or) {
      const a = ev(p, or[0], at, stack, depth + 1);
      if (a.kind === 'bundle' || a.kind === 'object' || a.kind === 'array' || a.kind === 'processEnv') return a;
      return pick(a, ev(p, or[1], at, stack, depth + 1));
    }
    if (isStr(expr)) { const s = unquote(expr); return SEED_LEAF.test(s) ? { kind: 'bundle' } : { kind: 'lit', s }; }
    if (/^-?\d/.test(expr)) return { kind: 'lit', s: expr };
    if (expr === 'undefined' || expr === 'null') return { kind: 'absent' };
    if (expr[0] === '[' && matchClose(expr, 0) === expr.length - 1) return { kind: 'array', items: splitTop(expr.slice(1, -1)).map((x) => ({ x, p, at, stack })) };
    if (expr[0] === '{' && matchClose(expr, 0) === expr.length - 1) return { kind: 'object', items: splitTop(expr.slice(1, -1)).map((x) => ({ x, p, at, stack })) };
    if (/^process\s*\.\s*env$/.test(expr)) return { kind: 'processEnv' };
    const envv = /^(?:process\s*\.\s*)?env\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"`]([A-Za-z_$][\w$]*)['"`]\s*\])$/.exec(expr)
      || /^[A-Za-z_$][\w$]*\s*\.\s*(CLODE_[A-Z_]+)$/.exec(expr);
    if (envv) { const k = envv[1] || envv[2]; if (SEED_VAR.test(k)) return { kind: 'bundle' }; if (/^process/.test(expr)) return { kind: 'lit', s: `$${k}` }; }
    const id = /^([A-Za-z_$][\w$]*)$/.exec(expr);
    if (id) return evIdent(p, id[1], at, stack, depth);
    // member access / indexing: A.B, A[0], A['k'], f(...).B
    const mem = /^([\s\S]+?)\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(\d+|['"`][A-Za-z_$][\w$]*['"`])\s*\])$/.exec(expr);
    if (mem && balanced(mem[1]) && !/\($/.test(mem[1])) {
      const key = mem[2] || (mem[3] && (/^\d/.test(mem[3]) ? Number(mem[3]) : unquote(mem[3])));
      if (typeof key === 'string' && SEED_VAR.test(key)) return { kind: 'bundle' };
      const o = ev(p, mem[1], at, stack, depth + 1);
      return prop(o, key, depth);
    }
    // an array method that keeps the array's own elements: found.filter(...), xs.slice(1)
    const keep = /^([\s\S]+?)\s*\.\s*(?:filter|slice|sort|reverse|concat|flat)\s*\(/.exec(expr);
    if (keep && balanced(keep[1]) && matchClose(expr, keep[0].length - 1) === expr.length - 1) {
      const base = ev(p, keep[1], at, stack, depth + 1);
      if (base.kind === 'array' || base.kind === 'bundle') return base;
    }
    // require('./x.cjs').fn(args): the module's own function
    const rq = /^require\(\s*(['"`])([^'"`]+)\1\s*\)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(expr);
    if (rq && matchClose(expr, rq[0].length - 1) === expr.length - 1) {
      const f = requiredFile(p, rq[2]);
      const g = f && P(f).fns.find((h) => h.name === rq[3]);
      if (!g) return { kind: 'opaque', why: `${rq[3]}() of ${rq[2]} is not a function the scan can read` };
      return callValue(g, splitTop(expr.slice(rq[0].length, -1)), p, at, stack, depth);
    }
    const call = /^((?:[A-Za-z_$][\w$]*\s*\.\s*)*)([A-Za-z_$][\w$]*)\s*\(/.exec(expr);
    if (call && matchClose(expr, call[0].length - 1) === expr.length - 1) {
      const args = splitTop(expr.slice(call[0].length, -1));
      const qual = call[1].replace(/\s/g, '');
      if (/^path\.$/.test(qual) && /^(?:join|resolve|normalize)$/.test(call[2])) {
        const vs = args.map((a) => ev(p, a, at, stack, depth + 1));
        if (vs.some((v) => v.kind === 'bundle')) return { kind: 'bundle' };
        const ps = vs.find((v) => v.kind === 'param');
        return ps || { kind: 'lit', s: vs.map((v) => (v.kind === 'lit' ? v.s : '')).filter(Boolean).join('/') };
      }
      if (qual === 'Object.' && call[2] === 'assign') return { kind: 'object', items: args.map((a) => ({ x: `...${a}`, p, at, stack })) };
      const g = fnFor(p, call[2], qual);
      if (!g) {
        // a function the scan cannot read, or a caller-supplied one (an argv builder handed in as a parameter): what it
        // returns is the bundle when it is handed the bundle, or a path named after it (seaBin(REPO, 'naude'))
        const vs = args.map((a) => ev(p, a, at, stack, depth + 1));
        if (vs.some((v) => v.kind === 'bundle')) return { kind: 'bundle' };
        return { kind: 'opaque', why: `${qual}${call[2]}() is not a function the scan can read` };
      }
      return callValue(g, args, p, at, stack, depth);
    }
    return { kind: 'opaque', why: `${short(expr)} cannot be followed` };
  }
  function callValue(g, args, p, at, stack, depth) {
    {
      const st = new Map(stack); st.set(g, { p, args, at, stack });
      const gp = P(g.file);
      const vs = g.returns.map((r) => ev(gp, r.expr, r.at, st, depth + 1));
      if (vs.some((v) => v.kind === 'bundle')) return { kind: 'bundle' };
      // several returns: the LAST array is the function's ordinary answer (an early return is its special case:
      // engineSpawn's trampoline, apeCmd's pass-through)
      const arrs = vs.filter((v) => v.kind === 'array');
      if (arrs.length) return arrs[arrs.length - 1];
      const objs = vs.filter((v) => v.kind === 'object');
      if (objs.length > 1) return { kind: 'object', items: objs.flatMap((v) => v.items), alts: objs };
      if (objs.length) return objs[0];
      const prm = vs.find((v) => v.kind === 'param');
      if (prm) return prm;
      if (!g.returns.length) return { kind: 'absent' };
      return vs.find((v) => v.kind === 'processEnv') || { kind: 'opaque', why: `${g.name}() returns nothing the scan can read` };
    }
  }
  function evIdent(p, name, at, stack, depth) {
    const b = resolve(p, name, at);
    if (!b) return { kind: 'opaque', why: `${name} is not bound here` };
    if (b.param) {
      const fr = stack.get(b.param.fn);
      if (!fr) return { kind: 'param', fn: b.param.fn, i: b.param.i, key: b.param.key || null };
      const arg = fr.args[b.param.i];
      const v = arg === undefined ? { kind: 'absent' } : ev(fr.p, arg, fr.at, fr.stack, depth + 1);
      return b.param.key ? prop(v, b.param.key, depth) : v;
    }
    // a name destructured from require('./x'): that module's own binding of it
    const rq = /^require\(\s*(['"`])([^'"`]+)\1\s*\)$/.exec(String(b.rhs).trim());
    if (rq && b.key) {
      const f = requiredFile(p, rq[2]);
      if (!f) return { kind: 'opaque', why: `${name} comes from ${rq[2]}, outside test/` };
      const q = P(f), qb = resolve(q, b.key, q.t.length);
      return qb && !qb.param ? ev(q, qb.rhs, qb.rhsAt, new Map(), depth + 1) : { kind: 'opaque', why: `${b.key} is not a binding of ${f}` };
    }
    const key = `${p.file}:${b.at}:${b.name}`;
    if (!stack.size && memo.has(key)) return memo.get(key);
    if (!stack.size) memo.set(key, { kind: 'opaque', why: 'a cycle' });
    let v = ev(p, b.rhs, b.rhsAt, stack, depth + 1);
    if (b.key !== undefined && b.key !== null) v = prop(v, b.key, depth);
    else if (b.index !== undefined) v = prop(v, b.index, depth);
    else if (b.elem) v = v.kind === 'array' ? anyItem(v, depth) : v;
    if (v.kind === 'array') {
      const pushes = p.bindings.filter((q) => q.push && q.name === name && q.at > b.at && q.at < at + 1e9);
      const home = enclosing(p, b.at);
      const pushed = (q) => {
        // pushed from inside a closure (`const add = (x) => found.push(x); add(env.CLODE_PROVIDER_BIN)`): what its
        // callers hand it
        const f = enclosing(p, q.at);
        const xs = splitTop(q.rhs.slice(1, -1));
        if (!f || f === home || !f.name) return xs.map((x) => ({ x, p, at: q.rhsAt, stack }));
        return xs.flatMap((x) => {
          const pb = resolve(p, x.trim(), q.at);
          if (!pb || !pb.param || pb.param.fn !== f) return [{ x, p, at: q.rhsAt, stack }];
          return p.calls.filter((c) => c.name === f.name && !c.qual).map((c) => ({ x: c.args[pb.param.i] || 'undefined', p, at: c.argsAt, stack }));
        });
      };
      if (pushes.length) v = { kind: 'array', items: [...v.items, ...pushes.flatMap(pushed)] };
    }
    if (v.kind === 'object' || (v.kind === 'processEnv')) {
      const ms = p.members.filter((m) => m.name === name && m.at > b.at && m.at < at);
      if (ms.length) {
        const base = v.kind === 'processEnv' ? [{ x: '...process.env', p, at: b.at, stack }] : v.items;
        const items = base.slice();
        for (const m of ms) {
          if (m.assign) for (const x of m.assign) items.push({ x: `...${x}`, p, at: m.at, stack });
          else items.push({ x: `${m.key}: ${m.del ? 'undefined' : m.value}`, p, at: m.at, stack });
        }
        v = { kind: 'object', items };
      }
    }
    if (!stack.size) memo.set(key, v);
    return v;
  }
  function anyItem(arr, depth) {
    for (const it of arr.items) {
      const v = ev(it.p, it.x.replace(/^\.\.\./, ''), it.at, it.stack, depth + 1);
      if (v.kind === 'bundle') return v;
    }
    return { kind: 'opaque', why: 'no element is the bundle' };
  }
  function prop(o, key, depth) {
    if (o.kind === 'bundle') return o;
    if (o.kind === 'param') return o.key == null ? { kind: 'param', fn: o.fn, i: o.i, key } : { kind: 'opaque', why: 'a nested parameter key' };
    if (o.kind === 'array') {
      if (typeof key !== 'number') return { kind: 'opaque', why: `.${key} of an array` };
      const flat = flatItems(o, depth);
      return flat[key] ? ev(flat[key].p, flat[key].x, flat[key].at, flat[key].stack, depth + 1) : { kind: 'absent' };
    }
    if (o.kind === 'object' && o.alts) {
      const vs = o.alts.map((a) => prop(a, key, depth + 1));
      return vs.find((v) => v.kind === 'bundle') || vs.find((v) => v.kind === 'param') || vs.filter((v) => v.kind !== 'absent').pop() || { kind: 'absent' };
    }
    if (o.kind === 'object') {
      let hit = null;
      for (const it of o.items) {
        const kv = /^([A-Za-z_$][\w$]*|['"][^'"]+['"])\s*:\s*([\s\S]*)$/.exec(it.x);
        if (kv && kv[1].replace(/^['"]|['"]$/g, '') === String(key)) hit = { ...it, x: kv[2] };
        else if (it.x === String(key)) hit = it;
        else if (/^\.\.\./.test(it.x)) {
          const s = ev(it.p, it.x.slice(3), it.at, it.stack, depth + 1);
          if (s.kind === 'object' && objHas(s, key)) hit = { spread: s };
        }
      }
      if (!hit) return { kind: 'absent' };
      if (hit.spread) return prop(hit.spread, key, depth + 1);
      return ev(hit.p, hit.x, hit.at, hit.stack, depth + 1);
    }
    return o.kind === 'absent' ? o : { kind: 'opaque', why: `.${key} of something unread` };
  }
  const objHas = (o, key) => o.items.some((it) => new RegExp(`^(?:${key}|['"]${key}['"])\\s*(?::|$)`).test(it.x));
  function flatItems(arr, depth) {
    const out = [];
    for (const it of arr.items) {
      if (/^\.\.\./.test(it.x)) {
        const v = ev(it.p, it.x.slice(3), it.at, it.stack, depth + 1);
        if (v.kind === 'array') out.push(...flatItems(v, depth + 1));
        else out.push({ ...it, x: it.x.slice(3), spreadOf: v });
      } else out.push(it);
    }
    return out;
  }
  return { parsed, enclosing, resolve, fnFor, isCpPrimitive, ev, prop, flatItems };
}
function balanced(s) { let d = 0; for (const c of s) { if (OPEN[c]) d++; else if (c === ')' || c === ']' || c === '}') d--; if (d < 0) return false; } return d === 0; }
function pick(a, b) {
  if (a.kind === 'bundle' || b.kind === 'bundle') return { kind: 'bundle' };
  // two objects (`c ? { skip } : { path }`): both are possible, so both are judged
  if (a.kind === 'object' && b.kind === 'object') return { kind: 'object', items: [...a.items, ...b.items], alts: [...(a.alts || [a]), ...(b.alts || [b])] };
  if (a.kind === 'param') return a;
  if (b.kind === 'param') return b;
  if (a.kind === 'object' || a.kind === 'array' || a.kind === 'processEnv') return a;
  return b;
}
function topTernary(e) {
  let depth = 0, q = -1;
  for (let j = 0; j < e.length; j++) {
    const c = e[j];
    if (c === '"' || c === '\'' || c === '`') { j = skipString(e, j) - 1; continue; }
    if (OPEN[c]) depth++; else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === '?' && e[j + 1] !== '?' && e[j + 1] !== '.' && e[j - 1] !== '?') { if (q === -1) q = j; }
    else if (depth === 0 && c === ':' && q !== -1) return [e.slice(0, q), e.slice(q + 1, j), e.slice(j + 1)];
  }
  return null;
}
function topOr(e) {
  let depth = 0;
  for (let j = 0; j < e.length - 1; j++) {
    const c = e[j];
    if (c === '"' || c === '\'' || c === '`') { j = skipString(e, j) - 1; continue; }
    if (OPEN[c]) depth++; else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && ((c === '|' && e[j + 1] === '|') || (c === '?' && e[j + 1] === '?'))) return [e.slice(0, j), e.slice(j + 2)];
  }
  return null;
}

// What a spawn runs: its command, and from its argv the script position and the command line after a `--`.
function runs(A, s) {
  const out = [A.ev(s.p, s.cmd, s.call.argsAt, s.stack || new Map())];
  if (!s.argv) return out;
  const av = A.ev(s.p, s.argv, s.call.argsAt, s.stack || new Map());
  if (av.kind === 'param') { out.push(av); return out; }
  if (av.kind !== 'array') return out;
  const items = A.flatItems(av, 0);
  const val = (it) => (it.spreadOf ? it.spreadOf : A.ev(it.p, it.x, it.at, it.stack));
  let script = null, skip = false;
  for (const it of items) {
    if (skip) { skip = false; continue; }
    const v = val(it);
    if (v.kind === 'lit' && /^-/.test(v.s)) { if (NODE_NO_SCRIPT.has(v.s)) break; if (NODE_VALUE_FLAGS.has(v.s)) skip = true; continue; }
    if (v.kind === 'lit' && (v.s === 'run' || /loader\.cjs$/.test(v.s))) continue;
    if (v.kind === 'lit' && v.s === '') { const r = A.resolve(it.p, String(it.x).trim(), it.at); if (r && /loader\.cjs/.test(r.rhs || '')) continue; }
    script = v; break;
  }
  if (script) out.push(script);
  const dd = items.findIndex((it) => { const v = val(it); return v.kind === 'lit' && v.s === '--'; });
  if (dd !== -1) for (const it of items.slice(dd + 1)) out.push(val(it));
  return out;
}

// ---- judging an env ------------------------------------------------------------------------------------------------
function judgeOpts(A, s) {
  const stack = s.stack || new Map();
  if (!s.opts) return { ok: false, why: 'it passes no options, so the bundle inherits the real HOME' };
  const o = A.ev(s.p, s.opts, s.call.argsAt, stack);
  if (o.kind === 'absent') return { ok: false, why: 'it passes no options, so the bundle inherits the real HOME' };
  if (o.kind !== 'object') return { ok: false, why: `its options cannot be followed: ${o.why || o.kind}` };
  const env = A.prop(o, 'env', 0);
  if (env.kind === 'absent') return { ok: false, why: 'its options set no env, so the bundle inherits the real HOME' };
  return judgeEnv(A, env);
}
function judgeEnv(A, v) {
  // a value with alternatives (a helper with several returns): every one must hold
  if (v.kind === 'object' && v.alts) { for (const a of v.alts) { const r = judgeEnv(A, a); if (!r.ok) return r; } return { ok: true }; }
  const set = new Map(), bad = [];
  let spreadsEnv = false;
  const walk = (val, depth) => {
    if (depth > 16) { bad.push('its env is nested too deep to follow'); return; }
    if (val.kind === 'processEnv') { spreadsEnv = true; for (const k of HOME_KEYS) set.set(k, 'real'); return; }
    if (val.kind === 'absent') { bad.push('its env is absent, so the bundle inherits the real HOME'); return; }
    if (val.kind !== 'object') { bad.push(`its env cannot be followed: ${val.why || val.kind}`); return; }
    for (const it of val.items) {
      const sp = /^\.\.\.\s*([\s\S]+)$/.exec(it.x);
      if (sp) {
        const sv = A.ev(it.p, sp[1], it.at, it.stack);
        if (sv.kind === 'absent' || (sv.kind === 'object' && !sv.items.length)) continue;
        walk(sv, depth + 1);
        continue;
      }
      const kv = /^([A-Za-z_$][\w$]*|['"][^'"]+['"])\s*:\s*([\s\S]*)$/.exec(it.x) || (/^[A-Za-z_$][\w$]*$/.test(it.x) ? [null, it.x, it.x] : null);
      if (!kv) continue;
      const key = kv[1].replace(/^['"]|['"]$/g, '');
      if (!HOME_KEYS.includes(key)) continue;
      const src = kv[2].trim();
      if (src === 'undefined') { set.set(key, 'unset'); continue; }
      if (REAL_HOME.test(src)) { bad.push(`${key} is the real home (${short(src)})`); set.set(key, 'real'); continue; }
      const idm = /^([A-Za-z_$][\w$]*)$/.exec(src);
      if (idm) {
        const b = A.resolve(it.p, idm[1], it.at);
        if (b && !b.param && REAL_HOME.test(b.rhs)) { bad.push(`${key} is ${idm[1]}, the real home (${short(b.rhs)})`); set.set(key, 'real'); continue; }
      }
      set.set(key, 'own');
    }
  };
  walk(v, 0);
  if (bad.length) return { ok: false, why: bad.join('; ') };
  const home = set.get('HOME'), cfg = set.get('CLAUDE_CONFIG_DIR');
  if (home === 'real') return { ok: false, why: 'it spreads process.env and no HOME of its own comes after it' };
  if (!home || home === 'unset') return { ok: false, why: 'it sets no HOME, so the bundle asks the OS for the real one' };
  if (spreadsEnv && cfg === 'real') return { ok: false, why: 'it spreads process.env and sets no CLAUDE_CONFIG_DIR of its own (an ambient one would win)' };
  return { ok: true };
}

// ---- every bundle spawn -------------------------------------------------------------------------------------------
function bundleSpawns(files) {
  const A = analyze(files);
  const prims = [];
  for (const p of A.parsed.values()) {
    for (const c of p.calls) {
      if (!A.isCpPrimitive(p, c)) continue;
      const a = c.args, one = c.name === 'exec' || c.name === 'execSync';
      const second = a[1] || '';
      const argv = one ? '' : (second && second[0] !== '{' ? second : '');
      const opts = one ? second : (second && second[0] === '{' ? second : (a[2] || ''));
      prims.push({ p, call: c, cmd: a[0] || '', argv, opts });
    }
  }
  // launchers, to a fixpoint: (fn, i, key) whose spawn runs that parameter
  const launch = new Map();   // fn -> Map(`${i}:${key}` -> { i, key })
  const addL = (fn, i, key) => {
    if (!launch.has(fn)) launch.set(fn, new Map());
    const k = `${i}:${key}`;
    if (launch.get(fn).has(k)) return false;
    launch.get(fn).set(k, { i, key }); return true;
  };
  const sites = [];   // { p, at, how, judge: () => verdict }
  for (const s of prims) {
    for (const v of runs(A, s)) {
      if (v.kind === 'param') addL(v.fn, v.i, v.key);
    }
  }
  const launcherCalls = (p) => p.calls.map((c) => ({ c, g: A.fnFor(p, c.name, c.qual) })).filter((x) => x.g && launch.has(x.g));
  for (let changed = true, n = 0; changed && n < 30; n++) {
    changed = false;
    for (const p of A.parsed.values()) {
      for (const { c, g } of launcherCalls(p)) {
        for (const { i, key } of launch.get(g).values()) {
          let v = c.args[i] === undefined ? { kind: 'absent' } : A.ev(p, c.args[i], c.argsAt, new Map());
          if (key) v = A.prop(v, key, 0);
          if (v.kind === 'array') { const fl = A.flatItems(v, 0); v = fl.map((it) => (it.spreadOf || A.ev(it.p, it.x, it.at, it.stack))).find((x) => x.kind === 'param' || x.kind === 'bundle') || v; }
          if (v.kind === 'param' && addL(v.fn, v.i, v.key)) changed = true;
        }
      }
    }
  }
  // judging a launcher reached with the bundle at (i, key): every primitive in it that runs that parameter, with the
  // launcher's parameters bound to the call
  const judgeVia = (g, frame, i, key, depth) => {
    const out = [];
    const gp = A.parsed.get(g.file);
    const st = new Map(frame.stack); st.set(g, frame);
    const inside = (at) => g.bodyAt <= at && at < g.end;
    for (const s of prims) {
      if (s.p !== gp || !inside(s.call.at)) continue;
      const hits = runs(A, s).some((v) => v.kind === 'param' && v.fn === g && v.i === i && (v.key || null) === (key || null));
      if (!hits) continue;
      // `const spawn = opts.spawn || require('child_process').spawn`: a caller that hands in its own spawn (a test
      // double) spawns nothing
      const b = A.resolve(s.p, s.call.name, s.call.at);
      const alt = b && !b.param && !s.call.qual ? topOr(String(b.rhs).trim()) : null;
      if (alt && A.ev(s.p, alt[0], s.call.at, st).kind !== 'absent') { out.push({ double: true }); continue; }
      out.push(judgeOpts(A, { ...s, stack: st }));
    }
    if (depth < 8) {
      for (const { c, g: h } of launcherCalls(gp)) {
        if (!inside(c.at) || h === g) continue;
        for (const { i: j, key: k } of launch.get(h).values()) {
          let v = c.args[j] === undefined ? { kind: 'absent' } : A.ev(gp, c.args[j], c.argsAt, new Map());
          if (k) v = A.prop(v, k, 0);
          if (v.kind === 'array') { const fl = A.flatItems(v, 0); v = fl.map((it) => (it.spreadOf || A.ev(it.p, it.x, it.at, it.stack))).find((x) => x.kind === 'param') || v; }
          if (v.kind === 'param' && v.fn === g && v.i === i && (v.key || null) === (key || null)) out.push(...judgeVia(h, { p: gp, args: c.args, at: c.argsAt, stack: st }, j, k, depth + 1));
        }
      }
    }
    return out;
  };
  const out = [];
  const callersOf = (g) => {
    const cs = [];
    for (const p of A.parsed.values()) for (const c of p.calls) if (A.fnFor(p, c.name, c.qual) === g) cs.push({ p, c });
    return cs;
  };
  for (const s of prims) {
    if (!runs(A, s).some((v) => v.kind === 'bundle')) continue;
    // the env handed in by the function the spawn sits in (runQuaude(args, env)): judged at each of its callers
    const o = s.opts ? A.ev(s.p, s.opts, s.call.argsAt, new Map()) : { kind: 'absent' };
    const ev0 = o.kind === 'object' ? A.prop(o, 'env', 0) : o;
    const g = (ev0.kind === 'param') ? ev0.fn : null;
    if (g) {
      const cs = callersOf(g);
      if (!cs.length) out.push({ where: `${s.p.file}:${lineOf(s.p.t, s.call.at)}`, how: `${s.call.name}(${short(s.cmd)})`, ok: false, why: `its env is ${g.name || 'a function'}'s parameter, and nothing calls ${g.name || 'it'}` });
      for (const { p, c } of cs) {
        const st = new Map(); st.set(g, { p, args: c.args, at: c.argsAt, stack: new Map() });
        out.push({ where: `${p.file}:${lineOf(p.t, c.at)}`, how: `${c.name}(...) -> ${s.call.name}(${short(s.cmd)}) at ${s.p.file}:${lineOf(s.p.t, s.call.at)}`, ...judgeOpts(A, { ...s, stack: st }) });
      }
      continue;
    }
    out.push({ where: `${s.p.file}:${lineOf(s.p.t, s.call.at)}`, how: `${s.call.name}(${short(s.cmd)})`, ...judgeOpts(A, s) });
  }
  for (const p of A.parsed.values()) {
    for (const { c, g } of launcherCalls(p)) {
      for (const { i, key } of launch.get(g).values()) {
        let v = c.args[i] === undefined ? { kind: 'absent' } : A.ev(p, c.args[i], c.argsAt, new Map());
        if (key) v = A.prop(v, key, 0);
        if (v.kind === 'array') v = A.flatItems(v, 0).map((it) => (it.spreadOf || A.ev(it.p, it.x, it.at, it.stack))).find((x) => x.kind === 'bundle') || v;
        if (v.kind !== 'bundle') continue;
        const all = judgeVia(g, { p, args: c.args, at: c.argsAt, stack: new Map() }, i, key, 0);
        const rs = all.filter((r) => !r.double);
        if (!rs.length && all.length) continue;   // every spawn it reaches is the caller's own double
        const bad = rs.find((r) => !r.ok);
        out.push({ where: `${p.file}:${lineOf(p.t, c.at)}`, how: `${c.name}(...) -> ${g.file}:${g.name || '?'}`,
          ...(bad || (rs.length ? { ok: true } : { ok: false, why: `the launcher ${g.name} was not followed to its spawn` })) });
      }
    }
  }
  const launchers = [...launch.keys()].map((f) => `${f.file}:${f.name || '?'}`);
  return { spawns: out, launchers };
}

module.exports = { bundleSpawns, SEED_VAR, SEED_LEAF, REAL_HOME };
