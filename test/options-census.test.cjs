'use strict';
// THE OPTIONS CENSUS: every option a shim entry point is handed is HONOURED or REFUSED BY NAME, never ignored.
//
// THE CLASS (measured in live quaude turns, 2026-11-22/23): a shim function the bundle calls with an options object
// read past a key in silence, so behaviour diverged from native with no error to show for it. child_process.spawnSync
// ignored `stdio: 'inherit'` (the /tui relaunch drew into a pipe), https.Agent ignored `ca` (a server the caller did
// not trust was accepted), Bun's fetch ignored `unix`, `proxy`, `compress` and `decompress`, Bun.spawn ignored every
// option but cmd/cwd/env (stderr piped where Bun inherits it, no timeout, no signal, no argv0).
//
// THE RATCHET is two guards (test/guard.cjs) over the option TABLES:
//   options-census-node  node-shim (libexec/node-shim/internal/options.cjs): the reference is NODE'S OWN SOURCE, read
//                        by test/fixtures/options-census-node-derive.cjs and recorded in options-census-node.json
//   options-census-bun   bun-shim (libexec/bun-shim.cjs BUN_OPTION_TABLES): the reference is NATIVE BUN, recorded with
//                        a Proxy inside native Claude Code (test/fixtures/options-census-bun-native.json)
// A key the reference reads that the table neither honours, refuses nor exempts is a finding, named; so is a key the
// table names that the reference no longer reads (stale: it would hide a renamed one), an honoured key whose proof
// does not exist, and an exemption whose BACKLOG.md entry does not. The TLS keys are the TLS census's
// (test/node-shim-tls-options.test.cjs), which this one generalizes and does not repeat.
//
// THE PROOFS behind the tables, run here too: the node rows (test/fixtures/options-census-probe.cjs) under host node
// and under the shim, compared; the Bun rows (test/fixtures/options-census-bun-rows.cjs) under the shim, compared with
// native Bun's recorded answers; and every refused key, under the shim, throws its coded error before anything is
// started, opened, created or sent.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

const FIX = path.join(__dirname, 'fixtures');
const NODE_FIXTURE = path.join(FIX, 'options-census-node.json');
const BUN_FIXTURE = path.join(FIX, 'options-census-bun-native.json');
const BUN_ROWS_NATIVE = path.join(FIX, 'options-census-bun-rows-native.json');
const DERIVE = path.join(FIX, 'options-census-node-derive.cjs');
const PROBE = path.join(FIX, 'options-census-probe.cjs');
const BUN_ROWS = path.join(FIX, 'options-census-bun-rows.cjs');
const ORIGIN = path.join(FIX, 'options-census-origin.cjs');
const OPTIONS = path.join(REPO, 'libexec/node-shim/internal/options.cjs');
const HTTP = path.join(REPO, 'libexec/node-shim/modules/http.cjs');
const BUN_SHIM = path.join(REPO, 'libexec/bun-shim.cjs');
const BACKLOG = path.join(REPO, 'BACKLOG.md');

