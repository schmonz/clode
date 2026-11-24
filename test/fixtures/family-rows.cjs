'use strict';
// THE FAMILY ROWS (test/connect-family.test.cjs): every client quaude provides, reaching an origin by the name
// `localhost`, which resolves to two addresses, one of each family (::1 and 127.0.0.1). test/fixtures/family-origin.cjs
// listens on one family only or on both at one port, and answers with the family that answered; each row is that
// answer, or the client's error code. Families are named by the host resolver's order, so a recording holds wherever
// localhost resolves to both: `first` is the family of its first answer (IPv6 on darwin), `second` the other.
//   target first    only the first answer's address listens
//   target second   only the second answer's address listens (the first is refused: does the client go on?)
//   target both     both listen: which one does the client reach first?
//
// Two groups, each against its own reference:
//   bun    Bun's fetch and WebSocket, recorded under native Bun (a preload of native Claude Code)
//   node   node's http and https clients, recorded under host node 24
// The test runs both groups under the shim and compares each with its reference.
//
// FAMILY_ROWS (env): { ports: { first|second|both: { http, https } }, order: ['v6', 'v4'] (the resolver's families, in
// its order), ca: <CA path>, groups: ['bun'|'node', ...] }. OUTF (env): where to write the JSON (a native preload must
// exit before Claude Code starts); else it is the last line of stdout.
const fs = require('fs');

const F = JSON.parse(process.env.FAMILY_ROWS);
const CA = fs.readFileSync(F.ca, 'utf8');
// the engine's default trust is the test CA, so tls.ca: [CA] is that set (bun-shim honours a ca equal to it), as in
// test/fixtures/fetch-proxy-rows.cjs
require('tls').setDefaultCACertificates([CA]);
const TARGETS = ['first', 'second', 'both'];
const errOf = (e) => ({ error: (e && (e.code || e.name)) || String(e) });
const famOf = (text) => {
  let fam;
  try { fam = JSON.parse(text).fam; } catch (_) { return `unparsed: ${String(text).slice(0, 40)}`; }
  return fam === F.order[0] ? 'first' : fam === F.order[1] ? 'second' : `unknown family ${fam}`;
};
const within = (ms, p) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve({ error: `no answer in ${ms} ms` }), ms))]);

const bun = {
  fetchHttp: (t) => fetch(`http://localhost:${F.ports[t].http}/`, { keepalive: false }).then((r) => r.text()).then((x) => ({ fam: famOf(x) }), errOf),
  fetchHttps: (t) => fetch(`https://localhost:${F.ports[t].https}/`, { keepalive: false, tls: { ca: [CA] } })
    .then((r) => r.text()).then((x) => ({ fam: famOf(x) }), errOf),
  webSocket: (t) => new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(`ws://localhost:${F.ports[t].http}/`); } catch (e) { resolve(errOf(e)); return; }
    ws.onmessage = (m) => { resolve({ fam: famOf(m.data) }); try { ws.close(); } catch (_) { /* closing */ } };
    ws.onerror = () => resolve({ error: 'error event' });
    ws.onclose = () => resolve({ error: 'closed before a message' });
  }),
};

function nodeRequest(mod, t, extra) {
  return new Promise((resolve) => {
    const req = require(mod).get({ host: 'localhost', port: F.ports[t][mod], path: '/', agent: false, ...extra }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ fam: famOf(b) }));
    });
    req.on('error', (e) => resolve(errOf(e)));
  });
}
// node-shim provides http and https clients (internal/connect-multiple.cjs dials them); its net.connect and
// tls.connect are throwing stubs, so they have no rows
const node = {
  httpGet: (t) => nodeRequest('http', t),
  httpsGet: (t) => nodeRequest('https', t, { ca: CA }),
  // the switch: node 24 defaults autoSelectFamily to true; false dials one address, the first the lookup gives
  httpGetNoAutoSelect: (t) => nodeRequest('http', t, { autoSelectFamily: false }),
};

(async () => {
  const out = {};
  for (const [g, rows] of Object.entries({ bun, node })) {
    if (!F.groups.includes(g)) continue;
    for (const [name, fn] of Object.entries(rows)) {
      for (const t of TARGETS) out[`${g}.${name}.${t}`] = await within(10000, fn(t));
    }
  }
  const json = JSON.stringify(out);
  if (process.env.OUTF) { fs.writeFileSync(process.env.OUTF, json); process.exit(0); }
  process.stdout.write(`${json}\n`);
  process.exit(0);
})();
