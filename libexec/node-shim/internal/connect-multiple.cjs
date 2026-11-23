'use strict';
// Connect to a HOSTNAME the way node does: every address, in node's order, with node's per-attempt timeout
// (net.connect's autoSelectFamily — "Happy Eyeballs" — on by default since node 20; Bun does the same).
//
// WHY THIS EXISTS. tjs.connect(transport, host, port) resolves a hostname itself and connects to the FIRST
// getaddrinfo answer only (txiki src/js/core/lookup.js: `return r[0]`). A dual-stack name answers AAAA first, so a box
// with no IPv6 route dies on it: the 2026-11-22 live /login on the NetBSD/arm64 VM failed the token exchange with
// "Couldn't get an answer from the sign-in service (EHOSTUNREACH)" — platform.claude.com has A and AAAA, the VM has
// only link-local IPv6, and the bundle's axios POST went through node-shim's http client to tjs.connect. Native (Bun)
// and node fall back to the A record and succeed. Every connect node-shim makes goes through connectHost, so there is
// ONE resolver policy (test/node-shim-connect-multiple.test.cjs scans that no other tjs.connect( call exists).
//
// NODE'S RULES, as lib/net.js lookupAndConnectMultiple implements them:
//   - an IP literal is connected to directly;
//   - family 4 or 6, or autoSelectFamily false: one lookup answer (of that family), one attempt, no attempt timeout;
//   - otherwise every address (deduplicated), families ALTERNATED starting with the first answer's family;
//   - each attempt but the last gets autoSelectFamilyAttemptTimeout ms (default 250, at least 10) before the next
//     begins; a failure moves on at once (node ABANDONS the attempt at its timeout; this keeps it racing, see below);
//   - all failed: an AggregateError of every attempt's error, its `code` the first one's (node's NodeAggregateError).
// The hostname stays the TLS name (sni) whatever address is dialled, so the certificate is checked against the name.
//
// Everything that touches the system is INJECTED (makeConnectMultiple's deps), so host node can test it with a fake
// resolver and fake sockets.

const DEFAULT_ATTEMPT_TIMEOUT = 250;
const MIN_ATTEMPT_TIMEOUT = 10;
const state = { autoSelectFamily: true, attemptTimeout: DEFAULT_ATTEMPT_TIMEOUT };

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
function ipFamily(s) {
  if (typeof s !== 'string') return 0;
  if (V4.test(s)) return 4;
  return /^[0-9a-fA-F:.]+(%[\w.-]+)?$/.test(s) && s.includes(':') ? 6 : 0;
}

// node's alternation: bucket by family (first answer's family first), dedupe, interleave.
function attemptOrder(addresses) {
  let first = 0;
  const buckets = { 4: [], 6: [] };
  for (const raw of addresses || []) {
    const a = raw && { address: raw.address ?? raw.ip, family: raw.family };  // tjs.lookup answers { ip, family }
    const fam = a && (a.family === 6 || a.family === 'IPv6' ? 6 : a.family === 4 || a.family === 'IPv4' ? 4 : ipFamily(a.address));
    if (fam !== 4 && fam !== 6) continue;
    if (!first) first = fam;
    if (!buckets[fam].some((b) => b.address === a.address)) buckets[fam].push({ address: a.address, family: fam });
  }
  if (!first) return [];
  const [p, q] = first === 6 ? [buckets[6], buckets[4]] : [buckets[4], buckets[6]];
  const out = [];
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (i < p.length) out.push(p[i]);
    if (i < q.length) out.push(q[i]);
  }
  return out;
}

