'use strict';
// The probe half of test/node-shim-http-client.test.cjs. Runs UNCHANGED under
// host node (the oracle) and under the node-shim loader (the subject); the two
// JSON results must deep-equal. Talks to test/fixtures/http-client-origin.cjs,
// whose port arrives in PROBE_PORT.
const http = require('node:http');
const { Readable } = require('node:stream');

const PORT = Number(process.env.PROBE_PORT);
// `agent: false` on every row deliberately: node's default globalAgent pools
// (keepAlive since v19) and would reuse a socket this origin has already
// closed, and the shim's client never pools at all (a documented divergence —
// see libexec/node-shim/modules/http.cjs). Pinning both sides to one
// connection per request is what makes every OTHER behaviour comparable; the
// pooling divergence itself is asserted separately in the test file.
const BASE = { host: '127.0.0.1', port: PORT, agent: false };
const out = {};

function collect(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}
// Response summary shared by every row, so a divergence names itself.
async function summarize(res, { withBody = true } = {}) {
  const body = withBody ? (await collect(res)).toString('utf8') : '';
  return {
    statusCode: res.statusCode,
    statusMessage: res.statusMessage,
    httpVersion: res.httpVersion,
    headers: res.headers,
    rawHeaders: res.rawHeaders,
    complete: res.complete,
    body,
  };
}
function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ ...BASE, ...opts }, (res) => resolve({ res, r }));
    r.on('error', reject);
    if (typeof body === 'function') body(r);
    else r.end(body);
  });
}

