'use strict';
// scripts/elf-machine.cjs: the CI arch gates' verdict, from the ELF header instead of
// file(1)'s prose. Run 44572930594: libmagic after 5.45 renamed e_machine 3 from
// "Intel 80386" to "Intel i386", and the netbsd-i386 gate (/80386|Intel 386/) failed a
// correct engine. One row per arch the legs use: the e_machine, byte order and class the
// gate now checks, plus file(1)'s wording for that e_machine in BOTH libmagic versions
// (magic/Magdir/elf at FILE5_45 and at master, compared 2026-11-19) — only i386 moved.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');
const { ARCHES, readElfIdent, archMismatches } = require('../scripts/elf-machine.cjs');

const REPO = path.resolve(__dirname, '..');

// [arch, e_machine, bits, endian, file(1) <=5.45, file(1) master]
const ROWS = [
  ['i386', 3, 32, 'LE', 'Intel 80386', 'Intel i386'],
  ['x86', 3, 32, 'LE', 'Intel 80386', 'Intel i386'],
  ['m68k', 4, 32, 'BE', 'Motorola m68k', 'Motorola m68k'],
  ['sparc64', 43, 64, 'BE', 'SPARC V9', 'SPARC V9'],
  ['alpha', 0x9026, 64, 'LE', 'Alpha (unofficial)', 'Alpha (unofficial)'],
  ['hppa', 15, 32, 'BE', 'PA-RISC', 'PA-RISC'],
  ['powerpc', 20, 32, 'BE', 'PowerPC or cisco 4500', 'PowerPC or cisco 4500'],
  ['mipsel', 8, 32, 'LE', 'MIPS', 'MIPS'],
  ['mipseb', 8, 32, 'BE', 'MIPS', 'MIPS'],
  ['mips64eb', 8, 64, 'BE', 'MIPS', 'MIPS'],
  ['earmv7hf', 40, 32, 'LE', 'ARM', 'ARM'],
  ['sh3el', 42, 32, 'LE', 'Renesas SH', 'Renesas SH'],
  ['riscv64', 243, 64, 'LE', 'UCB RISC-V', 'UCB RISC-V'],
  ['s390x', 22, 64, 'BE', 'IBM S/390', 'IBM S/390'],
  ['x86_64', 62, 64, 'LE', 'x86-64', 'x86-64'],
  ['aarch64', 183, 64, 'LE', 'ARM aarch64', 'ARM aarch64'],
  ['armv7', 40, 32, 'LE', 'ARM', 'ARM'],
  ['armhf', 40, 32, 'LE', 'ARM', 'ARM'],
  ['ppc64le', 21, 64, 'LE', '64-bit PowerPC or cisco 7500', '64-bit PowerPC or cisco 7500'],
  ['loongarch64', 258, 64, 'LE', 'LoongArch', 'LoongArch'],
];

function elfHeader(machine, bits, endian) {
  const b = Buffer.alloc(64);
  b.set([0x7f, 0x45, 0x4c, 0x46], 0);
  b[4] = bits === 64 ? 2 : 1;
  b[5] = endian === 'LE' ? 1 : 2;
  b[6] = 1;
  if (endian === 'LE') b.writeUInt16LE(machine, 18); else b.writeUInt16BE(machine, 18);
  return b;
}

for (const [arch, machine, bits, endian, oldWord, newWord] of ROWS) {
  test(`${arch}: e_machine ${machine} ${bits}-bit ${endian} passes, whichever file(1) says "${oldWord}"/"${newWord}"`, () => {
    assert.deepStrictEqual(archMismatches(arch, readElfIdent(elfHeader(machine, bits, endian))), []);
    // The verdict never consults prose, so both wordings name the same fact by construction.
    // A host x86-64 binary (the stale-CMakeCache failure the gate exists for) is refused.
    if (machine !== 62) assert.notDeepStrictEqual(archMismatches(arch, readElfIdent(elfHeader(62, 64, 'LE'))), []);
    // Wrong byte order is refused (mipsel vs mipseb, sh3el vs sh3eb).
    assert.notDeepStrictEqual(archMismatches(arch, readElfIdent(elfHeader(machine, bits, endian === 'LE' ? 'BE' : 'LE'))), []);
  });
}

