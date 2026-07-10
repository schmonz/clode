'use strict';
// clode-fuse — the `clode build` subcommand (clode's own namespace, NOT a
// passthrough): fuse a standalone quaude binary on THIS machine. quaude is the
// product users make/use/update; it is derived work and is NEVER distributed —
// fusing always happens locally (canon; CI may fuse in ephemeral runners for
// tests only).
//
// Pipeline (Q1a design memo spike/quickjs/results/quaude-fuse-design.md):
//   1. resolve + extract + hook the upstream bundle (existing cache machinery);
//   2. ensure the ext-dep closure (existing deps machinery);
//   3. copy the pinned tjs template and ad-hoc re-sign the COPY while it is
//      still a valid Mach-O (sign-THEN-append: appending tail data breaks
//      strict codesign validation, and --remove-signature dies outright, so
//      signing after assembly is impossible — but the kernel only validates
//      mapped code pages, so the fused binary executes fine on the template's
//      signature; memo §6.1);
//   4. spawn the fuse worker (libexec/quaude-fuse.js) UNDER THE TEMPLATE
//      ITSELF — bytecode writer == runtime, BC_VERSION lockstep automatic —
//      which compiles cli.cjs to bytecode, assembles the member archive +
//      manifest + bootstrap, and appends;
//   5. smoke the result LOUDLY: `quaude -p 'say PONG'` against an in-process
//      canned Messages mock (no network, no key), then `quaude
//      --quaude-attest` — any failure exits nonzero and says why.
//
// Usage: clode build [--out PATH]        (default ./quaude)
// Env:   CLODE_TJS  — the tjs template binary (default <root>/build/tjs/tjs)

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const resolve = require('./clode-resolve.cjs');
const extract = require('./clode-extract.cjs');
const deps = require('./clode-deps.cjs');
const { clodeCacheDir, depsStore } = require('./clode-paths.cjs');

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// A minimal in-process stand-in for the Anthropic Messages API, answering every
// POST .../messages with the canonical streaming-SSE single-turn "PONG". A
// product-side mirror of test/mock-anthropic-helper.cjs (which is not shipped);
// keep the SSE sequence in step with it.
function cannedSSE(text) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    ev('message_start', { type: 'message_start', message: { id: 'msg_clode_build_smoke', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }) +
    ev('message_stop', { type: 'message_stop' })
  );
}
function startPongMock() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url });
      if (req.method === 'POST' && /\/messages$/.test(req.url.split('?')[0])) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.end(cannedSSE('PONG'));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => ok({
      url: `http://127.0.0.1:${server.address().port}`,
      requests,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

// Async spawn with capture + timeout (spawnSync would starve the in-process
// mock server — the same reason the test harnesses spawn async).
function run(cmd, args, opts = {}) {
  return new Promise((ok) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env, cwd: opts.cwd,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const to = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, opts.timeout || 120000);
    child.on('exit', (status) => { clearTimeout(to); ok({ status, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(to); ok({ status: null, stdout, stderr: stderr + String(e) }); });
  });
}

// clode build [--out PATH]. Returns the exit status (0 on success). Injectable
// bits (env/stderr/stdout) keep the unit-testable surface consistent with the
// sibling subcommand modules.
async function clodeBuild(args, opts) {
  const { libexec, here, version } = opts;
  const env = opts.env || process.env;
  const stderr = opts.stderr || process.stderr;
  const stdout = opts.stdout || process.stdout;
  const verbose = !!env.CLODE_VERBOSE;
  const clodeLog = (m) => { if (verbose) stderr.write(m + '\n'); };
  const fail = (m) => { stderr.write('clode: ' + m + '\n'); return 1; };

  // -- argv: only --out for v1; anything else is an error (this is clode's own
  // namespace — nothing here passes through to Claude Code).
  let out = 'quaude';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) { out = args[++i]; }
    else return fail(`build: unknown argument '${args[i]}' (usage: clode build [--out PATH])`);
  }
  out = path.resolve(out);

  // -- template: the pinned tjs this repo builds (scripts/build-tjs.mjs).
  const ROOT = path.resolve(libexec, '..');
  const template = env.CLODE_TJS || path.join(ROOT, 'build', 'tjs', 'tjs');
  if (!fs.existsSync(template)) {
    return fail(`build: no tjs template at '${template}' (run scripts/build-tjs.mjs, or set CLODE_TJS)`);
  }

  // -- upstream bundle: resolve + extract + hook via the existing machinery.
  let bin = resolve.resolveClaudeBin({ env });
  if (bin == null || !resolve.pathExists(bin)) {
    return fail(bin == null
      ? 'build: no Claude Code binary found (install the provider package, or set CLODE_CLAUDE_BIN)'
      : `build: claude binary not found at '${bin}'`);
  }
  bin = resolve.followWrapper(bin);
  const key = resolve.cacheKey(bin);
  const cache = path.join(clodeCacheDir(env), key);
  clodeLog(`clode: build: staging bundle ${key} ...`);
  try {
    extract.extractIfNeeded({ bin, cacheDir: cache, libexec, verbose, key });
  } catch (e) {
    return fail(`build: extraction failed: ${(e && e.message) || e}`);
  }

  // -- ext-dep closure: ensureDeps installs into the deps store unless the
  // deps already ship beside this checkout (repo/npm layout).
  deps.ensureDeps({ libexec, here, verbose, env });
  const nmCandidates = [path.join(ROOT, 'node_modules'), path.join(depsStore(env), 'node_modules')];
  const nmDir = nmCandidates.find((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  if (!nmDir) return fail(`build: no node_modules with the runtime deps (looked in: ${nmCandidates.join(', ')})`);

  // -- node-side manifest fields (the worker adds engine/idna/members/fusedAt).
  const extras = {
    quaude: '1', // quaude archive/manifest schema version
    bundleVersion: key,
    clodeVersion: version,
    template: { sha256: sha256File(template), len: fs.statSync(template).size },
    // The transforms baked into the fused artifact beyond the members
    // themselves: the extractor that hooked cli.cjs (memo §6.9 — staleness of
    // the frozen entry transforms is detectable via these + bundleVersion).
    hooks: { 'extract-claude-js.cjs': sha256File(path.join(libexec, 'extract-claude-js.cjs')) },
  };

  // -- sign-then-append (memo §6.1): copy template -> re-sign the copy while it
  // is still a plain Mach-O -> the worker appends. Never sign after appending.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-build-'));
  const signedBase = path.join(work, 'template-signed');
  const extrasPath = path.join(work, 'extras.json');
  try {
    fs.copyFileSync(template, signedBase);
    fs.chmodSync(signedBase, 0o755);
    if (process.platform === 'darwin') {
      const cs = spawnSync('codesign', ['-s', '-', '--force', signedBase], { encoding: 'utf8' });
      if (cs.status !== 0) return fail(`build: codesign of the template copy failed:\n${cs.stderr || cs.stdout}`);
      clodeLog('clode: build: template copy re-signed (ad-hoc)');
    }
    fs.writeFileSync(extrasPath, JSON.stringify(extras));

    // -- fuse, under the template itself.
    clodeLog(`clode: build: fusing ${out} ...`);
    const w = await run(template, ['run', path.join(libexec, 'quaude-fuse.js'),
      signedBase, cache, path.join(libexec, 'node-shim'), nmDir,
      path.join(libexec, 'quaude-bootstrap.mjs'), extrasPath, out], { env, timeout: 300000 });
    if (w.status !== 0) {
      return fail(`build: fuse worker failed (exit ${w.status}):\n${w.stdout}${w.stderr}`);
    }
    clodeLog(w.stdout.trimEnd());

    // -- smoke 1: -p PONG against the canned mock. NODE_PATH is stripped so a
    // pass PROVES the binary is self-contained.
    clodeLog('clode: build: smoke -p against the canned Messages mock ...');
    const mock = await startPongMock();
    let pong;
    try {
      const smokeEnv = { ...env, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-clode-build-smoke' };
      delete smokeEnv.NODE_PATH;
      pong = await run(out, ['-p', 'say PONG'], { env: smokeEnv, cwd: work });
    } finally { await mock.close(); }
    const posted = mock.requests.some((q) => q.method === 'POST' && /\/messages/.test(q.url));
    if (pong.status !== 0 || !/PONG/.test(pong.stdout) || !posted) {
      stderr.write(`clode: build: SMOKE FAILED — the fused quaude did not complete the mock round-trip\n`);
      stderr.write(`clode: build: exit=${pong.status} posted=${posted} stdout:\n${pong.stdout}\nstderr:\n${pong.stderr}\n`);
      return 1;
    }

    // -- smoke 2: attest must verify every member from the trailer just written.
    const attest = await run(out, ['--quaude-attest'], { env, cwd: work });
    if (attest.status !== 0 || !/quaude-attest: all members verified/.test(attest.stdout)) {
      stderr.write(`clode: build: ATTEST FAILED (exit ${attest.status}):\n${attest.stdout}\n${attest.stderr}\n`);
      return 1;
    }

    stdout.write(`clode: fused ${out} (${fs.statSync(out).size} bytes, bundle ${key})\n`);
    stdout.write(`clode: smoke: PONG round-trip ok, attest ok — run '${out}' to use it\n`);
    return 0;
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

module.exports = { clodeBuild, startPongMock, cannedSSE };
