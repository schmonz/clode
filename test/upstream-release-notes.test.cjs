'use strict';
// Hermetic characterization of scripts/upstream-release-notes.mjs — the tool that
// prints what UPSTREAM SAID between two Claude Code versions when a job goes red.
//
// NO NETWORK, EVER, IN THE DEFAULT SUITE. Every parse/range/render test runs
// against a fixture string, and the two end-to-end tests spawn the real script
// against a LOOPBACK http server (or a closed loopback port) — `npm test` stays
// offline and deterministic. That is not incidental: the whole point of the tool
// is to be usable inside an already-failing job, so its own tests must not add a
// second network dependency to the suite.
//
// The load-bearing assertions here are about WORDING, not just shape. On 2.1.243
// the upstream changelog's zstd line was true of a DIFFERENT artifact and sent an
// investigation down the wrong path (BACKLOG.md, "2.1.243"). So this file gates
// that the printed header still says lead-not-diagnosis and still carries that
// specific cautionary tale — a future edit that quietly softens the framing into
// "here's what changed" fails these tests, which is exactly the intent.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'upstream-release-notes.mjs');
const NODE = process.env.CLODE_NODE || process.execPath;

// A stand-in for upstream's CHANGELOG.md: `## <version>` sections, newest first,
// including the real 2.1.243 zstd line (the entry this tool exists to frame).
const FIXTURE = [
  '# Changelog',
  '',
  '## 2.1.243',
  '',
  '- Improved native install and auto-update download size: the binary is now zstd-compressed (about 75 MB instead of 340 MB on Linux x64)',
  '- Improved memory usage of native builds: code is now loaded on demand instead of keeping the whole bundle resident',
  '',
  '## 2.1.241',
  '',
  '- Fixed a thing in the TUI',
  '',
  '## 2.1.240',
  '',
  '- Added a setting',
  '',
  '## 2.1.239',
  '',
  '- four',
  '',
  '## 2.1.238',
  '',
  '- five',
  '',
  '## 2.1.237',
  '',
  '- six',
  '',
].join('\n');

let mod;
test.before(async () => { mod = await import('../scripts/upstream-release-notes.mjs'); });

// A fetch that never touches a socket. `body` may be a string (200) or a status number.
function fakeFetch(body) {
  return async () => (typeof body === 'number'
    ? { ok: false, status: body, text: async () => '' }
    : { ok: true, status: 200, text: async () => body });
}
function capture() {
  const buf = { out: '', err: '' };
  return { buf, stdout: (s) => { buf.out += s; }, stderr: (s) => { buf.err += s; } };
}

// ------------------------------------------------------------------ parsing

