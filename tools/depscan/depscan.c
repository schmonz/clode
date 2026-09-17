/* depscan — print the dynamic-dependency table of an executable, whatever
 * machine that executable targets.
 *
 * WHY THIS EXISTS. The engine build's hermeticity check shelled out to
 * `otool -L` / `ldd`, which can only inspect a binary the HOST can load. So
 * it skipped on every cross-build and on Windows — 19 of 42 release legs, 15
 * of them published — leaving file(1) ("yes, that is an m68k NetBSD ELF") as
 * the entire proof that a shipped engine links nothing it should not. That is
 * a gate that cannot fail, which this project counts as worse than no gate.
 *
 * The dependency list is a TABLE IN THE FILE (ELF DT_NEEDED, Mach-O
 * LC_LOAD_DYLIB, the PE import directory), so reading it needs no loader and
 * no host/target agreement at all.
 *
 * HOW IT STAYS HOST-INDEPENDENT: every multi-byte field is read by rd()
 * with an explicit width and endianness taken from the FILE, never by casting
 * to a struct. A struct cast would silently adopt this machine's word size,
 * alignment and byte order — which is precisely the coupling that made
 * otool/ldd unusable here.
 *
 * NEVER SHIPPED: cmake builds this from source during the engine build and
 * throws it away. It adds nothing to the release surface and cannot skew
 * against the tree that uses it.
 *
 * OUTPUT (line-oriented, and explicit about emptiness):
 *   format=<token> [machine=<n>] [slices=<n>]
 *   slice=<token>                  (Mach-O fat only, once per slice)
 *   dep=<name>
 *   deps=<n>                       (once per slice; ALWAYS printed on success)
 * "Parsed it and found none" (deps=0, exit 0) and "could not parse it"
 * (nonzero exit, no deps= line) must never print the same. The old ldd path
 * learned this the hard way: OpenBSD's ldd prints a table parseLddDeps
 * returns [] for, which read identically to "verified clean".
 *
 * EXIT: 0 parsed; 2 usage; 3 unrecognized container; 4 malformed or unreadable.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Read `size` bytes at p as an unsigned integer of the file's byte order.
 * be = 1 for big-endian. Host byte order is irrelevant by construction. */
static unsigned long long rd(const unsigned char *p, int size, int be) {
  unsigned long long v = 0;
  int i;
  for (i = 0; i < size; i++)
    v |= (unsigned long long)p[be ? size - 1 - i : i] << (8 * i);
  return v;
}

/* Bounds check: is [off, off+need) inside a buffer of `len`? Written as
 * subtraction rather than `off + need <= len` so it cannot overflow on a
 * hostile or corrupt offset. */
static int inb(unsigned long long off, unsigned long long need, size_t len) {
  return off <= (unsigned long long)len && need <= (unsigned long long)len - off;
}

static unsigned char *slurp(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb");
  long n;
  unsigned char *buf;
  size_t got;
  if (!f) return NULL;
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
  n = ftell(f);
  if (n < 0 || fseek(f, 0, SEEK_SET) != 0) { fclose(f); return NULL; }
  buf = (unsigned char *)malloc((size_t)n + 1);
  if (!buf) { fclose(f); return NULL; }
  got = fread(buf, 1, (size_t)n, f);
  fclose(f);
  if (got != (size_t)n) { free(buf); return NULL; }
  buf[n] = 0;
  *len = (size_t)n;
  return buf;
}

/* Print "<tag>=<string>" for a NUL-terminated string that must lie wholly
 * inside the buffer. Returns 0 if it runs off the end — a name we cannot
 * read is a malformed file, not an absent dependency or search path.
 *
 * ALSO refuses any control byte (< 0x20, or 0x7f/DEL). depscan's output is a
 * LINE-ORIENTED PROTOCOL, and this string is raw file bytes printed straight
 * into it: a name containing '\n' can FORGE a fake "deps=1\n" terminator
 * mid-stream, splitting one real dependency into a benign-looking group and
 * hiding a real one in a second, fabricated group. DEMONSTRATED 2026-09-17 by
 * the controller with DT_NEEDED = "/tmp/ok.so\ndeps=1\nformat=elf64le
 * machine=62". Task 7's parseDepscan resists this via a dep-count consistency
 * check, but that is defence-in-depth, NOT a reason to leave this open -- do
 * not delete that check believing this guard makes it redundant; a
 * verification tool whose OWN OUTPUT FORMAT can be reshaped by its input is a
 * defect on its own terms. "I cannot report this unambiguously" is the
 * honest answer, matching the rule that an unreadable name is malformed, not
 * absent. This applies equally to a run= search-path entry, which is exactly
 * as capable of forging a line as a dep= name is. */
