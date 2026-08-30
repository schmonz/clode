'use strict';
// zlib.createZstdDecompress is an INTENTIONAL, DOCUMENTED gap — this file is the
// decision, kept executable. Same shape as test/bun-shim-ant-gap.test.cjs; read that
// one first, because the reasoning is deliberately parallel and the difference between
// the two cases is the interesting part.
//
// WHAT IT IS. From Claude Code 2.1.251 the NATIVE release downloader streams
// zstd-compressed binaries: beside `var xe="https://downloads.claude.ai/claude-code-releases"`
// it does `import{createZstdDecompress as rt}from"zlib"` and then
//     await pipeline(res.data, hashTap, rt(), sizeTap, fileStream, {signal})
// on `${base}/${version}/${platform}/${file}.zst`.
//
// NOT the zstd clode already has. clode's zstd is a HOST TOOL: libexec/host-provision.cjs
// resolves a real `zstd -d -c` (KAT-verified) and libexec/bun-graph.cjs shells out to it
// at CARVE time, so a built target never needs zstd to read upstream's embedded text
// assets. This one is a streaming node:zlib Transform inside someone else's pipeline,
// and tjs has no native zlib at all (libexec/node-shim/modules/zlib.cjs: every
// compression entry point is a throwing `unimplemented`).
//
// MUST NOT BE STUBBED. A throwing stub inside `pipeline` turns "we cannot decompress"
// into a half-written binary or a destroyed stream mid-download; a no-op Transform is
// worse still — it would write the compressed bytes to the target path and only the
// checksum would notice. And there is nothing to shell out to from inside a pipeline:
// the host-tool trick that works for carving does not fit here. Absent is the faithful
// answer: upstream's own `catch` around the compressed attempt falls back to the
// uncompressed URL, which is the behaviour a host without zstd should produce.
//
// WHY ABSENT IS ACCEPTABLE IS REACHABILITY, and reachability is a fact about OTHER code
// that can change without anyone thinking about zstd. TWO INDEPENDENT WALLS stand
// between a built target and that pipeline, and this file pins BOTH:
//
//   WALL 1 — installation type can never be "native". Upstream's resolver (2.1.251 QZ)
//     returns "native" ONLY inside `if(Al())`, and `Al()` is
//     `typeof Bun<"u"&&Bun.isStandaloneExecutable===!0`. libexec/bun-shim.cjs reports
//     that false, so a target resolves "unknown" and mounts the LEGACY npm updater
//     widget, never the native one (see the comment block above patchLegacyAutoupdater
//     in libexec/extract-claude-js.cjs).
//   WALL 2 — every installer entry point is neutralized at carve time anyway: the
//     native widget is redirected to __clodeCheckUpdate, the legacy npm widget returns
//     before its install dispatch, and the manual `update` command switches on a
//     sentinel no case matches.
//
// The day EITHER wall comes down, this file goes red and the decision gets re-taken —
// which is the point, because the failure mode on the far side is not graceful: a
// download that inflates through a missing Transform does not degrade, it corrupts or
// hangs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const hostZlib = require('node:zlib');

const models = require('./oracle-models.cjs');

const REPO = path.resolve(__dirname, '..');
const shimZlib = require(path.join(REPO, 'libexec/node-shim/modules/zlib.cjs'));
const bunShim = require(path.join(REPO, 'libexec/bun-shim.cjs'));

// Derived from the RUNNING node, never transcribed: every zstd entry point real zlib
// exposes. Case-sensitive on 'Zstd' so it picks up the API (createZstdDecompress,
// ZstdDecompress, zstdDecompressSync, ...) and not the ZSTD_* constants, which the shim
// DOES carry and should keep carrying — upstream destructures them at module init.
function zstdApiNames(mod) {
  return Object.keys(mod).filter((k) => /Zstd/.test(k)).sort();
}
function present(mod, names) {
  return names.filter((k) => typeof mod[k] !== 'undefined').sort();
}

const ZSTD_API = zstdApiNames(hostZlib);

// --- the gap itself ----------------------------------------------------------

test('host node really does expose the zstd surface (else this file is measuring nothing)', () => {
  assert.ok(ZSTD_API.includes('createZstdDecompress'),
    `node ${process.version} has no createZstdDecompress; this pin's premise is gone — `
    + 'recheck what upstream imports before touching the shim');
});

