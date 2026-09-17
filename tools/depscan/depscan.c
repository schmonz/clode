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

/* Task 2 fills these in. Returning 3 keeps the "unrecognized" contract
 * honest in the meantime — it must never return 0 without printing deps=. */
static int scan_elf(const unsigned char *b, size_t len) { (void)b; (void)len; return 3; }
static int scan_macho(const unsigned char *b, size_t len) { (void)b; (void)len; return 3; }
static int scan_pe(const unsigned char *b, size_t len) { (void)b; (void)len; return 3; }
