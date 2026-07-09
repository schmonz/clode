'use strict';
// probes.cjs — phase-3 guest probes, run under the node-shim loader:
//   tjs run node-shim/loader.cjs probes.cjs sw    -> 'vflag OK'  (bcf53eb v->u regexp downgrade path)
//   tjs run node-shim/loader.cjs probes.cjs uyn   -> 'uyn OK'    (asyncDispose FileHandle tail-reader repro)
// Exit 0 on pass, 1 on fail. Staged by stage-p3.sh, exercised by guest-p3.sh.
const mode = process.argv[2] || 'all';

function probeSW() {
  // string-width@8 (ESM, NODE_PATH-staged) requires get-east-asian-width and
  // compiles \p{}-classed regex literals; under an unfixed tjs the v-flag
  // miscompile makes baseVisible() strip ASCII and widths come out wrong/throw.
  const sw = require('string-width');
  const f = typeof sw === 'function' ? sw : sw.default;
  const a = f('abc');
  const c = f('古'); // CJK, expect width 2
  console.log('string-width-abc=' + a + ' string-width-cjk=' + c);
  if (a === 3 && c === 2) { console.log('vflag OK'); return true; }
  console.log('vflag FAIL');
  return false;
}

async function probeUyn() {
  // The Uyn tail-reader shape (bundle >=2.1.204 Bash-tool output readback):
  // `await using` FileHandle from fs.promises.open, stat, positioned read.
  // Degrades to 'bash output unavailable' if Symbol.asyncDispose is missing.
  const fsp = require('fs/promises');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const p = path.join(os.tmpdir(), 'uyn-probe-' + process.pid + '.txt');
  fs.writeFileSync(p, '0123456789ABCDEF');
  let ok = false;
  {
    await using fh = await fsp.open(p, 'r');
    const st = await fh.stat();
    const buf = Buffer.alloc(6);
    const r = await fh.read(buf, 0, 6, 10);
    const got = buf.toString('utf8');
    console.log('uyn size=' + st.size + ' bytesRead=' + r.bytesRead + ' got=' + got);
    ok = st.size === 16 && r.bytesRead === 6 && got === 'ABCDEF';
  }
  fs.unlinkSync(p);
  if (ok) { console.log('uyn OK'); return true; }
  console.log('uyn FAIL');
  return false;
}

(async () => {
  let pass = true;
  if (mode === 'sw' || mode === 'all') pass = probeSW() && pass;
  if (mode === 'uyn' || mode === 'all') pass = (await probeUyn()) && pass;
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('probe ERROR ' + (e && e.stack || e)); process.exit(1); });
