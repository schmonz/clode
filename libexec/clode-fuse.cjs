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
//        clode build --self [--out PATH] (default ./clode-native)
// Env:   CLODE_TJS         — the tjs template binary (default <root>/build/tjs/tjs)
//        CLODE_MAIN_BUNDLE — the esbuilt clode-main bundle for --self (default:
//                            newest build/*/clode-main.bundle.cjs)
//
// --self fuses the BUILDER itself: the same trailer format with role "builder"
// — the esbuilt clode-main bundle as a SOURCE entry (65KB; bytecode would force
// strict mode on the esbuild output for no parse win — measured 0.24s boot),
// plus everything `clode build` needs as fuse INPUTS on a machine with no
// checkout and no node: the node-shim tree, the libexec support files
// (extractor, bun-shim, worker, bootstrap), and the ext-dep closure (quaude
// member inputs — clode-main itself imports node builtins only). When `build`
// later RUNS under that fused builder, the payload is materialized back to
// disk first (subprocesses — the template-tjs worker — need real files).

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
  const { here, version } = opts;
  const env = opts.env || process.env;
  const stderr = opts.stderr || process.stderr;
  const stdout = opts.stdout || process.stdout;
  const verbose = !!env.CLODE_VERBOSE;
  const clodeLog = (m) => { if (verbose) stderr.write(m + '\n'); };
  const fail = (m) => { stderr.write('clode: ' + m + '\n'); return 1; };

  // -- argv: --self + --out only; anything else is an error (this is clode's
  // own namespace — nothing here passes through to Claude Code).
  let out = null;
  let self = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) { out = args[++i]; }
    else if (args[i] === '--self') { self = true; }
    else return fail(`build: unknown argument '${args[i]}' (usage: clode build [--self] [--out PATH])`);
  }
  out = path.resolve(out || (self ? 'clode-native' : 'quaude'));

  const ROOT = path.resolve(opts.libexec, '..');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-build-'));
  try {
    // -- fused-builder payload: when `build` runs under a fused NATIVE clode
    // (the bootstrap mounted the builder-role VFS), the fuse inputs are archive
    // members, but the worker is a template-tjs SUBPROCESS that needs real
    // files — materialize libexec + node-shim + node_modules to disk once.
    let libexec = opts.libexec;
    let nmDir = null;
    const vfs = globalThis.__quaudeVFS;
    if (vfs && vfs.manifest && vfs.manifest.role === 'builder') {
      const mat = path.join(work, 'payload');
      for (const [name, bytes] of vfs.files) {
        let dest;
        if (name.startsWith('node-shim/')) dest = path.join(mat, 'libexec', name);
        else if (name.startsWith('libexec/')) dest = path.join(mat, name);
        else if (name.startsWith('node_modules/')) dest = path.join(mat, name);
        else continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(bytes));
      }
      libexec = path.join(mat, 'libexec');
      nmDir = path.join(mat, 'node_modules');
      clodeLog(`clode: build: materialized the fused payload -> ${mat}`);
    }

    // -- template resolution: an explicit CLODE_TJS wins (and must exist —
    // fail loud, never fall through a typo); then the EMBEDDED pristine
    // template a builder-role fuse carries (Q2 Decision 2 — the shipped
    // builder needs nothing on disk); then the pinned tjs this repo builds
    // (scripts/build-tjs.mjs).
    let template = env.CLODE_TJS || null;
    if (!template && vfs && vfs.manifest && vfs.manifest.role === 'builder' && vfs.files.get('template/tjs')) {
      template = path.join(work, 'template-tjs');
      fs.writeFileSync(template, Buffer.from(vfs.files.get('template/tjs')));
      fs.chmodSync(template, 0o755);
      // Verify the materialized bytes against the manifest BEFORE exec'ing
      // them: a truncated or corrupted write shows up as a bare exit-127
      // spawn failure with no output (matrix openbsd leg, dispatch #8
      // 2026-07-10) — this converts that into a precise loud error.
      const want = vfs.manifest.template || {};
      const got = fs.statSync(template).size;
      if (want.len && got !== want.len) {
        return fail(`build: embedded template materialized ${got} bytes; manifest says ${want.len} (shim fs write fault?)`);
      }
      if (want.sha256 && sha256File(template) !== want.sha256) {
        return fail('build: embedded template sha256 mismatch after materialization (shim fs write fault?)');
      }
      if (process.platform === 'darwin') {
        // Same discipline as the fuse copy below: a materialized Mach-O may
        // need its ad-hoc signature refreshed before it can exec.
        const cs = spawnSync('codesign', ['-s', '-', '--force', template], { encoding: 'utf8' });
        if (cs.status !== 0) return fail(`build: codesign of the embedded template failed:\n${cs.stderr || cs.stdout}`);
      }
      clodeLog(`clode: build: using the embedded tjs template -> ${template}`);
    }
    if (!template) template = path.join(ROOT, 'build', 'tjs', 'tjs');
    if (!fs.existsSync(template)) {
      return fail(`build: no tjs template at '${template}' (run scripts/build-tjs.mjs, or set CLODE_TJS)`);
    }

    // -- payload staging: the upstream Claude Code bundle (default), or the
    // esbuilt clode-main bundle (--self).
    let stageDir, key;
    if (self) {
      let bundle = env.CLODE_MAIN_BUNDLE;
      if (bundle) {
        if (!fs.existsSync(bundle)) return fail(`build --self: no esbuilt clode-main bundle at '${bundle}' (CLODE_MAIN_BUNDLE)`);
      } else {
        // Newest build/*/clode-main.bundle.cjs (per-platform tag dirs).
        let newest = null;
        try {
          for (const d of fs.readdirSync(path.join(ROOT, 'build'))) {
            const c = path.join(ROOT, 'build', d, 'clode-main.bundle.cjs');
            try {
              const m = fs.statSync(c).mtimeMs;
              if (!newest || m > newest.m) newest = { c, m };
            } catch { /* not this dir */ }
          }
        } catch { /* no build dir */ }
        if (!newest) {
          return fail('build --self: no esbuilt clode-main bundle found (run `node scripts/build-sea.mjs --bundle-only`, or set CLODE_MAIN_BUNDLE)');
        }
        bundle = newest.c;
      }
      // The bundle freezes clode's own logic; warn when libexec sources are
      // newer (an honest staleness signal, not a gate).
      try {
        const bm = fs.statSync(bundle).mtimeMs;
        const stale = fs.readdirSync(libexec).some((f) => /\.(cjs|mjs|js)$/.test(f)
          && fs.statSync(path.join(libexec, f)).mtimeMs > bm);
        if (stale) stderr.write(`clode: build --self: WARNING: ${bundle} is older than libexec sources; re-run \`node scripts/build-sea.mjs --bundle-only\`\n`);
      } catch { /* best effort */ }
      stageDir = path.join(work, 'stage');
      fs.mkdirSync(stageDir, { recursive: true });
      fs.copyFileSync(bundle, path.join(stageDir, 'clode-main.bundle.cjs'));
      clodeLog(`clode: build: staging builder bundle ${bundle} ...`);
    } else {
      // Upstream bundle: resolve + extract + hook via the existing machinery.
      let bin = resolve.resolveClaudeBin({ env });
      if (bin == null || !resolve.pathExists(bin)) {
        return fail(bin == null
          ? 'build: no Claude Code binary found (install the provider package, or set CLODE_CLAUDE_BIN)'
          : `build: claude binary not found at '${bin}'`);
      }
      bin = resolve.followWrapper(bin);
      key = resolve.cacheKey(bin);
      stageDir = path.join(clodeCacheDir(env), key);
      clodeLog(`clode: build: staging bundle ${key} ...`);
      try {
        extract.extractIfNeeded({ bin, cacheDir: stageDir, libexec, verbose, key });
      } catch (e) {
        return fail(`build: extraction failed: ${(e && e.message) || e}`);
      }
    }

    // -- ext-dep closure (both roles: quaude requires them at runtime; the
    // builder ships them as the member INPUTS for the quaude it will fuse).
    // Already materialized from the payload under a fused builder; otherwise
    // ensureDeps installs into the deps store unless the deps ship beside
    // this checkout (repo/npm layout).
    if (!nmDir) {
      deps.ensureDeps({ libexec, here, verbose, env });
      const nmCandidates = [path.join(ROOT, 'node_modules'), path.join(depsStore(env), 'node_modules')];
      nmDir = nmCandidates.find((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
      if (!nmDir) return fail(`build: no node_modules with the runtime deps (looked in: ${nmCandidates.join(', ')})`);
    }

    // -- node-side manifest fields (the worker adds engine/idna/members/fusedAt).
    const extras = {
      quaude: '1', // archive/manifest schema version (shared by both roles)
      role: self ? 'builder' : 'quaude',
      bundleVersion: key, // undefined for --self (no upstream bundle) — dropped by JSON
      clodeVersion: version,
      template: { sha256: sha256File(template), len: fs.statSync(template).size },
      // The transforms baked into the fused artifact beyond the members
      // themselves: the extractor that hooked cli.cjs (memo §6.9 — staleness of
      // the frozen entry transforms is detectable via these + bundleVersion).
      hooks: { 'extract-claude-js.cjs': sha256File(path.join(libexec, 'extract-claude-js.cjs')) },
    };

    // -- sign-then-append (memo §6.1): copy template -> re-sign the copy while
    // it is still a plain Mach-O -> the worker appends. Never sign after
    // appending.
    const signedBase = path.join(work, 'template-signed');
    const extrasPath = path.join(work, 'extras.json');
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
      signedBase, stageDir, path.join(libexec, 'node-shim'), nmDir,
      path.join(libexec, 'quaude-bootstrap.mjs'), extrasPath, out,
      // --self embeds the PRISTINE template as a member (Decision 2); the
      // quaude role has no use for it (its base IS the signed copy).
      ...(self ? [template] : [])], { env, timeout: 300000 });
    if (w.status !== 0) {
      let extra = '';
      if (!w.stdout && !w.stderr) {
        // A bare status with no output = the child never ran (exec failed
        // inside the spawn; 127 is libuv's could-not-exec convention). Say
        // what we tried to exec so a remote CI log is diagnosable.
        try {
          extra = `\n(no worker output — exec failure? template=${template} size=${fs.statSync(template).size})`;
        } catch {
          extra = `\n(no worker output — exec failure? template=${template} MISSING)`;
        }
      }
      return fail(`build: fuse worker failed (exit ${w.status}):\n${w.stdout}${w.stderr}${extra}`);
    }
    clodeLog(w.stdout.trimEnd());

    if (self) {
      // -- builder smoke: its own flags must answer, with NODE_PATH stripped
      // (self-containment proof at the same strength as the quaude smoke).
      clodeLog('clode: build: smoke --clode-version/--clode-help ...');
      const smokeEnv = { ...env };
      delete smokeEnv.NODE_PATH;
      const v = await run(out, ['--clode-version'], { env: smokeEnv, cwd: work });
      if (v.status !== 0 || !/^clode /.test(v.stdout)) {
        stderr.write(`clode: build --self: SMOKE FAILED — the fused builder did not answer --clode-version\n`);
        stderr.write(`clode: build --self: exit=${v.status} stdout:\n${v.stdout}\nstderr:\n${v.stderr}\n`);
        return 1;
      }
      const h = await run(out, ['--clode-help'], { env: smokeEnv, cwd: work });
      if (h.status !== 0 || !/clode build/.test(h.stdout)) {
        stderr.write(`clode: build --self: SMOKE FAILED — the fused builder did not answer --clode-help\n`);
        stderr.write(`clode: build --self: exit=${h.status} stdout:\n${h.stdout}\nstderr:\n${h.stderr}\n`);
        return 1;
      }
      stdout.write(`clode: fused ${out} (${fs.statSync(out).size} bytes, native clode builder)\n`);
      stdout.write(`clode: smoke: --clode-version + --clode-help ok — run '${out} build' to fuse a quaude\n`);
      return 0;
    }

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
