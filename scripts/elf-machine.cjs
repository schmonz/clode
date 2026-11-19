#!/usr/bin/env node
'use strict';
// Which architecture is this ELF, read from the HEADER rather than from file(1)'s prose.
//
// WHY. The CI arch gates grepped `file -b` output for a wording, and file(1)'s wording is
// not an interface: libmagic after 5.45 renamed e_machine 3 from "Intel 80386" to
// "Intel i386" (and 6/7 to "Intel i486"/"Intel i860"). ubuntu-latest picked that up and
// run 44572930594's netbsd-i386 leg went red on a correct i386 engine. The musl
// static gate's `x86 -> 80386` had the same latent mismatch. e_machine, EI_CLASS and
// EI_DATA are the facts file(1) was paraphrasing; reading them retires the class.
//
// The table is keyed by the arch names the legs use (tier-2 `guest-arch` and the musl
// legs' `guest-arch`). `bits`/`endian` are asserted only where the port fixes them;
// null means "not pinned" (mips64eb: NetBSD's userland ABI choice is not this gate's
// business — e_machine and byte order are).

const fs = require('node:fs');

const EM = Object.freeze({
  SPARC: 2, I386: 3, M68K: 4, MIPS: 8, PARISC: 15, SPARC32PLUS: 18, PPC: 20, PPC64: 21,
  S390: 22, ARM: 40, ALPHA: 41, SH: 42, SPARCV9: 43, X86_64: 62, AARCH64: 183,
  RISCV: 243, LOONGARCH: 258, ALPHA_EXP: 0x9026,
});

const ARCHES = Object.freeze({
  // tier-2 cross legs (NetBSD build.sh + Debian cross images)
  i386: { machines: [EM.I386], bits: 32, endian: 'LE' },
  m68k: { machines: [EM.M68K], bits: 32, endian: 'BE' },
  sparc64: { machines: [EM.SPARCV9], bits: 64, endian: 'BE' },
  // NetBSD/alpha historically stamps the pre-assignment EM_ALPHA_EXP (0x9026).
  alpha: { machines: [EM.ALPHA, EM.ALPHA_EXP], bits: 64, endian: 'LE' },
  hppa: { machines: [EM.PARISC], bits: 32, endian: 'BE' },
  powerpc: { machines: [EM.PPC], bits: 32, endian: 'BE' },
  mipsel: { machines: [EM.MIPS], bits: 32, endian: 'LE' },
  mipseb: { machines: [EM.MIPS], bits: 32, endian: 'BE' },
  mips64eb: { machines: [EM.MIPS], bits: null, endian: 'BE' },
  earmv7hf: { machines: [EM.ARM], bits: 32, endian: 'LE' },
  sh3el: { machines: [EM.SH], bits: 32, endian: 'LE' },
  riscv64: { machines: [EM.RISCV], bits: 64, endian: 'LE' },
  s390x: { machines: [EM.S390], bits: 64, endian: 'BE' },
  // musl static legs
  x86_64: { machines: [EM.X86_64], bits: 64, endian: 'LE' },
  aarch64: { machines: [EM.AARCH64], bits: 64, endian: 'LE' },
  x86: { machines: [EM.I386], bits: 32, endian: 'LE' },
  armv7: { machines: [EM.ARM], bits: 32, endian: 'LE' },
  armhf: { machines: [EM.ARM], bits: 32, endian: 'LE' },
  ppc64le: { machines: [EM.PPC64], bits: 64, endian: 'LE' },
  loongarch64: { machines: [EM.LOONGARCH], bits: 64, endian: 'LE' },
});

// Parse the identifying fields of an ELF header from a Buffer (>= 20 bytes).
function readElfIdent(buf) {
  if (!buf || buf.length < 20 || buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    throw new Error('not an ELF file (no \\x7fELF magic)');
  }
  const bits = buf[4] === 1 ? 32 : buf[4] === 2 ? 64 : null;
  const endian = buf[5] === 1 ? 'LE' : buf[5] === 2 ? 'BE' : null;
  if (bits === null || endian === null) throw new Error(`bad ELF ident (class ${buf[4]}, data ${buf[5]})`);
  const machine = endian === 'LE' ? buf.readUInt16LE(18) : buf.readUInt16BE(18);
  return { bits, endian, machine };
}

// [] when `ident` is the arch's, else the reasons it is not. An unknown arch is a
// finding, never a pass: a gate that knows nothing about a leg must not wave it through.
function archMismatches(arch, ident) {
  const want = ARCHES[arch];
  if (!want) return [`no ELF expectation recorded for arch '${arch}' (add it to scripts/elf-machine.cjs)`];
  const out = [];
  if (!want.machines.includes(ident.machine)) {
    out.push(`e_machine ${ident.machine} (0x${ident.machine.toString(16)}), want ${want.machines.join(' or ')}`);
  }
  if (want.bits !== null && ident.bits !== want.bits) out.push(`ELFCLASS${ident.bits}, want ${want.bits}-bit`);
  if (ident.endian !== want.endian) out.push(`${ident.endian}, want ${want.endian}`);
  return out;
}

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(64);
    const n = fs.readSync(fd, buf, 0, 64, 0);
    return buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}

module.exports = { EM, ARCHES, readElfIdent, archMismatches };

if (require.main === module) {
  const [cmd, arch, file] = process.argv.slice(2);
  if (cmd !== 'check' || !arch || !file) {
    process.stderr.write('usage: elf-machine.cjs check <arch> <elf-file>\n');
    process.exit(2);
  }
  let ident;
  try { ident = readElfIdent(readHead(file)); } catch (e) {
    process.stderr.write(`ERROR: ${file}: ${e.message}\n`);
    process.exit(1);
  }
  const why = archMismatches(arch, ident);
  const desc = `e_machine=${ident.machine} ELFCLASS${ident.bits} ${ident.endian}`;
  if (why.length) {
    process.stderr.write(`ERROR: ${file} is not ${arch} (${desc}): ${why.join('; ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`elf arch ok: ${arch} (${desc})\n`);
}
