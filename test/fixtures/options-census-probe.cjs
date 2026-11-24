'use strict';
// THE NODE ROWS of the options census (test/options-census.test.cjs): one behavioural row per honoured option that
// libexec/node-shim/internal/options.cjs proves with `row:<label>`. Each row answers in plain JSON what the option DID
// (never a path, a pid or a time), and the test runs this file under HOST node and under the tjs loader and compares
// the two answers row by row. POSIX only (the rows run /bin/sh); the http rows talk to the census origin
// (test/fixtures/options-census-origin.cjs) at ORIGIN_PORT.
//   OPTIONS_CENSUS_RUN_ROWS=1 ORIGIN_PORT=<n> node test/fixtures/options-census-probe.cjs   (prints the answers)
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const O = () => Number(process.env.ORIGIN_PORT);
const errOf = (e) => (e ? { code: e.code || null, name: e.name } : null);
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
function tmp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-row-'))); }
function collect(s) {
  return new Promise((res) => {
    if (!s) { res(null); return; }
    const parts = [];
    s.on('data', (d) => parts.push(typeof d === 'string' ? Buffer.from(d) : d));
    s.on('end', () => res(Buffer.concat(parts).toString()));
  });
}
// spawn and wait: stdout text, exit code and signal, the 'error' event if one came
function run(file, args, opts) {
  return new Promise((res) => {
    let child;
    try { child = cp.spawn(file, args, opts); } catch (e) { res({ threw: errOf(e) }); return; }
    let error = null;
    child.on('error', (e) => { error = errOf(e); });
    const out = collect(child.stdout);
    child.on('close', async (code, signal) => res({ stdout: await out, code, signal, error, stdinNull: child.stdin === null, stdoutNull: child.stdout === null }));
  });
}
function execFileP(file, args, opts) {
  return new Promise((res) => {
    cp.execFile(file, args, opts, (e, stdout, stderr) => res({
      err: e ? { code: e.code === undefined ? null : e.code, killed: e.killed, signal: e.signal, name: e.name } : null,
      stdout: Buffer.isBuffer(stdout) ? { buffer: stdout.toString('hex') } : stdout,
      stderr: Buffer.isBuffer(stderr) ? { buffer: stderr.toString('hex') } : stderr,
    }));
  });
}
const ids = () => String(cp.execFileSync('/bin/sh', ['-c', 'id -u; id -g'])).trim().split('\n').map(Number);
const pgidIsPid = async (opts) => { const r = await run('/bin/sh', ['-c', 'ps -o pgid= -p $$; echo $$'], opts); const w = r.stdout.trim().split(/\s+/); return w[0] === w[1]; };
const tryCode = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code || e.name; } };
const tryCodeAsync = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return e.code || e.name; } };
function request(opts, body) {
  return new Promise((res) => {
    let req;
    const events = [];
    try {
      req = http.request(opts, (r) => {
        collect(r).then((text) => { let j = null; try { j = JSON.parse(text); } catch (_) { j = text; } res({ status: r.statusCode, body: j, events }); });
      });
    } catch (e) { res({ threw: errOf(e) }); return; }
    req.on('timeout', () => { events.push('timeout'); req.destroy(new Error('timed out here')); });
    req.on('error', (e) => res({ error: errOf(e), events }));
    if (body) req.write(body);
    req.end();
  });
}
const echoOf = (r) => (r.body && typeof r.body === 'object'
  ? { status: r.status, method: r.body.method, url: r.body.url, host: r.body.headers.host || null, xa: r.body.headers['x-a'] || null,
    authorization: r.body.headers.authorization || null }
  : r);

