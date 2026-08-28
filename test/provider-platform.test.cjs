'use strict';
// THE PROVIDER-PLATFORM GATE — "was this graph carved from a binary for the target
// we are building?"
//
// Bun constant-folds `process.platform` at carve time, so a provider binary does not
// produce a portable graph: it produces a graph for ITS OWN platform, with every other
// platform's branches dead-coded away. A darwin quaude fused from a linux carve is not
// "mostly right" — upstream's entire macOS credential store is simply absent from it.
//
// That shipped. The 2026-08-27 quaude contained ZERO of the three markers a darwin carve
// always carries (`[keychain] read failed`, `[keychain] readAsync failed`, `exceeds
// security -i stdin limit`), so it could not read the login Keychain, fell back to a
// stale ~/.claude/.credentials.json, and failed every turn with `401 OAuth access token
// has been revoked`. --version, --help, the mock PONG smoke and the CI matrix were all
// green on it, because none of them reads a credential.
//
// The mechanism that allowed it: clode-extract.cjs keys its cache on the VERSION alone
// (`~/.cache/clode/2.1.243/`) and guards reuse with the EXTRACTOR's signature. Neither
// encodes the provider's platform, so extracting a linux provider for version X silently
// poisons every later darwin build of X. Same bug class as the templates cache key that
// shipped a sha256 mismatch — a key missing a dimension that changes the content.
//
// Two layers, same doctrine as test/extract-bundle-format.test.cjs:
//
//   1. SELF-CONTAINED (always runs): synthetic executable headers prove the detector
//      names each platform from the bytes rather than from a filename or the host.
//
//   2. REAL PROVIDER (skips when absent): the provider this checkout would actually
//      build against must report THIS host's platform. On a mac that is 'darwin'; if it
//      says otherwise, the cache is poisoned and a build from it would ship the defect
//      above.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ex = require('../libexec/extract-claude-js.cjs');

// Real first bytes of each container. Mach-O 64 little-endian (arm64/x86_64 macOS),
// ELF with its OSABI byte at e_ident[7], and PE/COFF's 'MZ'. Kept as literal bytes so
// the test asserts on the WIRE format, not on a constant the implementation also uses.
const HEADERS = {
  'macho64-le':   { bytes: [0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01], want: 'darwin' },
  'macho64-be':   { bytes: [0xfe, 0xed, 0xfa, 0xcf, 0x00, 0x00, 0x00, 0x12], want: 'darwin' },
  'macho-fat':    { bytes: [0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02], want: 'darwin' },
  'elf-sysv':     { bytes: [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00], want: 'linux' },
  'elf-linux':    { bytes: [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x03], want: 'linux' },
  'elf-freebsd':  { bytes: [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x09], want: 'freebsd' },
  'elf-openbsd':  { bytes: [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x0c], want: 'openbsd' },
  'elf-netbsd':   { bytes: [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x02], want: 'netbsd' },
  'pe':           { bytes: [0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00], want: 'win32' },
};

test('providerPlatformOf names the platform from the container bytes', () => {
  assert.strictEqual(typeof ex.providerPlatformOf, 'function',
    'extract-claude-js.cjs must export providerPlatformOf(binpath)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-provplat-'));
  try {
    for (const [name, { bytes, want }] of Object.entries(HEADERS)) {
      // Pad past any plausible header read so a short-file guard cannot pass by accident.
      const buf = Buffer.concat([Buffer.from(bytes), Buffer.alloc(4096, 0)]);
      const p = path.join(dir, name);
      fs.writeFileSync(p, buf);
      assert.strictEqual(ex.providerPlatformOf(p), want, `${name} should detect as ${want}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('providerPlatformOf refuses to guess at an unrecognized container', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-provplat-'));
  try {
    const p = path.join(dir, 'not-an-executable');
    fs.writeFileSync(p, Buffer.alloc(4096, 0x41));
    // NOT the host's platform, and NOT a throw: an honest null the caller can refuse on.
    // Defaulting to the host is exactly how a linux carve passes for darwin.
    assert.strictEqual(ex.providerPlatformOf(p), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// LAYER 2 — the provider this checkout would really build from.
function resolveProvider() {
  if (process.env.CLODE_CLAUDE_BIN && fs.existsSync(process.env.CLODE_CLAUDE_BIN)) {
    return process.env.CLODE_CLAUDE_BIN;
  }
  const vdir = path.join(os.homedir(), '.local', 'share', 'claude', 'versions');
  if (!fs.existsSync(vdir)) return null;
  const found = fs.readdirSync(vdir)
    .map((n) => path.join(vdir, n))
    .filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } })
    .sort();
  return found.length ? found[found.length - 1] : null;
}

test('the real provider carves for THIS host, not another platform', (t) => {
  const bin = resolveProvider();
  if (!bin) return t.skip('no provider binary resolved (set CLODE_CLAUDE_BIN)');
  const got = ex.providerPlatformOf(bin);
  assert.strictEqual(got, process.platform,
    `provider ${bin} is a ${got} binary but this host is ${process.platform} — `
    + 'a graph carved from it would have this platform\'s branches dead-coded away');
});
