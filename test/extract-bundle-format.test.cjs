'use strict';
// THE BUNDLE-FORMAT GATE — "can clode still carve the bundle at all?"
//
// Every other extractor test asks whether a PATCH still anchors inside the carved
// JS. This one asks the question underneath: is there still a single CommonJS
// entry module to carve? Upstream can answer no without changing one line here,
// and did — Claude Code 2.1.243 turned on Bun code splitting + on-demand loading,
// so the standalone module graph went from 15 modules (entry = ONE 28,252,477-byte
// `// @bun @bytecode @bun-cjs` block) to 1391 modules, 1383 of them bare ESM
// (`// @bun @bytecode`, no CJS wrapper) wired by
// `from"/$bunfs/root/chunk-<hash>.js"` imports. `clode build` broke for every user
// on every platform, native and cross.
//
// Two layers, same doctrine as test/regression.test.cjs:
//
//   1. SELF-CONTAINED (always runs): synthetic bundles in BOTH shapes prove the
//      extractor (a) still carves the CJS shape and (b) recognizes the split-ESM
//      shape and refuses it BY NAME. These would not have caught 2.1.243 on their
//      own — they are the ratchet that keeps the diagnosis honest once it exists.
//
//   2. REAL PROVIDER (skips when absent): carve the provider this checkout would
//      actually build against. This IS the check that catches an upstream format
//      change, and it is deliberately a HARD failure, not a skip, whenever a
//      provider is present: "we could not check" is not "nothing changed".
//
// WHERE THE DURABLE TRIPWIRE BELONGS (not fixable from here — scripts/ is
// off-limits to this change): `npm test` installs no provider, so layer 2 skips in
// the suite job. The daily attributed check is scripts/upstream-drift-check.mjs,
// and on 2.1.243 it reported "OK — all 5 anchors present" while the extractor was
// dead, because libexec/inspect-claude-bundle.cjs scans the WHOLE binary for its
// anchors and 2.1.243 still contains all that JS as plain text — just in 1383
// chunks nobody can carve into one file. That job needs one more assertion: its
// own `inspect --json` output already carries `bun_cjs_blocks`, so requiring an
// entry whose name ends `entrypoints/cli.js` turns this failure class into an
// attributed daily red light.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const { carveBlocks } = require(path.join(REPO, 'libexec', 'bundle-carve.cjs'));
const { describeBundleFormat, pickEntry, extractToFile } =
  require(path.join(REPO, 'libexec', 'extract-claude-js.cjs'));

const NUL = '\x00';
const MIN_OUTPUT_BYTES = 1000000; // must match libexec/extract-claude-js.cjs

// ---- synthetic providers ----------------------------------------------------

// The shape clode has always carved (<= 2.1.241): ONE @bun-cjs module named
// .../entrypoints/cli.js, big enough to clear the extractor's size floor and
// carrying a sentinel token so contentChecks() passes.
function cjsProvider() {
  const filler = 'x'.repeat(MIN_OUTPUT_BYTES + 64);
  return 'PADDING' + NUL
    + '/$bunfs/root/src/entrypoints/cli.js' + NUL
    + '// @bun @bytecode @bun-cjs\n'
    + '(function(exports, require, module, __filename, __dirname) {'
    + `\n/* ${filler} commander @anthropic-ai/claude-code */\n`
    + 'module.exports={};\n'
    + '})' + NUL + 'TRAILER' + NUL;
}

