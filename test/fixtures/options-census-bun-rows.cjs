'use strict';
// THE BUN ROWS of the options census (test/options-census.test.cjs): one behavioural row per honoured key of fetch,
// Bun.spawn, Bun.spawnSync and WebSocket (libexec/bun-shim.cjs BUN_OPTION_TABLES names each key's row). Each row
// answers in plain JSON what the option DID, so native Bun's answer and the shim's can be compared exactly.
//
// Native Bun's answers are RECORDED (test/fixtures/options-census-bun-rows-native.json): run inside native Claude
// Code's Bun as a preload, against the census origin (test/fixtures/options-census-origin.cjs, under host node):
//   node test/fixtures/options-census-origin.cjs   (prints PORT <n>)
//   env -i PATH=/usr/bin:/bin HOME=<tmp> ORIGIN_PORT=<n> OUTF=<file> BUN_OPTIONS="--preload <this file>" <native claude> --version
// and copy OUTF over the fixture. The test runs the same file under the tjs loader with bun-shim loaded, against a
// fresh origin, and compares. POSIX only (it runs /bin/sh); the answers do not depend on the host's paths.
const fs = require('fs');

const B = `http://127.0.0.1:${process.env.ORIGIN_PORT}`;
const err = (e) => ({ error: e && e.name });
const kind = (v) => (v === undefined ? 'undefined' : v === null ? 'null' : typeof v);
async function text(s) {
  if (s === undefined || s === null) return kind(s);
  if (typeof s.getReader === 'function') return new Response(s).text();
  return new Promise((res) => { let b = ''; s.on('data', (d) => { b += d; }); s.on('end', () => res(b)); });
}
const enc = (x) => new TextEncoder().encode(x);
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const ROWS = {
  // ---- fetch ----
  'fetch.methodHeadersBody': async () => {
    const j = await (await fetch(`${B}/echo`, { method: 'POST', headers: { 'x-a': 'b' }, body: 'payload' })).json();
    return { method: j.method, xa: j.headers['x-a'], body: j.body };
  },
  'fetch.redirect': async () => {
    const out = {};
    const m = await fetch(`${B}/redirect?n=2`, { redirect: 'manual' });
    out.manual = { status: m.status, location: m.headers.get('location') };
    try { await fetch(`${B}/redirect?n=2`, { redirect: 'error' }); out.error = 'followed'; } catch (e) { out.error = err(e); }
    const f = await fetch(`${B}/redirect?n=2`, { redirect: 'follow' });
    out.follow = { status: f.status, text: await f.text() };
    return out;
  },
  'fetch.signal': async () => {
    const out = {};
    const pre = new AbortController(); pre.abort();
    try { await fetch(`${B}/echo`, { signal: pre.signal }); out.pre = 'answered'; } catch (e) { out.pre = err(e); }
    const late = new AbortController(); setTimeout(() => late.abort(), 200);
    try { await fetch(`${B}/slow-headers?ms=1500`, { signal: late.signal }); out.late = 'answered'; } catch (e) { out.late = err(e); }
    return out;
  },
  // Bun reads timeout as a switch: neither false nor a number cuts off a 1.2 s answer
  'fetch.timeout': async () => {
    const out = {};
    for (const [k, v] of [['false', false], ['number', 300], ['one', 1]]) {
      try { out[k] = await (await fetch(`${B}/slow-headers?ms=1200`, { timeout: v })).text(); } catch (e) { out[k] = err(e); }
    }
    return out;
  },
  'fetch.decompress': async () => {
    const raw = await fetch(`${B}/gzip-negotiated`, { decompress: false });
    const dflt = await fetch(`${B}/gzip-negotiated`);
    return { rawText: await raw.text(), rawEncoding: raw.headers.get('content-encoding'), defaultText: await dflt.text() };
  },
  'fetch.compress': async () => {
    const j = await (await fetch(`${B}/echo`, { method: 'POST', body: 'squeeze me', compress: true })).json();
    const k = await (await fetch(`${B}/echo`, { method: 'POST', body: 'leave me', compress: false })).json();
    return { on: { encoding: j.headers['content-encoding'] || null, body: j.body }, off: { encoding: k.headers['content-encoding'] || null, body: k.body } };
  },
  'fetch.keepalive': async () => {
    const j = await (await fetch(`${B}/echo`, { keepalive: false })).json();
    return { reuseAsked: j.headers.connection === 'keep-alive' };
  },

  // ---- Bun.spawn ----
  'spawn.cwdEnv': async () => {
    const p = Bun.spawn({ cmd: ['/bin/sh', '-c', 'pwd; echo "$FOO"'], cwd: '/', env: { FOO: 'bar', PATH: '/usr/bin:/bin' } });
    return text(p.stdout);
  },
  'spawn.argv0': async () => text(Bun.spawn(['/bin/sh', '-c', 'echo $0'], { argv0: 'zz' }).stdout),
  'spawn.stdin': async () => {
    const out = {};
    out.bytes = await text(Bun.spawn(['/bin/sh', '-c', 'cat'], { stdin: enc('bytes-in') }).stdout);
    out.blob = await text(Bun.spawn(['/bin/sh', '-c', 'cat'], { stdin: new Blob(['blob-in']) }).stdout);
    out.response = await text(Bun.spawn(['/bin/sh', '-c', 'cat'], { stdin: new Response('resp-in') }).stdout);
    const p = Bun.spawn(['/bin/sh', '-c', 'cat'], { stdin: 'pipe' });
    p.stdin.write('piped'); p.stdin.end();
    out.pipe = await text(p.stdout);
    try { Bun.spawn(['/bin/sh', '-c', 'cat'], { stdin: 'not-a-mode' }); out.string = 'accepted'; } catch (e) { out.string = e.name; }
    return out;
  },
  'spawn.stdout': async () => {
    const d = Bun.spawn(['/bin/sh', '-c', 'read x; echo "r=$? x=$x"']);
    const out = { defaults: { stdin: kind(d.stdin), stdout: await text(d.stdout), stderr: kind(d.stderr), code: await d.exited } };
    const i = Bun.spawn(['/bin/sh', '-c', 'echo o; echo e >&2'], { stdout: 'ignore', stderr: 'pipe' });
    out.ignore = { stdout: kind(i.stdout), stderr: await text(i.stderr) };
    const n = Bun.spawn(['/bin/sh', '-c', 'echo x'], { stdin: null, stdout: null, stderr: null });
    out.nulls = kind(n.stdout); await n.exited;
    return out;
  },
  'spawn.stdio': async () => {
    const p = Bun.spawn(['/bin/sh', '-c', 'echo o; echo e >&2'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { stdout: await text(p.stdout), stderr: await text(p.stderr) };
  },
  'spawn.timeout': async () => {
    const out = {};
    for (const [k, o] of [['default', { timeout: 200 }], ['named', { timeout: 200, killSignal: 'SIGINT' }], ['number', { timeout: 200, killSignal: 9 }]]) {
      const t0 = Date.now();
      const p = Bun.spawn(['/bin/sleep', '5'], o);
      const exited = await p.exited;
      out[k] = { exited, exitCode: p.exitCode, signalCode: p.signalCode, quick: Date.now() - t0 < 2500 };
    }
    return out;
  },
  'spawn.signal': async () => {
    const out = {};
    const ac = new AbortController();
    const p = Bun.spawn(['/bin/sleep', '5'], { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    out.late = { exited: await p.exited, signalCode: p.signalCode };
    const pre = new AbortController(); pre.abort();
    try { Bun.spawn(['/bin/sleep', '5'], { signal: pre.signal }); out.pre = 'started'; } catch (e) { out.pre = e.name; }
    return out;
  },
  'spawn.onExit': async () => {
    let got = 'not called';
    const p = Bun.spawn(['/bin/sh', '-c', 'exit 3'], { onExit: (proc, code, sig, e) => { got = { same: proc === p, code, sig, err: kind(e) }; } });
    await p.exited; await settle(50);
    return got;
  },
  'spawn.detached': async () => {
    const pg = async (o) => { const w = (await text(Bun.spawn(['/bin/sh', '-c', 'ps -o pgid= -p $$; echo $$'], o).stdout)).trim().split(/\s+/); return w[0] === w[1]; };
    return { detached: await pg({ detached: true }), attached: await pg({}) };
  },
  // the caller's own ids (any other needs root): the child runs as them, and is not refused
  'spawn.uidGid': async () => {
    const ids = String(Bun.spawnSync(['/bin/sh', '-c', 'id -u; id -g']).stdout);
    const [uid, gid] = ids.trim().split('\n').map(Number);
    const p = Bun.spawn(['/bin/sh', '-c', 'id -u; id -g'], { uid, gid });
    return (await text(p.stdout)) === ids;
  },

  // ---- Bun.spawnSync ----
  'spawnSync.argvCwdEnv': async () => String(Bun.spawnSync({ cmd: ['/bin/sh', '-c', 'echo $0; pwd; echo "$FOO"'], argv0: 'yy', cwd: '/', env: { FOO: 'baz' } }).stdout),
  'spawnSync.stdin': async () => {
    const r = Bun.spawnSync(['/bin/sh', '-c', 'cat; exit 2'], { stdin: enc('sync-in') });
    const p = Bun.spawnSync(['/bin/sh', '-c', 'cat'], { stdin: 'pipe' });
    return { bytes: String(r.stdout), exitCode: r.exitCode, success: r.success, pipe: `${String(p.stdout)}|${p.exitCode}` };
  },
  'spawnSync.stdout': async () => {
    const d = Bun.spawnSync(['/bin/sh', '-c', 'echo o; echo e >&2']);
    const i = Bun.spawnSync(['/bin/sh', '-c', 'echo o'], { stdout: 'ignore' });
    const s = Bun.spawnSync(['/bin/sh', '-c', 'echo o; echo e >&2'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return { defaults: { stdout: String(d.stdout), stderr: String(d.stderr) }, ignore: kind(i.stdout), stdio: { stdout: String(s.stdout), stderr: kind(s.stderr) } };
  },
  'spawnSync.timeout': async () => {
    const t0 = Date.now();
    const r = Bun.spawnSync(['/bin/sleep', '5'], { timeout: 200 });
    const k = Bun.spawnSync(['/bin/sleep', '5'], { timeout: 200, killSignal: 'SIGINT' });
    return { exitCode: r.exitCode, signalCode: r.signalCode, success: r.success, exitedDueToTimeout: r.exitedDueToTimeout,
      quick: Date.now() - t0 < 3000, killSignal: k.signalCode };
  },
  'spawnSync.onExit': async () => {
    let got = 'not called';
    Bun.spawnSync(['/bin/sh', '-c', 'exit 4'], { onExit: () => { got = 'called'; } });
    await settle(50);
    return got;
  },

  // ---- WebSocket ----
  'ws.args': async () => {
    const one = (opts) => new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${process.env.ORIGIN_PORT}/ws`, opts);
      const timer = setTimeout(() => resolve('no message'), 5000);
      ws.addEventListener('message', (m) => {
        clearTimeout(timer);
        const j = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString());
        resolve({ xa: j.headers['x-a'] || null, offered: j.offered, chosen: ws.protocol || null });
        try { ws.close(); } catch (_) { /* closing */ }
      });
      ws.addEventListener('error', () => { clearTimeout(timer); resolve('error'); });
    });
    return { headersProtocols: await one({ headers: { 'x-a': 'b' }, protocols: ['p1', 'p2'] }), protocol: await one({ protocol: 'solo' }) };
  },
};

async function runRows(only) {
  const out = {};
  for (const [label, row] of Object.entries(ROWS)) {
    if (only && !only.includes(label)) continue;
    try { out[label] = await row(); } catch (e) { out[label] = { threw: e && e.name, code: e && e.code, message: String(e && e.message).slice(0, 200) }; }
  }
  return out;
}

module.exports = { ROWS, runRows };
// As a preload in native Bun (OUTF set) or a script under the shim: answer every row, then exit.
if (process.env.OPTIONS_CENSUS_RUN_ROWS === '1' || process.env.OUTF) {
  runRows().then((out) => {
    if (process.env.OUTF) fs.writeFileSync(process.env.OUTF, JSON.stringify(out, null, 1) + '\n');
    else process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(0);
  });
}
