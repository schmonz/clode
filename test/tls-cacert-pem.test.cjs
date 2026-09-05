'use strict';
// Bug (found while root-causing RECIPE G6): tls.rootCertificates / a bare
// tls.getCACertificates() came back EMPTY under the shim, while the engine
// (mbedtls + libwebsockets, via spike/quickjs/vendor/txiki.js/src/cacert.c)
// already vendors and already TRUSTS a real, current Mozilla CA bundle for
// its own TLS traffic (fetch()'s https:// requests, wss://). Consequence,
// observed live: the bundle logs "CA certs: Loaded 0 bundled root
// certificates" and therefore never logs "mTLS: Creating HTTPS agent with
// custom certificates" — a real branch divergence from naude.
//
// Fix: scripts/extract-cacert-pem.mjs pulls that SAME already-vendored,
// already-trusted bundle out of cacert.c (not a separately-sourced or
// invented set) into libexec/node-shim/modules/tls-cacert.pem, a sibling
// asset libexec/quaude-fuse.js sweeps into a fused quaude verbatim. This
// file gates two things: (1) the extraction logic itself, against a small
// synthetic fixture (no engine/tjs binary needed — pure node:test), and (2)
// that the COMMITTED tls-cacert.pem is not stale relative to the cacert.c the
// txiki.js pin names — a drift here means someone updated one without the other.
//
// WHY THIS IS SPLIT INTO A CHECKOUT-FREE HALF AND A CHECKOUT-ONLY HALF.
// cacert.c is NOT committed. It lives in the txiki.js checkout — gitignored
// scratch that exists only after a build. This file used to hard-assert that
// path existed, on the reasoning that a silent skip forever is worse than a
// failure. The reasoning was right and the implementation was still wrong: no
// job that runs `npm test` ever creates a checkout, so the assertion could
// only ever be red on CI. It was, on the first run that reached it — and
// moving the vendor default (TMPDIR -> ~/.cache/clode) did not cause that, it
// only changed which absent path the message named.
//
// Both halves below are real. cacert.c's BYTES are not committed, but its
// IDENTITY is: spike/quickjs/PINS.md pins txiki.js to an exact sha, and
// scripts/extract-cacert-pem.mjs records the chain
//     txiki.js pin -> sha256(cacert.c) -> sha256(tls-cacert.pem)
// into spike/quickjs/tls-cacert-provenance.json when it writes the .pem. So the
// drift that actually happens — someone bumps the pin, or edits the .pem, and
// does not re-extract — is caught with NO checkout, on every runner. What needs
// the checkout is only the re-derivation in the middle, and that is the one
// thing skipping cannot silently hide, because the ends are pinned.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const {
  extractPemFromCacertC, txikiPin, sha256, provenancePath, readProvenance,
} = require('../scripts/extract-cacert-pem.mjs');
const { tjsVendorParentDir } = require('../scripts/platform-tag.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');

const REPO = path.resolve(__dirname, '..');
// Resolved the SAME way build-tjs.mjs resolves its own CLODE_TJS_VENDOR
// default (see platform-tag.cjs's tjsVendorParentDir) — not hardcoded to the
// old spike/quickjs/vendor path, which would silently stop matching the moment
// that default moves off the NFS-mounted repo tree onto local scratch.
const CACERT_C = path.join(tjsVendorParentDir(), 'txiki.js/src/cacert.c');
const OUT_PEM = path.join(REPO, 'libexec/node-shim/modules/tls-cacert.pem');
const NO_CHECKOUT = fs.existsSync(CACERT_C)
  ? false
  : `no txiki.js checkout at ${CACERT_C} — run scripts/build-tjs.mjs (the pin and `
    + 'digest checks above still ran, and catch drift without it)';

test('extractPemFromCacertC: decodes a small synthetic C string literal', () => {
  // Build the fake cacert.c source with explicit C-escape substrings (each
  // `Q`/`BS`/`NL` below is a LITERAL two-character C escape: backslash-quote,
  // backslash-backslash, backslash-n) so the expected value is easy to read
  // back off, rather than fighting JS/C double-escaping in one literal.
  const Q = '\\"', BS = '\\\\', NL = '\\n';
  const src = [
    '#include "cacert.h"',
    'const char tjs_cacert_pem[] =',
    `    "line one${NL}"`,
    `    "line two with a ${Q}quote${Q} and a backslash ${BS}${NL}"`,
    `    "-----END CERTIFICATE-----${NL}"`,
    ';',
    'const size_t tjs_cacert_pem_len = sizeof(tjs_cacert_pem) - 1;',
  ].join('\n');
  const got = extractPemFromCacertC(src);
  assert.strictEqual(got, 'line one\nline two with a "quote" and a backslash \\\n-----END CERTIFICATE-----\n');
});

test('extractPemFromCacertC: throws loudly if the literal is not found', () => {
  assert.throws(() => extractPemFromCacertC('no such literal here'), /tjs_cacert_pem\[\] literal not found/);
});