// The 2.1.243 shape: bare ESM modules (no CJS wrapper) addressed by
// /$bunfs/root/chunk-<hash>.js, static + dynamic imports, and an entry module that
// is nothing but imports. Reproduced from the real graph, not invented: the marker
// line, the specifier form, the `// Version:` line and the `export{local as Name}`
// tail are all verbatim shapes from darwin-arm64 2.1.243.
// Bun's own format-template strings, which live in the compiled binary's string
// table and are what carveBlocks actually finds in a 2.1.243 provider: two stray
// @bun-cjs "blocks" with no module name and no CLI in them (665 and 588 bytes in
// the real darwin-arm64 2.1.243). They are why the real failure took the "no block
// named entrypoints/cli.js" branch rather than the "no marker at all" branch —
// reproduce them so this fixture fails exactly the way the real binary does.
function bunTemplateStrings() {
  const wrapper = '(function(exports, require, module, __filename, __dirname) {';
  return '__toESM__require' + NUL + NUL
    + '// @bun @bytecode @bun-cjs\n' + wrapper
    + '// @bun @bun-cjs\n' + wrapper
    + '// @bun @bytecode\n"use strict";\n(() => {\n((()=>{/* //  (})();})();\n})\n}, {\n'
    + '  main: __reExportinfallible: VecWriter never errors' + NUL;
}

function splitEsmProvider(version = '2.1.243') {
  const chunk = (hash, body) =>
    '/$bunfs/root/chunk-' + hash + '.js' + NUL + '// @bun @bytecode\n' + body + NUL;
  return 'PADDING' + NUL
    + bunTemplateStrings()
    + chunk('aaaa1111', 'function r(){return 1}export{r as Emd};')
    + chunk('bbbb2222', 'function s(){return 2}export{s as Fmd};')
    + '/$bunfs/root/src/entrypoints/cli.js' + NUL
    + '// @bun @bytecode\n'
    + `// Version: ${version}\n`
    + 'import{Emd as ct}from"/$bunfs/root/chunk-aaaa1111.js";'
    + 'async function kt(){let{Fmd:ot}=await import("/$bunfs/root/chunk-bbbb2222.js");return ct()+ot()}kt();'
    + NUL + 'TRAILER' + NUL;
}

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-fmt-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function writeProvider(dir, data) {
  const p = path.join(dir, 'claude');
  fs.writeFileSync(p, Buffer.from(data, 'latin1'));
  return p;
}

// ---- layer 1: the two shapes, self-contained --------------------------------

test('the pre-2.1.243 single-CJS-module shape still carves and extracts', () => {
  withTmp((dir) => {
    const bin = writeProvider(dir, cjsProvider());
    const out = path.join(dir, 'cli.cjs');
    const res = extractToFile(bin, out);
    assert.strictEqual(res.name, '/$bunfs/root/src/entrypoints/cli.js');
    assert.ok(res.bytes > MIN_OUTPUT_BYTES, `carved ${res.bytes} bytes`);
    assert.ok(fs.existsSync(out), 'wrote cli.cjs');
  });
});

test('the carvable shape is NOT diagnosed as split-ESM (no false positive)', () => {
  assert.strictEqual(describeBundleFormat(cjsProvider()), null);
});

test('a split-ESM bundle is named, versioned, and counted in the refusal', () => {
  const shape = describeBundleFormat(splitEsmProvider());
  assert.ok(shape, 'split-ESM bundle recognized');
  assert.match(shape, /Bun CODE-SPLIT ESM bundle \(Claude Code 2\.1\.243\)/);
  assert.match(shape, /4 bare `\/\/ @bun @bytecode` modules/);
  assert.match(shape, /1 static `from"\/\$bunfs\/root\/chunk-\*\.js"` imports/);
  assert.match(shape, /1 dynamic `import\(\.\.\.\)` calls/);
  assert.match(shape, /NO CommonJS entry module/);
  assert.match(shape, /needs an ESM relinker, not a carve/);
});