test('zlib zstd stays ABSENT from the shim: not implemented, and not stubbed either', () => {
  assert.deepStrictEqual(present(shimZlib, ZSTD_API), [],
    'the node-shim\'s zlib must expose NO zstd entry point. A stub is worse than the gap: '
    + 'upstream drops createZstdDecompress() into a pipeline, so a throwing Transform '
    + 'destroys the stream mid-download and a no-op Transform writes compressed bytes to '
    + 'the target path. If this is now implemented FOR REAL (a native tjs zstd, or a JS '
    + 'decoder), delete this file rather than editing it.');
  // The ZSTD_* constants are a different thing and must survive: upstream destructures
  // them from zlib.constants at module init and would crash on undefined.
  assert.strictEqual(typeof shimZlib.constants.ZSTD_c_compressionLevel, 'number',
    'zlib.constants.ZSTD_* are NOT part of this gap and must stay present');
});

// --- WALL 1: installation type can never resolve to "native" -----------------

test('WALL 1: bun-shim reports isStandaloneExecutable false, so upstream cannot resolve "native"', () => {
  assert.notStrictEqual(bunShim.isStandaloneExecutable, true,
    'Bun.isStandaloneExecutable is now true — upstream\'s Al() gate passes, so the '
    + 'installation type can resolve to "native", the NATIVE updater widget gets mounted '
    + 'and the zstd release downloader becomes reachable. Re-take the '
    + 'zlib.createZstdDecompress decision (test/shim-surface/golden.json notes).');
});

// --- the carved-bundle half: WALL 1's upstream side, and WALL 2 --------------
// Same staging convention as test/node-shim-wall-tripwires.test.cjs: the carved,
// PATCHED cli.cjs a target actually runs. Skips without a provider; CI's node-shim
// oracle step exports CLODE_PROVIDER_BIN.

function resolveBundleSrc(env = process.env) {
  if (env.CLODE_ZSTD_GAP_BUNDLE) {
    return fs.existsSync(env.CLODE_ZSTD_GAP_BUNDLE)
      ? fs.readFileSync(env.CLODE_ZSTD_GAP_BUNDLE, 'utf8') : null;
  }
  try {
    const staged = models.stageProviderCli({ env });
    return staged && staged.cli ? fs.readFileSync(staged.cli, 'utf8') : null;
  } catch { return null; }
}

// QUOTES MUST BE MATCHED ESCAPE-BLIND, and this is not a style choice — it is the trap
// this file fell into on its first run. From 2.1.243 the staged cli.cjs is the GRAPH
// RUNNER: every module's source rides inside a JS string literal, so a carved
// `switch("clode-managed-target")` appears in the file as `switch(\\\"clode-managed-target\\\")`.
// Two of the four checks below went RED against a bundle where the wall was perfectly
// intact, purely because their patterns spelled a bare `"`. `Q` matches a quote with any
// number of backslashes in front of it, so the same pattern reads a raw module source
// and a runner-embedded one identically. The positive self-check at the bottom pins
// BOTH encodings, because "fails when absent" is only half of a working guard.
const Q = '\\\\*"';

// Each check is (name, pattern, why-it-matters), as DATA, so the mechanism self-checks
// below run the SAME patterns they claim to verify.
const CARVED_CHECKS = [
  {
    name: 'WALL 1 (upstream side): the native installation type is still gated on Bun.isStandaloneExecutable',
    pattern: /Bun\.isStandaloneExecutable===!0/,
    why: 'upstream no longer gates the "native" installation type on '
      + 'Bun.isStandaloneExecutable, so bun-shim reporting it false no longer keeps a '
      + 'target off the native updater. WALL 1 is gone as written; re-derive it.',
  },
  {
    name: 'WALL 2a: the native autoupdater is redirected to the notify-only check',
    pattern: new RegExp('globalThis\\.__clodeCheckUpdate\\(' + Q),
    why: 'patchNativeAutoupdater/patchAutoupdater no longer applied to this bundle '
      + '(their anchors are fail-loud-skip, so a build stays GREEN while the in-TUI '
      + 'installer runs live). The native updater is the direct caller of the zstd '
      + 'release downloader.',
  },
  {
    name: 'WALL 2b: the legacy npm autoupdater returns before its install dispatch',
    pattern: /AutoUpdater: install skipped: this binary is managed by clode \(notify-only\)/,
    why: 'patchLegacyAutoupdater no longer applied — this is the widget a target '
      + 'ACTUALLY mounts (installation type "unknown"), and unpatched it installs '
      + 'upstream over the binary clode owns.',
  },
  {
    name: 'WALL 2c: the manual `update` command switches on a sentinel no case matches',
    pattern: new RegExp('switch\\(' + Q + 'clode-managed-target' + Q + '\\)'),
    why: 'patchManualUpdate no longer applied — `quaude update` reaches the installer '
      + 'dispatch again, the second way a target installs upstream over itself.',
  },
];