// ---- the shared scan --------------------------------------------------------------------------------------------
// reference: { entry: [keys] }; tables: { entry: { honoured, refused, exempt, absent, tls, platform } };
// proofs: { rows: Set, bunRows: Set, tests: (file, title) => bool }; tlsKeys: keys the TLS census owns; backlog: text
function scanCensus({ who, reference, tables, rows, tests, tlsKeys, backlog, refusedEverywhere = {} }) {
  const findings = [];
  let examined = 0;
  for (const [entry, keys] of Object.entries(reference)) {
    const t = tables[entry];
    if (!t) { findings.push(`${who}: reference entry '${entry}' has no table: its ${keys.length} keys are unaccounted for`); continue; }
    if (t.absent) { examined += keys.length; continue; }
    const honoured = Object.keys(t.honoured || {});
    const refused = Object.keys({ ...(t.refused || {}), ...(entry.startsWith('Bun.spawn') ? refusedEverywhere : {}) });
    const exempt = Object.keys(t.exempt || {});
    const platform = Object.keys(t.platform || {});
    const named = [...honoured, ...refused, ...exempt];
    for (const k of named) {
      const n = named.filter((x) => x === k).length;
      if (n > 1 && !(honoured.includes(k) && refused.includes(k) && (t.honoured[k] || '').startsWith('false only'))) {
        findings.push(`${who}: ${entry} '${k}' is in more than one list`);
      }
    }
    for (const k of keys) {
      examined++;
      if (t.tls && tlsKeys.includes(k)) continue;   // the TLS census's key
      if (!named.includes(k)) {
        findings.push(`${who}: ${entry} reads option '${k}' and the shim neither honours nor refuses it, so it is IGNORED `
          + `(add it to ${who === 'node' ? 'libexec/node-shim/internal/options.cjs' : 'libexec/bun-shim.cjs BUN_OPTION_TABLES'})`);
      }
    }
    for (const k of named) {
      if (!keys.includes(k) && !platform.includes(k) && !(t.tls && tlsKeys.includes(k))) {
        findings.push(`${who}: ${entry} names '${k}', which the reference no longer reads there (stale: it would hide a renamed key)`);
      }
    }
    for (const [k, proof] of Object.entries(t.honoured || {})) {
      if (typeof proof !== 'string') { findings.push(`${who}: ${entry} '${k}' has no proof`); continue; }
      if (proof.startsWith('row:')) { if (!rows.has(proof.slice(4))) findings.push(`${who}: ${entry} '${k}' cites row '${proof.slice(4)}', which does not exist`); }
      else if (proof.startsWith('test:')) {
        const [file, title] = proof.slice(5).split('::');
        if (!tests(file, title)) findings.push(`${who}: ${entry} '${k}' cites test '${title}' in ${file}, which does not exist`);
      } else if (!/^(tls:|false only)/.test(proof)) findings.push(`${who}: ${entry} '${k}' cites '${proof}', which is not a row or a test`);
    }
    for (const [k, why] of Object.entries(t.exempt || {})) {
      const m = /BACKLOG\.md "([^"]+)"/.exec(why);
      if (!m) findings.push(`${who}: ${entry} '${k}' is exempt without naming a BACKLOG.md entry`);
      else if (!backlog.includes(m[1])) findings.push(`${who}: ${entry} '${k}' is exempt under BACKLOG.md "${m[1]}", which BACKLOG.md does not have`);
    }
  }
  for (const entry of Object.keys(tables)) {
    if (!(entry in reference)) findings.push(`${who}: the table '${entry}' answers no entry the reference has (stale)`);
  }
  return { findings, examined };
}

