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

// DETERMINISTIC SELECTION. Everything below answers one question: which provider does
// THIS suite run use? The answer must not depend on what is on PATH, what a previous
// build happened to cache, or which env var was set moments earlier.
//
// It used to. Measured 2026-09-03: with CLODE_STATE_ROOT pointed at a fresh tmpdir --
// which test/run.mjs does, on purpose, for isolation -- the product resolver fell
// through to PATH and selected ~/.local/share/claude/versions/2.1.260, NINE versions
// past the pin, on a box whose store also held 2.1.210/215/218/251/252. Two machines
// would have tested two different products and neither would have said so.
//
// So: the clode-managed store only, capped at UPSTREAM_PIN, ordered by version. No
// PATH, no `current` pointer, no most-recently-cached. An explicit env var still wins,
// because an operator who names a provider means it.
function storeDir(env) {
  const home = env.HOME || require('node:os').homedir();
  return path.join(home, '.local', 'share', 'clode', 'providers');
}

// Memoised per env object: selection reads the filesystem, and a test file that asks
// twice should not pay twice.
const _cache = new WeakMap();

function providers(env = process.env) {
  const hit = _cache.get(env);
  if (hit) return hit;
  const list = _providers(env);
  _cache.set(env, list);
  return list;
}

// Every provider this box can see, best first, deduped, existence-checked.
function _providers(env) {
  const found = [];
  const seen = new Set();
  const add = (p) => {
    if (p && !seen.has(p) && fs.existsSync(p)) { seen.add(p); found.push(p); }
  };

  // An operator's explicit choice, first and unconditional -- not pin-capped, because
  // naming a provider is how you deliberately test an unpinned one.
  add(env.CLODE_PROVIDER_BIN);
  add(env.CLODE_CLAUDE_BIN);

  // THE PINNED VERSION, EXACTLY. Not "the newest at or below the pin" -- that still
  // varies with whatever a given box happens to have in its store, which is the wobble
  // this is here to remove. UPSTREAM_PIN names one version; every machine tests that
  // one, or says why it cannot.
  //
  // EVERY CARVE THE PIN HAS, not one path. Since spec 2026-09-14 §7.1 the store is
  // providers/<ver>/<os>-<arch>/claude, so one version legitimately holds several entries
  // and a test that wants a SPECIFIC platform's carve (providerBinFor, below) can now
  // actually find one that is not this host's. Before the key had that dimension there was
  // one path per version and nothing to enumerate.
  //
  // rekeyLegacyEntry FIRST, through the PRODUCT's own migration rather than a second copy of
  // it here: a box whose store predates the change still holds providers/<pin>/claude, and a
  // harness that quietly reached for the old path would keep the suite running against an
  // entry whose platform the path cannot state -- which is the whole defect.
  const pin = pinnedVersion();
  if (pin) {
    try { require('../libexec/clode-current.cjs').rekeyLegacyEntry(env, pin); } catch { /* best effort */ }
    let keys = [];
    try {
      keys = fs.readdirSync(path.join(storeDir(env), pin), { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch { /* no entries for the pin */ }
    // This host's own carve first, so providerBin() (the "any provider" answer) is the one a
    // build here would actually use; the rest follow for providerBinFor's sake.
    const mine = require('../libexec/clode-paths.cjs').pickProviderEntry(keys);
    for (const k of (mine ? [mine, ...keys.filter((x) => x !== mine)] : keys)) {
      add(path.join(storeDir(env), pin, k, 'claude'));
    }
    // A store the migration could not re-key (unidentifiable container, or an unwritable
    // store) still has to be USABLE -- just never mistakable for a known platform. Last,
    // so it can never displace a keyed entry.
    add(path.join(storeDir(env), pin, 'claude'));
  }

  return found.filter(isBunContainer);
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


// Is this path an actual Bun container, or just something named like one?
//
// On Windows `npm i -g @anthropic-ai/claude-code` leaves an EXTENSIONLESS shell wrapper
// at <prefix>/claude next to the real executable. Handing that to a tool that expects a
// Bun binary produces a confident, wrong diagnosis about the BINARY's format -- on
// 2026-09-03 it briefly convinced us that scripts/make-min-provider.cjs could not carve
// win32 providers, which the same CI run disproved by minimising a real 217MB win32
// provider to 43MB in an earlier step.
//
// The check is the trailer, which is what actually makes a file a Bun container --
// never the filename, the extension, or the platform.
function isBunContainer(binpath) {
  try {
    const { TRAILER } = require('../libexec/bun-graph.cjs');
    return fs.readFileSync(binpath, 'latin1').lastIndexOf(TRAILER) >= 0;
  } catch { return false; }
}


// A provider carved FOR a given platform, or null.
//
// Some tests need a provider from a SPECIFIC platform rather than any provider: the
// darwin-carve check (test/node-shim-agentic.test.cjs) asserts a darwin-carved bundle takes
// the macOS managed-settings branch, which only means anything against a darwin carve. The
// platform of a PROVIDER is not the platform of this HOST -- this Mac's store holds linux
// carves at 2.1.207/210/211/215/243 -- so this asks the BYTES (providerPlatformOf) and not
// process.platform, and not the path either.
//
// WHY THE BYTES, NOW THAT THE PATH SAYS IT TOO. Since spec 2026-09-14 §7.1 the store key
// carries version x platform x arch, so `providers/<pin>/macos-arm64/claude` is a claim the
// path makes -- and a claim is not the thing. The bytes are what Bun folded the platform
// into, they are what the build's own carve gate reads (libexec/clode-build.cjs, via the same
// providerPlatformOf), and a store entry can be replaced by hand. Asking the container costs
// a 16-byte read.
//
// Never substitutes a different VERSION to satisfy the platform. Reaching for a
// nearer-matching version would trade a loud, honest "no darwin carve at the pin" for a
// quiet "tested something else", which is how the darwin check silently ran against 2.1.252
// and failed on the SCC break the pin exists to avoid.
function providerBinFor(platform, env = process.env) {
  const { providerPlatformOf } = require('../libexec/extract-claude-js.cjs');
  for (const p of providers(env)) {
    try { if (providerPlatformOf(p) === platform) return p; } catch { /* unreadable: not a candidate */ }
  }
  return null;
}

// Why no provider carved for `platform` is available -- names the pin, what the pinned
// carve actually IS, and how to get the right one.
function platformSkipReason(platform, env = process.env) {
  if (providerBinFor(platform, env)) return false;
  const { providerPlatformOf } = require('../libexec/extract-claude-js.cjs');
  const pin = pinnedVersion();
  const have = providers(env).map((p) => {
    let plat = 'unreadable';
    try { plat = String(providerPlatformOf(p)); } catch { /* keep 'unreadable' */ }
    return `${path.basename(path.dirname(p))}=${plat}`;
  });
  return `no ${platform}-carved provider. UPSTREAM_PIN names ${pin || '(unset)'}; `
    + `available: ${have.join(', ') || '(none)'}. The store is keyed by version x platform x `
    + `arch (providers/<ver>/<os>-<arch>/claude), so this is an honest absence and not an `
    + `entry hiding behind an ambiguous path — fetch a ${platform} carve at `
    + `${pin || 'the pin'} (CLODE_FETCH_PLATFORM=${platform}-<arch> clode fetch claude `
    + `${pin || '<version>'}) or set CLODE_${platform.toUpperCase()}_PROVIDER_BIN explicitly.`;
}

// UPSTREAM_PIN names the newest version this project supports. A provider NEWER than it
// is not "a slightly different provider" -- it is one we have deliberately not absorbed
// yet, and handing one to a test produces a failure that looks like the test's subject
// and is not.
//
// Measured: wiring the darwin-carve check to "the first darwin provider" picked 2.1.252,
// which fails with `compiling __clode-scc-2.js failed: invalid property name` -- the very
// SCC-merge break the pin exists to sequence away. The test looked broken; the input was.
// 2.1.218 is also darwin, predates the break, and is what this now selects.
//
// Version compare is numeric-by-segment, not lexicographic: '2.1.9' must not sort above
// '2.1.10'.
function newerThanPin(binPath) {
  const pin = pinnedVersion();
  if (!pin) return false;
  const m = /providers[\\/](\d+(?:\.\d+)*)[\\/]/.exec(binPath);
  if (!m) return false;              // not from the versioned store: cannot tell, do not exclude
  return cmpVersion(m[1], pin) > 0;
}

function pinnedVersion() {
  try {
    const line = fs.readFileSync(path.join(REPO, 'UPSTREAM_PIN'), 'utf8')
      .split('\n').map((l) => l.match(/^claude-code (.+)$/)).find(Boolean);
    return line ? line[1].trim() : null;
  } catch { return null; }
}

function cmpVersion(a, b) {
  const A = a.split('.').map(Number), B = b.split('.').map(Number);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

module.exports = { providers, providerBin, providerBinFor, platformSkipReason, skipReason, isBunContainer, pinnedVersion, cmpVersion, REPO };
