'use strict';
// The differential executor: runs one plan of calls and writes what each returned, threw or did.
// The SAME file runs under host node (the oracle) and under tjs + node-shim (the subject):
//   node exec.cjs <plan.json> <out.jsonl>
//   tjs run libexec/node-shim/loader.cjs exec.cjs <plan.json> <out.jsonl>
// so anything this file gets wrong it gets wrong on both sides. It uses only plain JS and the APIs
// being judged; a result is written as a typed, runtime-neutral description (show() below), never
// as a value whose printing could differ.
//
// A plan is { shared, cases: [{ id, api, style, args, post, mutates }] }; see plan.cjs. One line of
// output per case, appended as it finishes, so a case that kills the process is still named (the
// last line written is the one before it).
const fs = require('fs');
const path = require('path');
const { build, fixturePath } = require('./fixtures.cjs');

const [planFile, outFile] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const SHARED = plan.shared;
const CASE_TIMEOUT = 8000;

const STAT_FIELDS = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks',
  'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs', 'atimeNs', 'mtimeNs', 'ctimeNs', 'birthtimeNs',
  'atime', 'mtime', 'ctime', 'birthtime'];
// In a tree each side built for itself, a file's identity and times are its own: only these compare.
const CASE_STAT_FIELDS = ['mode', 'nlink', 'uid', 'gid', 'size'];
const KINDS = ['isFile', 'isDirectory', 'isSymbolicLink', 'isFIFO', 'isSocket', 'isCharacterDevice', 'isBlockDevice'];

let roots = [];
const scrub = (s) => { for (const [r, tag] of roots) s = s.split(r).join(tag); return s; };

function errShape(e) {
  if (!e || typeof e !== 'object') return { thrown: show(e, 1) };
  const out = { ctor: e.constructor && e.constructor.name, name: e.name, message: scrub(String(e.message)) };
  for (const k of ['code', 'errno', 'syscall', 'path', 'dest', 'signal', 'status']) {
    if (e[k] !== undefined) out[k] = typeof e[k] === 'string' ? scrub(e[k]) : e[k];
  }
  return { error: out };
}

function kindsOf(v) { return KINDS.filter((k) => { try { return v[k](); } catch { return false; } }).join(','); }

function show(v, depth = 3, ctx = {}) {
  if (v === undefined) return { undefined: true };
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Object.is(v, -0) ? { number: '-0' } : Number.isNaN(v) ? { number: 'NaN' } : v;
  if (typeof v === 'string') return scrub(v);
  if (typeof v === 'bigint') return { bigint: String(v) };
  if (typeof v === 'symbol') return { symbol: String(v.description) };
  if (typeof v === 'function') return { function: true };
  if (v instanceof Error) return errShape(v);
  if (Buffer.isBuffer(v)) return { Buffer: v.subarray(0, 512).toString('hex'), length: v.length };
  if (v instanceof Uint8Array) return { Uint8Array: Buffer.from(v.buffer, v.byteOffset, Math.min(v.length, 512)).toString('hex'), length: v.length };
  if (v instanceof Date) return { Date: v.getTime() };
  if (typeof v.isFile === 'function' && typeof v.isDirectory === 'function') {
    if ('mode' in v) {
      const out = { Stats: v.constructor && v.constructor.name, kinds: kindsOf(v) };
      for (const f of (ctx.mutates ? CASE_STAT_FIELDS : STAT_FIELDS)) out[f] = show(v[f], 1, ctx);
      return out;
    }
    if ('name' in v) return { Dirent: show(v.name, 1, ctx), parentPath: show(v.parentPath, 1, ctx), kinds: kindsOf(v) };
  }
  if (depth <= 0) return { depth: v.constructor ? v.constructor.name : 'Object' };
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => show(x, depth - 1, ctx)).concat(v.length > 200 ? [{ more: v.length - 200 }] : []);
  const ctor = Object.getPrototypeOf(v) && Object.getPrototypeOf(v).constructor;
  const out = {};
  for (const k of Object.keys(v).sort()) {
    if (k.startsWith('_')) continue; // a stream's or an emitter's internals are not behaviour
    let x;
    try { x = v[k]; } catch (e) { x = e; }
    out[k] = show(x, depth - 1, ctx);
  }
  if (ctor && ctor !== Object) return { ctor: ctor.name, own: out };
  return out;
}

// What a mutating case left behind: every entry under its tree, with what it is.
const T0 = Date.now();
function snapshot(dir) {
  const out = {};
  const walk = (d, rel) => {
    let names;
    try { names = fs.readdirSync(d).sort(); } catch (e) { out[rel || '.'] = errShape(e); return; }
    for (const n of names) {
      const p = path.join(d, n);
      // mkdtemp's six random characters are its own on each side
      const r = (rel ? `${rel}/${n}` : n).replace(/(tmp-)[A-Za-z0-9]{6}$/, '$1XXXXXX');
      let st;
      try { st = fs.lstatSync(p); } catch (e) { out[r] = errShape(e); continue; }
      const e = { kind: kindsOf(st), mode: (st.mode & 0o7777).toString(8) };
      // times: a fixture made for this case is 'recent' on both sides; a time a call SET (utimes to
      // 1000 s) is old, and is judged to the millisecond, so a utimes that does nothing diverges
      for (const t of ['mtimeMs', 'atimeMs']) e[t] = st[t] < T0 - 3600e3 ? Math.round(st[t]) : 'recent';
      if (st.isFile()) { e.size = st.size; e.data = fs.readFileSync(p).subarray(0, 256).toString('hex'); }
      if (st.isSymbolicLink()) e.link = scrub(fs.readlinkSync(p));
      out[r] = e;
      if (st.isDirectory()) walk(p, r);
    }
  };
  walk(dir, '');
  return out;
}

