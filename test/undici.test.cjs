const { test } = require('node:test');
const assert = require('node:assert');
globalThis.Bun = require('../libexec/bun-shim.cjs'); // installs the Module._load hook
test('require("undici") resolves and the proxy-setup path never throws', () => {
  const undici = require('undici');
  assert.ok(undici, 'undici require returned falsy');
  assert.doesNotThrow(() => {
    undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({ httpProxy: 'http://p:1', httpsProxy: 'http://p:1', noProxy: '' }));
  });
  assert.doesNotThrow(() => { undici.setGlobalDispatcher(new undici.ProxyAgent('http://p:1')); });
  const { setGlobalDispatcher, EnvHttpProxyAgent } = undici; // destructured use
  assert.doesNotThrow(() => setGlobalDispatcher(new EnvHttpProxyAgent({})));
});