const BUNDLE_SRC = resolveBundleSrc();
const SKIP_REASON = 'no upstream bundle available locally — set CLODE_PROVIDER_BIN to a '
  + 'real claude binary (or run where clode has already resolved a provider); see '
  + 'test/oracle-models.cjs';

for (const check of CARVED_CHECKS) {
  test(`zstd gap: ${check.name}`, (t) => {
    if (!BUNDLE_SRC) { t.skip(SKIP_REASON); return; }
    assert.ok(check.pattern.test(BUNDLE_SRC),
      `zstd-gap wall FIRED — ${check.why}\n`
      + '  Consequence: upstream\'s NATIVE release downloader becomes reachable, and it '
      + 'pipes a .zst download through createZstdDecompress(), which the node-shim does '
      + 'not provide and deliberately does not stub.\n'
      + '  Re-take the decision recorded in test/shim-surface/golden.json '
      + '(zlib.createZstdDecompress) and in this file\'s header.');
  });
}

// Mechanism self-check — always runs, needs no bundle. Proves each pattern actually
// discriminates, so a green run above means "the wall is up", not "the pattern never
// matched anything". This is the half that was missing from the gates this repo has
// been repairing all week.
test('zstd gap mechanism: every wall pattern FAILS on a body with the walls down', () => {
  // A carve with none of the neutralizations and no standalone gate: what the bundle
  // looks like the day either wall comes down.
  const wallsDown = 'async function QZ(){if(yT())return"native";return"unknown"}'
    + 'M("tengu_native_auto_updater_start",{});try{let S=await zmt(d),w={VERSION:"9.9.9"};'
    + 'if(L(`AutoUpdater: Detected installation type: ${x}`),x==="development"){return}'
    + 'switch(r.installationType){case"npm-local":c=!0;break}';
  for (const check of CARVED_CHECKS) {
    assert.ok(!check.pattern.test(wallsDown),
      `${check.name}: pattern matched a body where the wall is DOWN — it cannot fail, so `
      + 'it is not a guard');
  }
});

test('zstd gap mechanism: every wall pattern MATCHES both the raw and the runner-escaped carve', () => {
  // The raw module source (what graph.json's `sources` hold) and the same bytes as they
  // appear inside the graph RUNNER's string literals (what the staged cli.cjs holds).
  // A pattern that reads only one of these is the bug this check exists to prevent.
  const raw = 'function VI(){return typeof Bun<"u"&&Bun.isStandaloneExecutable===!0}'
    + 'globalThis.__clodeCheckUpdate("2.1.251");'
    + 's("AutoUpdater: install skipped: this binary is managed by clode (notify-only)"),t(!1);return;'
    + 'switch("clode-managed-target"){case"npm-local":p=!0;break}';
  const runnerEscaped = JSON.stringify(JSON.stringify(raw));
  for (const check of CARVED_CHECKS) {
    assert.ok(check.pattern.test(raw), `${check.name}: pattern does not match the RAW carve`);
    assert.ok(check.pattern.test(runnerEscaped),
      `${check.name}: pattern does not match the runner-ESCAPED carve — it would report the `
      + 'wall down against a bundle where it is up (measured: exactly that, 2026-08-29)');
  }
});

test('zstd gap mechanism: the absence check FAILS on a stubbed zlib', () => {
  const stubbed = { ...shimZlib, createZstdDecompress: () => { throw new Error('nope'); } };
  assert.deepStrictEqual(present(stubbed, ZSTD_API), ['createZstdDecompress'],
    'the gap check must notice a stub — if it cannot see one, it is not a guard');
});

module.exports = { CARVED_CHECKS, zstdApiNames, resolveBundleSrc };
