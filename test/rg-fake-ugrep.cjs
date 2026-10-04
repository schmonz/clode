'use strict';
// A stand-in ugrep, for the tests that drive quaude's rg end to end through the spawn surfaces on a
// host with no ugrep (CI's runners have none until the grep-native plan's Task 11 provisions one).
// It answers exactly the three calls quaude's rg makes of ugrep (libexec/rg-native.cjs), the way
// ugrep 7.8.2 answers them, for PLAIN LITERAL patterns only (anything else exits 2, so a test that
// strays from what it can answer fails loudly):
//   --version                                       `ugrep 7.8.2 ...`, at quaude's floor
//   -r [...] -l --null -e '' -- TARGET              the walk's listing: every non-empty regular file
//                                                   under TARGET (dot names only under -.), `.`'s bare
//                                                   and any other target's joined to it, NUL-ended; a
//                                                   file or directory it cannot read is 7.8.2's warning
//                                                   (`ugrep: warning: cannot read X: Permission
//                                                   denied`, `cannot open directory X: ...`) and exit 2
//   -Y -H --null --format=[%u]%F%b %e%~ -e LIT -- FILES   the plumbing's records (%u: one per line)
// FAKE_UGREP_SLOW_MS in its environment makes the listing sleep that long first, so a test can end a
// search while ugrep is still running. Its own interpreter is the node running the tests (a shebang),
// so it is POSIX-only, as the shell stand-ins beside it are.
const fs = require('node:fs');
const path = require('node:path');

const BODY = String.raw`
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
if (a[0] === '--version') { process.stdout.write('ugrep 7.8.2 fake-for-tests\n'); process.exit(0); }
const dd = a.indexOf('--');
const opts = a.slice(0, dd), files = a.slice(dd + 1);
const e = opts[opts.indexOf('-e') + 1];
const go = () => {
  if (opts.includes('-r')) {
    const hidden = opts.includes('-.'), T = files[0], out = [];
    const prefix = T === '.' || T === './' ? '' : T.replace(/\/+$/, '') + '/';
    let warned = false;
    const warn = (what, r, e) => { warned = true; process.stderr.write('ugrep: warning: cannot ' + what + ' ' + prefix + r + ': ' + (e.code === 'EACCES' ? 'Permission denied' : e.message) + '\n'); };
    const walk = (d, rel) => {
      let names;
      try { names = fs.readdirSync(d).sort(); } catch (e) { warn('open directory', rel, e); return; }
      for (const n of names) {
        if (!hidden && n.startsWith('.')) continue;
        const p = path.join(d, n), r = rel ? rel + '/' + n : n, st = fs.lstatSync(p);
        if (st.isDirectory()) walk(p, r);
        else if (st.isFile() && st.size) {
          try { fs.closeSync(fs.openSync(p, 'r')); out.push(prefix + r + '\0'); } catch (e) { warn('read', r, e); }
        }
      }
    };
    walk(T, '');
    process.stdout.write(out.join(''));
    process.exit(warned ? 2 : out.length ? 0 : 1);
  }
  const fmt = opts.find((o) => o.startsWith('--format=')) || '';
  if (/[\\.+*?()|[\]{}^$]/.test(e)) { process.stderr.write('fake ugrep: plain literals only\n'); process.exit(2); }
  const lit = Buffer.from(e), out = [];
  for (const f of files) {
    const b = fs.readFileSync(f);
    let lastLine = -2;
    for (let i = b.indexOf(lit); i !== -1; i = b.indexOf(lit, i + lit.length)) {
      const ls = i === 0 ? -1 : b.lastIndexOf(10, i - 1);
      if (fmt.includes('%u') && ls === lastLine) continue;
      lastLine = ls;
      out.push(Buffer.from(f + '\0' + i + ' ' + (i + lit.length) + '\n'));
    }
  }
  process.stdout.write(Buffer.concat(out));
  process.exit(out.length ? 0 : 1);
};
const slow = Number(process.env.FAKE_UGREP_SLOW_MS || 0);
if (slow && opts.includes('-r')) setTimeout(go, slow); else go();
`;

// Writes the stand-in as DIR/NAME and returns its path.
function writeFakeUgrep(dir, name = 'ugrep') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!${process.execPath}\n${BODY}`, { mode: 0o755 });
  return p;
}

module.exports = { writeFakeUgrep };