// Decode one plan argument into the value the call receives.
function decode(a, ctx) {
  if (a === null || typeof a !== 'object') return a;
  if ('v' in a) return a.v;
  if (a.undef) return undefined;
  if ('path' in a) return fixturePath(ctx.root, a.path);
  if ('abs' in a) return a.abs;
  if ('rel' in a) return a.rel; // relative to the case's tree: runCase chdirs there for the call
  if ('flags' in a) return a.flags.reduce((acc, f) => acc | (fs.constants[f] || 0), 0);
  if ('buf' in a) return Buffer.from(a.buf, 'hex');
  if ('fd' in a) {
    if (a.fd === 'bad') return 987;
    if (a.fd === 'brokenpipe') return 3; // the runner hands fd 3 as a pipe whose reader it closed
    if (a.fd === 'pipe') return 4; // and fd 4 as a pipe holding "piped\n" whose writer it closed
    const [name, flags] = a.fd.split(':');
    const fd = fs.openSync(fixturePath(ctx.root, name), flags || 'r');
    ctx.fds.push(fd);
    return fd;
  }
  if (a.signal) return new AbortController().signal;
  if (a.obj) { const o = {}; for (const [k, x] of Object.entries(a.obj)) o[k] = decode(x, ctx); return o; }
  if (a.arr) return a.arr.map((x) => decode(x, ctx));
  if (a.env) return { PATH: process.env.PATH, DIFF_ENV: 'x' };
  if (a.cwd) return ctx.root;
  throw new Error(`exec.cjs: cannot decode ${JSON.stringify(a)}`);
}

// Code-unit order, never localeCompare: the instrument must not lean on a behaviour the two runtimes
// differ in (QuickJS's localeCompare is not ICU's), or it measures itself.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const withTimeout = (p, what) => Promise.race([p, new Promise((_, rej) => {
  const t = setTimeout(() => rej(Object.assign(new Error(`case timed out: ${what}`), { code: 'DIFF_TIMEOUT' })), CASE_TIMEOUT);
  if (t.unref) t.unref();
})]);

// A stream's own close, waited for before the case goes on. An autoClose stream closes its fd ASYNCHRONOUSLY, after
// 'end'/'error'/end()'s callback, which is where post() used to return. runCase then closed the case's fds itself
// (closeSync), and snapshot() opened the case directory, which the kernel gave the number just freed; the stream's
// late close then closed THAT, and node's snapshot threw "EBADF: bad file descriptor, scandir '<case>'" (node-shim-
// oracle, linux-musl, CI 44945260530: fs.createWriteStream(<file>, {fd: <read-only fd>, autoClose: true})). A driver
// double close, not node's answer: waiting for 'close' takes the race out on both sides. It answers whether the
// stream closed (`closed`, which the case records and the differential judges): node-shim's fs streams emitted no
// 'close' and had no .closed before 2026-11-21. Bounded, so a stream that never closes cannot hang the case.
function streamClosed(r) {
  if (!r || typeof r.once !== 'function') return Promise.resolve(show(r && r.closed));
  if (r.closed === true) return Promise.resolve(true);
  return new Promise((res) => {
    const t = setTimeout(() => res(r.closed === true), 2000);
    r.once('close', () => { clearTimeout(t); res(r.closed === true); });
  });
}