const testTitles = new Map();
function hasTest(file, title) {
  const f = path.join(__dirname, file);
  if (!testTitles.has(f)) testTitles.set(f, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return testTitles.get(f).includes(title);
}

// ---- node ---------------------------------------------------------------------------------------------------------
function readNodeCensus() {
  const recorded = JSON.parse(fs.readFileSync(NODE_FIXTURE, 'utf8'));
  const { TABLES } = require(OPTIONS);
  const { TLS_OPTIONS_HONOURED, UNSUPPORTED_TLS_OPTIONS } = require(HTTP)._internals.tls;
  return {
    who: 'node', reference: recorded.entries, tables: TABLES, rows: new Set(Object.keys(require(PROBE).ROWS)), tests: hasTest,
    tlsKeys: [...TLS_OPTIONS_HONOURED, ...UNSUPPORTED_TLS_OPTIONS], backlog: fs.readFileSync(BACKLOG, 'utf8'),
  };
}
guardTests(defineGuard({
  name: 'options-census-node',
  floor: 400,
  read: readNodeCensus,
  scan: scanCensus,
  // the real tables with one refused key taken away: the census must name it
  control() {
    const r = readNodeCensus();
    const spawnTable = r.tables['child_process.spawn'];
    const { serialization, ...refused } = spawnTable.refused;
    return { ...r, tables: { ...r.tables, 'child_process.spawn': { ...spawnTable, refused } } };
  },
}));

test('options census (node): the recorded reference is what host node\'s source says, when the majors match', (t) => {
  const major = (v) => v.replace(/^v/, '').split('.')[0];
  const r = spawnSync(process.execPath, ['--expose-internals', DERIVE], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const live = JSON.parse(r.stdout);
  assert.deepStrictEqual(live.problems, [], 'the derivation reported problems: it no longer reads node\'s source as written');
  if (process.env.CLODE_RECORD_OPTIONS_CENSUS === '1') {
    fs.writeFileSync(NODE_FIXTURE, `${JSON.stringify({ _recorded: `${new Date().toISOString().slice(0, 10)}, node ${live.node} (test/fixtures/options-census-node-derive.cjs)`, node: live.node, entries: live.entries }, null, 1)}\n`);
    t.diagnostic(`recorded ${NODE_FIXTURE} from node ${live.node}`);
    return;
  }
  const recorded = JSON.parse(fs.readFileSync(NODE_FIXTURE, 'utf8'));
  if (major(live.node) !== major(recorded.node)) {
    t.skip(`host node ${live.node} is not the recorded ${recorded.node}'s major; re-record with CLODE_RECORD_OPTIONS_CENSUS=1 on that major`);
    return;
  }
  assert.deepStrictEqual(live.entries, recorded.entries,
    `node ${live.node} reads different option keys than the recording (${recorded.node}); re-record with CLODE_RECORD_OPTIONS_CENSUS=1 and answer every new key`);
});

// ---- bun ----------------------------------------------------------------------------------------------------------
function readBunCensus() {
  const recorded = JSON.parse(fs.readFileSync(BUN_FIXTURE, 'utf8'));
  const { tables, refusedEverywhere } = require(BUN_SHIM)._bunOptionTables;
  // the tls keys are the TLS census's; here `tls` itself is a key, honoured through that census
  return {
    who: 'bun', reference: recorded.entries, tables, rows: new Set(Object.keys(require(BUN_ROWS).ROWS)), tests: hasTest,
    tlsKeys: [], backlog: fs.readFileSync(BACKLOG, 'utf8'), refusedEverywhere,
  };
}
guardTests(defineGuard({
  name: 'options-census-bun',
  floor: 50,
  read: readBunCensus,
  scan: scanCensus,
  // the real tables without `unix`, one of the keys native passes (ANTHROPIC_UNIX_SOCKET) that bun-shim used to ignore
  control() {
    const r = readBunCensus();
    const f = r.tables.fetch;
    const { unix, ...refused } = f.refused;
    return { ...r, tables: { ...r.tables, fetch: { ...f, refused } } };
  },
}));

// ---- the census origin --------------------------------------------------------------------------------------------
async function startOrigin() {
  const proc = spawn(process.execPath, [ORIGIN], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('the census origin printed no PORT line')), 15000);
    proc.stdout.on('data', (d) => { buf += d; const m = /PORT (\d+)/.exec(buf); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
    proc.on('close', (code) => { clearTimeout(timer); reject(new Error(`the census origin exited (${code})`)); });
  });
  return { port, stop: () => proc.kill() };
}
function posixOnly(t) {
  if (process.platform === 'win32') { t.skip('the rows run /bin/sh'); return true; }
  return false;
}
const lastJson = (s) => JSON.parse(String(s).trim().split('\n').pop());

// ---- the proofs: rows ---------------------------------------------------------------------------------------------
test('options census (node): every row answers under the shim as it does under host node', async (t) => {
  if (skipUnlessTjs(t) || posixOnly(t)) return;
  const o = await startOrigin();
  try {
    const env = { ...process.env, ORIGIN_PORT: String(o.port), OPTIONS_CENSUS_RUN_ROWS: '1' };
    const node = await new Promise((resolve) => {
      const c = spawn(process.execPath, [PROBE], { env, stdio: ['ignore', 'pipe', 'inherit'] });
      let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', () => resolve(lastJson(out)));
    });
    const r = runLoader(PROBE, [], { env: { ORIGIN_PORT: String(o.port), OPTIONS_CENSUS_RUN_ROWS: '1' }, timeout: 120000 });
    assert.strictEqual(r.status, 0, r.stderr);
    const shim = lastJson(r.stdout);
    const differ = Object.keys(node).filter((k) => JSON.stringify(node[k]) !== JSON.stringify(shim[k]));
    assert.deepStrictEqual(differ.map((k) => ({ row: k, node: node[k], shim: shim[k] })), [], 'rows where the shim does not do what the option asks');
    assert.ok(Object.keys(node).length >= 70, `only ${Object.keys(node).length} rows ran`);
  } finally { o.stop(); }
});

test('options census (bun): every row answers under the shim as native Bun answered it', async (t) => {
  if (skipUnlessTjs(t) || posixOnly(t)) return;
  const { _recorded, ...native } = JSON.parse(fs.readFileSync(BUN_ROWS_NATIVE, 'utf8'));
  const o = await startOrigin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bunrows-'));
  try {
    const f = path.join(dir, 'rows.cjs');
    fs.writeFileSync(f, `require(${JSON.stringify(BUN_SHIM)});\nrequire(${JSON.stringify(BUN_ROWS)});\n`);
    const r = runLoader(f, [], { env: { ORIGIN_PORT: String(o.port), OPTIONS_CENSUS_RUN_ROWS: '1' }, timeout: 120000 });
    assert.strictEqual(r.status, 0, r.stderr);
    const shim = lastJson(r.stdout);
    const differ = Object.keys(native).filter((k) => JSON.stringify(native[k]) !== JSON.stringify(shim[k]));
    assert.deepStrictEqual(differ.map((k) => ({ row: k, native: native[k], shim: shim[k] })), [], 'rows where bun-shim does not do what native Bun does');
    assert.strictEqual(Object.keys(shim).length, Object.keys(native).length, 'the rows file and the native recording disagree on the rows');
  } finally { o.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the proofs: refusals -----------------------------------------------------------------------------------------
// Under the shim, each refused key of each entry: the call throws (or rejects) its coded error, and the side effect it
// would have had (a child started, a file created, a connection made) did not happen.
test('options census (node): every refused option throws its code before any side effect', (t) => {
  if (skipUnlessTjs(t) || posixOnly(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-refused-'));
  const f = path.join(dir, 'refused.cjs');
  fs.writeFileSync(f, `
const { TABLES, INERT } = require(${JSON.stringify(OPTIONS)});
const cp = require('child_process'); const fs = require('fs'); const http = require('http'); const https = require('https');
const zlib = require('zlib'); const path = require('path');
const dir = process.argv[2];
const sample = (k) => { const inert = INERT[k] || []; return inert.includes(1) ? 2 : 1; };
const mark = (n) => path.join(dir, 'mark-' + n);
const sh = (n) => ['/bin/sh', ['-c', 'touch ' + mark(n)]];
const CALL = {
  'child_process.spawn': (o, n) => cp.spawn(...sh(n), o),
  'child_process.spawnSync': (o, n) => cp.spawnSync(...sh(n), o),
  'child_process.execFileSync': (o, n) => cp.execFileSync(...sh(n), o),
  'child_process.execSync': (o, n) => cp.execSync('touch ' + mark(n), o),
  'child_process.execFile': (o, n) => cp.execFile(...sh(n), o, () => {}),
  'child_process.exec': (o, n) => cp.exec('touch ' + mark(n), o, () => {}),
  'http.request': (o) => http.request({ host: '127.0.0.1', port: 9, path: '/', ...o }).on('error', () => {}),
  'https.request': (o) => https.request({ host: '127.0.0.1', port: 9, path: '/', ...o }).on('error', () => {}),
  'http.Agent': (o) => new http.Agent(o),
  'https.Agent': (o) => new https.Agent(o),
  'fs.readFileSync': (o, n) => fs.readFileSync(mark(n), o),
  'fs.readFile': (o, n) => fs.readFile(mark(n), o, () => {}),
  'fs.promises.readFile': (o, n) => fs.promises.readFile(mark(n), o),
  'fs.writeFileSync': (o, n) => fs.writeFileSync(mark(n), 'x', o),
  'fs.writeFile': (o, n) => fs.writeFile(mark(n), 'x', o, () => {}),
  'fs.promises.writeFile': (o, n) => fs.promises.writeFile(mark(n), 'x', o),
  'fs.mkdirSync': (o, n) => fs.mkdirSync(mark(n), o),
  'fs.mkdir': (o, n) => fs.mkdir(mark(n), o, () => {}),
  'fs.promises.mkdir': (o, n) => fs.promises.mkdir(mark(n), o),
  'fs.createReadStream': (o, n) => fs.createReadStream(mark(n), o),
  'fs.createWriteStream': (o, n) => fs.createWriteStream(mark(n), o),
  'zlib.zlib': (o) => zlib.createGunzip(o),
  'zlib.zlib/sync': (o) => zlib.gunzipSync(zlib.gzipSync('x'), o),
};
const out = {};
(async () => {
  let n = 0;
  for (const [entry, table] of Object.entries(TABLES)) {
    if (!table.refused || entry === 'fs.open:flags') continue;
    for (const [k] of Object.entries(table.refused)) {
      for (const via of entry === 'zlib.zlib' ? [entry, entry + '/sync'] : [entry]) {
        const call = CALL[via];
        if (!call) { out[via + ' ' + k] = 'NO CALL'; continue; }
        n++;
        let got;
        try { const r = call({ [k]: sample(k) }, n); got = r && typeof r.then === 'function' ? await r.then(() => 'NOT REFUSED', (e) => e.code) : 'NOT REFUSED'; }
        catch (e) { got = e.code; }
        await new Promise((res) => setTimeout(res, 0));
        out[via + ' ' + k] = { code: got, sideEffect: fs.existsSync(mark(n)) };
      }
    }
  }
  console.log(JSON.stringify(out));
  process.exit(0);
})();
`);
  try {
    const r = runLoader(f, [dir], { timeout: 60000 });
    assert.strictEqual(r.status, 0, r.stderr);
    const got = lastJson(r.stdout);
    const { TABLES } = require(OPTIONS);
    const wrong = [];
    for (const [k, v] of Object.entries(got)) {
      const entry = k.split(' ')[0].replace('/sync', '').replace(/^fs\.open$/, 'fs.open:flags');
      const want = (TABLES[entry] && TABLES[entry].code) || 'ERR_SHIM_UNSUPPORTED_OPTION';
      if (!v || v.code !== want || v.sideEffect) wrong.push(`${k}: ${JSON.stringify(v)} (want ${want}, no side effect)`);
    }
    assert.deepStrictEqual(wrong, []);
    assert.ok(Object.keys(got).length >= 40, `only ${Object.keys(got).length} refusals were exercised`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('options census (node): every entry the tables call absent is absent or a wall under the shim', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-absent-'));
  const f = path.join(dir, 'absent.cjs');
  fs.writeFileSync(f, `
const out = {};
out.fork = typeof require('child_process').fork;
for (const [m, fn] of [['net', 'connect'], ['tls', 'connect']]) {
  try { require(m)[fn]({ host: '127.0.0.1', port: 9 }); out[m] = 'connected'; } catch (e) { out[m] = /node-shim/.test(e.message) ? 'wall' : e.message; }
}
out.brotli = typeof require('zlib').createBrotliDecompress;
console.log(JSON.stringify(out));
`);
  try {
    const r = runLoader(f);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(lastJson(r.stdout), { fork: 'undefined', net: 'wall', tls: 'wall', brotli: 'undefined' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('options census (bun): every refused option throws its code before anything is started or sent', async (t) => {
  if (skipUnlessTjs(t) || posixOnly(t)) return;
  const o = await startOrigin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bunrefused-'));
  const f = path.join(dir, 'refused.cjs');
  fs.writeFileSync(f, `
const Bun = require(${JSON.stringify(BUN_SHIM)});
const { tables, inert, refusedEverywhere } = Bun._bunOptionTables;
const fs = require('fs'); const path = require('path');
const dir = process.argv[2]; const B = 'http://127.0.0.1:' + process.env.ORIGIN_PORT;
const sample = (k) => ((inert[k] || []).includes(true) ? 2 : true);
const mark = (n) => path.join(dir, 'mark-' + n);
const out = {};
(async () => {
  let n = 0;
  for (const [entry, table] of Object.entries(tables)) {
    const refused = { ...(table.refused || {}), ...(entry.startsWith('Bun.spawn') ? refusedEverywhere : {}) };
    for (const k of Object.keys(refused)) {
      n++;
      let got;
      try {
        if (entry === 'fetch') got = await fetch(B + '/echo?mark=' + n, { [k]: sample(k) }).then(() => 'NOT REFUSED', (e) => e.code);
        // what reached the origin is the side effect a fetch or a WebSocket would have had
        else if (entry === 'Bun.spawn') { Bun.spawn(['/bin/sh', '-c', 'touch ' + mark(n)], { [k]: sample(k) }); got = 'NOT REFUSED'; }
        else if (entry === 'Bun.spawnSync') { Bun.spawnSync(['/bin/sh', '-c', 'touch ' + mark(n)], { [k]: sample(k) }); got = 'NOT REFUSED'; }
        else if (entry === 'WebSocket') { new WebSocket('ws://127.0.0.1:' + process.env.ORIGIN_PORT + '/?mark=' + n, { [k]: 'http://127.0.0.1:9' }); got = 'NOT REFUSED'; }
      } catch (e) { got = e.code; }
      await new Promise((res) => setTimeout(res, 50));
      const reached = (await (await fetch(B + '/marks')).json()).includes(String(n));
      out[entry + ' ' + k] = { code: got, sideEffect: fs.existsSync(mark(n)) || reached };
    }
  }
  // decompress:false against a server that encodes regardless: refused by name rather than handed back decoded
  out.decompressEncodedAnyway = await fetch(B + '/gzip', { decompress: false }).then(() => 'NOT REFUSED', (e) => e.code + ':' + e.option);
  console.log(JSON.stringify(out));
  process.exit(0);
})();
`);
  try {
    const r = runLoader(f, [dir], { env: { ORIGIN_PORT: String(o.port) }, timeout: 60000 });
    assert.strictEqual(r.status, 0, r.stderr);
    const got = lastJson(r.stdout);
    const { decompressEncodedAnyway, ...rest } = got;
    assert.strictEqual(decompressEncodedAnyway, 'ERR_CLODE_UNSUPPORTED_OPTION:decompress');
    const wrong = Object.entries(rest).filter(([, v]) => v.code !== 'ERR_CLODE_UNSUPPORTED_OPTION' || v.sideEffect);
    assert.deepStrictEqual(wrong, []);
    assert.ok(Object.keys(rest).length >= 15, `only ${Object.keys(rest).length} refusals were exercised`);
  } finally { o.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