async function main() {
  /* 1. a plain GET: response framed by Content-Length, request serialization
     echoed back so both clients' wire bytes are compared. */
  {
    const { res } = await req({ path: '/echo?x=1', method: 'GET', headers: { 'X-Probe': 'p1', 'user-agent': 'probe/1' } });
    const s = await summarize(res);
    out.get = { ...s, echoed: JSON.parse(s.body) };
    delete out.get.body;
  }

  /* 2. POST with a known-length body via end(body) — Content-Length framing. */
  {
    const { res } = await req({ path: '/echo', method: 'POST', headers: { 'content-type': 'text/plain' } }, 'HELLO-BODY');
    out.postFixed = JSON.parse((await collect(res)).toString());
  }

  /* 3. POST with a STREAMED body (write/write/end) — must frame as chunked,
     exactly as node does, and the origin must dechunk to the same bytes. */
  {
    const { res } = await req({ path: '/echo', method: 'POST' }, (r) => {
      r.write('part-one|');
      r.write('part-two');
      r.end();
    });
    out.postStreamed = JSON.parse((await collect(res)).toString());
  }

  /* 4. a caller-declared Content-Length must be honoured verbatim (no chunking). */
  {
    const { res } = await req({ path: '/echo', method: 'PUT', headers: { 'Content-Length': '4' } }, (r) => {
      r.write('ab'); r.end('cd');
    });
    out.postDeclaredLength = JSON.parse((await collect(res)).toString());
  }

  /* 5. piping a Readable into the request (what @smithy/node-http-handler does
     for a stream body). */
  {
    const { res } = await req({ path: '/echo', method: 'POST' }, (r) => {
      Readable.from([Buffer.from('piped-'), Buffer.from('body')]).pipe(r);
    });
    out.postPiped = JSON.parse((await collect(res)).toString());
  }

  /* 6. an empty body on a body-carrying method vs a bodyless one — node's
     Content-Length: 0 rule. */
  {
    const { res: a } = await req({ path: '/echo', method: 'POST' });
    out.emptyPost = JSON.parse((await collect(a)).toString());
    const { res: b } = await req({ path: '/echo', method: 'DELETE' });
    out.emptyDelete = JSON.parse((await collect(b)).toString());
  }

  /* 7. chunked RESPONSE body. */
  { const { res } = await req({ path: '/chunked' }); out.chunked = await summarize(res); }

  /* 8. chunked response with chunk extensions AND a trailer. */
  { const { res } = await req({ path: '/ext' }); out.chunkedExt = await summarize(res); }

  /* 9. body framed only by connection close. */
  { const { res } = await req({ path: '/eof' }); out.eof = await summarize(res); }

  /* 10. 204: no body, whatever the framing. */
  { const { res } = await req({ path: '/204' }); out.noContent = await summarize(res); }

  /* 11. HEAD: Content-Length advertised, body absent — must not hang. */
  { const { res } = await req({ path: '/nobody', method: 'HEAD' }); out.head = await summarize(res); }

  /* 12. duplicate headers: node's join rules, set-cookie as an array, and the
     "keep the first" discard list for content-type. */
  { const { res } = await req({ path: '/dup' }); out.dupHeaders = await summarize(res); }

  /* 13. a 1xx informational response before the real one. */
  {
    const info = [];
    const { res } = await new Promise((resolve, reject) => {
      const r = http.request({ ...BASE, path: '/info' }, (res) => resolve({ res }));
      r.on('information', (i) => info.push({ statusCode: i.statusCode, link: i.headers.link }));
      r.on('error', reject);
      r.end();
    });
    out.informational = { info, res: await summarize(res) };
  }

  /* 14. Expect: 100-continue — 'continue' must fire before the body is sent. */
  {
    const order = [];
    const { res } = await new Promise((resolve, reject) => {
      const r = http.request({ ...BASE, path: '/expect', method: 'POST', headers: { Expect: '100-continue', 'Content-Length': '9' } },
        (res) => { order.push('response'); resolve({ res }); });
      r.on('continue', () => { order.push('continue'); r.end('post-body'); });
      r.on('error', reject);
    });
    out.expectContinue = { order, body: (await collect(res)).toString() };
  }

  /* 15. 'upgrade': the raw socket and the head bytes are handed over, and the
     socket keeps delivering data afterwards. */
  {
    out.upgrade = await new Promise((resolve, reject) => {
      const r = http.request({ ...BASE, path: '/upgrade', headers: { Connection: 'Upgrade', Upgrade: 'probe' } });
      r.on('error', reject);
      r.on('upgrade', (res, socket, head) => {
        const seen = [head.toString()];
        socket.on('data', (d) => {
          seen.push(d.toString());
          socket.destroy();
          resolve({ statusCode: res.statusCode, upgradeHeader: res.headers.upgrade, seen });
        });
      });
      r.end();
    });
  }

  /* 16. a connection refused surfaces as 'error' on the request, not a throw. */
  {
    out.refused = await new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: 1, path: '/', agent: false });
      r.on('error', (e) => resolve({ code: e.code, isError: e instanceof Error }));
      r.end();
    });
  }

  /* 17. setTimeout fires 'timeout' on the request and does NOT destroy it
     (node's contract: the caller decides). */
  {
    out.timeout = await new Promise((resolve, reject) => {
      const r = http.request({ ...BASE, path: '/slow' });
      r.setTimeout(150, () => { resolve({ fired: true, destroyedByTimeout: r.destroyed }); r.destroy(); });
      r.on('error', () => {});
      setTimeout(() => reject(new Error('timeout never fired')), 4000).unref?.();
      r.end();
    });
  }

  /* 18. outgoing-header bookkeeping before the head goes out. */
  {
    const r = http.request({ ...BASE, path: '/echo', method: 'POST', headers: { 'X-One': '1' } });
    r.setHeader('X-Two', '2');
    r.setHeader('x-three', '3');
    r.removeHeader('X-Two');
    const shape = {
      has1: r.hasHeader('x-one'), has2: r.hasHeader('X-Two'),
      get3: r.getHeader('X-Three'),
      names: r.getHeaderNames().filter((n) => n.startsWith('x-')).sort(),
      headersSentBefore: r.headersSent,
    };
    const res = await new Promise((resolve, reject) => { r.on('response', resolve); r.on('error', reject); r.end('h'); });
    shape.headersSentAfter = r.headersSent;
    shape.echoed = JSON.parse((await collect(res)).toString()).headers.filter((h) => /^x-/i.test(h)).sort();
    out.headerApi = shape;
  }

  /* 19. http.get(): ends the request for you. */
  {
    out.getHelper = await new Promise((resolve, reject) => {
      const r = http.get({ ...BASE, path: '/status?418' }, async (res) => resolve({ statusCode: res.statusCode, statusMessage: res.statusMessage, body: (await collect(res)).toString() }));
      r.on('error', reject);
    });
  }

  /* 20. URL-string form + auth in the URL. */
  {
    const { res } = await new Promise((resolve, reject) => {
      const r = http.request(`http://user:pa%3Ass@127.0.0.1:${PORT}/echo`, { method: 'GET', agent: false }, (res) => resolve({ res }));
      r.on('error', reject);
      r.end();
    });
    out.urlForm = JSON.parse((await collect(res)).toString());
  }

  /* 21. an https: URL handed to http.request is refused by name, not silently
     downgraded to plaintext. */
  {
    try { http.request('https://127.0.0.1/x'); out.protocolGuard = 'NO THROW'; }
    catch (e) { out.protocolGuard = { code: e.code, msgHasProtocol: /https:/.test(e.message) }; }
  }

  /* 22. the socket lifecycle @smithy/node-http-handler actually depends on:
     it reads req.socket if already assigned else waits for 'socket', then
     checks `socket.connecting` and hangs its connect-timeout on 'connect';
     it also calls setKeepAlive/setNoDelay/setTimeout on the socket. All four
     must exist and the connecting->connect transition must be observable. */
  {
    out.socketLifecycle = await new Promise((resolve, reject) => {
      const r = http.request({ ...BASE, path: '/echo' });
      const seen = { socketBeforeEvent: r.socket !== null && r.socket !== undefined };
      r.on('socket', (s) => {
        seen.connectingAtSocketEvent = s.connecting;
        seen.hasSetKeepAlive = typeof s.setKeepAlive === 'function';
        seen.hasSetNoDelay = typeof s.setNoDelay === 'function';
        seen.hasSetTimeout = typeof s.setTimeout === 'function';
        s.setNoDelay(true);
        s.setKeepAlive(true, 1000);
        s.on('connect', () => { seen.connectFired = true; seen.connectingAfterConnect = s.connecting; });
      });
      r.on('response', (res) => { res.resume(); res.on('end', () => resolve(seen)); });
      r.on('error', reject);
      r.end();
    });
  }

  console.log(JSON.stringify(out, null, 1));
}

main().then(() => process.exit(0), (e) => { console.error('probe failed: ' + (e && e.stack || e)); process.exit(1); });
