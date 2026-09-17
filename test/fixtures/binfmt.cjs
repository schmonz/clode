'use strict';
// Synthetic binary fixtures for test/depscan.test.cjs.
//
// WHY SYNTHETIC. depscan's whole claim is that it reads a binary built for a
// machine this one cannot execute. Feeding it only the host's own binaries
// proves none of that. Emitting the bytes here covers every (format × class ×
// endianness) the fleet ships -- on any host, with no cross toolchain, no
// network and no cached artifact -- and lets a test construct the malformed
// and non-hermetic inputs that guard.cjs requires as controls.
//
// These are MINIMAL but REAL: the headers and tables depscan reads are
// correct and internally consistent. Nothing here needs to load or run.

// Write `val` as a `size`-byte integer at `off` in the file's byte order.
function u(b, off, val, size, be) {
  let v = BigInt(val);
  for (let i = 0; i < size; i++) {
    b[off + (be ? size - 1 - i : i)] = Number((v >> BigInt(8 * i)) & 0xffn);
  }
}

// ---- ELF ------------------------------------------------------------------
// Fixed layout, so the offsets below stay readable:
//   0x0000  ELF header
//   0x0040  program headers: [0] PT_LOAD, [1] PT_DYNAMIC
//   0x0100  .dynamic
//   0x0200  .dynstr
// PT_LOAD maps the whole file at vaddr BASE, so the vaddr->offset mapping
// depscan must perform is exactly `vaddr - BASE`, and a wrong mapping cannot
// accidentally land on the right bytes.
const ELF_PHOFF = 0x40, ELF_DYN = 0x100, ELF_STR = 0x200, ELF_BASE = 0x1000;

function elf({ cls = 2, be = false, machine = 62, needed = [], strtabVaddr = null } = {}) {
  const w = cls === 2 ? 8 : 4;
  const phesz = cls === 2 ? 56 : 32;

  // .dynstr: a leading NUL (index 0 is the empty string by convention),
  // then each name NUL-terminated.
  let str = '\0';
  const nameOffsets = [];
  for (const n of needed) { nameOffsets.push(str.length); str += n + '\0'; }
  const strLen = Buffer.byteLength(str, 'latin1');

  const total = ELF_STR + strLen + 16;
  const b = Buffer.alloc(total, 0);

  // ---- ELF header
  b[0] = 0x7f; b[1] = 0x45; b[2] = 0x4c; b[3] = 0x46;  // \x7fELF
  b[4] = cls;                                          // EI_CLASS 1=32 2=64
  b[5] = be ? 2 : 1;                                   // EI_DATA  1=LE 2=BE
  b[6] = 1;                                            // EI_VERSION
  u(b, 0x10, 2, 2, be);                                // e_type = ET_EXEC
  u(b, 0x12, machine, 2, be);                          // e_machine
  u(b, 0x14, 1, 4, be);                                // e_version
  u(b, cls === 2 ? 0x20 : 0x1c, ELF_PHOFF, w, be);     // e_phoff
  u(b, cls === 2 ? 0x34 : 0x28, cls === 2 ? 0x40 : 0x34, 2, be); // e_ehsize
  u(b, cls === 2 ? 0x36 : 0x2a, phesz, 2, be);         // e_phentsize
  u(b, cls === 2 ? 0x38 : 0x2c, 2, 2, be);             // e_phnum

  // ---- phdr[0]: PT_LOAD covering the whole file at ELF_BASE
  const p0 = ELF_PHOFF;
  if (cls === 2) {
    u(b, p0 + 0, 1, 4, be);      u(b, p0 + 4, 5, 4, be);       // p_type, p_flags
    u(b, p0 + 8, 0, 8, be);      u(b, p0 + 16, ELF_BASE, 8, be); // p_offset, p_vaddr
    u(b, p0 + 24, ELF_BASE, 8, be);                            // p_paddr
    u(b, p0 + 32, total, 8, be); u(b, p0 + 40, total, 8, be);   // p_filesz, p_memsz
  } else {
    u(b, p0 + 0, 1, 4, be);      u(b, p0 + 4, 0, 4, be);        // p_type, p_offset
    u(b, p0 + 8, ELF_BASE, 4, be); u(b, p0 + 12, ELF_BASE, 4, be); // p_vaddr, p_paddr
    u(b, p0 + 16, total, 4, be); u(b, p0 + 20, total, 4, be);   // p_filesz, p_memsz
    u(b, p0 + 24, 5, 4, be);                                    // p_flags
  }

  // ---- phdr[1]: PT_DYNAMIC
  const dynCount = needed.length + 3;           // NEEDED* + STRTAB + STRSZ + NULL
  const dynSize = dynCount * w * 2;
  const p1 = ELF_PHOFF + phesz;
  if (cls === 2) {
    u(b, p1 + 0, 2, 4, be);      u(b, p1 + 4, 4, 4, be);
    u(b, p1 + 8, ELF_DYN, 8, be); u(b, p1 + 16, ELF_BASE + ELF_DYN, 8, be);
    u(b, p1 + 24, ELF_BASE + ELF_DYN, 8, be);
    u(b, p1 + 32, dynSize, 8, be); u(b, p1 + 40, dynSize, 8, be);
  } else {
    u(b, p1 + 0, 2, 4, be);      u(b, p1 + 4, ELF_DYN, 4, be);
    u(b, p1 + 8, ELF_BASE + ELF_DYN, 4, be); u(b, p1 + 12, ELF_BASE + ELF_DYN, 4, be);
    u(b, p1 + 16, dynSize, 4, be); u(b, p1 + 20, dynSize, 4, be);
    u(b, p1 + 24, 4, 4, be);
  }

  // ---- .dynamic: DT_NEEDED(1) per dep, then DT_STRTAB(5), DT_STRSZ(10), DT_NULL(0)
  const entries = nameOffsets.map((off) => [1, off]);
  entries.push([5, strtabVaddr === null ? ELF_BASE + ELF_STR : strtabVaddr]);
  entries.push([10, strLen]);
  entries.push([0, 0]);
  entries.forEach(([tag, val], i) => {
    u(b, ELF_DYN + i * w * 2, tag, w, be);
    u(b, ELF_DYN + i * w * 2 + w, val, w, be);
  });

  b.write(str, ELF_STR, 'latin1');
  return b;
}

module.exports = { u, elf, ELF_BASE, ELF_STR };