function makeConnectMultiple(deps) {
  const { lookup, connect } = deps;
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;

  // opts: the engine connect options (sni etc.); policy: { family, autoSelectFamily, autoSelectFamilyAttemptTimeout }
  async function connectHost(transport, host, port, opts = {}, policy = {}) {
    const engineOpts = transport === 'tls' ? { ...opts, sni: opts.sni ?? host } : { ...opts };
    if (ipFamily(host)) return connect(transport, host, port, engineOpts);
    const family = Number(policy.family) === 4 || Number(policy.family) === 6 ? Number(policy.family) : 0;
    const auto = policy.autoSelectFamily === undefined ? state.autoSelectFamily : !!policy.autoSelectFamily;
    let timeout = policy.autoSelectFamilyAttemptTimeout === undefined ? state.attemptTimeout : Number(policy.autoSelectFamilyAttemptTimeout);
    if (!(timeout >= MIN_ATTEMPT_TIMEOUT)) timeout = MIN_ATTEMPT_TIMEOUT;

    let targets;
    if (family || !auto) {
      const one = await lookup(host, { family, all: false });
      targets = one ? attemptOrder([one]) : [];
    } else {
      targets = attemptOrder(await lookup(host, { family: 0, all: true }));
    }
    if (!targets.length) {
      const e = new Error(`getaddrinfo ENOTFOUND ${host}`);
      e.code = 'ENOTFOUND'; e.hostname = host;
      throw e;
    }
    if (targets.length === 1) return connect(transport, targets[0].address, port, engineOpts);

    // Attempts start in node's order, each after the previous one failed or outlived the attempt timeout; one that
    // outlived it is NOT abandoned but keeps going beside the next (RFC 8305's racing), and the first to connect wins.
    // DIVERGENCE FROM NODE, on purpose: node abandons it. node's attempt is the TCP connect alone, and the TLS
    // handshake runs after it, untimed; tjs.connect('tls') is the connect AND the handshake, done in JavaScript over
    // mbedtls, so on a loop as busy as the bundle's startup a handshake to api.anthropic.com outlived 250 ms and was
    // thrown away where node would have kept it: every first-party request at quaude's startup failed
    // "ETIMEDOUT ...; EHOSTUNREACH" (the bootstrap, the fast-mode probe, the MCP registry; darwin-arm64 with no IPv6
    // route, 2026-11-23, caught by test/fidelity/debug-log-errors.test.cjs). Racing keeps node's ORDER and its
    // fallback (a dead first address still costs one attempt timeout) and never loses a connection node keeps.
    const errors = new Array(targets.length);
    // A FAILED HANDSHAKE ENDS IT, as in node. An error carrying mbedtlsCode means the TCP connection WAS made and the
    // handshake (certificate verification, say) failed; node's attempt is the TCP connect, so node has already chosen
    // that address and fails with that error. Trying (or waiting for) another address would hide a verification
    // failure behind an AggregateError of unrelated attempts, or worse, let a different address answer instead.
    // A refusal or a timeout is a reason to try the next address; a handshake failure is not.
    let fatal = null;
    const live = new Map();   // index -> AbortController (or null), attempts not yet settled
    let won = null;
    const loseAll = (except) => {
      for (const [j, ac] of live) if (j !== except && ac) ac.abort();
    };
    const winner = await new Promise((resolve) => {
      let next = 0, settled = 0, timer = null;
      const finish = (v) => { clearT(timer); resolve(v); };
      const start = () => {
        if (won !== null || next >= targets.length) return;
        const i = next++;
        const ac = typeof AbortController === 'function' ? new AbortController() : null;
        live.set(i, ac);
        clearT(timer);
        timer = next < targets.length ? setT(() => {
          // outlived the attempt timeout: the next starts beside it (node would have recorded ETIMEDOUT here)
          if (live.has(i) && !errors[i]) {
            const e = new Error(`connect ETIMEDOUT ${targets[i].address}:${port}`);
            e.code = 'ETIMEDOUT'; e.address = targets[i].address; e.port = port;
            errors[i] = e;
          }
          start();
        }, timeout) : null;
        Promise.resolve().then(() => connect(transport, targets[i].address, port, ac ? { ...engineOpts, signal: ac.signal } : engineOpts)).then((sock) => {
          live.delete(i);
          if (won !== null) { try { sock && sock.close && sock.close(); } catch { /* lost the race */ } return; }
          won = i;
          loseAll(i);
          finish(sock);
        }, (e) => {
          live.delete(i);
          if (won !== null) return;
          if (e && e.mbedtlsCode !== undefined) { fatal = e; won = -1; loseAll(-1); finish(null); return; }
          if (!errors[i] || errors[i].code === 'ETIMEDOUT') errors[i] = e;
          settled++;
          if (settled === targets.length) finish(null);
          else if (live.size === 0 || next === i + 1) start();
        });
      };
      start();
    });
    if (fatal) throw fatal;
    if (won !== null) return winner;
    const agg = new AggregateError(errors, errors.map((e) => (e && e.message) || String(e)).join('; '));
    agg.code = errors[0] && errors[0].code;
    throw agg;
  }
  return { connectHost };
}

// net.setDefaultAutoSelectFamily & co., validated as node does (a boolean; an integer timeout, at least 10).
function setDefaultAutoSelectFamily(v) {
  if (typeof v !== 'boolean') {
    const e = new TypeError(`The "value" argument must be of type boolean. Received ${typeof v}`);
    e.code = 'ERR_INVALID_ARG_TYPE'; throw e;
  }
  state.autoSelectFamily = v;
}
function getDefaultAutoSelectFamily() { return state.autoSelectFamily; }
function setDefaultAutoSelectFamilyAttemptTimeout(v) {
  if (!Number.isInteger(v) || v < 1) {
    const e = new RangeError(`The value of "value" is out of range. It must be >= 1 && <= 4294967295. Received ${v}`);
    e.code = 'ERR_OUT_OF_RANGE'; throw e;
  }
  state.attemptTimeout = Math.max(v, MIN_ATTEMPT_TIMEOUT);
}
function getDefaultAutoSelectFamilyAttemptTimeout() { return state.attemptTimeout; }

// THE engine-bound connector, and the ONLY place node-shim calls tjs.lookup / tjs.connect (the scan in
// test/node-shim-connect-multiple.test.cjs holds that). tjs is read at call time, so host node can load this file.
const { connectHost } = makeConnectMultiple({
  lookup: (host, o) => tjs.lookup(host, o),
  connect: (transport, host, port, o) => tjs.connect(transport, host, port, o),
});

module.exports = {
  connectHost, makeConnectMultiple, attemptOrder, ipFamily,
  setDefaultAutoSelectFamily, getDefaultAutoSelectFamily,
  setDefaultAutoSelectFamilyAttemptTimeout, getDefaultAutoSelectFamilyAttemptTimeout,
};
