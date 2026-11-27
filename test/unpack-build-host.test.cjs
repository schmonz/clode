'use strict';
// libexec/unpack.cjs ON THE BUILD HOST: the engine scripts/bootstrap-engine.sh hands the build (the pinned last
// release's, v0.20260831.1 today), not the engine this checkout built.
//
// WHY THIS FILE EXISTS. 30bc91b8 moved every archive extraction in process, over node:zlib, which under tjs is
// node-shim's zlib over the engine's __tjs_zlib_sync. The bootstrap engine predates txiki-zlib-sync.patch, and the
// cosmo leg extracts its cosmocc zip on it (scripts/build-tjs.cjs provisionCosmocc), so CI run 46018235655 died with
// "this engine has no __tjs_zlib_sync ... so zlib.crc32 cannot answer". Nothing local ran build-path code on the
// bootstrap engine: test/unpack.test.cjs's engine row runs CLODE_TJS, a CURRENT engine, which has the binding. Now
// unpack picks its codec by what the engine has (node:zlib, or the WHATWG DecompressionStream), and this file holds it
// to that on the engines a build actually runs on:
//   * the REAL bootstrap engine, the pinned slice from the resolver's own cache (sha256-checked against
//     scripts/bootstrap-engine.manifest.json), when this machine has it: the build-host floor
//     (scripts/engine-api-floor.cjs --role build-host) passes on it, and a zip and a tar.gz extract through HEAD's
//     node-shim loader to node's tree with an EMPTY CLODE_ENGINE_FLOOR_LOG (the log build-leg gates every engine phase
//     on, so any binding the extraction reaches past the floor is a failure here, not only zlib's);
//   * the stand-in for it (test/stale-build-host.cjs: a current tjs with the bindings the last release lacks taken
//     away, __tjs_zlib_sync among them), which needs no download, so it runs wherever a tjs does, CI included.
// CONTROL, on each engine: the same extraction with unpack forced onto node:zlib (the 30bc91b8 shape) must fail with
// node-shim's __tjs_zlib_sync refusal and a non-empty floor log. A row that cannot see that failure proves nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { userCacheDir } = require('./suite-home.cjs');
const { makeStaleHost } = require('./stale-build-host.cjs');
const { makeZip } = require('./archive-fixtures.cjs');
const { packTar } = require('../scripts/tar-pack.cjs');
const { OK_TOKEN, engineFloorCheckJs, floorFor } = require('../scripts/engine-api-floor.cjs');
const canon = require('../scripts/canonical-name.cjs');
const unpack = require('../libexec/unpack.cjs');

const REPO = path.resolve(__dirname, '..');
const LOADER = path.join(REPO, 'libexec', 'node-shim', 'loader.cjs');
const UNPACK = path.join(REPO, 'libexec', 'unpack.cjs');
const MANIFEST = path.join(REPO, 'scripts', 'bootstrap-engine.manifest.json');
const tmp = (tag) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `clode-unpack-bh-${tag}-`)));

// The pinned bootstrap engine, where the resolver caches it (<cache>/bootstrap/<tag>/<target>/tjs, step 3 of
// scripts/bootstrap-engine.sh), checked as the resolver checks a cache hit. -> { engine } or { skip }.
function bootstrapEngine() {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const os_ = process.platform === 'win32' ? 'windows' : process.platform;
  const target = `${canon.canonOs(os_)}-${canon.canonArch(process.arch)}`;
  const slice = m.targets[target];
  if (!slice) return { skip: `this host's target (${target}) is not in the pinned pack ${m.bootstrapTag}: no bootstrap engine exists for it` };
  const engine = path.join(userCacheDir(), 'bootstrap', m.bootstrapTag, target, process.platform === 'win32' ? 'tjs.exe' : 'tjs');
  if (!fs.existsSync(engine)) {
    return { skip: `the pinned bootstrap engine (${m.bootstrapTag}, ${target}) is not in the resolver's cache at ${engine}, `
      + 'and the suite is offline; fetch it once with `CLODE_TJS= CLODE_NODE=/nonexistent sh scripts/bootstrap-engine.sh` '
      + '(the stand-in row below still runs)' };
  }
  const got = crypto.createHash('sha256').update(fs.readFileSync(engine)).digest('hex');
  if (got !== slice.sha256) {
    return { skip: `the cached bootstrap engine at ${engine} is not the manifest's (${got} != ${slice.sha256}); `
      + 'the resolver would discard it and fetch again, and this offline suite cannot' };
  }
  return { engine };
}

