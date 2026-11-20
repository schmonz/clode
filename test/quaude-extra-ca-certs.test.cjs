'use strict';
// NODE_EXTRA_CA_CERTS under a built quaude (libexec/quaude-bootstrap.mjs extraCaBundle / applyExtraCaCerts): the
// engine trusts ONE bundle, so the extra file's certificates are appended to the compiled-in roots, never put in their
// place (node's and Bun's NODE_EXTRA_CA_CERTS ADD to the roots). Driven end to end by test/fidelity/webfetch.test.cjs,
// whose target only NODE_EXTRA_CA_CERTS makes trusted.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'libexec', 'quaude-bootstrap.mjs')).href);
const cert = (b) => `-----BEGIN CERTIFICATE-----\n${b}\n-----END CERTIFICATE-----`;

test('extraCaBundle appends the extra certificates to the roots, keeping every root', async () => {
  const { extraCaBundle } = await load();
  const roots = `# roots\n${cert('ROOT1')}\n\n${cert('ROOT2')}\n`;
  const out = extraCaBundle(roots, `junk before\n${cert('EXTRA1')}\ntext between\n${cert('EXTRA2')}\n`);
  assert.strictEqual(out, `# roots\n${cert('ROOT1')}\n\n${cert('ROOT2')}\n${cert('EXTRA1')}\n${cert('EXTRA2')}\n`);
});

test('extraCaBundle is null when the extra file has no certificate, or there are no roots to add to', async () => {
  const { extraCaBundle } = await load();
  assert.strictEqual(extraCaBundle(cert('ROOT'), 'not a pem'), null);
  assert.strictEqual(extraCaBundle(cert('ROOT'), ''), null);
  assert.strictEqual(extraCaBundle('', cert('EXTRA')), null);
});
