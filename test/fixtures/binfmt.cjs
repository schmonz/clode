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

function elf({ cls = 2, be = false, machine = 62, needed = [], strtabVaddr = null, rpath = [], rawNeeded = null } = {}) {
  const w = cls === 2 ? 8 : 4;
  const phesz = cls === 2 ? 56 : 32;

  // .dynstr: a leading NUL (index 0 is the empty string by convention),
  // then each name NUL-terminated.
  let str = '\0';
  const nameOffsets = [];
  for (const n of needed) { nameOffsets.push(str.length); str += n + '\0'; }
  // DT_RUNPATH's value is a string-table offset too, and the list is
  // colon-separated in one string.
  let runpathOffset = 0;
  if (rpath.length) { runpathOffset = str.length; str += rpath.join(':') + '\0'; }
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

  // rawNeeded lets a test emit a DT_NEEDED VALUE directly (e.g. one near
  // UINT64_MAX to probe overflow arithmetic) instead of an offset this
  // builder computed from a real name -- an option rather than reshaping
  // every caller that just wants an ordinary name.
  const neededTags = rawNeeded !== null ? rawNeeded : nameOffsets;

  // ---- phdr[1]: PT_DYNAMIC
  const dynCount = neededTags.length + 3 + (rpath.length ? 1 : 0);  // NEEDED* + RUNPATH? + STRTAB + STRSZ + NULL
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

  // ---- .dynamic: DT_NEEDED(1) per dep, DT_RUNPATH(29) if asked, then
  // DT_STRTAB(5), DT_STRSZ(10), DT_NULL(0).
  const entries = neededTags.map((off) => [1, off]);
  if (rpath.length) entries.push([29, runpathOffset]);
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

// ---- Mach-O ----------------------------------------------------------------
// Layout: header, then LC_LOAD_DYLIB commands back to back. Each dylib_command
// carries its name INLINE, at `name_offset` bytes from the start of the command
// itself -- not in a separate string table, which is why Mach-O needs no
// address mapping at all.
const CPU_X86_64 = 0x01000007, CPU_ARM64 = 0x0100000c, CPU_PPC = 18, CPU_I386 = 7;
// CPU_TYPE_ARM64's cpusubtype: the SAME cputype as plain arm64, so a fat
// binary can (and, on an ordinary Mac's /bin/sh, does) carry both.
const CPU_SUBTYPE_ARM64E = 2;

function macho({ bits = 64, be = false, cputype = CPU_ARM64, cpusubtype = 0, needed = [], rpath = [] } = {}) {
  const hdrSize = bits === 64 ? 32 : 28;
  const cmds = needed.map((name) => {
    const nameBytes = Buffer.byteLength(name, 'latin1') + 1;   // + NUL
    // dylib_command is 24 bytes, then the name, then pad to a 4-byte multiple.
    const size = Math.ceil((24 + nameBytes) / 4) * 4;
    const c = Buffer.alloc(size, 0);
    u(c, 0, 0x0c, 4, be);       // cmd = LC_LOAD_DYLIB
    u(c, 4, size, 4, be);       // cmdsize
    u(c, 8, 24, 4, be);         // dylib.name.offset -- from the START of this command
    u(c, 12, 0, 4, be);         // timestamp
    u(c, 16, 0x10000, 4, be);   // current_version
    u(c, 20, 0x10000, 4, be);   // compatibility_version
    c.write(name, 24, 'latin1');
    return c;
  });
  // LC_RPATH carries its path INLINE too, same shape as a dylib command but
  // with a 12-byte fixed part (just path.offset) instead of 24.
  const rpathCmds = rpath.map((p) => {
    const nameBytes = Buffer.byteLength(p, 'latin1') + 1;
    const size = Math.ceil((12 + nameBytes) / 4) * 4;
    const c = Buffer.alloc(size, 0);
    u(c, 0, 0x8000001c, 4, be);   // LC_RPATH
    u(c, 4, size, 4, be);         // cmdsize
    u(c, 8, 12, 4, be);           // path.offset
    c.write(p, 12, 'latin1');
    return c;
  });
  const allCmds = cmds.concat(rpathCmds);
  const sizeofcmds = allCmds.reduce((n, c) => n + c.length, 0);
  const b = Buffer.alloc(hdrSize + sizeofcmds, 0);
  // MH_MAGIC (32-bit) / MH_MAGIC_64 stored in the file's own byte order: a
  // big-endian ppc binary has the SAME logical magic, laid out the other way.
  u(b, 0, bits === 64 ? 0xfeedfacf : 0xfeedface, 4, be);
  u(b, 4, cputype, 4, be);
  u(b, 8, cpusubtype, 4, be);     // cpusubtype
  u(b, 12, 2, 4, be);             // filetype = MH_EXECUTE
  u(b, 16, allCmds.length, 4, be); // ncmds
  u(b, 20, sizeofcmds, 4, be);    // sizeofcmds
  u(b, 24, 0, 4, be);             // flags
  let at = hdrSize;
  for (const c of allCmds) { c.copy(b, at); at += c.length; }
  return b;
}

// A fat (universal) container. The fat header and every fat_arch are ALWAYS
// big-endian on disk, whatever the slices inside them are -- the one place in
// Mach-O where byte order is fixed rather than declared.
function fat(slices) {
  const HDR = 8, ARCH = 20;
  const tableEnd = HDR + ARCH * slices.length;
  // Page-align each slice, as the real linker does.
  let off = Math.ceil(tableEnd / 4096) * 4096;
  const placed = slices.map((s) => {
    const at = off;
    off = Math.ceil((off + s.buf.length) / 4096) * 4096;
    return { ...s, at };
  });
  const b = Buffer.alloc(off, 0);
  u(b, 0, 0xcafebabe, 4, true);          // FAT_MAGIC, big-endian
  u(b, 4, slices.length, 4, true);       // nfat_arch
  placed.forEach((s, i) => {
    const a = HDR + ARCH * i;
    u(b, a + 0, s.cputype, 4, true);
    u(b, a + 4, s.cpusubtype || 0, 4, true);
    u(b, a + 8, s.at, 4, true);
    u(b, a + 12, s.buf.length, 4, true);
    u(b, a + 16, 12, 4, true);           // align = 2^12
    s.buf.copy(b, s.at);
  });
  return b;
}

// ---- PE --------------------------------------------------------------------
// Layout: MZ stub, PE signature at 0x80, COFF header, optional header (whose
// data directory [1] is the import table), one section mapping RVA 0x1000 to
// file offset 0x400, and the import descriptors + DLL names inside it.
// PE is little-endian on every target Windows has ever shipped.
function pe({ plus = true, machine = 0x8664, needed = [], zeroImportDir = false } = {}) {
  const PE_AT = 0x80, OPT_AT = PE_AT + 24;
  const optSize = plus ? 240 : 224;
  const SEC_AT = OPT_AT + optSize;
  const IDATA_FILE = 0x400, IDATA_RVA = 0x1000;

  const descBytes = (needed.length + 1) * 20;      // + the all-zero terminator
  let names = Buffer.alloc(0);
  const nameRvas = [];
  for (const n of needed) {
    nameRvas.push(IDATA_RVA + descBytes + names.length);
    names = Buffer.concat([names, Buffer.from(n + '\0', 'latin1')]);
  }
  const idataSize = descBytes + names.length;
  const total = IDATA_FILE + Math.ceil(idataSize / 512) * 512;
  const b = Buffer.alloc(total, 0);

  b.write('MZ', 0, 'latin1');
  u(b, 0x3c, PE_AT, 4, false);                     // e_lfanew
  b.write('PE\0\0', PE_AT, 'latin1');

  // ---- COFF header
  u(b, PE_AT + 4, machine, 2, false);              // Machine
  u(b, PE_AT + 6, 1, 2, false);                    // NumberOfSections
  u(b, PE_AT + 20, optSize, 2, false);             // SizeOfOptionalHeader
  u(b, PE_AT + 22, 0x0022, 2, false);              // Characteristics (EXECUTABLE_IMAGE|LARGE_ADDRESS_AWARE)

  // ---- Optional header: only the fields depscan reads need to be right.
  u(b, OPT_AT, plus ? 0x20b : 0x10b, 2, false);    // Magic
  const ddAt = OPT_AT + (plus ? 112 : 96);         // first data directory
  u(b, OPT_AT + (plus ? 108 : 92), 16, 4, false);  // NumberOfRvaAndSizes
  // zeroImportDir emits a data directory [1] of {0,0} -- "this PE imports
  // nothing" is a distinct code path in scan_pe from "imports an empty
  // table": a nonzero RVA still walks to a table holding just the all-zero
  // terminator entry, but a zero RVA short-circuits before ever reaching the
  // section table at all.
  u(b, ddAt + 8, zeroImportDir ? 0 : IDATA_RVA, 4, false);   // [1] Import Table RVA
  u(b, ddAt + 12, zeroImportDir ? 0 : idataSize, 4, false);  // [1] Import Table size

  // ---- Section table: one section carrying the import data.
  b.write('.idata\0\0', SEC_AT, 'latin1');
  u(b, SEC_AT + 8, idataSize, 4, false);           // VirtualSize
  u(b, SEC_AT + 12, IDATA_RVA, 4, false);          // VirtualAddress
  u(b, SEC_AT + 16, total - IDATA_FILE, 4, false); // SizeOfRawData
  u(b, SEC_AT + 20, IDATA_FILE, 4, false);         // PointerToRawData

  // ---- Import descriptors, then the names they point at.
  needed.forEach((_, i) => {
    const d = IDATA_FILE + i * 20;
    u(b, d + 0, IDATA_RVA + 0x800, 4, false);      // OriginalFirstThunk (unread)
    u(b, d + 12, nameRvas[i], 4, false);           // Name RVA
    u(b, d + 16, IDATA_RVA + 0x900, 4, false);     // FirstThunk (unread)
  });
  names.copy(b, IDATA_FILE + descBytes);
  return b;
}

module.exports = { u, elf, macho, fat, pe, ELF_BASE, ELF_STR, CPU_X86_64, CPU_ARM64, CPU_PPC, CPU_I386, CPU_SUBTYPE_ARM64E };
