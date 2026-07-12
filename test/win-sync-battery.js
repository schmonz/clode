// Windows sync-primitive acceptance battery. Run: tjs.exe run test/win-sync-battery.js
// Exercises __tjs_spawn_sync / __tjs_fs_sync directly (node-shim is Phase 2).
const SELF = tjs.exePath;           // the running tjs.exe
const dec = new TextDecoder();
const enc = new TextEncoder();
let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`ok   - ${name}`); }
  else { console.log(`FAIL - ${name}${detail ? ': ' + detail : ''}`); failures++; }
}
function spawnEval(js, opts = {}) {
  // tjs eval <js> : child runs js and exits. argv[0] is filled by the C side.
  return globalThis.__tjs_spawn_sync(SELF, ['eval', js], opts);
}

// 1. small stdout
{
  const r = spawnEval(`__tjs_fs_sync.write(1, new TextEncoder().encode('hello-stdout').buffer, -1)`);
  check('spawn small stdout byte-exact', dec.decode(r.stdout) === 'hello-stdout', dec.decode(r.stdout));
  check('spawn small exit status 0', r.status === 0, String(r.status));
}

// 2. big interleaved stdout + stderr (>64KB each)
{
  const js = `const e=new TextEncoder();for(let i=0;i<5000;i++){__tjs_fs_sync.write(1,e.encode('O'.repeat(20)).buffer,-1);__tjs_fs_sync.write(2,e.encode('E'.repeat(20)).buffer,-1);}`;
  const r = spawnEval(js, { maxBuffer: 8 << 20 });
  const out = dec.decode(r.stdout), err = dec.decode(r.stderr);
  check('big stdout length', out.length === 100000, String(out.length));
  check('big stderr length', err.length === 100000, String(err.length));
  check('big stdout all O', /^O+$/.test(out), out.slice(0, 8));
  check('big stderr all E', /^E+$/.test(err), err.slice(0, 8));
}

// 3. exit-with-buffered (write then exit immediately — the drain race)
{
  const r = spawnEval(`__tjs_fs_sync.write(1,new TextEncoder().encode('LASTBYTES').buffer,-1);tjs.exit(0)`);
  check('exit-with-buffered captured', dec.decode(r.stdout) === 'LASTBYTES', dec.decode(r.stdout));
}

// 4. stdin echo round-trip
{
  const payload = 'round-trip-42';
  const ab = enc.encode(payload).buffer;
  const js = `const ab=__tjs_fs_sync.read(0,1024,-1);__tjs_fs_sync.write(1,ab,-1);`;
  const r = spawnEval(js, { input: ab });
  check('stdin echo round-trip', dec.decode(r.stdout) === payload, dec.decode(r.stdout));
}

// 5. nonzero exit
{
  const r = spawnEval(`tjs.exit(7)`);
  check('nonzero exit status', r.status === 7, String(r.status));
}

// 6. missing binary -> ENOENT
{
  let code = null;
  try { globalThis.__tjs_spawn_sync('C:\\\\no\\\\such\\\\prog-xyz.exe', [], {}); }
  catch (e) { code = e.code; }
  check('missing binary throws ENOENT', code === 'ENOENT', String(code));
}

// 7. fs write + read byte-exact
{
  const dir = (tjs.env.TEMP || tjs.env.TMP || '.') + '\\\\tjs_sync_battery';
  try { __tjs_fs_sync.mkdir(dir, 0o777); } catch (_) {}
  const fp = dir + '\\\\rt.bin';
  const fd = __tjs_fs_sync.open(fp, 'w');
  __tjs_fs_sync.write(fd, enc.encode('FSDATA').buffer, -1);
  __tjs_fs_sync.close(fd);
  const rfd = __tjs_fs_sync.open(fp, 'r');
  const back = __tjs_fs_sync.read(rfd, 64, -1);
  __tjs_fs_sync.close(rfd);
  check('fs write+read byte-exact', dec.decode(back) === 'FSDATA', dec.decode(back));
  const st = __tjs_fs_sync.stat(fp);
  check('fs stat size', st.size === 6, String(st.size));
  check('fs stat mtimeMs present', typeof st.mtimeMs === 'number' && st.mtimeMs > 0, String(st.mtimeMs));
  check('fs stat kind file', st.kind === 'file', st.kind);
  const names = __tjs_fs_sync.readdir(dir);
  check('fs readdir sees the file', names.indexOf('rt.bin') >= 0, JSON.stringify(names));
  const rp = __tjs_fs_sync.realpath(fp);
  check('fs realpath resolves', typeof rp === 'string' && rp.toLowerCase().endsWith('rt.bin'), rp);
}

if (failures) { console.log(`\n${failures} FAILURE(S)`); tjs.exit(1); }
console.log('\nBATTERY OK');
