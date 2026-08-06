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
// that the COMMITTED tls-cacert.pem is not stale relative to the COMMITTED
// cacert.c — a drift here means someone updated one without the other.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const { extractPemFromCacertC } = require('../scripts/extract-cacert-pem.mjs');
const { tjsVendorParentDir } = require('../scripts/platform-tag.cjs');

const REPO = path.resolve(__dirname, '..');
// Resolved the SAME way build-tjs.mjs resolves its own CLODE_TJS_VENDOR
// default (see platform-tag.cjs's tjsVendorParentDir) — not hardcoded to the
// old spike/quickjs/vendor path, which would silently stop matching (and
// start hard-FAILING the existence assertion below) the moment that default
// moves off the NFS-mounted repo tree onto local scratch.
const CACERT_C = path.join(tjsVendorParentDir(), 'txiki.js/src/cacert.c');
const OUT_PEM = path.join(REPO, 'libexec/node-shim/modules/tls-cacert.pem');

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

test('cacert.c exists and is the expected txiki.js-vendored source', () => {
  assert.ok(fs.existsSync(CACERT_C), `expected ${CACERT_C} to exist — repo layout changed?`);
});

test('tls-cacert.pem is committed and NOT stale relative to cacert.c (re-run scripts/extract-cacert-pem.mjs if this fails)', () => {
  assert.ok(fs.existsSync(OUT_PEM), `${OUT_PEM} is missing — run scripts/extract-cacert-pem.mjs`);
  const src = fs.readFileSync(CACERT_C, 'utf8');
  const expected = extractPemFromCacertC(src);
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