// --- checkout-free half: runs on every runner, verifies the ends of the chain ---
//
// PURE: every check below is derived from the provenance record, the PINS.md
// pin, and the .pem bytes that read() gathers — no I/O happens inside scan().
// `provenance`/`pemBytes` are null when read() found the file missing (rather than
// scan() re-checking existsSync itself, which would be I/O inside the pure half) —
// a MISSING committed file is a real, named finding here, not an uncaught ENOENT:
// read() throwing (the pre-fix-round-1 shape) gave the exact same red as a real
// drift, with a stack trace instead of "run scripts/extract-cacert-pem.mjs".
function scanCacertProvenance({ provenance, pemBytes, pin }) {
  const findings = [];
  let examined = 0;

  examined++;
  if (provenance === null) {
    findings.push(`${provenancePath()} is missing — run scripts/extract-cacert-pem.mjs`);
  } else {
    for (const k of ['txiki_tag', 'txiki_sha', 'cacert_c_sha256', 'pem_sha256']) {
      if (typeof provenance[k] !== 'string' || !provenance[k]) findings.push(`provenance record has no ${k}`);
    }
    if (typeof provenance.cacert_c_sha256 === 'string' && !/^[0-9a-f]{64}$/.test(provenance.cacert_c_sha256)) {
      findings.push('provenance cacert_c_sha256 is not a 64-hex sha256');
    }
    if (typeof provenance.pem_sha256 === 'string' && !/^[0-9a-f]{64}$/.test(provenance.pem_sha256)) {
      findings.push('provenance pem_sha256 is not a 64-hex sha256');
    }
  }

  // THE staleness gate: bumping txiki.js is how cacert.c changes; if the pin
  // moves and nobody re-runs the extractor, the .pem is stale — caught here
  // with NO checkout, on every runner.
  examined++;
  if (provenance !== null) {
    if (provenance.txiki_sha !== pin.sha) {
      findings.push(`tls-cacert.pem was extracted from txiki.js ${provenance.txiki_tag} `
        + `(${String(provenance.txiki_sha).slice(0, 12)}) but PINS.md now pins ${pin.tag} `
        + `(${pin.sha.slice(0, 12)}) — re-run \`node scripts/extract-cacert-pem.mjs\` against `
        + 'the new checkout');
    }
    if (provenance.txiki_tag !== pin.tag) findings.push('provenance tag disagrees with PINS.md');
  }

  // Not hand-edited: the committed .pem must hash to the digest recorded at
  // extraction time.
  examined++;
  if (pemBytes === null) {
    findings.push(`${OUT_PEM} is missing — run scripts/extract-cacert-pem.mjs`);
  } else if (provenance !== null) {
    const actualPemSha = sha256(pemBytes);
    if (actualPemSha !== provenance.pem_sha256) {
      findings.push('tls-cacert.pem does not hash to the digest recorded when it was extracted — '
        + 'it was edited by hand, or written by something other than scripts/extract-cacert-pem.mjs');
    }
  }

  // Every BEGIN/END block must be a real, parseable X.509 certificate, and
  // there must be a plausible number of them.
  examined++;
  if (pemBytes !== null) {
    const blocks = pemBytes.toString('utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
    if (blocks.length < 50) findings.push(`expected at least 50 certificates, found ${blocks.length}`);
    for (const b of blocks) {
      try { new X509Certificate(b); } catch { findings.push(`block failed to parse as X.509: ${b.slice(0, 60)}...`); }
    }
  }

  return { findings, examined };
}

const cacertProvenanceGuard = defineGuard({
  name: 'tls-cacert-provenance',
  read: () => ({
    provenance: fs.existsSync(provenancePath()) ? readProvenance() : null,
    pin: txikiPin(),
    pemBytes: fs.existsSync(OUT_PEM) ? fs.readFileSync(OUT_PEM) : null,
  }),
  scan: scanCacertProvenance,
  // I2 (coordinator, 2026-09-04): table-driven — a fixed set of checks over one
  // provenance record + pin + pem. Floored at the exact measured count (4).
  floor: 4,
  // Models the actual dangerous drift: PINS.md moved on without a re-extraction,
  // AND the .pem bytes no longer match what was recorded (a hand edit, or a
  // corrupted write) — both real failure modes this guard exists to catch.
  control: () => ({
    provenance: {
      txiki_tag: 'v0.0.0-stale', txiki_sha: 'deadbeef'.repeat(8),
      cacert_c_sha256: 'a'.repeat(64), pem_sha256: 'b'.repeat(64),
    },
    pin: { tag: 'v9.9.9-current', sha: 'feedface'.repeat(8) },
    pemBytes: Buffer.from('not a real pem file'),
  }),
});
guardTests(cacertProvenanceGuard);

// --- checkout-only half: re-derives the middle of the chain ---

test('cacert.c is the exact file the provenance record was extracted from',
  { skip: NO_CHECKOUT }, () => {
    const p = readProvenance();
    assert.strictEqual(sha256(fs.readFileSync(CACERT_C)), p.cacert_c_sha256,
      `${CACERT_C} does not match the digest recorded at extraction time — the checkout is `
      + 'not at the pinned sha, or cacert.c was regenerated; re-run scripts/extract-cacert-pem.mjs');
  });

test('tls-cacert.pem is NOT stale relative to cacert.c (re-run scripts/extract-cacert-pem.mjs if this fails)',
  { skip: NO_CHECKOUT }, () => {
    const expected = extractPemFromCacertC(fs.readFileSync(CACERT_C, 'utf8'));
    const actual = fs.readFileSync(OUT_PEM, 'utf8');
    assert.strictEqual(actual, expected,
      'tls-cacert.pem does not match a fresh extraction from cacert.c — regenerate with `node scripts/extract-cacert-pem.mjs`');
  });

// The X.509-parse and cert-count checks now live in scanCacertProvenance() above
// (folded into the tls-cacert-provenance guard), so they are not repeated here.
