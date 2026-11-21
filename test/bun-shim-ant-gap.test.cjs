'use strict';
// Bun.ant is an INTENTIONAL, DOCUMENTED gap — this file is the decision, kept
// executable. See the long comment beside `spawnSync` in libexec/bun-shim.cjs
// for the full reasoning; the short version:
//
// Bun.ant arrived in Claude Code 2.1.243 with four syscall-backed methods
// (getPeerUid/getPeerPid on a unix socket, Linux prctl setDumpable, macOS
// memoryPressureLevel). The shim does not provide them, and MUST NOT stub them:
// upstream gates a capability on `typeof Bun.ant?.getPeerPid === "function"`,
// so any stub — throwing or not — makes upstream advertise a peer-credential
// capability we cannot honor. Absent is the faithful answer.
//
// 2.1.278 added a member whose absence is NOT survivable, CellSegmenter (the
// TUI's screen model; see test/bun-shim-cell-segmenter.test.cjs), so Bun.ant now
// EXISTS. 2.1.330 added a second unsurvivable one, isVmContextGlobal: its sandbox
// builder refuses to make a node:vm context unless `Bun.ant.isVmContextGlobal(g)
// === true`, which killed every Workflow (test/bun-shim-vm-context-global.test.cjs).
// It is pure-JS bookkeeping of the contexts the shim's vm made, not a stub of a
// syscall. The first test pins the membership exactly: a third member is a failure
// here, not a quiet capability change.
//
// The reason it is acceptable to leave absent is REACHABILITY, and reachability
// is a fact about OTHER code that can change without anyone thinking about
// Bun.ant. Both peer-credential call sites sit behind declared node-shim walls:
// the UDS client goes through net.connect, the daemon through net.createServer, and
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
const { shimBunAntMembers } = require('../libexec/inspect-claude-bundle.cjs');

const SHIM = path.join(REPO, 'libexec/bun-shim.cjs');

function writeProg(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-shim-ant-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, `require(${JSON.stringify(SHIM)});\n${body}`);
  return f;
}

// Members upstream feature-detects (typeof / === undefined) whose absence takes a reported fallback; a stub would
// switch the fallback off and claim a capability the shim lacks. Each is reviewed in
// libexec/inspect-claude-bundle.cjs KNOWN_BUN_ANT with its call site.
const MUST_STAY_ABSENT = ['getPeerUid', 'getPeerPid', 'setDumpable', 'memoryPressureLevel', 'waitForUrlEvent',
  'loginTty', 'posixFsAt', 'stringifyToBytes', 'stringifyToBytesFallbacks', 'ttyName', 'withThreadWorkingDirectory',
  'windowsFolderSecurity', 'windowsProcessCreationTime', 'windowsProcessList', 'windowsSandboxDeniesArg'];

test('Bun.ant carries CellSegmenter and isVmContextGlobal and NOTHING else, so every capability probe reads false', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    console.log('members:' + JSON.stringify(Object.keys(Bun.ant).sort()));
    console.log('segmenter:' + typeof Bun.ant.CellSegmenter);
    // upstream, verbatim in shape:
    //   function D9(){ if(P()==="windows")return!1;
    //     return typeof Bun<"u" && typeof Bun.ant?.getPeerPid==="function" }
    console.log('probe:' + (typeof Bun < "u" && typeof Bun.ant?.getPeerPid === "function"));
    for (const k of ${JSON.stringify(MUST_STAY_ABSENT)})
      console.log(k + ':' + typeof Bun.ant[k]);
  `);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /members:\["CellSegmenter","isVmContextGlobal"\]/,
    'Bun.ant must hold exactly CellSegmenter and isVmContextGlobal: any other member is a stub of a'
    + ' syscall-backed method, and upstream feature-detects those');
  assert.match(r.stdout, /segmenter:function/);
  // inspect-claude-bundle derives "what bun-shim provides" from bun-shim's SOURCE TEXT
  // (it must not require() the shim). That derivation is only trustworthy if it agrees
  // with the runtime, so a spelling its regex cannot see is red HERE, not a member that
  // silently stops counting as provided and resurfaces as a phantom gate finding.
  const runtime = JSON.parse(r.stdout.match(/members:(\[.*\])/)[1]);
  assert.deepStrictEqual(shimBunAntMembers(), runtime,
    'shimBunAntMembers() (text-derived) disagrees with Object.keys(Bun.ant) at runtime');
  assert.match(r.stdout, /probe:false/,
    'upstream\'s peer-credential capability probe must evaluate false under the shim');
  for (const k of MUST_STAY_ABSENT) {
    assert.match(r.stdout, new RegExp(`${k}:undefined`), `Bun.ant.${k} must stay absent`);
  }
});

test('the peer-credential call sites are still behind node-shim walls', (t) => {
  if (skipUnlessTjs(t)) return;
  // If EITHER of these stops throwing, upstream's peer-credential code becomes
  // reachable and the "absent is harmless" half of the Bun.ant decision expires.
  const f = writeProg(`
    const net = require('net');
    let c = 'NO-THROW'; try { net.connect({ path: '/tmp/nope.sock' }); } catch (e) { c = 'THREW'; }
    console.log('connect:' + c);
    let srv = 'NO-THROW'; try { net.createServer(() => {}); } catch (e) { srv = 'THREW'; }
    console.log('server:' + srv);
  `);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /connect:THREW/,
    'net.connect no longer throws — the UDS client that calls Bun.ant.getPeerPid is now'
    + ' reachable, and upstream REFUSES TO SEND when the peer pid cannot be read.'
    + ' Re-take the Bun.ant decision (libexec/bun-shim.cjs, beside spawnSync).');
  // Round 3 (M1): net.createServer EXISTS now, as a stub that throws naming the gap ("quaude does not support the
  // sandbox yet"). Throwing at the call is the same wall: the daemon never gets a server to listen on.
  assert.match(r.stdout, /server:THREW/,
    'net.createServer no longer throws — the daemon that calls Bun.ant.getPeerUid is now'
    + ' reachable, and upstream\'s uid check FAILS OPEN when the lookup throws.'
    + ' Re-take the Bun.ant decision (libexec/bun-shim.cjs, beside spawnSync).');
});