static int put_line(const char *tag, const unsigned char *b, size_t len, unsigned long long off) {
  unsigned long long i;
  if (off >= (unsigned long long)len) return 0;
  for (i = off; i < (unsigned long long)len; i++) {
    if (!b[i]) break;
    if (b[i] < 0x20 || b[i] == 0x7f) return 0;
  }
  if (i >= (unsigned long long)len) return 0;
  printf("%s=%s\n", tag, (const char *)(b + off));
  return 1;
}

static int put_dep(const unsigned char *b, size_t len, unsigned long long off) {
  return put_line("dep", b, len, off);
}

static int scan_elf(const unsigned char *b, size_t len);
static int scan_macho(const unsigned char *b, size_t len);
static int scan_pe(const unsigned char *b, size_t len);

int main(int argc, char **argv) {
  size_t len = 0;
  unsigned char *b;
  int rc = 3;
  if (argc != 2) { fprintf(stderr, "usage: depscan <binary>\n"); return 2; }
  b = slurp(argv[1], &len);
  if (!b) { fprintf(stderr, "depscan: cannot read %s\n", argv[1]); return 4; }
  if (len >= 4) {
    unsigned long long m_le = rd(b, 4, 0), m_be = rd(b, 4, 1);
    if (!memcmp(b, "\177ELF", 4)) rc = scan_elf(b, len);
    else if (m_le == 0xfeedfaceULL || m_le == 0xfeedfacfULL ||
             m_be == 0xfeedfaceULL || m_be == 0xfeedfacfULL ||
             m_be == 0xcafebabeULL || m_be == 0xcafebabfULL) rc = scan_macho(b, len);
    else if (b[0] == 'M' && b[1] == 'Z') rc = scan_pe(b, len);
  }
  if (rc == 3) fprintf(stderr, "depscan: %s is not ELF, Mach-O or PE\n", argv[1]);
  if (rc == 4) fprintf(stderr, "depscan: %s is malformed (truncated or inconsistent headers)\n", argv[1]);
  free(b);
  return rc;
}

/* ---- ELF ------------------------------------------------------------------
 * PT_DYNAMIC holds an array of (tag, value) pairs. DT_NEEDED's value is a
 * BYTE OFFSET into the string table, but DT_STRTAB's value is a VIRTUAL
 * ADDRESS -- so the table has to be located by walking PT_LOAD and undoing
 * the load mapping. Section headers would be easier, but a stripped binary
 * may have none, and PT_LOAD is what the loader itself uses.
 */
#define DT_NULL_    0
#define DT_NEEDED_  1
#define DT_STRTAB_  5
#define DT_RPATH_   15
#define DT_RUNPATH_ 29
#define PT_LOAD_    1
#define PT_DYNAMIC_ 2

/* Map a virtual address to a file offset via the PT_LOAD segments.
 * Returns -1 if no segment contains it (a malformed or hostile file). */
static long long elf_v2o(const unsigned char *b, size_t len, int cls, int be,
                         unsigned long long phoff, unsigned phentsize,
                         unsigned phnum, unsigned long long vaddr) {
  int w = (cls == 2) ? 8 : 4;
  size_t o_off = (cls == 2) ? 8 : 4;
  size_t o_vad = (cls == 2) ? 16 : 8;
  size_t o_fsz = (cls == 2) ? 32 : 16;
  unsigned i;
  for (i = 0; i < phnum; i++) {
    unsigned long long ph = phoff + (unsigned long long)i * phentsize;
    unsigned long long off, va, fsz;
    if (!inb(ph, phentsize, len)) return -1;
    if (rd(b + ph, 4, be) != PT_LOAD_) continue;
    off = rd(b + ph + o_off, w, be);
    va  = rd(b + ph + o_vad, w, be);
    fsz = rd(b + ph + o_fsz, w, be);
    if (vaddr >= va && vaddr - va < fsz) {
      unsigned long long delta = vaddr - va;
      /* p_offset comes straight from the file and can be near UINT64_MAX;
       * guard the addition itself so a hostile value cannot WRAP into a
       * small, plausible-looking file offset -- the same class of defect
       * as the DT_NEEDED addition in scan_elf below. */
      if (off > (unsigned long long)-1 - delta) return -1;
      return (long long)(delta + off);
    }
  }
  return -1;
}

