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

/* Print a NUL-terminated string that must lie wholly inside the buffer.
 * Returns 0 if it runs off the end — a dependency name we cannot read is a
 * malformed file, not an absent dependency. */
static int put_dep(const unsigned char *b, size_t len, unsigned long long off) {
  unsigned long long i;
  if (off >= (unsigned long long)len) return 0;
  for (i = off; i < (unsigned long long)len; i++) if (!b[i]) break;
  if (i >= (unsigned long long)len) return 0;
  printf("dep=%s\n", (const char *)(b + off));
  return 1;
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
    if (vaddr >= va && vaddr - va < fsz) return (long long)(vaddr - va + off);
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

  if (len < 0x40) return 4;
  cls = b[4];
  be  = (b[5] == 2);
  if ((cls != 1 && cls != 2) || (b[5] != 1 && b[5] != 2)) return 4;
  w = (cls == 2) ? 8 : 4;

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
    }
  }
  if (nneeded > 0 && strtab_va == 0) return 4;  /* names we cannot resolve */

  strtab_off = nneeded ? elf_v2o(b, len, cls, be, phoff, phentsize, phnum, strtab_va) : 0;
  if (nneeded > 0 && strtab_off < 0) return 4;

  for (i = 0; i < (unsigned)nneeded; i++) {
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

static const char *cpu_name(unsigned long long t) {
  switch (t) {
    case 0x01000007ULL: return "x86_64";
    case 0x0100000cULL: return "arm64";
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
  unsigned long long hdrsz, ncmds, sizeofcmds, at, cputype;
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
  ncmds      = rd(b + base + 16, 4, be);
  sizeofcmds = rd(b + base + 20, 4, be);

  if (emit_format) printf("format=macho%d%s machine=%s\n", bits, be ? "be" : "le", cpu_name(cputype));
  else printf("slice=%s\n", cpu_name(cputype));

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

/* Task 4 fills this in. Returning 3 keeps the "unrecognized" contract
 * honest in the meantime — it must never return 0 without printing deps=. */
static int scan_pe(const unsigned char *b, size_t len) { (void)b; (void)len; return 3; }