test('parseChangelog: sections in file order (newest first), bodies attached', () => {
  const s = mod.parseChangelog(FIXTURE);
  assert.deepStrictEqual(s.map((x) => x.version),
    ['2.1.243', '2.1.241', '2.1.240', '2.1.239', '2.1.238', '2.1.237']);
  assert.match(s[0].body, /zstd-compressed/);
  assert.strictEqual(s[1].body, '- Fixed a thing in the TUI');
  // The preamble before the first `##` belongs to no section and is dropped.
  assert.ok(!s.some((x) => /# Changelog/.test(x.body)));
});

test('parseChangelog: CRLF and trailing whitespace in heads', () => {
  const s = mod.parseChangelog('## 2.0.1  \r\n\r\n- a\r\n\r\n## 2.0.0\r\n\r\n- b\r\n');
  assert.deepStrictEqual(s.map((x) => x.version), ['2.0.1', '2.0.0']);
  assert.strictEqual(s[0].body, '- a');
});

test('parseChangelog: malformed input yields no sections rather than throwing', () => {
  for (const bad of ['', '<html><body>404: Not Found</body></html>', null, undefined, 42, '###### nope']) {
    assert.deepStrictEqual(mod.parseChangelog(bad), [], `input ${JSON.stringify(bad)}`);
  }
});

// ------------------------------------------------------------- range picking

test('selectRange: --from exclusive, --to inclusive, newest first', () => {
  const s = mod.parseChangelog(FIXTURE);
  const r = mod.selectRange(s, { from: '2.1.240', to: '2.1.243' });
  assert.strictEqual(r.status, 'delta');
  assert.deepStrictEqual(r.entries.map((e) => e.version), ['2.1.243', '2.1.241']);
  const one = mod.selectRange(s, { from: '2.1.241', to: '2.1.243' });
  assert.deepStrictEqual(one.entries.map((e) => e.version), ['2.1.243']);
});

test('selectRange: --to defaults to the newest section in the changelog', () => {
  const r = mod.selectRange(mod.parseChangelog(FIXTURE), { from: '2.1.240' });
  assert.strictEqual(r.to, '2.1.243');
  assert.deepStrictEqual(r.entries.map((e) => e.version), ['2.1.243', '2.1.241']);
});

test('selectRange: --from not in the changelog falls back to the newest N, and SAYS so', () => {
  const r = mod.selectRange(mod.parseChangelog(FIXTURE), { from: '1.0.0', to: '2.1.243' });
  assert.strictEqual(r.status, 'from-not-found');
  assert.strictEqual(r.entries.length, 5, 'newest 5 as context, never nothing');
  assert.deepStrictEqual(r.entries.map((e) => e.version),
    ['2.1.243', '2.1.241', '2.1.240', '2.1.239', '2.1.238']);
  assert.match(r.note, /not in the changelog/);
  assert.match(r.note, /context only/);
});

test('selectRange: --to not in the changelog is named, not silently defaulted', () => {
  const r = mod.selectRange(mod.parseChangelog(FIXTURE), { from: '2.1.240', to: '2.1.999' });
  assert.strictEqual(r.status, 'to-not-found');
  assert.match(r.note, /2\.1\.999 is not in the changelog/);
  assert.strictEqual(r.entries.length, 5);
});

test('selectRange: empty delta is a named answer, not silence', () => {
  const s = mod.parseChangelog(FIXTURE);
  const same = mod.selectRange(s, { from: '2.1.243', to: '2.1.243' });
  assert.strictEqual(same.status, 'no-delta');
  assert.deepStrictEqual(same.entries, []);
  assert.match(same.note, /empty range/);
  // Adjacent sections: from 2.1.241 through 2.1.241 is also empty.
  const adjacent = mod.selectRange(s, { from: '2.1.241', to: '2.1.241' });
  assert.strictEqual(adjacent.status, 'no-delta');
});

test('selectRange: swapped arguments are reported, not guessed at', () => {
  const r = mod.selectRange(mod.parseChangelog(FIXTURE), { from: '2.1.243', to: '2.1.240' });
  assert.strictEqual(r.status, 'inverted');
  assert.deepStrictEqual(r.entries, []);
  assert.match(r.note, /swapped/);
});

test('selectRange: a document with no sections is "no-sections", not an empty delta', () => {
  const r = mod.selectRange(mod.parseChangelog('<html>404</html>'), { from: '2.1.241' });
  assert.strictEqual(r.status, 'no-sections');
  assert.match(r.note, /not a changelog/);
});

// ------------------------------------------------ the framing (the whole point)

test('renderText: the header frames entries as a LEAD, never as a cause', () => {
  const sel = mod.selectRange(mod.parseChangelog(FIXTURE), { from: '2.1.241', to: '2.1.243' });
  const out = mod.renderText(sel);
  assert.match(out, /a LEAD, not a diagnosis/);
  assert.match(out, /what UPSTREAM SAID about THEIR product/);
  assert.match(out, /not one word of it has been checked against the artifact we carve/i);
  assert.match(out, /GO LOOK/);
  // The specific incident that justifies the warning must survive edits.
  assert.match(out, /zstd-compressed/);
  assert.match(out, /325MB -> 361MB/);
  assert.match(out, /Bun code splitting/);
  assert.match(out, /None of the above is evidence/);
  // And it must not claim causation for us.
  assert.doesNotMatch(out, /here is why|this is why .* broke|root cause/i);
  assert.match(out, /^## 2\.1\.243$/m);
  assert.doesNotMatch(out, /^## 2\.1\.241$/m, 'from is exclusive');
});

test('renderText: no-delta prints the useful negative answer', () => {
  const sel = mod.selectRange(mod.parseChangelog(FIXTURE), { from: '2.1.243', to: '2.1.243' });
  const out = mod.renderText(sel);
  assert.match(out, /NO DELTA/);
  assert.match(out, /useful answer, not a failure/);
  assert.match(out, /probably NOT an upstream announcement/);
});

test('renderText: the context-only fallback says it is context only', () => {
  const sel = mod.selectRange(mod.parseChangelog(FIXTURE), { from: '1.0.0' });
  const out = mod.renderText(sel);
  assert.match(out, /CONTEXT ONLY/);
  assert.match(out, /a LEAD, not a diagnosis/);
});

test('renderJson: machine output carries the framing with the data', () => {
  const sel = mod.selectRange(mod.parseChangelog(FIXTURE), { from: '2.1.240', to: '2.1.243' });
  const j = JSON.parse(mod.renderJson(sel));
  assert.strictEqual(j.status, 'delta');
  assert.strictEqual(j.from, '2.1.240');
  assert.strictEqual(j.to, '2.1.243');
  assert.deepStrictEqual(j.entries.map((e) => e.version), ['2.1.243', '2.1.241']);
  assert.match(j.framing, /never a cause/i);
  assert.match(j.source, /^https:\/\/raw\.githubusercontent\.com\/anthropics\/claude-code\//);
});

// ------------------------------------------------------------------ arguments

test('parseArgs: --from is required; flags parse in both spellings', () => {
  assert.match(mod.parseArgs([]).error, /missing required --from/);
  assert.match(mod.parseArgs(['--to', '2.1.243']).error, /missing required --from/);
  const a = mod.parseArgs(['--from', '2.1.241', '--to', '2.1.243', '--json']);
  assert.deepStrictEqual([a.from, a.to, a.json, a.error], ['2.1.241', '2.1.243', true, undefined]);
  const b = mod.parseArgs(['--from=2.1.241', '--to=2.1.243']);
  assert.deepStrictEqual([b.from, b.to], ['2.1.241', '2.1.243']);
  assert.strictEqual(mod.parseArgs(['--from', '2.1.241']).to, null, 'to stays unset -> newest');
  assert.match(mod.parseArgs(['--from', '2.1.241', '--wat']).error, /unknown argument: --wat/);
  assert.strictEqual(mod.parseArgs(['--help']).help, true);
});

// ------------------------------------------------- failure is never fatal

test('run: a fetch that throws prints ONE honest line and returns 0', async () => {
  const c = capture();
  const code = await mod.run({
    argv: ['--from', '2.1.241'], stdout: c.stdout, stderr: c.stderr,
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com'); },
  });
  assert.strictEqual(code, 0, 'a diagnostic aid must not turn a real red into a confusing red');
  assert.strictEqual(c.buf.out, '', 'nothing on stdout to be mistaken for findings');
  assert.strictEqual(c.buf.err.trimEnd().split('\n').length, 1, 'exactly one line');
  assert.match(c.buf.err, /could not fetch upstream changelog: getaddrinfo ENOTFOUND/);
});

test('run: a non-2xx response is a fetch failure, and still returns 0', async () => {
  const c = capture();
  const code = await mod.run({
    argv: ['--from', '2.1.241'], stdout: c.stdout, stderr: c.stderr, fetchImpl: fakeFetch(503),
  });
  assert.strictEqual(code, 0);
  assert.match(c.buf.err, /could not fetch upstream changelog: HTTP 503/);
});

test('run: --json on a fetch failure emits a status, not a crash', async () => {
  const c = capture();
  const code = await mod.run({
    argv: ['--from', '2.1.241', '--json'], stdout: c.stdout, stderr: c.stderr,
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); },
  });
  assert.strictEqual(code, 0);
  const j = JSON.parse(c.buf.out);
  assert.strictEqual(j.status, 'unavailable');
  assert.deepStrictEqual(j.entries, []);
  assert.match(j.note, /Not a finding/);
  assert.match(j.error, /ECONNREFUSED/);
});

test('run: a body that is not a changelog returns 0 and says so', async () => {
  const c = capture();
  const code = await mod.run({
    argv: ['--from', '2.1.241'], stdout: c.stdout, stderr: c.stderr,
    fetchImpl: fakeFetch('<html><body>404: Not Found</body></html>'),
  });
  assert.strictEqual(code, 0);
  assert.match(c.buf.out, /UNREADABLE/);
});

test('run: the happy path renders the delta', async () => {
  const c = capture();
  const code = await mod.run({
    argv: ['--from', '2.1.241', '--to', '2.1.243'], stdout: c.stdout, stderr: c.stderr,
    fetchImpl: fakeFetch(FIXTURE),
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(c.buf.err, '');
  assert.match(c.buf.out, /a LEAD, not a diagnosis/);
  assert.match(c.buf.out, /code is now loaded on demand/);
});

test('run: a usage error is the ONLY nonzero exit', async () => {
  const c = capture();
  const code = await mod.run({ argv: [], stdout: c.stdout, stderr: c.stderr, fetchImpl: fakeFetch(FIXTURE) });
  assert.strictEqual(code, 64, 'our own bad invocation is a caller bug, and must be loud');
  assert.match(c.buf.err, /missing required --from/);
  assert.match(c.buf.err, /usage: upstream-release-notes/);
});

// ------------------------------------------------------------------- proxies

test('proxyReexecEnv: delegate to Node, once, and only when there is a proxy', () => {
  // Node parses NODE_USE_ENV_PROXY at STARTUP, so honoring HTTPS_PROXY means
  // re-execing with it set — but never in a loop, and never without a proxy.
  assert.deepStrictEqual(mod.proxyReexecEnv({}), null, 'no proxy -> no re-exec');
  assert.deepStrictEqual(mod.proxyReexecEnv({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://p:1' }), null,
    'already honored -> no re-exec');
  assert.deepStrictEqual(mod.proxyReexecEnv({ HTTPS_PROXY: 'http://p:1', CLODE_UPSTREAM_NOTES_REEXEC: '1' }), null,
    'sentinel set -> never a second time');
  for (const v of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    assert.deepStrictEqual(mod.proxyReexecEnv({ [v]: 'http://p:1' }),
      { NODE_USE_ENV_PROXY: '1', CLODE_UPSTREAM_NOTES_REEXEC: '1' }, `${v} honored`);
  }
});

// ------------------------------------------------- end to end, over loopback

// A clean env: no ambient proxy (which would re-exec) and no ambient noise.
function cleanEnv(extra) {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
    HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '', NODE_USE_ENV_PROXY: '',
    ...extra,
  };
}

// Async spawn of the real script, collected. Used wherever this process must stay
// responsive while the child runs (see the loopback-server test).
function runScript(args, extra) {
  return new Promise((resolve) => {
    const ch = spawn(NODE, [SCRIPT, ...args], { env: cleanEnv(extra) });
    let out = '', err = '';
    ch.stdout.setEncoding('utf8'); ch.stderr.setEncoding('utf8');
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { err += d; });
    ch.on('close', (status) => resolve({ status, stdout: out, stderr: err }));
  });
}

test('e2e: the real script against a loopback changelog server prints the framed delta', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(FIXTURE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/CHANGELOG.md`;
    // spawn, NOT spawnSync: the server lives on THIS process's event loop, and a
    // synchronous child would block it forever (the request would never be
    // accepted, and the run would die at the fetch timeout instead).
    const r = await runScript(['--from', '2.1.241', '--to', '2.1.243', '--url', url]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /a LEAD, not a diagnosis: after 2\.1\.241, through 2\.1\.243/);
    assert.match(r.stdout, /^## 2\.1\.243$/m);
    assert.doesNotMatch(r.stdout, /^## 2\.1\.240$/m);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('e2e: the real script exits 0 when the fetch fails outright', () => {
  // Port 1 on loopback: refused immediately, no DNS, no network egress.
  const r = spawnSync(NODE, [SCRIPT, '--from', '2.1.241', '--url', 'http://127.0.0.1:1/CHANGELOG.md'],
    { encoding: 'utf8', env: cleanEnv() });
  assert.strictEqual(r.status, 0, 'this runs inside an already-failing job; it must not add a red');
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /could not fetch upstream changelog:/);
});

test('e2e: a missing --from exits 64 with usage', () => {
  const r = spawnSync(NODE, [SCRIPT], { encoding: 'utf8', env: cleanEnv() });
  assert.strictEqual(r.status, 64);
  assert.match(r.stderr, /missing required --from/);
});
