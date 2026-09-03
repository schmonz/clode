'use strict';
// ONE way for tests to find a Claude Code provider, and ONE way to say so when they
// cannot.
//
// Why this exists: provider-gated tests are the largest dark surface in this suite —
// 43 of 84 skips at the time this was written. They were dark for several DIFFERENT
// reasons wearing the same clothes ("no provider"), and at least one file
// (test/inspect.test.cjs) gated on a HARDCODED version, 2.1.183, that is neither
// present on any current box nor the version UPSTREAM_PIN names. A test pinned to an
// artifact nobody has has not been skipping — it has been absent.
//
// The chain below is the product's own resolution first, then the fixture stores,
// so a box that can build can prove it. Order matters: explicit env beats the
// resolver beats the fixture store, because an operator who names a provider means it.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');

// Memoised per env object: resolution shells out, and a test file that asks twice
// should not pay twice (nor print twice).
const _cache = new WeakMap();

// Every provider this box can see, best first, deduped, existence-checked.
function providers(env = process.env) {
  const hit = _cache.get(env);
  if (hit) return hit;
  const list = _providers(env);
  _cache.set(env, list);
  return list;
}

function _providers(env) {
  const found = [];
  const seen = new Set();
  const add = (p) => {
    if (p && !seen.has(p) && fs.existsSync(p)) { seen.add(p); found.push(p); }
  };

  add(env.CLODE_PROVIDER_BIN);
  add(env.CLODE_CLAUDE_BIN);

  // UPSTREAM_PIN's version, BEFORE the product's ambient resolver. This ordering is
  // load-bearing and was wrong on the first cut: resolveClaudeBin() returns whatever
  // this box last happened to cache (2.1.252 here), while UPSTREAM_PIN names the
  // version this project actually supports and CI installs (2.1.251). Preferring the
  // ambient one silently tested a version nobody declared — 25 failures, all from
  // running against an unsupported provider. `dev-box-state-hides-bugs`: the declared
  // pin beats whatever is lying around.
  //
  // Read from the file, never written here — a second hardcoded version string is how
  // the 2.1.183 problem in test/inspect.test.cjs happened.
  try {
    const pin = fs.readFileSync(path.join(REPO, 'UPSTREAM_PIN'), 'utf8')
      .split('\n').map((l) => l.match(/^claude-code (.+)$/)).find(Boolean);
    if (pin) {
      const home = env.HOME || require('node:os').homedir();
      add(path.join(home, '.local', 'share', 'clode', 'providers', pin[1].trim(), 'claude'));
    }
  } catch { /* no pin file, or unreadable */ }

  // The product's OWN resolver. Without this a local run sees only fixture stores and
  // never exercises what `clode build` would actually pick.
  try { add(require('../libexec/clode-resolve.cjs').resolveClaudeBin(env)); } catch { /* none */ }

  try {
    // stderr ignored on purpose: find-provider prints a multi-line diagnostic when it
    // finds nothing, and that is NOT this helper's news to deliver — skipReason() says
    // where we looked, once, instead of every caller dumping the same paragraph.
    add(execFileSync(process.execPath, [path.join(REPO, 'scripts', 'find-provider.mjs')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { /* absence is reported by skipReason, not thrown */ }

  try {
    const { VERSIONS, providerBin } = require('./golden-shas-lib.cjs');
    for (const v of VERSIONS) add(providerBin(v));
  } catch { /* fixture lib unavailable */ }

  return found;
}

// The first usable provider, or null.
function providerBin(env = process.env) {
  return providers(env)[0] || null;
}

// A skip reason that names WHERE we looked, or false when one was found. Returning a
// string (never a bare boolean) is deliberate: node:test renders `{ skip: true }` as
// "# SKIP" with no reason, and a skip that cannot say what it wanted is
// indistinguishable from one that is hiding something.
function skipReason(env = process.env) {
  if (providers(env).length) return false;
  return 'no Claude provider found. Looked at: CLODE_PROVIDER_BIN, CLODE_CLAUDE_BIN, '
    + "libexec/clode-resolve.cjs's resolveClaudeBin, scripts/find-provider.mjs, "
    + 'UPSTREAM_PIN\'s pinned version under ~/.local/share/clode/providers/, and the '
    + 'golden-shas fixture store. Set CLODE_PROVIDER_BIN=<path to a claude binary> to run this.';
}

module.exports = { providers, providerBin, skipReason, REPO };