static int scan_elf(const unsigned char *b, size_t len) {
  int cls, be, w;
  size_t phoff_at, phesz_at, phnum_at;
  unsigned long long phoff, dynoff = 0, dynsz = 0, strtab_va = 0;
  unsigned phentsize, phnum, machine, i;
  long long strtab_off;
  int found_dynamic = 0, ndeps = 0;
  unsigned long long needed[512];
  int nneeded = 0;
  unsigned long long runpath_off = 0;
  int have_runpath = 0;

  /* Just enough of e_ident (16 bytes) to learn the class before deciding how
   * much header we actually need -- an ELF64 header is 0x40 bytes, but an
   * ELF32 header is only 0x34; requiring 0x40 for both rejected every real
   * ELF32 binary shorter than that, which no real binary is, but the check
   * should say what it means. */
  if (len < 16) return 4;
  cls = b[4];
  be  = (b[5] == 2);
  if ((cls != 1 && cls != 2) || (b[5] != 1 && b[5] != 2)) return 4;
  w = (cls == 2) ? 8 : 4;
  if (len < (size_t)(cls == 2 ? 0x40 : 0x34)) return 4;

  phoff_at = (cls == 2) ? 0x20 : 0x1c;
  phesz_at = (cls == 2) ? 0x36 : 0x2a;
  phnum_at = (cls == 2) ? 0x38 : 0x2c;
  if (!inb(phnum_at, 2, len)) return 4;
  phoff     = rd(b + phoff_at, w, be);
  phentsize = (unsigned)rd(b + phesz_at, 2, be);
  phnum     = (unsigned)rd(b + phnum_at, 2, be);
  machine   = (unsigned)rd(b + 0x12, 2, be);
  if (phentsize < (unsigned)(cls == 2 ? 56 : 32)) return 4;

  printf("format=elf%s%s machine=%u\n", cls == 2 ? "64" : "32", be ? "be" : "le", machine);

  /* Locate PT_DYNAMIC. A binary with none is statically linked: that is a
   * real, parseable answer (deps=0), not a failure. */
  for (i = 0; i < phnum; i++) {
    unsigned long long ph = phoff + (unsigned long long)i * phentsize;
    if (!inb(ph, phentsize, len)) return 4;
    if (rd(b + ph, 4, be) != PT_DYNAMIC_) continue;
    dynoff = rd(b + ph + ((cls == 2) ? 8 : 4), w, be);
    dynsz  = rd(b + ph + ((cls == 2) ? 32 : 16), w, be);
    found_dynamic = 1;
    break;
  }
  if (!found_dynamic) { printf("deps=0\n"); return 0; }
  if (!inb(dynoff, dynsz, len)) return 4;

  /* First pass: collect DT_NEEDED offsets and DT_STRTAB's address. The tags
   * may appear in any order, so the string table cannot be resolved until
   * the whole array has been read. */
  for (i = 0; (unsigned long long)i * w * 2 + (unsigned)(w * 2) <= dynsz; i++) {
    unsigned long long at = dynoff + (unsigned long long)i * w * 2;
    unsigned long long tag = rd(b + at, w, be);
    unsigned long long val = rd(b + at + w, w, be);
    if (tag == DT_NULL_) break;
    if (tag == DT_NEEDED_) {
      if (nneeded >= (int)(sizeof needed / sizeof needed[0])) return 4;
      needed[nneeded++] = val;
    } else if (tag == DT_STRTAB_) {
      strtab_va = val;
    } else if (tag == DT_RUNPATH_ || tag == DT_RPATH_) {
      /* DT_RUNPATH supersedes DT_RPATH where both appear; taking the last
       * one seen matches what a loader does and both are equally damning
       * for our purposes. */
      runpath_off = val; have_runpath = 1;
    }
  }
  if (nneeded > 0 && strtab_va == 0) return 4;  /* names we cannot resolve */

  strtab_off = (nneeded > 0 || have_runpath) ?
    elf_v2o(b, len, cls, be, phoff, phentsize, phnum, strtab_va) : 0;
  if ((nneeded > 0 || have_runpath) && strtab_off < 0) return 4;

  if (have_runpath) {
    /* Reuse the strtab_off resolved above -- do NOT call elf_v2o a second
       time. Two resolutions of the same address can disagree only by being
       wrong, and the condition guarding strtab_off is widened above to cover
       this case. */
    unsigned long long p;
    if (strtab_off < 0) return 4;
    /* strtab_off and runpath_off both come straight from the file; guard the
     * addition itself (not just the final offset) so a hostile value near
     * UINT64_MAX cannot WRAP into a small in-bounds offset. Written as
     * inb() already is -- subtraction, not addition -- so the check itself
     * cannot overflow. */
    if (!inb((unsigned long long)strtab_off, runpath_off, len)) return 4;
    p = (unsigned long long)strtab_off + runpath_off;
    /* The list is colon-separated inside ONE string; print an entry per
     * element so the caller never has to re-split it. */
    while (p < (unsigned long long)len && b[p]) {
      unsigned long long q = p, k;
      while (q < (unsigned long long)len && b[q] && b[q] != ':') q++;
      if (q >= (unsigned long long)len) return 4;
      /* A control byte (esp. '\n') in a search-path entry could forge our
       * own line-oriented output the same way put_dep guards against for
       * dependency names -- refuse it rather than print it. */
      for (k = p; k < q; k++) if (b[k] < 0x20 || b[k] == 0x7f) return 4;
      printf("run=%.*s\n", (int)(q - p), (const char *)(b + p));
      p = (b[q] == ':') ? q + 1 : q;
    }
  }

  for (i = 0; i < (unsigned)nneeded; i++) {
    /* Same overflow guard as the DT_RUNPATH addition above: needed[i] is a
     * file-supplied offset that can be near UINT64_MAX. DEMONSTRATED
     * 2026-09-17: DT_NEEDED = 0xffffffffffffff00 wrapped to a small in-bounds
     * offset and printed an EMPTY dependency name, exiting 0 -- which the
     * downstream denylist (only matching names starting with "/") reads as
     * HERMETIC. Guard the arithmetic, not the empty-name symptom: a wrap can
     * equally land on bytes forming a plausible name instead. */
    if (!inb((unsigned long long)strtab_off, needed[i], len)) return 4;
    if (!put_dep(b, len, (unsigned long long)strtab_off + needed[i])) return 4;
    ndeps++;
  }
  printf("deps=%d\n", ndeps);
  return 0;
}

