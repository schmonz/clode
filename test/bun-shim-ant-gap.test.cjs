'use strict';
// Bun.ant is an INTENTIONAL, DOCUMENTED gap — this file is the decision, kept
// executable. See the long comment beside `spawnSync` in libexec/bun-shim.cjs
// for the full reasoning; the short version:
//
// Bun.ant arrived in Claude Code 2.1.243 with four syscall-backed methods
// (getPeerUid/getPeerPid on a unix socket, Linux prctl setDumpable, macOS
// memoryPressureLevel). The shim does not provide it, and MUST NOT stub it:
// upstream gates a capability on `typeof Bun.ant?.getPeerPid === "function"`,
// so any stub — throwing or not — makes upstream advertise a peer-credential
// capability we cannot honor. Absent is the faithful answer.
//
// The reason it is acceptable to leave absent is REACHABILITY, and reachability
// is a fact about OTHER code that can change without anyone thinking about
// Bun.ant. Both peer-credential call sites sit behind declared node-shim walls:
// the UDS client goes through net.connect, the daemon through net.Server, and
// both throw first. The last test here pins that. The day either wall comes
// down, this file goes red and the decision gets re-taken — which is the point,
// because upstream's fallbacks are NOT uniformly graceful: the daemon's uid
// check fails OPEN, and the client's pid check refuses to send outright.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

const SHIM = path.join(REPO, 'libexec/bun-shim.cjs');

function writeProg(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-shim-ant-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, `require(${JSON.stringify(SHIM)});\n${body}`);
  return f;
}

test('Bun.ant stays ABSENT so upstream\'s capability probe reads false', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    // upstream, verbatim in shape:
    //   function D9(){ if(P()==="windows")return!1;
    //     return typeof Bun<"u" && typeof Bun.ant?.getPeerPid==="function" }
    console.log('ant:' + typeof Bun.ant);
    console.log('probe:' + (typeof Bun < "u" && typeof Bun.ant?.getPeerPid === "function"));
  `);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /ant:undefined/,
    'Bun.ant must not be stubbed: upstream feature-detects getPeerPid, so any stub'
    + ' advertises a peer-credential capability the shim cannot honor');
  assert.match(r.stdout, /probe:false/,
    'upstream\'s capability probe must evaluate false under the shim');
});

test('the peer-credential call sites are still behind node-shim walls', (t) => {
  if (skipUnlessTjs(t)) return;
  // If EITHER of these stops throwing, upstream's peer-credential code becomes
  // reachable and the "absent is harmless" half of the Bun.ant decision expires.
  const f = writeProg(`
    const net = require('net');
    let c = 'NO-THROW'; try { net.connect({ path: '/tmp/nope.sock' }); } catch (e) { c = 'THREW'; }
    console.log('connect:' + c);
    console.log('server:' + (typeof net.createServer));
  `);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /connect:THREW/,
    'net.connect no longer throws — the UDS client that calls Bun.ant.getPeerPid is now'
    + ' reachable, and upstream REFUSES TO SEND when the peer pid cannot be read.'
    + ' Re-take the Bun.ant decision (libexec/bun-shim.cjs, beside spawnSync).');
  assert.match(r.stdout, /server:undefined/,
    'net.createServer now exists — the daemon that calls Bun.ant.getPeerUid is now'
    + ' reachable, and upstream\'s uid check FAILS OPEN when the lookup throws.'
    + ' Re-take the Bun.ant decision (libexec/bun-shim.cjs, beside spawnSync).');
});
