'use strict';
// A LOCAL NAMED AFTER A PLATFORM MACRO compiles on the box that wrote it and nowhere else.
//
// CI 45343043007: txiki-fetch-proxy.patch declared `const char *s_host` in ws.c and httpclient.c.
// <winsock2.h> and illumos/Solaris <netinet/in.h> #define s_host as in_addr's S_un.S_un_b.s_b2, so the
// windows-amd64/arm64, omnios, openindiana and solaris legs failed to compile while darwin, linux and
// NetBSD built it clean. The CLASS: an identifier some supported platform's system header defines as an
// object-like macro, DECLARED (a variable, parameter or field) by C we add to the engine. Using such a
// name (`errno = e`, `x.s_addr`) is fine; declaring one is not.
//
// So every `+` line of spike/quickjs/patches/*.patch is scanned for a declaration of a name on the list
// below. The list is the home for the next one: each entry says which header defines it.
//
// BLIND SPOTS, stated: C that scripts/build-tjs.cjs injects through its fixup* string edits is not
// scanned (it is JS text, not a patch); a declaration split across lines, or a name from a header this
// list does not know, is not seen. The engine legs in CI are the proof; this makes the known class fail
// in the suite on the author's own box, before a CI round trip.
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');

const PATCHES = path.join(__dirname, '..', 'spike', 'quickjs', 'patches');

const MACROS = {
  s_addr: 'winsock2.h, illumos/Solaris netinet/in.h (in_addr union member)',
  s_host: 'winsock2.h, illumos/Solaris netinet/in.h',
  s_net: 'winsock2.h, illumos/Solaris netinet/in.h',
  s_imp: 'winsock2.h, illumos/Solaris netinet/in.h',
  s_impno: 'winsock2.h, illumos/Solaris netinet/in.h',
  s_lh: 'winsock2.h, illumos/Solaris netinet/in.h',
  h_addr: 'netdb.h (h_addr_list[0]) everywhere',
  small: 'Windows rpcndr.h (#define small char)',
  hyper: 'Windows rpcndr.h',
  interface: 'Windows objbase.h (#define interface struct)',
  near: 'Windows minwindef.h',
  far: 'Windows minwindef.h',
  sun: 'gcc on Solaris/illumos predefines sun=1 outside strict ISO modes',
  unix: 'gcc predefines unix=1 outside strict ISO modes',
  linux: 'gcc on linux predefines linux=1 outside strict ISO modes',
  errno: 'errno.h, a macro on every libc',
  stdin: 'stdio.h, a macro on several libcs',
  stdout: 'stdio.h, a macro on several libcs',
  stderr: 'stdio.h, a macro on several libcs',
};

// A type-ish token (or `*`) then the name then a declarator end. return/case/else/goto/sizeof are not types.
const DECL = new RegExp(
  String.raw`(?:\b(?!return\b|case\b|else\b|goto\b|sizeof\b)[A-Za-z_]\w*(?:\s+|\s*\*+\s*)|\*\s*)\b(`
  + Object.keys(MACROS).join('|') + String.raw`)\b\s*(?:=|;|,|\[|\))`, 'g');

function code(line) {
  return line
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/\/\*.*?\*\//g, '')
    .replace(/\/\*.*$/, '')
    .replace(/\/\/.*$/, '');
}

// PURE: { files: [{ name, text }] } -> findings.
function scanPatches({ files }) {
  const findings = [];
  let examined = 0;
  for (const { name, text } of files) {
    text.split('\n').forEach((line, i) => {
      if (!line.startsWith('+') || line.startsWith('+++')) return;
      const c = code(line.slice(1));
      const t = c.trim();
      if (t.startsWith('*') || t.startsWith('#')) return;
      examined++;
      DECL.lastIndex = 0;
      for (let m = DECL.exec(c); m; m = DECL.exec(c)) {
        findings.push(`${name}:${i + 1} declares \`${m[1]}\`, a macro in ${MACROS[m[1]]}: rename it | ${line.trim().slice(0, 100)}`);
      }
    });
  }
  return { findings, examined, note: 'added C lines of the engine patches, for declarations named after a platform macro' };
}

const guard = defineGuard({
  name: 'engine-patch-macro-names',
  floor: 1000,
  read: () => ({
    files: fs.readdirSync(PATCHES).filter((f) => f.endsWith('.patch')).sort()
      .map((f) => ({ name: f, text: fs.readFileSync(path.join(PATCHES, f), 'utf8') })),
  }),
  scan: scanPatches,
  // The lines CI 45343043007 failed on, verbatim, padded past the floor with clean C.
  control: () => ({
    files: [{
      name: 'txiki-fetch-proxy.patch',
      text: Array.from({ length: 1000 }, () => '+    int ok = 1;').join('\n')
        + '\n+    const char *s_host = JS_ToCString(ctx, host);\n',
    }],
  }),
});

guardTests(guard);
