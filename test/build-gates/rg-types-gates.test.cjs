'use strict';
// rg-types-fresh: scripts/gen-rg-types.cjs's --check verdict (staleness) over libexec/rg-types.cjs's
// GENERATED region, against the pinned native's own embedded rg: its `--type-list` (the type table quaude's
// rg selects --type with, RG-TYPE) and its `--version` (RG-VERSION: the bundle's first-use probe reads it).
// An upstream bump whose embedded rg adds or changes a type, or its version, fails HERE, naming what moved.
// The provider is pin-exact, so a native whose embedded rg is not the one the region was generated from IS
// such a bump: a finding saying to regenerate, never a skip. The generator itself refuses unless quaude's
// rg would print exactly what that native printed (--type-list and --version, the simd lines by rg's rule
// for the native's architecture). Control: a planted difference, run through the generator's OWN
// staleness(), which must name it.
//
// The literal relative requires below are load-bearing for the production-gate population sweep
// (test/guards-population.cjs), which derives "which guard controls this production gate" from them.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert');
const { defineGuard, guardTests } = require('../guard.cjs');
const gen = require('../../scripts/gen-rg-types.cjs');
const { providerBin } = require('../provider-resolve.cjs');
const { nativeRgVersion } = require('../../scripts/lib/rg-probe.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const TARGET = path.join(REPO, 'libexec', 'rg-types.cjs');

// The rg version line the generated region names, or the problem that stops it being read (a finding).
function typesHeader(src) {
  const m = src.match(/const RG_TYPES_DATA = (\{.*\});\n/);
  if (!m) return { problem: 'libexec/rg-types.cjs has no generated `const RG_TYPES_DATA = {...};` line: the region is missing or reshaped' };
  try {
    const d = JSON.parse(m[1]);
    if (!d.header || typeof d.header.rg !== 'string' || !d.header.rg) return { problem: 'libexec/rg-types.cjs\'s RG_TYPES_DATA header names no rg version' };
    if (!Array.isArray(d.types) || !d.types.length) return { problem: 'libexec/rg-types.cjs\'s RG_TYPES_DATA holds no types' };
    return { rg: d.header.rg };
  } catch (e) { return { problem: `libexec/rg-types.cjs's RG_TYPES_DATA does not parse: ${e.message}` }; }
}
function versionProblem(generatedFrom, nativeVersionText) {
  const pinned = String(nativeVersionText).split('\n')[0];
  return pinned === generatedFrom ? null
    : `regenerate: libexec/rg-types.cjs was generated from ${generatedFrom}, the pinned native's rg is ${pinned}`;
}

guardTests(defineGuard({
  name: 'rg-types-fresh',
  read: () => {
    const current = fs.readFileSync(TARGET, 'utf8');
    const { rg, problem } = typesHeader(current);
    if (problem) return { problem };
    const bin = providerBin(process.env);
    if (!bin) return { skip: `no native provider (CLODE_PROVIDER_BIN or the pinned version): libexec/rg-types.cjs was generated from ${rg}` };
    const v = nativeRgVersion(bin);
    if (!v) return { skip: `the provider ${bin} did not answer as rg here` };
    const moved = versionProblem(rg, v);
    if (moved) return { problem: moved };
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'gen-rg-types.cjs'), '--native', bin, '--emit'],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) return { problem: `gen-rg-types.cjs --emit failed (exit ${r.status}): ${(r.stderr || '').slice(-1500)}` };
    return { current, regenerated: r.stdout };
  },
  scan: ({ current, regenerated, problem }) => (problem
    ? { examined: 1, findings: [problem] }
    : { examined: 1, findings: gen.staleness(current, regenerated) }),
  control: () => {
    const cur = fs.readFileSync(TARGET, 'utf8');
    return { current: cur, regenerated: cur.replace('["ts",["*.cts","*.mts","*.ts","*.tsx"]]', '["ts",["*.cts","*.mts","*.ts"]]') };
  },
}));

test('a missing or garbled generated region is a finding, not a skip', () => {
  assert.match(typesHeader("'use strict';\n").problem, /no generated `const RG_TYPES_DATA/);
  assert.match(typesHeader('const RG_TYPES_DATA = {"header":};\n').problem, /does not parse/);
  assert.match(typesHeader('const RG_TYPES_DATA = {"header":{"rg":""}};\n').problem, /names no rg version/);
  assert.match(typesHeader('const RG_TYPES_DATA = {"header":{"rg":"ripgrep 1"},"types":[]};\n').problem, /holds no types/);
  assert.match(typesHeader(fs.readFileSync(TARGET, 'utf8')).rg, /^ripgrep \d+\.\d+\.\d+/);
});
test('a pinned native whose rg differs from the generated one is a finding, not a skip', () => {
  assert.strictEqual(versionProblem('ripgrep 14.1.1 (rev a)', 'ripgrep 14.1.1 (rev a)\nfeatures'), null);
  assert.match(versionProblem('ripgrep 14.1.1 (rev a)', 'ripgrep 15.0.0 (rev b)\nfeatures'),
    /regenerate: libexec\/rg-types\.cjs was generated from ripgrep 14\.1\.1 \(rev a\), the pinned native's rg is ripgrep 15\.0\.0 \(rev b\)/);
});
test('the generator\'s staleness names what moved: a type, the version, nothing when equal', () => {
  const cur = fs.readFileSync(TARGET, 'utf8');
  assert.deepStrictEqual(gen.staleness(cur, cur), []);
  assert.match(gen.staleness(cur, cur.replace('"*.tsx"]]', '"*.tsx","*.tsz"]]'))[0], /: type ts$/);
  assert.match(gen.staleness(cur, cur.replace('"features":"+pcre2"', '"features":"-pcre2"'))[0], /version\.features/);
});
test('the generator reads a native\'s architecture from its header (Mach-O, ELF, PE), for RG-VERSION-SIMD', () => {
  // A win32 native and node.exe are PE: a reader that knew Mach-O and ELF alone read 'unknown' for
  // both on windows-latest (CI 44443821699). Every format, here, on every host:
  const bf = require('../fixtures/binfmt.cjs');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rg-types-arch-'));
  try {
    for (const [name, bytes, want] of [['pe-x64', bf.pe({ machine: 0x8664 }), 'x64'], ['pe-arm64', bf.pe({ machine: 0xaa64 }), 'arm64'],
      ['elf-x64', bf.elf({ machine: 62 }), 'x64'], ['macho-arm64', bf.macho({ cputype: bf.CPU_ARM64 }), 'arm64']]) {
      fs.writeFileSync(path.join(dir, name), bytes);
      assert.strictEqual(gen.binaryArch(path.join(dir, name)), want, name);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const bin = providerBin(process.env);
  if (bin) assert.strictEqual(gen.binaryArch(bin), process.arch === 'arm64' || process.arch === 'x64' ? process.arch : gen.binaryArch(bin));
  assert.strictEqual(gen.binaryArch(process.execPath), process.arch === 'arm64' || process.arch === 'x64' ? process.arch : 'unknown');
});