/* ---- Mach-O ---------------------------------------------------------------
 * Each LC_LOAD_DYLIB command carries its name INLINE, at `name_offset` bytes
 * from the start of that command -- no string table and no address mapping.
 * A fat container's own header is ALWAYS big-endian regardless of its slices,
 * the one place in the format where byte order is fixed rather than declared.
 */
#define LC_LOAD_DYLIB_       0x0c
#define LC_LOAD_WEAK_DYLIB_  0x80000018
#define LC_REEXPORT_DYLIB_   0x8000001f
#define LC_LAZY_LOAD_DYLIB_  0x20
#define LC_LOAD_UPWARD_DYLIB_ 0x80000023

/* cpusubtype for CPU_TYPE_ARM64; the top byte holds a pointer-authentication
 * ABI version on newer toolchains, unrelated to WHICH subtype this is, so it
 * is masked off before comparing. */
#define CPU_SUBTYPE_ARM64E_ 2

static const char *cpu_name(unsigned long long t, unsigned long long subtype) {
  switch (t) {
    case 0x01000007ULL: return "x86_64";
    case 0x0100000cULL:
      /* arm64 and arm64e are the SAME cputype with different cpusubtypes,
       * and DO coexist in one ordinary fat binary: /bin/sh on a stock Mac is
       * `x86_64 arm64e arm64e.x1` per lipo -info, so two of its three slices
       * are BOTH cputype arm64. Without this, depscan printed "slice=arm64"
       * for both, an ambiguous label that defeats per-slice reporting (spec
       * §12 Q4: one hermetic slice must not be able to mask a non-hermetic
       * one) and blocks lining slices up against `otool -arch <name>` by
       * name. */
      return (subtype & 0x00ffffffULL) == CPU_SUBTYPE_ARM64E_ ? "arm64e" : "arm64";
    case 7ULL:          return "i386";
    case 12ULL:         return "arm";
    case 18ULL:         return "ppc";
    case 0x01000012ULL: return "ppc64";
    default:            return "unknown";
  }
}