const ROWS = {
  // ---- child_process.spawn ----
  'spawn.argv0': async () => (await run('/bin/sh', ['-c', 'echo $0'], { argv0: 'zz' })).stdout,
  'spawn.cwd': async () => (await run('/bin/sh', ['-c', 'pwd'], { cwd: '/' })).stdout,
  'spawn.env': async () => (await run('/bin/sh', ['-c', 'echo "$FOO"'], { env: { FOO: 'bar', PATH: '/usr/bin:/bin' } })).stdout,
  'spawn.detached': async () => ({ detached: await pgidIsPid({ detached: true }), attached: await pgidIsPid({}) }),
  'spawn.uid': async () => { const [u] = ids(); return (await run('/bin/sh', ['-c', 'id -u'], { uid: u })).stdout === `${u}\n`; },
  'spawn.gid': async () => { const [, g] = ids(); return (await run('/bin/sh', ['-c', 'id -g'], { gid: g })).stdout === `${g}\n`; },
  'spawn.timeout': async () => { const r = await run('/bin/sleep', ['5'], { timeout: 200 }); return { code: r.code, signal: r.signal }; },
  'spawn.killSignal': async () => {
    const a = await run('/bin/sleep', ['5'], { timeout: 200, killSignal: 'SIGINT' });
    const b = await run('/bin/sleep', ['5'], { timeout: 200, killSignal: 9 });
    let c = 'no throw';
    try { cp.spawn('/bin/sh', ['-c', 'true'], { killSignal: 'SIGNOPE' }).on('error', () => {}); } catch (e) { c = e.code; }
    return { named: a.signal, number: b.signal, invalid: c };
  },
  'spawn.signal': async () => {
    const ac = new AbortController();
    const p = run('/bin/sleep', ['5'], { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const late = await p;
    const pre = new AbortController(); pre.abort();
    const early = await run('/bin/sleep', ['5'], { signal: pre.signal });
    return { late: { error: late.error, signal: late.signal }, early: { error: early.error, signal: early.signal } };
  },
  'spawn.shell': async () => ({
    yes: (await run('echo $0-x', [], { shell: true })).stdout.replace(/^.*\//, ''),
    named: (await run('echo "$((1+2))"', [], { shell: '/bin/sh' })).stdout,
  }),
  'spawn.stdio': async () => {
    const a = await run('/bin/sh', ['-c', 'echo o'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const b = await run('/bin/sh', ['-c', 'echo o'], { stdio: 'ignore' });
    return { a: { stdout: a.stdout, stdinNull: a.stdinNull }, b: { stdoutNull: b.stdoutNull } };
  },
  // windowsHide / windowsVerbatimArguments ask for nothing off Windows: node and the shim both run the child as usual
  'spawn.windowsHide': async () => (await run('/bin/sh', ['-c', 'echo "$1"', 'sh', 'a b'], { windowsHide: true })).stdout,
  'spawn.windowsVerbatimArguments': async () => (await run('/bin/sh', ['-c', 'echo "$1"', 'sh', '"q"'], { windowsVerbatimArguments: true })).stdout,

  // ---- child_process.spawnSync ----
  'spawnSync.argv0': async () => String(cp.spawnSync('/bin/sh', ['-c', 'echo $0'], { argv0: 'yy' }).stdout),
  'spawnSync.encoding': async () => {
    const u = cp.spawnSync('/bin/sh', ['-c', 'printf "\\303\\251"'], { encoding: 'utf8' });
    const l = cp.spawnSync('/bin/sh', ['-c', 'printf "\\303\\251"'], { encoding: 'latin1' });
    const h = cp.spawnSync('/bin/sh', ['-c', 'printf "AB"'], { encoding: 'hex' });
    const b = cp.spawnSync('/bin/sh', ['-c', 'printf "AB"'], { encoding: 'buffer' });
    return { utf8: u.stdout, latin1: l.stdout, hex: h.stdout, buffer: Buffer.isBuffer(b.stdout) };
  },
  'spawnSync.killSignal': async () => {
    const r = cp.spawnSync('/bin/sleep', ['5'], { timeout: 200, killSignal: 'SIGINT' });
    return { signal: r.signal, status: r.status, error: r.error && r.error.code };
  },
  'spawnSync.shell': async () => String(cp.spawnSync('echo "$((2+3))"', { shell: '/bin/sh' }).stdout),
  'spawnSync.windowsHide': async () => String(cp.spawnSync('/bin/sh', ['-c', 'echo ok'], { windowsHide: true }).stdout),
  'spawnSync.windowsVerbatimArguments': async () => String(cp.spawnSync('/bin/sh', ['-c', 'echo "$1"', 'sh', '"q"'], { windowsVerbatimArguments: true }).stdout),

  // ---- child_process.execFile / exec ----
  'execFile.cwd': async () => (await execFileP('/bin/sh', ['-c', 'pwd'], { cwd: '/' })).stdout,
  'execFile.env': async () => (await execFileP('/bin/sh', ['-c', 'echo "$FOO"'], { env: { FOO: 'q' } })).stdout,
  'execFile.encoding': async () => ({
    buffer: (await execFileP('/bin/sh', ['-c', 'printf AB'], { encoding: 'buffer' })).stdout,
    hex: (await execFileP('/bin/sh', ['-c', 'printf AB'], { encoding: 'hex' })).stdout,
  }),
  'execFile.timeout': async () => (await execFileP('/bin/sleep', ['5'], { timeout: 200 })).err,
  'execFile.killSignal': async () => (await execFileP('/bin/sleep', ['5'], { timeout: 200, killSignal: 'SIGINT' })).err,
  'execFile.maxBuffer': async () => {
    const r = await execFileP('/bin/sh', ['-c', 'printf 0123456789'], { maxBuffer: 4 });
    return { err: r.err, stdout: r.stdout };
  },
  'execFile.shell': async () => ({
    execFile: (await execFileP('echo "$((3+4))"', [], { shell: '/bin/sh' })).stdout,
    exec: await new Promise((res) => cp.exec('echo "$((4+5))"', { shell: '/bin/sh' }, (e, so) => res(so))),
  }),
  'execFile.signal': async () => {
    const ac = new AbortController();
    const p = execFileP('/bin/sleep', ['5'], { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    return (await p).err;
  },

  // ---- fs ----
  'fs.readFile.encoding': async () => {
    const d = tmp(); const f = path.join(d, 'x');
    fs.writeFileSync(f, Buffer.from([0x7a, 0xc3, 0xa9, 0xff]));
    const out = {};
    for (const e of ['utf8', 'latin1', 'hex', 'base64', 'base64url', 'utf16le', 'ascii']) out[e] = fs.readFileSync(f, { encoding: e });
    out.promises = await fs.promises.readFile(f, 'hex');
    out.callback = await new Promise((res) => fs.readFile(f, { encoding: 'base64' }, (e, v) => res(v)));
    out.bad = tryCode(() => fs.readFileSync(f, 'klingon'));
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.readFile.flag': async () => {
    const d = tmp(); const f = path.join(d, 'new');
    const out = { missing: tryCode(() => fs.readFileSync(f, { flag: 'r' })) };
    out.created = fs.readFileSync(f, { flag: 'w+', encoding: 'utf8' });
    out.exists = fs.existsSync(f);
    out.promises = await tryCodeAsync(() => fs.promises.readFile(path.join(d, 'other'), { flag: 'r' }));
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.readFile.signal': async () => {
    const d = tmp(); const f = path.join(d, 'x'); fs.writeFileSync(f, 'x');
    const ac = new AbortController(); ac.abort();
    const out = { promises: await tryCodeAsync(() => fs.promises.readFile(f, { signal: ac.signal })) };
    out.callback = await new Promise((res) => fs.readFile(f, { signal: ac.signal }, (e) => res(e ? e.code || e.name : 'ok')));
    const live = new AbortController();
    out.live = await fs.promises.readFile(f, { signal: live.signal, encoding: 'utf8' });
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.writeFile.encoding': async () => {
    const d = tmp(); const f = path.join(d, 'x');
    const out = {};
    for (const [e, v] of [['hex', '7a7a'], ['base64', 'enp6'], ['utf16le', 'zz'], ['latin1', 'é']]) {
      fs.writeFileSync(f, v, { encoding: e }); out[e] = fs.readFileSync(f).toString('hex');
    }
    await fs.promises.writeFile(f, '7b', 'hex'); out.promises = fs.readFileSync(f).toString('hex');
    out.bad = tryCode(() => fs.writeFileSync(f, 'x', { encoding: 'klingon' }));
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.writeFile.flag': async () => {
    const d = tmp(); const f = path.join(d, 'x');
    fs.writeFileSync(f, 'a'); fs.writeFileSync(f, 'b', { flag: 'a' });
    const out = { appended: fs.readFileSync(f, 'utf8'), exclusive: tryCode(() => fs.writeFileSync(f, 'c', { flag: 'wx' })) };
    out.after = fs.readFileSync(f, 'utf8');
    out.promises = await tryCodeAsync(() => fs.promises.writeFile(f, 'd', { flag: 'wx' }));
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.writeFile.mode': async () => {
    const d = tmp(); const f = path.join(d, 'x'); const g = path.join(d, 'y');
    fs.writeFileSync(f, 'a', { mode: 0o600 });
    await fs.promises.writeFile(g, 'a', { mode: 0o640 });
    const out = { sync: (fs.statSync(f).mode & 0o777).toString(8), promises: (fs.statSync(g).mode & 0o777).toString(8) };
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.writeFile.signal': async () => {
    const d = tmp(); const f = path.join(d, 'x');
    const ac = new AbortController(); ac.abort();
    const out = { promises: await tryCodeAsync(() => fs.promises.writeFile(f, 'x', { signal: ac.signal })), created: fs.existsSync(f) };
    out.callback = await new Promise((res) => fs.writeFile(f, 'x', { signal: ac.signal }, (e) => res(e ? e.code || e.name : 'ok')));
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.mkdir.recursive': async () => {
    const d = tmp();
    const out = { plain: tryCode(() => fs.mkdirSync(path.join(d, 'a', 'b'))) };
    out.first = path.relative(d, fs.mkdirSync(path.join(d, 'a', 'b', 'c'), { recursive: true }) || '') || null;
    out.again = fs.mkdirSync(path.join(d, 'a', 'b', 'c'), { recursive: true }) === undefined;
    out.promises = path.relative(d, (await fs.promises.mkdir(path.join(d, 'p', 'q'), { recursive: true })) || '') || null;
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.rm.force': async () => {
    const d = tmp();
    const out = { plain: tryCode(() => fs.rmSync(path.join(d, 'nope'))), force: tryCode(() => fs.rmSync(path.join(d, 'nope'), { force: true })) };
    out.promises = await tryCodeAsync(() => fs.promises.rm(path.join(d, 'nope'), { force: true }));
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.rm.recursive': async () => {
    const d = tmp(); fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true }); fs.writeFileSync(path.join(d, 'a', 'b', 'f'), '');
    const out = { plain: tryCode(() => fs.rmSync(path.join(d, 'a'))) };
    out.promisesPlain = await tryCodeAsync(() => fs.promises.rm(path.join(d, 'a')));
    out.recursive = tryCode(() => fs.rmSync(path.join(d, 'a'), { recursive: true }));
    out.gone = !fs.existsSync(path.join(d, 'a'));
    fs.rmSync(d, { recursive: true });
    return out;
  },
  // retries take effect only on EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM; elsewhere the options change nothing
  'fs.rm.maxRetries': async () => {
    const d = tmp(); fs.mkdirSync(path.join(d, 'a'));
    const out = { removed: tryCode(() => fs.rmSync(path.join(d, 'a'), { recursive: true, maxRetries: 2, retryDelay: 5 })) };
    out.missing = tryCode(() => fs.rmSync(path.join(d, 'a'), { maxRetries: 2, retryDelay: 5 }));
    out.promises = await tryCodeAsync(() => fs.promises.rm(path.join(d, 'a'), { force: true, maxRetries: 1, retryDelay: 5 }));
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.cp.recursive': async () => {
    const d = cpTree();
    const out = { plain: tryCode(() => fs.cpSync(path.join(d, 'a'), path.join(d, 'x'))) };
    fs.cpSync(path.join(d, 'a'), path.join(d, 'x'), { recursive: true });
    out.tree = listTree(path.join(d, 'x'));
    await fs.promises.cp(path.join(d, 'a'), path.join(d, 'y'), { recursive: true });
    out.promises = listTree(path.join(d, 'y'));
    out.callback = await new Promise((res) => fs.cp(path.join(d, 'a'), path.join(d, 'z'), (e) => res(e ? e.code : 'ok')));
    fs.rmSync(d, { recursive: true });
    return out;
  },
  // through fs.promises.cp: node 24's cpSync answers dereference with ERR_FS_EISDIR for a link to a FILE and keeps the
  // links of a recursive copy (its native fast path, measured on 24.21 and 26.10); its cp does what the docs say, and
  // the shim's cp and cpSync both do that
  'fs.cp.dereference': async () => {
    const d = cpTree();
    await fs.promises.cp(path.join(d, 'a', 'abs'), path.join(d, 'deref'), { dereference: true });
    await fs.promises.cp(path.join(d, 'a', 'abs'), path.join(d, 'kept'));
    await fs.promises.cp(path.join(d, 'a'), path.join(d, 'tree'), { recursive: true, dereference: true });
    const link = (p) => fs.lstatSync(path.join(d, p)).isSymbolicLink();
    const out = { deref: link('deref'), kept: link('kept'), tree: link('tree/abs') };
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.cp.errorOnExist': async () => {
    const d = cpTree(); const src = path.join(d, 'a', 'b', 'f'); const dst = path.join(d, 'dst'); fs.writeFileSync(dst, 'old');
    const out = { quiet: tryCode(() => fs.cpSync(src, dst, { force: false })), loud: tryCode(() => fs.cpSync(src, dst, { force: false, errorOnExist: true })) };
    out.promises = await tryCodeAsync(() => fs.promises.cp(src, dst, { force: false, errorOnExist: true }));
    out.content = fs.readFileSync(dst, 'utf8');
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.cp.force': async () => {
    const d = cpTree(); const src = path.join(d, 'a', 'b', 'f'); const dst = path.join(d, 'dst');
    fs.writeFileSync(dst, 'old'); fs.cpSync(src, dst, { force: false }); const kept = fs.readFileSync(dst, 'utf8');
    fs.cpSync(src, dst); const over = fs.readFileSync(dst, 'utf8');
    fs.rmSync(d, { recursive: true });
    return { kept, over };
  },
  'fs.cp.filter': async () => {
    const d = cpTree();
    const seen = [];
    fs.cpSync(path.join(d, 'a'), path.join(d, 'x'), { recursive: true, filter: (s) => { seen.push(path.relative(d, s)); return !s.endsWith(`${path.sep}b`); } });
    const out = { tree: listTree(path.join(d, 'x')), seen: seen.sort() };
    await fs.promises.cp(path.join(d, 'a'), path.join(d, 'y'), { recursive: true, filter: async (s) => !s.endsWith('rel') });
    out.promises = listTree(path.join(d, 'y'));
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.cp.mode': async () => {
    const d = cpTree(); const src = path.join(d, 'a', 'b', 'f'); const dst = path.join(d, 'dst');
    const out = { fresh: tryCode(() => fs.cpSync(src, dst, { mode: fs.constants.COPYFILE_EXCL })) };
    out.exists = tryCode(() => fs.cpSync(src, dst, { mode: fs.constants.COPYFILE_EXCL }));
    out.ficlone = tryCode(() => fs.cpSync(src, path.join(d, 'clone'), { mode: fs.constants.COPYFILE_FICLONE }));
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.cp.preserveTimestamps': async () => {
    const d = cpTree(); const src = path.join(d, 'a', 'b', 'f');
    fs.utimesSync(src, new Date('2001-02-03T04:05:06Z'), new Date('2001-02-03T04:05:06Z'));
    fs.cpSync(src, path.join(d, 'p'), { preserveTimestamps: true });
    fs.cpSync(src, path.join(d, 'n'));
    const out = { preserved: Math.floor(fs.statSync(path.join(d, 'p')).mtimeMs / 1000), fresh: fs.statSync(path.join(d, 'n')).mtimeMs > 1e12 };
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.cp.verbatimSymlinks': async () => {
    const d = cpTree();
    fs.cpSync(path.join(d, 'a'), path.join(d, 'v'), { recursive: true, verbatimSymlinks: true });
    fs.cpSync(path.join(d, 'a'), path.join(d, 'r'), { recursive: true });
    await fs.promises.cp(path.join(d, 'a'), path.join(d, 'p'), { recursive: true });
    const show = (l) => { const t = fs.readlinkSync(l); return path.isAbsolute(t) ? `abs:${path.relative(d, t)}` : `rel:${t}`; };
    const out = { verbatim: show(path.join(d, 'v', 'rel')), resolved: show(path.join(d, 'r', 'rel')), promises: show(path.join(d, 'p', 'rel')) };
    fs.rmSync(d, { recursive: true });
    return out;
  },
  // every honoured flag string, on a file that exists and one that does not: what the open did
  'fs.open.flags': async () => {
    const d = tmp(); const out = {};
    const flags = ['r', 'rs', 'sr', 'r+', 'rs+', 'sr+', 'w', 'wx', 'xw', 'w+', 'wx+', 'xw+', 'a', 'ax', 'xa', 'as', 'sa'];
    for (const f of flags) {
      const name = f.replace(/\+/g, 'p');
      const there = path.join(d, `e-${name}`); fs.writeFileSync(there, 'abc');
      const answer = (p) => {
        let fd;
        try { fd = fs.openSync(p, f); } catch (e) { return e.code; }
        const r = { read: tryCode(() => fs.readSync(fd, Buffer.alloc(3), 0, 3, 0)), write: tryCode(() => fs.writeSync(fd, 'Z')) };
        fs.closeSync(fd);
        r.after = fs.readFileSync(p, 'utf8');
        return r;
      };
      out[f] = { exists: answer(there), absent: answer(path.join(d, `n-${name}`)) };
    }
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.createReadStream.end': async () => {
    const d = tmp(); const f = path.join(d, 'x'); fs.writeFileSync(f, '0123456789');
    const out = { slice: await collect(fs.createReadStream(f, { start: 2, end: 5 })) };
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.createReadStream.highWaterMark': async () => {
    const d = tmp(); const f = path.join(d, 'x'); fs.writeFileSync(f, '0123456789');
    const sizes = await new Promise((res) => { const s = []; const r = fs.createReadStream(f, { highWaterMark: 4 }); r.on('data', (c) => s.push(c.length)); r.on('end', () => res(s)); });
    fs.rmSync(d, { recursive: true });
    return sizes;
  },
  'fs.createReadStream.flags': async () => {
    const d = tmp(); const f = path.join(d, 'new');
    const text = await collect(fs.createReadStream(f, { flags: 'w+', mode: 0o600 }));
    const out = { text, created: fs.existsSync(f), mode: fs.existsSync(f) ? (fs.statSync(f).mode & 0o777).toString(8) : null };
    out.missing = await new Promise((res) => { const r = fs.createReadStream(path.join(d, 'none')); r.on('error', (e) => res(e.code)); r.on('data', () => {}); r.on('end', () => res('ended')); });
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.createWriteStream.encoding': async () => {
    const d = tmp(); const f = path.join(d, 'x');
    await new Promise((res) => { const w = fs.createWriteStream(f, { encoding: 'hex' }); w.on('finish', res); w.end('7a7a'); });
    const out = fs.readFileSync(f).toString('hex');
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.createWriteStream.flags': async () => {
    const d = tmp(); const f = path.join(d, 'x'); fs.writeFileSync(f, 'a');
    await new Promise((res) => { const w = fs.createWriteStream(f, { flags: 'a' }); w.on('finish', res); w.end('b'); });
    const out = { appended: fs.readFileSync(f, 'utf8') };
    out.exclusive = await new Promise((res) => { const w = fs.createWriteStream(f, { flags: 'wx' }); w.on('error', (e) => res(e.code)); w.on('finish', () => res('ok')); w.end('c'); });
    fs.rmSync(d, { recursive: true });
    return out;
  },
  // a stream given an fd uses it, not the path; autoClose closes it (true) or leaves it open (false)
  'fs.createWriteStream.fd': async () => {
    const d = tmp(); const f = path.join(d, 'x'); const other = path.join(d, 'unused');
    const isOpen = (fd) => { try { fs.fstatSync(fd); return true; } catch (_) { return false; } };
    const fd1 = fs.openSync(f, 'w');
    await new Promise((res) => { const w = fs.createWriteStream(other, { fd: fd1, autoClose: false }); w.on('finish', res); w.end('ab'); });
    const out = { open: isOpen(fd1) };
    await new Promise((res) => { const w = fs.createWriteStream(other, { fd: fd1 }); w.on('close', res); w.end('c'); });
    out.closed = !isOpen(fd1);
    const ro = fs.openSync(f, 'r');
    out.readOnly = await new Promise((res) => { const w = fs.createWriteStream(other, { fd: ro }); w.on('error', (e) => res(e.code)); w.on('finish', () => res('ok')); w.end('z'); });
    out.content = fs.readFileSync(f, 'utf8'); out.pathTouched = fs.existsSync(other);
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.createReadStream.fd': async () => {
    const d = tmp(); const f = path.join(d, 'x'); fs.writeFileSync(f, '0123456789');
    const isOpen = (fd) => { try { fs.fstatSync(fd); return true; } catch (_) { return false; } };
    const read = (o) => new Promise((res) => { let s = ''; const r = fs.createReadStream(path.join(d, 'unused'), o); r.on('data', (c) => { s += c; }); r.on('error', (e) => res(e.code)); r.on('end', () => setTimeout(() => res(s), 20)); });
    const fd = fs.openSync(f, 'r');
    fs.readSync(fd, Buffer.alloc(3), 0, 3, null);
    const out = { fromHere: await read({ fd, autoClose: false, encoding: 'utf8' }), open: isOpen(fd) };
    out.range = await read({ fd, start: 2, end: 4, encoding: 'utf8' });
    out.closed = !isOpen(fd);
    fs.rmSync(d, { recursive: true });
    return out;
  },
  // read-and-append: one file position, reads from it and advance it, every write lands at the end and moves it there;
  // a positioned read leaves it. The bundle's session transcript takes O_RDWR|O_APPEND by default.
  'fs.open.readAppend': async () => {
    const d = tmp(); const out = {};
    for (const flag of ['a+', 'ax+', 'xa+', 'as+', 'sa+', fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT]) {
      const f = path.join(d, 'f' + String(flag).replace(/[^a-z0-9]/g, '_'));
      if (!String(flag).includes('x')) fs.writeFileSync(f, 'xyz');
      const fd = fs.openSync(f, flag);
      const rd = (n, pos = null) => { const b = Buffer.alloc(n); return b.subarray(0, fs.readSync(fd, b, 0, n, pos)).toString(); };
      const first = rd(2);
      fs.writeSync(fd, 'b'); fs.writeSync(fd, 'c');
      const afterWrite = rd(4);
      const whole = rd(16, 0);
      const afterPositioned = rd(4);
      fs.closeSync(fd);
      out[typeof flag === 'number' ? 'O_RDWR|O_APPEND|O_CREAT' : flag] = { first, afterWrite, whole, afterPositioned, content: fs.readFileSync(f, 'utf8') };
    }
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.createWriteStream.mode': async () => {
    const d = tmp(); const f = path.join(d, 'x');
    await new Promise((res) => { const w = fs.createWriteStream(f, { mode: 0o600 }); w.on('finish', res); w.end('m'); });
    const out = (fs.statSync(f).mode & 0o777).toString(8);
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.stream.start': async () => {
    const d = tmp(); const f = path.join(d, 'x'); fs.writeFileSync(f, '0123456789');
    await new Promise((res) => { const w = fs.createWriteStream(f, { flags: 'r+', start: 2 }); w.on('finish', res); w.end('ab'); });
    const out = { write: fs.readFileSync(f, 'utf8'), read: await collect(fs.createReadStream(f, { start: 7 })) };
    fs.rmSync(d, { recursive: true });
    return out;
  },
  'fs.stream.autoClose': async () => {
    const d = tmp(); const f = path.join(d, 'x'); fs.writeFileSync(f, 'abc');
    const watch = (s) => new Promise((res) => { const ev = []; s.on('end', () => ev.push('end')); s.on('finish', () => ev.push('finish')); s.on('close', () => ev.push('close')); s.on('data', () => {}); setTimeout(() => res(ev), 150); });
    const on = watch(fs.createReadStream(f));
    const off = watch(fs.createReadStream(f, { autoClose: false }));
    const out = { readOn: await on, readOff: await off };
    fs.rmSync(d, { recursive: true });
    return out;
  },

  // ---- http ----
  'http.request.host': async () => echoOf(await request({ host: '127.0.0.1', port: O(), path: '/echo' })),
  'http.request.hostname': async () => echoOf(await request({ hostname: '127.0.0.1', host: 'ignored.invalid', port: O(), path: '/echo' })),
  'http.request.port': async () => echoOf(await request({ host: '127.0.0.1', port: String(O()), path: '/echo' })),
  'http.request.path': async () => echoOf(await request({ host: '127.0.0.1', port: O(), path: '/echo?q=1' })),
  'http.request.method': async () => echoOf(await request({ host: '127.0.0.1', port: O(), path: '/echo', method: 'PUT' }, 'b')),
  'http.request.headers': async () => echoOf(await request({ host: '127.0.0.1', port: O(), path: '/echo', headers: { 'x-a': 'b', host: 'named.example' } })),
  'http.request.auth': async () => echoOf(await request({ host: '127.0.0.1', port: O(), path: '/echo', auth: 'u:p' })),
  'http.request.setHost': async () => echoOf(await request({ host: '127.0.0.1', port: O(), path: '/echo', setHost: false })),
  'http.request.defaultPort': async () => echoOf(await request({ host: '127.0.0.1', defaultPort: O(), path: '/echo' })),
  'http.request.protocol': async () => ({
    http: echoOf(await request({ protocol: 'http:', host: '127.0.0.1', port: O(), path: '/echo' })),
    other: await request({ protocol: 'ftp:', host: '127.0.0.1', port: O(), path: '/echo' }),
  }),
  'http.request.agent': async () => ({
    agent: echoOf(await request({ host: '127.0.0.1', port: O(), path: '/echo', agent: new http.Agent() })),
    none: echoOf(await request({ host: '127.0.0.1', port: O(), path: '/echo', agent: false })),
  }),
  'http.request.timeout': async () => {
    const r = await request({ host: '127.0.0.1', port: O(), path: '/slow-headers?ms=1500', timeout: 200 });
    return { events: r.events, error: r.error && r.error.name };
  },
  'http.request.signal': async () => {
    const ac = new AbortController();
    const p = request({ host: '127.0.0.1', port: O(), path: '/slow-headers?ms=1500', signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const pre = new AbortController(); pre.abort();
    return { late: (await p).error, early: (await request({ host: '127.0.0.1', port: O(), path: '/echo', signal: pre.signal })).error };
  },
  // a lookup that answers for a name no resolver knows: the request goes where it says, under that name
  'http.request.lookup': async () => {
    const calls = [];
    const lookup = (host, o, cb) => { calls.push({ host, all: !!o.all }); if (o.all) cb(null, [{ address: '127.0.0.1', family: 4 }]); else cb(null, '127.0.0.1', 4); };
    const r = echoOf(await request({ host: 'census.invalid', port: O(), path: '/echo', lookup }));
    const failing = await request({ host: 'census.invalid', port: O(), path: '/echo', lookup: (h, o, cb) => cb(Object.assign(new Error('no such name'), { code: 'ENOTFOUND' })) });
    return { r, hosts: [...new Set(calls.map((c) => c.host))], failing: failing.error };
  },
  'http.Agent.connect': async () => {
    const lookup = (host, o, cb) => { if (o.all) cb(null, [{ address: '127.0.0.1', family: 4 }]); else cb(null, '127.0.0.1', 4); };
    return {
      lookup: echoOf(await request({ host: 'census.invalid', port: O(), path: '/echo', agent: new http.Agent({ lookup }) })),
      family: echoOf(await request({ host: 'localhost', port: O(), path: '/echo', agent: new http.Agent({ family: 4, autoSelectFamily: false, autoSelectFamilyAttemptTimeout: 100 }) })),
    };
  },
  // an agent's timeout is its sockets' (a request naming none times out by it); a subclass that clears it in
  // createConnection, as the bundle's own keep-alive agent does, gets none; the request's own wins
  'http.Agent.timeout': async () => {
    class Clearing extends http.Agent {
      constructor() { super({ timeout: 200 }); }
      createConnection(o, cb) { return super.createConnection(Object.assign(o, { timeout: undefined }), cb); }
    }
    const slow = (agent, extra = {}) => request({ host: '127.0.0.1', port: O(), path: '/slow-headers?ms=700', agent, ...extra });
    const pick = (r) => ({ timedOut: r.events.includes('timeout'), status: r.status ?? null });
    return {
      agent: pick(await slow(new http.Agent({ timeout: 200 }))),
      cleared: pick(await slow(new Clearing())),
      own: pick(await slow(new http.Agent({ timeout: 5000 }), { timeout: 200 })),
    };
  },
  'http.Agent.defaultPort': async () => echoOf(await request({ host: '127.0.0.1', path: '/echo', agent: new http.Agent({ defaultPort: O() }) })),
  'http.Agent.protocol': async () => (await request({ host: '127.0.0.1', port: O(), path: '/echo', agent: new http.Agent({ protocol: 'https:' }) })).threw,

  // ---- zlib ----
  'zlib.encoding': async () => {
    const z = zlib.gzipSync(Buffer.from('hello encoding'));
    return new Promise((res) => {
      const g = zlib.createGunzip({ encoding: 'utf8' });
      const kinds = []; let text = '';
      g.on('data', (c) => { kinds.push(typeof c); text += c; });
      g.on('end', () => res({ kinds: [...new Set(kinds)], text }));
      g.end(z);
    });
  },
  'zlib.flush': async () => {
    const z = zlib.gzipSync(Buffer.from('flushed '.repeat(200)));
    return new Promise((res) => {
      const g = zlib.createGunzip({ flush: zlib.constants.Z_SYNC_FLUSH });
      const parts = [];
      g.on('data', (c) => parts.push(c));
      g.on('end', () => res(Buffer.concat(parts).length));
      g.write(z.subarray(0, 20)); g.write(z.subarray(20, 40)); g.end(z.subarray(40));
    });
  },
  'zlib.chunkSize': async () => {
    const z = zlib.gzipSync(Buffer.from('x'.repeat(5000)));
    const out = { bad: tryCode(() => zlib.gunzipSync(z, { chunkSize: 10 })), oneShot: zlib.gunzipSync(z, { chunkSize: 64 }).length };
    out.stream = await new Promise((res) => {
      const g = zlib.createGunzip({ chunkSize: 1024 }); const sizes = [];
      g.on('data', (c) => sizes.push(c.length));
      g.on('end', () => res({ total: sizes.reduce((a, b) => a + b, 0), none: sizes.every((n) => n <= 1024) }));
      g.end(z);
    });
    return out;
  },
  'zlib.maxOutputLength': async () => {
    const z = zlib.gzipSync(Buffer.from('x'.repeat(5000)));
    const out = { over: tryCode(() => zlib.gunzipSync(z, { maxOutputLength: 100 })), exact: zlib.gunzipSync(z, { maxOutputLength: 5000 }).length };
    out.callback = await new Promise((res) => zlib.gunzip(z, { maxOutputLength: 100 }, (e) => res(e ? e.code : 'ok')));
    out.deflate = tryCode(() => zlib.deflateSync(Buffer.from('y'.repeat(50)), { maxOutputLength: 2 }));
    return out;
  },
  'zlib.finishFlush': async () => {
    const z = zlib.gzipSync(Buffer.from('truncated '.repeat(300)));
    const cut = z.subarray(0, z.length - 12);
    const one = (opts) => new Promise((res) => {
      const g = zlib.createGunzip(opts);
      let n = 0;
      g.on('data', (c) => { n += c.length; });
      // how much is decoded before the cut is the inflater's buffering, not the option: only whether any was
      g.on('error', (e) => res({ error: e.code, decoded: n > 0 }));
      g.on('end', () => res({ end: true, decoded: n > 0 }));
      g.end(cut);
    });
    let bad = 'no throw';
    try { zlib.createGunzip({ finishFlush: 99 }); } catch (e) { bad = e.code; }
    return { finish: await one(undefined), sync: await one({ finishFlush: zlib.constants.Z_SYNC_FLUSH }), bad };
  },
};

// a: b/f (a file), rel -> b/f (a relative link), abs -> <a>/b/f (an absolute one); the tree the cp rows copy
function cpTree() {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(d, 'a', 'b', 'f'), 'new');
  fs.symlinkSync(path.join('b', 'f'), path.join(d, 'a', 'rel'));
  fs.symlinkSync(path.join(d, 'a', 'b', 'f'), path.join(d, 'a', 'abs'));
  return d;
}
function listTree(root) {
  const out = [];
  const walk = (p, rel) => {
    for (const n of fs.readdirSync(p).sort()) {
      const q = path.join(p, n); const r = rel ? `${rel}/${n}` : n; const st = fs.lstatSync(q);
      out.push(`${r}${st.isDirectory() ? '/' : st.isSymbolicLink() ? '@' : ''}`);
      if (st.isDirectory()) walk(q, r);
    }
  };
  walk(root, '');
  return out;
}

async function runRows(only) {
  const out = {};
  for (const [label, row] of Object.entries(ROWS)) {
    if (only && !only.includes(label)) continue;
    try { out[label] = await row(); } catch (e) { out[label] = { threw: e && (e.code || e.name), message: String(e && e.message).slice(0, 200) }; }
  }
  return out;
}
module.exports = { ROWS, runRows };
if (process.env.OPTIONS_CENSUS_RUN_ROWS === '1') {
  runRows(process.env.OPTIONS_CENSUS_ONLY ? process.env.OPTIONS_CENSUS_ONLY.split(',') : undefined).then((out) => {
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(0);
  });
}