// A zip (deflated, stored, a symlink) and a tar.gz of the same shape as the real downloads, and node's extraction of
// each, to compare against.
function fixtures() {
  const dir = tmp('fx');
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'top', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(src, 'top', 'bin', 'tool'), '#!/bin/sh\necho hi\n');
  fs.chmodSync(path.join(src, 'top', 'bin', 'tool'), 0o755);
  fs.writeFileSync(path.join(src, 'top', 'data.txt'), 'clode '.repeat(4000));
  fs.writeFileSync(path.join(dir, 'a.tar.gz'), zlib.gzipSync(packTar(src, ['top'])));
  fs.writeFileSync(path.join(dir, 'b.zip'), makeZip([
    { name: 'top/', type: 'dir' },
    { name: 'top/bin/tool', data: '#!/bin/sh\necho hi\n', mode: 0o755, method: 8 },
    { name: 'top/data.txt', data: 'clode '.repeat(4000), method: 8 },
    { name: 'top/stored', data: 'stored', method: 0 },
    ...(process.platform !== 'win32' ? [{ name: 'top/link', type: 'symlink', linkname: 'data.txt' }] : []),
  ]));
  return dir;
}

// Every path under dir: [rel, kind, exec bit, content-or-target].
function snapshot(dir) {
  const out = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(path.join(dir, r));
      if (st.isSymbolicLink()) out.push([r, 'l', 0, fs.readlinkSync(path.join(dir, r))]);
      else if (st.isDirectory()) { out.push([r, 'd', 0, '']); walk(r); }
      else out.push([r, 'f', process.platform === 'win32' ? 0 : st.mode & 0o111, fs.readFileSync(path.join(dir, r)).toString('hex')]);
    }
  };
  walk('');
  return out;
}

// Extract both fixtures on `engine` through HEAD's loader; `codec` forces unpack's codec (the control). -> the result.
function extractOn(engine, env, dir, tag, codec) {
  const script = path.join(dir, `x-${tag}.cjs`);
  fs.writeFileSync(script, `const u = require(${JSON.stringify(UNPACK)});
${codec ? `u.useCodec(${JSON.stringify(codec)});` : ''}
(async () => {
  for (const f of ['a.tar.gz', 'b.zip']) await u.extractArchive(${JSON.stringify(dir)} + '/' + f, ${JSON.stringify(dir)} + '/${tag}-' + f);
  console.log('ok ' + u.useCodec());
})().catch((e) => { console.log('ERR ' + (e && e.message)); process.exitCode = 1; });\n`);
  const log = path.join(dir, `floor-${tag}.log`);
  const r = spawnSync(engine, ['run', LOADER, script], {
    cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env, CLODE_ENGINE_FLOOR_LOG: log },
  });
  let floorLog = '';
  try { floorLog = fs.readFileSync(log, 'utf8'); } catch { /* never written: nothing refused */ }
  return { stdout: (r.stdout || '').trim(), stderr: r.stderr || '', status: r.status, floorLog };
}

async function nodeTrees(dir) {
  for (const f of ['a.tar.gz', 'b.zip']) await unpack.extractArchive(path.join(dir, f), path.join(dir, `node-${f}`));
}

function assertExtracts(engine, env, label) {
  return async () => {
    const dir = fixtures();
    await nodeTrees(dir);
    const r = extractOn(engine, env, dir, 'eng');
    assert.strictEqual(r.stdout, 'ok stream', `${label}: unpack did not extract on the build host with the stream codec:\n${r.stdout}\n${r.stderr}`);
    assert.strictEqual(r.floorLog, '', `${label}: the extraction reached past the build-host floor (CLODE_ENGINE_FLOOR_LOG):\n${r.floorLog}`);
    for (const f of ['a.tar.gz', 'b.zip']) {
      assert.deepStrictEqual(snapshot(path.join(dir, `eng-${f}`)), snapshot(path.join(dir, `node-${f}`)), `${label}: ${f}`);
    }
    // CONTROL: node:zlib on this engine is the 30bc91b8 shape, and it must fail where CI failed.
    const c = extractOn(engine, env, dir, 'ctl', 'zlib');
    assert.match(c.stdout, /^ERR .*__tjs_zlib_sync/, `${label} CONTROL: forcing node:zlib should fail as CI run 46018235655 did:\n${c.stdout}\n${c.stderr}`);
    assert.notStrictEqual(c.floorLog, '', `${label} CONTROL: the refusal should reach CLODE_ENGINE_FLOOR_LOG`);
  };
}

test('the real bootstrap engine: the build-host floor holds, and a zip and a tar.gz extract with nothing refused', async (t) => {
  const b = bootstrapEngine();
  if (b.skip) return t.skip(b.skip);
  const floor = spawnSync(b.engine, ['eval', engineFloorCheckJs(floorFor('build-host'))], { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual((floor.stdout || '').trim(), OK_TOKEN, `the bootstrap engine fails the build-host floor:\n${floor.stdout}${floor.stderr}`);
  await assertExtracts(b.engine, {}, 'bootstrap engine')();
});

test('the stale build-host stand-in: a zip and a tar.gz extract with nothing refused', async (t) => {
  const host = makeStaleHost(tmp('stand-in'));
  if (host.skip) return t.skip(host.skip);
  await assertExtracts(host.engine, {}, 'stand-in')();
});