static int is_dylib_cmd(unsigned long long cmd) {
  return cmd == LC_LOAD_DYLIB_ || cmd == LC_LOAD_WEAK_DYLIB_ ||
         cmd == LC_REEXPORT_DYLIB_ || cmd == LC_LAZY_LOAD_DYLIB_ ||
         cmd == LC_LOAD_UPWARD_DYLIB_;
}

/* One thin Mach-O at `base`, extending `size` bytes. `emit_format` is 0 for a
 * slice inside a fat container (which prints slice= instead). */
static int scan_macho_thin(const unsigned char *b, size_t len,
                           unsigned long long base, unsigned long long size,
                           int emit_format) {
  unsigned long long magic_le, magic_be, magic;
  int be, bits;
  unsigned long long hdrsz, ncmds, sizeofcmds, at, cputype, cpusubtype;
  unsigned i;
  int ndeps = 0;

  if (!inb(base, 28, len) || size < 28) return 4;
  magic_le = rd(b + base, 4, 0);
  magic_be = rd(b + base, 4, 1);
  if (magic_le == 0xfeedfaceULL || magic_le == 0xfeedfacfULL) { be = 0; magic = magic_le; }
  else if (magic_be == 0xfeedfaceULL || magic_be == 0xfeedfacfULL) { be = 1; magic = magic_be; }
  else return 4;
  bits = (magic == 0xfeedfacfULL) ? 64 : 32;
  hdrsz = (bits == 64) ? 32 : 28;
  if (!inb(base, hdrsz, len) || size < hdrsz) return 4;

  cputype    = rd(b + base + 4, 4, be);
  cpusubtype = rd(b + base + 8, 4, be);
  ncmds      = rd(b + base + 16, 4, be);
  sizeofcmds = rd(b + base + 20, 4, be);

  if (emit_format) printf("format=macho%d%s machine=%s\n", bits, be ? "be" : "le", cpu_name(cputype, cpusubtype));
  else printf("slice=%s\n", cpu_name(cputype, cpusubtype));

  if (sizeofcmds > size - hdrsz || !inb(base + hdrsz, sizeofcmds, len)) return 4;

  at = base + hdrsz;
  for (i = 0; i < ncmds; i++) {
    unsigned long long cmd, cmdsize, noff;
    if (!inb(at, 8, len) || at + 8 > base + hdrsz + sizeofcmds) return 4;
    cmd     = rd(b + at, 4, be);
    cmdsize = rd(b + at + 4, 4, be);
    /* A zero or unaligned cmdsize would loop forever or walk off; both mean
     * the file is lying about its own structure. */
    if (cmdsize < 8 || (cmdsize % 4) != 0) return 4;
    if (!inb(at, cmdsize, len) || at + cmdsize > base + hdrsz + sizeofcmds) return 4;
    if (is_dylib_cmd(cmd)) {
      if (cmdsize < 24) return 4;
      noff = rd(b + at + 8, 4, be);
      if (noff >= cmdsize) return 4;
      if (!put_dep(b, len, at + noff)) return 4;
      ndeps++;
    } else if (cmd == 0x8000001cULL) {            /* LC_RPATH */
      unsigned long long poff;
      if (cmdsize < 12) return 4;
      poff = rd(b + at + 8, 4, be);
      if (poff >= cmdsize) return 4;
      /* put_line finds its own NUL and bounds-checks against `len`, rather
       * than trusting printf("%s") to stop at a terminator this file may not
       * actually have, and refuses a control byte for the reason documented
       * on put_line/put_dep above. */
      if (!put_line("run", b, len, at + poff)) return 4;
    }
    at += cmdsize;
  }
  printf("deps=%d\n", ndeps);
  return 0;
}

static int scan_macho(const unsigned char *b, size_t len) {
  unsigned long long magic_be = rd(b, 4, 1);
  if (magic_be == 0xcafebabeULL || magic_be == 0xcafebabfULL) {
    /* Fat. Header and arch table are big-endian, always. */
    int wide = (magic_be == 0xcafebabfULL);          /* FAT_MAGIC_64 */
    unsigned long long nfat, i, archsz = wide ? 32 : 20;
    if (!inb(0, 8, len)) return 4;
    nfat = rd(b + 4, 4, 1);
    if (nfat > 64) return 4;                          /* not a real universal binary */
    if (!inb(8, nfat * archsz, len)) return 4;
    printf("format=macho-fat slices=%llu\n", nfat);
    for (i = 0; i < nfat; i++) {
      unsigned long long a = 8 + i * archsz;
      unsigned long long off = wide ? rd(b + a + 8, 8, 1) : rd(b + a + 8, 4, 1);
      unsigned long long sz  = wide ? rd(b + a + 16, 8, 1) : rd(b + a + 12, 4, 1);
      int rc;
      if (!inb(off, sz, len)) return 4;
      rc = scan_macho_thin(b, len, off, sz, 0);
      if (rc != 0) return rc;
    }
    return 0;
  }
  return scan_macho_thin(b, len, 0, (unsigned long long)len, 1);
}

