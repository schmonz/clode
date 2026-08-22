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

test('the tls-cacert provenance record is committed and well-formed', () => {
  assert.ok(fs.existsSync(provenancePath()),
    `${provenancePath()} is missing — run scripts/extract-cacert-pem.mjs`);
  const p = readProvenance();
  for (const k of ['txiki_tag', 'txiki_sha', 'cacert_c_sha256', 'pem_sha256']) {
    assert.ok(typeof p[k] === 'string' && p[k], `provenance record has no ${k}`);
  }
  assert.match(p.cacert_c_sha256, /^[0-9a-f]{64}$/);
  assert.match(p.pem_sha256, /^[0-9a-f]{64}$/);
});

// THE staleness gate, and the reason skipping the re-derivation below is safe.
// Bumping txiki.js is how cacert.c changes; if the pin moves and nobody re-runs
// the extractor, the .pem is stale and this fails — with no checkout, on CI.
test('tls-cacert.pem was extracted from the txiki.js version PINS.md currently pins', () => {
  const pin = txikiPin();
  const p = readProvenance();
  assert.strictEqual(p.txiki_sha, pin.sha,
    `tls-cacert.pem was extracted from txiki.js ${p.txiki_tag} (${p.txiki_sha.slice(0, 12)}) but `
    + `PINS.md now pins ${pin.tag} (${pin.sha.slice(0, 12)}) — re-run `
    + '`node scripts/extract-cacert-pem.mjs` against the new checkout');
  assert.strictEqual(p.txiki_tag, pin.tag, 'provenance tag disagrees with PINS.md');
});

test('the committed tls-cacert.pem is exactly the file that was extracted (not hand-edited)', () => {
  assert.ok(fs.existsSync(OUT_PEM), `${OUT_PEM} is missing — run scripts/extract-cacert-pem.mjs`);
  const p = readProvenance();
  assert.strictEqual(sha256(fs.readFileSync(OUT_PEM)), p.pem_sha256,
    'tls-cacert.pem does not hash to the digest recorded when it was extracted — it was '
    + 'edited by hand, or written by something other than scripts/extract-cacert-pem.mjs');
});

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

test('tls-cacert.pem: every BEGIN/END block is a real, parseable X.509 certificate', () => {
  const text = fs.readFileSync(OUT_PEM, 'utf8');
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  assert.ok(blocks.length >= 50, `expected at least 50 certificates, found ${blocks.length}`);
  for (const b of blocks) {
    assert.doesNotThrow(() => new X509Certificate(b), `block failed to parse as X.509: ${b.slice(0, 60)}...`);
  }
});