// After a call: things that need closing or draining are described by what they do.
async function post(kind, r, ctx, args) {
  if (kind === 'typeof') return { typeof: typeof r, ctor: r && typeof r === 'object' ? Object.getPrototypeOf(r) && Object.getPrototypeOf(r).constructor && Object.getPrototypeOf(r).constructor.name : undefined };
  if (kind === 'keys') return { keys: r && typeof r === 'object' ? Object.fromEntries(Object.keys(r).sort().map((k) => [k, typeof r[k]])) : typeof r };
  if (kind === 'sign') return { typeof: typeof r, sign: typeof r === 'number' ? (r > 0 ? '>0' : r === 0 ? '0' : '<0') : null };
  if (kind === 'readsync') return { bytesRead: show(r), buffer: show(args[1]) };
  if (kind === 'tmpname') return { tmpname: typeof r === 'string' ? scrub(r.slice(0, -6)) + 'XXXXXX' : show(r) };
  if (kind === 'gzip' || kind === 'deflate') {
    const zlib = require('zlib');
    const back = kind === 'gzip' ? zlib.gunzipSync(r) : zlib.inflateSync(r);
    return { header: Buffer.from(r).subarray(0, kind === 'gzip' ? 10 : 2).toString('hex'), roundtrip: Buffer.from(back).toString('hex') };
  }
  // raw deflate (no header): the bytes a compressor writes are its own choice, so judge what they inflate back to
  if (kind === 'deflateraw') return { roundtrip: Buffer.from(require('zlib').inflateRawSync(r)).toString('hex') };
  if (kind === 'fd') {
    const st = fs.fstatSync(r);
    fs.closeSync(r);
    return { fd: typeof r, fstat: show(st, 1, { mutates: true }) };
  }
  if (kind === 'filehandle') {
    const st = await r.stat();
    await r.close();
    return { FileHandle: typeof r.fd, stat: show(st, 1, { mutates: true }) };
  }
  if (kind === 'readstream') {
    const chunks = [];
    const end = await new Promise((res) => {
      r.on('data', (c) => chunks.push(Buffer.from(c)));
      r.on('end', () => res('end'));
      r.on('error', (e) => res(errShape(e)));
    });
    const closed = await streamClosed(r);
    return { end, data: Buffer.concat(chunks).toString('hex'), closed };
  }
  if (kind === 'writestream') {
    const end = await new Promise((res) => {
      r.on('error', (e) => res(errShape(e)));
      r.write('written\n');
      // end's callback gets the error too (node calls it with the stream's error): taking it as 'finish' made the
      // answer depend on whether 'error' or the callback ran first, which load decides (an fd opened read-only:
      // node said "finish" alone and EBADF in the suite, 2026-11-21). Both now give the error's shape.
      r.end((e) => res(e ? errShape(e) : 'finish'));
    });
    const closed = await streamClosed(r);
    return { end, closed };
  }
  if (kind === 'dir') {
    const names = [];
    for await (const d of r) names.push(show(d, 1, ctx));
    return { Dir: names.sort((a, b) => cmp(JSON.stringify(a), JSON.stringify(b))) };
  }
  if (kind === 'close') { try { r.close(); } catch { /* best effort */ } return { closed: show(r && r.constructor && r.constructor.name) }; }
  if (kind === 'sorted' && Array.isArray(r)) return show([...r].sort((a, b) => cmp(String(a && a.name !== undefined ? a.name : a), String(b && b.name !== undefined ? b.name : b))), 3, ctx);
  return show(r, 3, ctx);
}

async function runCase(c, idx) {
  const ctx = { root: SHARED, fds: [], mutates: !!c.mutates };
  let caseDir = null;
  if (c.mutates) {
    caseDir = path.join(plan.scratch, `case-${idx}`);
    build(caseDir, { fifo: false });
    ctx.root = caseDir;
  }
  roots = [[SHARED, '<shared>'], [plan.scratch, '<scratch>']];
  if (caseDir) roots.unshift([caseDir, '<case>']);
  const dot = c.api.indexOf('.');
  const mod = require(c.api.slice(0, dot));
  const prop = c.api.slice(dot + 1);
  const out = { id: c.id };
  try {
    const fn = mod[prop];
    if (c.style === 'value') {
      out.r = await post(c.post || 'show', fn, ctx, []);
    } else {
      if (typeof fn !== 'function') throw Object.assign(new TypeError(`${c.api} is ${typeof fn}`), { code: 'DIFF_ABSENT' });
      const args = c.args.map((a) => decode(a, ctx));
      const rel = c.args.some((a) => a && typeof a === 'object' && 'rel' in a);
      const home = process.cwd();
      if (rel) process.chdir(ctx.root);
      let r;
      try {
      if (c.style === 'sync') r = fn.apply(mod, args);
      else if (c.style === 'new') r = new fn(...args);
      else if (c.style === 'promise') r = await withTimeout(fn.apply(mod, args), c.id);
      else if (c.style === 'callback') {
        r = await withTimeout(new Promise((res, rej) => {
          fn.apply(mod, [...args, (e, ...rs) => (e ? rej(e) : res(rs.length > 1 ? rs : rs[0]))]);
        }), c.id);
      } else throw new Error(`exec.cjs: style ${c.style}`);
      } finally { if (rel) process.chdir(home); }
      out.r = await withTimeout(post(c.post, r, ctx, args), c.id);
    }
  } catch (e) {
    out.r = errShape(e);
  }
  for (const fd of ctx.fds) { try { fs.closeSync(fd); } catch { /* the case closed it */ } }
  if (caseDir) {
    out.after = snapshot(caseDir);
    try { fs.rmSync(caseDir, { recursive: true, force: true }); } catch { /* left for the runner */ }
  }
  return out;
}

(async () => {
  fs.writeFileSync(outFile, '');
  for (let i = 0; i < plan.cases.length; i++) {
    const c = plan.cases[i];
    let line;
    try { line = JSON.stringify(await runCase(c, i)); } catch (e) { line = JSON.stringify({ id: c.id, r: { harness: String(e && e.message) } }); }
    fs.appendFileSync(outFile, `${line}\n`);
  }
  fs.appendFileSync(outFile, `${JSON.stringify({ done: plan.cases.length })}\n`);
  process.exit(0);
})();