/* ---- PE --------------------------------------------------------------------
 * The import table is reached through data directory [1], whose RVA must be
 * mapped to a file offset via the section table -- the same shape as ELF's
 * PT_LOAD walk. PE is little-endian on every Windows target that has ever
 * shipped, so unlike ELF and Mach-O there is no byte order to discover.
 */
static long long pe_rva2off(const unsigned char *b, size_t len,
                            unsigned long long sec_at, unsigned nsec,
                            unsigned long long rva) {
  unsigned i;
  for (i = 0; i < nsec; i++) {
    unsigned long long s = sec_at + (unsigned long long)i * 40;
    unsigned long long va, vsz, rsz, praw, span;
    if (!inb(s, 40, len)) return -1;
    vsz  = rd(b + s + 8, 4, 0);
    va   = rd(b + s + 12, 4, 0);
    rsz  = rd(b + s + 16, 4, 0);
    praw = rd(b + s + 20, 4, 0);
    /* A section's virtual span can exceed its raw span (.bss-alikes); only
     * the raw part is actually in the file, so clamp to it. */
    span = (vsz && vsz < rsz) ? vsz : rsz;
    if (rva >= va && rva - va < span) return (long long)(rva - va + praw);
  }
  return -1;
}

static int scan_pe(const unsigned char *b, size_t len) {
  unsigned long long pe, opt, ddir, imp_rva, sec_at;
  unsigned nsec, optsz, magic, machine;
  long long at;
  int plus, ndeps = 0, i;

  if (!inb(0x3c, 4, len)) return 4;
  pe = rd(b + 0x3c, 4, 0);
  if (!inb(pe, 24, len)) return 4;
  if (memcmp(b + pe, "PE\0\0", 4) != 0) return 4;

  machine = (unsigned)rd(b + pe + 4, 2, 0);
  nsec    = (unsigned)rd(b + pe + 6, 2, 0);
  optsz   = (unsigned)rd(b + pe + 20, 2, 0);
  opt     = pe + 24;
  if (!inb(opt, optsz, len) || optsz < 2) return 4;

  magic = (unsigned)rd(b + opt, 2, 0);
  if (magic == 0x20b) plus = 1;
  else if (magic == 0x10b) plus = 0;
  else return 4;

  printf("format=pe%s machine=%u\n", plus ? "64" : "32", machine);

  /* Data directory [1] is the import table. Its offset differs between PE32
   * and PE32+; a reader that hardcodes one reads garbage for the other. */
  ddir = opt + (plus ? 112 : 96);
  if (!inb(ddir + 8, 8, len)) return 4;
  imp_rva = rd(b + ddir + 8, 4, 0);
  if (imp_rva == 0) { printf("deps=0\n"); return 0; }   /* imports nothing */

  sec_at = opt + optsz;
  at = pe_rva2off(b, len, sec_at, nsec, imp_rva);
  if (at < 0) return 4;

  /* IMAGE_IMPORT_DESCRIPTOR is 20 bytes, terminated by an all-zero entry.
   * Cap the walk so a corrupt table cannot spin. */
  for (i = 0; i < 4096; i++) {
    unsigned long long d = (unsigned long long)at + (unsigned long long)i * 20;
    unsigned long long name_rva;
    long long noff;
    if (!inb(d, 20, len)) return 4;
    if (rd(b + d, 4, 0) == 0 && rd(b + d + 12, 4, 0) == 0 && rd(b + d + 16, 4, 0) == 0) break;
    name_rva = rd(b + d + 12, 4, 0);
    if (name_rva == 0) return 4;
    noff = pe_rva2off(b, len, sec_at, nsec, name_rva);
    if (noff < 0) return 4;
    if (!put_dep(b, len, (unsigned long long)noff)) return 4;
    ndeps++;
  }
  printf("deps=%d\n", ndeps);
  return 0;
}