test('extracting a split-ESM bundle FAILS LOUDLY and writes nothing', () => {
  withTmp((dir) => {
    const bin = writeProvider(dir, splitEsmProvider());
    const out = path.join(dir, 'cli.cjs');
    assert.throws(() => extractToFile(bin, out), (e) => {
      // The refusal is preserved verbatim (this is the branch the REAL 2.1.243
      // takes: stray @bun-cjs template blocks exist, none is the entry); the
      // diagnosis is ADDED to it, never substituted for it.
      assert.match(e.message, /no block named entrypoints\/cli\.js/);
      assert.match(e.message, /Refusing to guess\./);
      assert.match(e.message, /Bun CODE-SPLIT ESM bundle/);
      return true;
    });
    // A bad carve must never reach disk — a subtly broken quaude is worse than a
    // loud failure (the whole reason pickEntry refuses to guess).
    assert.ok(!fs.existsSync(out), 'no partial cli.cjs left behind');
  });
});

test('the diagnosis rides BOTH refusal branches, incl. no-marker-at-all', () => {
  withTmp((dir) => {
    // Same graph without Bun's stray format-template strings: carveBlocks finds
    // zero blocks, so pickEntry throws its other message. Both must be diagnosed.
    const noStrays = splitEsmProvider().replace(bunTemplateStrings(), '');
    const bin = writeProvider(dir, noStrays);
    assert.throws(() => extractToFile(bin, path.join(dir, 'cli.cjs')), (e) => {
      assert.match(e.message, /no Bun @bun-cjs entry marker found/);
      assert.match(e.message, /Bun CODE-SPLIT ESM bundle/);
      return true;
    });
  });
});

test('both signals are required — neither alone trips the diagnosis', () => {
  // Bare-ESM markers with no chunk specifiers: 2.1.241 has exactly this (one
  // `// @bun @bytecode` module in the Bun runtime prelude, zero chunk specifiers).
  const markersOnly = 'a' + NUL + '// @bun @bytecode\nX' + NUL
    + 'b' + NUL + '// @bun @bytecode\nY' + NUL;
  assert.strictEqual(describeBundleFormat(markersOnly), null);
  // Chunk specifiers with no bare-ESM modules.
  const specsOnly = 'a' + NUL + 'from"/$bunfs/root/chunk-aaaa1111.js"' + NUL;
  assert.strictEqual(describeBundleFormat(specsOnly), null);
});

// ---- layer 2: the real provider ---------------------------------------------

// Explicit env first (the CI oracle jobs set CLODE_PROVIDER_BIN), then whatever
// `clode build` would resolve on this box. Returns null only when there is
// genuinely no provider to check.
function realProvider() {
  for (const v of [process.env.CLODE_PROVIDER_BIN, process.env.CLODE_CLAUDE_BIN]) {
    if (v && fs.existsSync(v)) return v;
  }
  try {
    const p = execFileSync(process.execPath,
      [path.join(REPO, 'scripts', 'find-provider.mjs')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return p && fs.existsSync(p) ? p : null;
  } catch (e) { return null; }
}

test('the installed provider still carves to a single entrypoints/cli.js module', (t) => {
  const bin = realProvider();
  if (!bin) {
    t.skip('no provider (set CLODE_PROVIDER_BIN, or npm i -g @anthropic-ai/claude-code)');
    return;
  }
  const data = fs.readFileSync(bin, 'latin1');
  const blocks = carveBlocks(data);
  let entry;
  try {
    entry = pickEntry(blocks);
  } catch (e) {
    const shape = describeBundleFormat(data);
    // Fail with the diagnosis inline: this test's product is a usable answer to
    // "what did upstream do to us", not just a red mark.
    assert.fail(`${bin}\n  ${e.message}` + (shape ? `\n  ${shape}` : ''));
  }
  assert.ok(entry.body.length > MIN_OUTPUT_BYTES,
    `entry module is only ${entry.body.length} bytes — the CLI is no longer in one module`);
  // Prove it is the CLI, not merely the biggest thing present.
  assert.ok(entry.body.includes('commander') || entry.body.includes('@anthropic-ai/claude-code'),
    'carved entry carries a Claude Code sentinel token');
  assert.strictEqual(describeBundleFormat(data), null,
    'a carvable provider must not also look like a split-ESM graph');
});
