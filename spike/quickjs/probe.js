// Capability probe + portability workload. Runs under tjs, qjs, and node
// (control). No imports — feature-detects everything, reports, never hangs.
// Output: PROBE <name> OK|FAIL|ABSENT <detail> lines + PROBE-SUMMARY.
// Active exercises are opt-out: NET=0 skips the network probe.
const out = [];
function report(name, status, detail) { out.push(`PROBE ${name} ${status} ${detail || ''}`.trim()); }
const G = globalThis;
const env = (G.tjs && tjs.env) || (G.process && process.env) || {};

// -- presence probes (cheap, universal) --
for (const name of ['fetch','crypto','TextEncoder','TextDecoder','URL','URLSearchParams','AbortController','WebSocket','Worker','queueMicrotask','structuredClone','performance','setTimeout','ReadableStream','Blob']) {
  report(`global.${name}`, typeof G[name] !== 'undefined' ? 'OK' : 'ABSENT');
}
report('runtime.tjs', G.tjs ? 'OK' : 'ABSENT', G.tjs && tjs.version);
report('runtime.node', G.process && process.versions && process.versions.node ? 'OK' : 'ABSENT', G.process && process.versions && process.versions.node);
report('runtime.qjs-std', typeof G.std !== 'undefined' || typeof G.os !== 'undefined' ? 'OK' : 'ABSENT');

// -- endianness semantics (must be explicit-endian regardless of host CPU) --
try {
  const b = new ArrayBuffer(8); const dv = new DataView(b); const u8 = new Uint8Array(b);
  dv.setUint32(0, 0x11223344, true);
  const leOK = u8[0] === 0x44 && u8[3] === 0x11;
  dv.setUint32(0, 0x11223344, false);
  const beOK = u8[0] === 0x11 && u8[3] === 0x44;
  dv.setFloat64(0, 1.5, true);
  const f64OK = u8[7] === 0x3f && u8[6] === 0xf8 && u8[0] === 0x00;
  report('exercise.endianness', leOK && beOK && f64OK ? 'OK' : 'FAIL', `le=${leOK} be=${beOK} f64=${f64OK}`);
} catch (e) { report('exercise.endianness', 'FAIL', String(e)); }

async function main() {
  // -- sha256 known-answer via WebCrypto (KAT catches BE-broken hashing) --
  try {
    if (!G.crypto || !crypto.subtle) { report('exercise.sha256-kat', 'ABSENT', 'no crypto.subtle'); }
    else {
      const KAT = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      const d = await crypto.subtle.digest('SHA-256', new Uint8Array(0));
      const hex = Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, '0')).join('');
      report('exercise.sha256-kat', hex === KAT ? 'OK' : 'FAIL', hex.slice(0, 12));
    }
  } catch (e) { report('exercise.sha256-kat', 'FAIL', String(e)); }

  // -- real file read (tjs / node / qjs-std, first available) --
  try {
    let text = null;
    if (G.tjs && tjs.readFile) { const b = await tjs.readFile('/etc/hostname').catch(() => null); text = b ? 'read' : 'noent-ok'; }
    else if (G.process) { text = require('node:fs').existsSync('/etc/hostname') ? 'read' : 'noent-ok'; }
    else if (G.std && std.loadFile) { text = std.loadFile('/etc/hostname') !== null ? 'read' : 'noent-ok'; }
    report('exercise.fileread', text ? 'OK' : 'ABSENT', text || 'no fs API found');
  } catch (e) { report('exercise.fileread', 'FAIL', String(e)); }

  // -- spawn a child and reap it --
  try {
    if (G.tjs && tjs.spawn) {
      const p = tjs.spawn(['sh', '-c', 'exit 0']);
      const st = await p.wait();
      report('exercise.spawn', (st.exit_status ?? st.exitCode ?? st.code) === 0 ? 'OK' : 'FAIL', JSON.stringify(st));
    } else if (G.process) {
      const r = require('node:child_process').spawnSync('sh', ['-c', 'exit 0']);
      report('exercise.spawn', r.status === 0 ? 'OK' : 'FAIL');
    } else if (G.os && os.exec) {
      const r = os.exec(['sh', '-c', 'exit 0']);
      report('exercise.spawn', r === 0 ? 'OK' : 'FAIL', `rc=${r}`);
    } else report('exercise.spawn', 'ABSENT', 'no spawn API found');
  } catch (e) { report('exercise.spawn', 'FAIL', String(e)); }

  // -- fetch over real TLS (our actual endpoint; NET=0 to skip) --
  if (env.NET === '0') report('exercise.fetch-tls', 'ABSENT', 'skipped NET=0');
  else try {
    if (typeof G.fetch !== 'function') report('exercise.fetch-tls', 'ABSENT', 'no fetch');
    else {
      const r = await fetch('https://downloads.claude.ai/claude-code-releases/stable');
      const body = (await r.text()).trim();
      report('exercise.fetch-tls', /^\d+\./.test(body) ? 'OK' : 'FAIL', `status=${r.status} body=${body.slice(0, 12)}`);
    }
  } catch (e) { report('exercise.fetch-tls', 'FAIL', String(e)); }

  // -- tty raw mode: PRESENCE only (never toggle; must not hang unattended) --
  try {
    if (G.tjs && tjs.stdin) report('exercise.tty-raw', typeof tjs.stdin.setRawMode === 'function' ? 'OK' : 'ABSENT', 'tjs.stdin.setRawMode');
    else if (G.process && process.stdin) report('exercise.tty-raw', typeof process.stdin.setRawMode === 'function' ? 'OK' : 'ABSENT', 'process.stdin.setRawMode');
    else if (G.os) report('exercise.tty-raw', typeof os.ttySetRaw === 'function' ? 'OK' : 'ABSENT', 'os.ttySetRaw');
    else report('exercise.tty-raw', 'ABSENT', 'no tty API found');
  } catch (e) { report('exercise.tty-raw', 'FAIL', String(e)); }

  const ok = out.filter((l) => / OK/.test(l)).length;
  const fail = out.filter((l) => / FAIL/.test(l)).length;
  const absent = out.filter((l) => / ABSENT/.test(l)).length;
  out.push(`PROBE-SUMMARY ok=${ok} fail=${fail} absent=${absent}`);
  (G.console ? console.log : print)(out.join('\n'));
}
main();
