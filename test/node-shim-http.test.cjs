'use strict';
// Characterization: node:http / node:https must expose a real, subclassable
// Agent constructor (the -p bundle's proxy-agent stack does
// `class X extends require('http').Agent`). The request/server surface is a
// documented divergence (fetch is the transport); this only locks the Agent
// shape the boot depends on.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

test('http/https: Agent is a real subclassable constructor (matches host node shape)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-http-'));
  const f = path.join(dir, 'http.cjs');
  fs.writeFileSync(f, `const http = require('http');
const https = require('https');
class MyAgent extends http.Agent {
  constructor(o) { super(o); this.tag = 'mine'; }
}
const a = new MyAgent({ maxSockets: 4 });
console.log(JSON.stringify({
  httpAgentFn: typeof http.Agent,
  httpsAgentFn: typeof https.Agent,
  subConstructs: a instanceof http.Agent && a.tag === 'mine' && a.maxSockets === 4,
  httpsExtendsHttp: (new https.Agent()) instanceof http.Agent,
  globalAgent: typeof http.globalAgent,
}));`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});