test('the table covers every arch it is asked about, and an unknown arch is a finding', () => {
  assert.deepStrictEqual(Object.keys(ARCHES).sort(), ROWS.map((r) => r[0]).sort());
  assert.match(archMismatches('vax', { machine: 75, bits: 32, endian: 'LE' })[0], /no ELF expectation/);
});

test('alpha also accepts the official EM_ALPHA (41)', () => {
  assert.deepStrictEqual(archMismatches('alpha', { machine: 41, bits: 64, endian: 'LE' }), []);
});

test('the CLI: exit 0 on a match, 1 naming the reason on a mismatch or a non-ELF', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-machine-'));
  const f = path.join(dir, 'tjs');
  fs.writeFileSync(f, elfHeader(3, 32, 'LE'));
  const cli = path.join(REPO, 'scripts/elf-machine.cjs');
  const ok = spawnSync(process.execPath, [cli, 'check', 'i386', f], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stderr);
  const bad = spawnSync(process.execPath, [cli, 'check', 'm68k', f], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /is not m68k .*e_machine 3/);
  fs.writeFileSync(f, '#!/bin/sh\n');
  const notElf = spawnSync(process.execPath, [cli, 'check', 'i386', f], { encoding: 'utf8' });
  assert.strictEqual(notElf.status, 1);
  assert.match(notElf.stderr, /not an ELF file/);
});

// Every leg arch the build-leg gates can be handed has an expectation, and neither gate
// judges file(1)'s wording any more.
function scanArchGates({ yml, legArches }) {
  const findings = [];
  let examined = 0;
  const code = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  for (const step of ['Arch gate — the cross-built engine is the target arch', 'Verify the binary is truly static (musl legs)']) {
    examined++;
    const i = code.indexOf(step);
    const body = i < 0 ? '' : code.slice(i, code.indexOf('\n    - name:', i + 1));
    if (!/node scripts\/elf-machine\.cjs check /.test(body)) findings.push(`${step}: does not check the ELF header via scripts/elf-machine.cjs`);
    if (/want=['"]?[^'"\s]*(80386|RISC-V|S\/390|PowerPC|MIPS|ARM)/.test(body)) findings.push(`${step}: still matches file(1) wording for the arch`);
  }
  for (const a of legArches) { examined++; if (!ARCHES[a]) findings.push(`leg arch '${a}' has no ELF expectation`); }
  return { findings, examined };
}

// The leg arches the two gates are handed (tier-2 + musl static legs), from the manifest
// itself. tjs-legs.mjs is ESM and read() is sync, so resolve it once through a child.
const legArches = (() => {
  const href = require('node:url').pathToFileURL(path.join(REPO, 'scripts/tjs-legs.mjs')).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(href)});
     const s = new Set(); for (const t of ['ci', 'release']) for (const l of m.legsFor(t)) if (l.tier2 || l.static) s.add(l['guest-arch']);
     console.log(JSON.stringify([...s]));`], { encoding: 'utf8' });
  return r.status === 0 ? JSON.parse(r.stdout) : [];
})();

const archGateGuard = defineGuard({
  name: 'arch-gates-read-the-elf-header',
  read: () => ({ yml: fs.readFileSync(path.join(REPO, '.github/actions/build-leg/action.yml'), 'utf8'), legArches }),
  scan: scanArchGates,
  // 2 gate steps + the leg arches (20 on 2026-11-19); an empty manifest read is BROKEN.
  floor: 12,
  // The gate as run 44572930594 ran it, plus an arch with no expectation.
  control: () => ({
    yml: "    - name: Arch gate — the cross-built engine is the target arch, not the host\n"
      + "        i386)    want='80386|Intel 386' ;;\n    - name: next\n",
    legArches: ['vax'],
  }),
});
guardTests(archGateGuard);
