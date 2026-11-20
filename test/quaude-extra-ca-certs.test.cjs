'use strict';
// NODE_EXTRA_CA_CERTS under a built quaude (libexec/quaude-bootstrap.mjs extraCaBundle / applyExtraCaCerts): the
// engine trusts ONE bundle, so the extra file's certificates are appended to the compiled-in roots, never put in their
// place (node's and Bun's NODE_EXTRA_CA_CERTS ADD to the roots). Each block must pass the engine's own parser first:
// the engine's fetch client refuses the WHOLE bundle when any block fails, which would end every HTTPS request
// (security review, 2026-11-20). The rows here inject the parser; test/tjs-tls-trust.test.cjs runs the real
// one in the built engine, and test/fidelity/webfetch.test.cjs drives the whole path, whose target only
// NODE_EXTRA_CA_CERTS makes trusted.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'libexec', 'quaude-bootstrap.mjs')).href);
const cert = (b) => `-----BEGIN CERTIFICATE-----\n${b}\n-----END CERTIFICATE-----`;
const acceptAll = () => undefined;

test('extraCaBundle appends the extra certificates to the roots, keeping every root', async () => {
  const { extraCaBundle } = await load();
  const roots = `# roots\n${cert('ROOT1')}\n\n${cert('ROOT2')}\n`;
  const out = extraCaBundle(roots, `junk before\n${cert('EXTRA1')}\ntext between\n${cert('EXTRA2')}\n`, acceptAll);
  assert.deepStrictEqual(out, {
    bundle: `# roots\n${cert('ROOT1')}\n\n${cert('ROOT2')}\n${cert('EXTRA1')}\n${cert('EXTRA2')}\n`, dropped: [],
  });
});

test('extraCaBundle keeps the roots and the good certificate, and drops one the engine cannot parse', async () => {
  const { extraCaBundle } = await load();
  const roots = `# roots\n${cert('ROOT1')}\n`;
  const parseError = (block) => (block.includes('ED25519') ? 'mbedtls -0x3c80: PK - Unknown key algorithm' : undefined);
  const out = extraCaBundle(roots, `${cert('GOOD')}\n${cert('ED25519')}\n`, parseError);
  assert.deepStrictEqual(out, {
    bundle: `# roots\n${cert('ROOT1')}\n${cert('GOOD')}\n`, dropped: ['mbedtls -0x3c80: PK - Unknown key algorithm'],
  });
  // A parser that throws drops the block too, never the bundle.
  const throwing = (block) => { if (block.includes('ED25519')) throw new Error('boom'); };
  assert.deepStrictEqual(extraCaBundle(roots, `${cert('GOOD')}\n${cert('ED25519')}\n`, throwing),
    { bundle: `# roots\n${cert('ROOT1')}\n${cert('GOOD')}\n`, dropped: ['boom'] });
});

test('extraCaBundle has no bundle when no certificate is kept, or there are no roots to add to', async () => {
  const { extraCaBundle } = await load();
  assert.deepStrictEqual(extraCaBundle(cert('ROOT'), 'not a pem', acceptAll), { bundle: null, dropped: [] });
  assert.deepStrictEqual(extraCaBundle(cert('ROOT'), '', acceptAll), { bundle: null, dropped: [] });
  assert.deepStrictEqual(extraCaBundle('', cert('EXTRA'), acceptAll), { bundle: null, dropped: [] });
  assert.deepStrictEqual(extraCaBundle(cert('ROOT'), cert('BAD'), () => 'bad'), { bundle: null, dropped: ['bad'] });
});
