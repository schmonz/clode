'use strict';
// The hermeticity DECISION, separated from the I/O that feeds it.
//
// Pure by contract: test/guard.cjs requires a guard's scan() to do no I/O and
// hold no path literals, which is the seam that lets a known-bad input be fed
// through the real logic. scripts/build-tjs.cjs runs the same two functions on
// real depscan output, so the build and the suite cannot drift.
//
// CJS rather than .mjs so both build-tjs.cjs (via createRequire, as it already
// does for platform-tag.cjs) and the CJS test suite reach it unchanged, and so
// phase 4c's ESM->CJS conversion leaves it alone.

// The SAME list scripts/build-tjs.cjs uses for CMAKE_IGNORE_PREFIX_PATH.
// Kept here as the single definition and imported there, so the cmake
// ignore-list and the post-build denylist cannot drift -- which is exactly
// how /usr/pkg once went missing from one half and not the other, breaking
// native NetBSD.
//
// Why /usr/pkg belongs in the cmake half too (CMAKE_IGNORE_PREFIX_PATH only
// touches find_library/find_path/find_package, never find_program, so it
// cannot hide /usr/pkg/bin/{cmake,gmake,ninja,node} on NetBSD): see the long
// CMAKE_IGNORE_PREFIX_PATH comment in scripts/build-tjs.cjs, which records the
// incident. Do not drop a root from this list "to be safe" -- that is the
// drift the single definition exists to prevent.
//
// DENYLIST, not an allowlist -- deliberately. An earlier attempt allowlisted
// system prefixes (['/lib/', '/usr/lib/']) and would have broken two legs that
// are actually fine: glibc's dynamic linker is /lib64/ld-linux-x86-64.so.2,
// and '/lib64/...'.startsWith('/lib/') is FALSE (a sibling, not a child), so a
// perfectly good dependency got flagged on every native linux-x64-glibc build.
// A denylist of the SPECIFIC roots we forbid cannot produce that false
// positive: it fires only when a dependency resolves inside a package-manager
// prefix, which is exactly (and only) the hazard CMAKE_IGNORE_PREFIX_PATH
// exists to prevent. Do not "simplify" this back into an allowlist.
const PKG_MANAGER_ROOTS = ['/opt/pkg', '/opt/homebrew', '/usr/local', '/opt/local', '/sw', '/usr/pkg'];

// Parse depscan's line protocol into per-slice groups.
//
// A `deps=` line TERMINATES a group. A group without one never completed, and
// that is an error rather than an empty result: "parsed it and found none"
// (deps=0) and "could not read it" must never arrive here looking the same.
// The ldd path this replaces got that wrong -- OpenBSD's ldd prints a table
// parseLddDeps did not recognize, and an unrecognized output shape read as
// zero dependencies for as long as it existed.
// ONE message for every way a group can fail to close, so the two sites cannot
// drift into saying different things about the same condition.
function unterminated(what) {
  return `depscan output is incomplete: ${what} — the scan did not complete, which is NOT `
    + 'the same as finding no dependencies. Treat it as unverified.';
}

function parseDepscan(stdout) {
  const slices = [];
  let cur = null;
  let format = null;
  let declared = null;
  const start = (slice) => { cur = { slice, deps: [], runs: [] }; };
  for (const raw of String(stdout).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('format=')) {
      const tokens = line.slice(7).split(/\s+/);
      format = tokens[0];
      // A fat Mach-O DECLARES how many slices follow. Capture it -- an earlier
      // revision split the line and threw everything after the format token
      // away, which is what let the incident below through.
      const n = tokens.find((t) => t.startsWith('slices='));
      if (n) {
        declared = Number(n.slice(7));
        if (!Number.isInteger(declared) || declared < 0) {
          throw new Error(`depscan output has an unparseable slice count: ${JSON.stringify(line)}`);
        }
      }
      continue;
    }
    if (line.startsWith('slice=')) {
      // A new slice may only begin once the previous one was TERMINATED. Simply
      // starting a fresh group here would discard the unterminated one -- and
      // the group being discarded is exactly the group carrying the finding.
      if (cur !== null) throw new Error(unterminated(`a new ${line} began while the previous group was still open`));
      start(line.slice(6));
      continue;
    }
    if (line.startsWith('dep=')) { if (!cur) start(null); cur.deps.push(line.slice(4)); continue; }
    if (line.startsWith('run=')) { if (!cur) start(null); cur.runs.push(line.slice(4)); continue; }
    if (line.startsWith('deps=')) {
      if (!cur) start(null);
      const n = Number(line.slice(5));
      if (!Number.isInteger(n) || n !== cur.deps.length) {
        throw new Error(`depscan output is inconsistent: ${line} but ${cur.deps.length} dep= line(s) were seen`);
      }
      slices.push(cur);
      cur = null;
      continue;
    }
    throw new Error(`depscan output has an unrecognized line: ${JSON.stringify(line)}`);
  }
  if (cur !== null) throw new Error(unterminated('the output ended without a deps= line'));
  // The header PROMISED a slice count; every one of them must have arrived.
  // REPRODUCED 2026-09-17 on the committed tree: a 2-slice universal whose
  // SECOND slice was corrupt printed `format=macho-fat slices=2`, then slice
  // 0's complete, hermetic-looking group, then exited 4 -- and this parser,
  // which discarded `slices=2`, read that truncated transcript as one clean
  // slice with zero findings. The /opt/pkg dependency in slice 1 was simply
  // not there. depscan.c no longer emits a partial fat transcript at all (it
  // scans every slice once with output suppressed before printing anything),
  // but this check closes the hole AT THE PARSER, independent of the exit
  // code: a caller that forgets to check the status, or drifted output from a
  // future depscan, still cannot turn a missing slice into a clean verdict.
  // Same shape as the deps=N vs dep= count check above, which is what caught
  // the protocol-forging DT_NEEDED name.
  if (declared !== null && slices.length !== declared) {
    throw new Error(`depscan output is incomplete: the header declared slices=${declared} but `
      + `${slices.length} slice group(s) were terminated — the scan did NOT cover every slice, `
      + 'which is NOT the same as finding no dependencies. Treat it as unverified.');
  }
  if (slices.length === 0) {
    throw new Error('depscan produced no deps= line at all — nothing was verified');
  }
  return { format, slices };
}

// Does `p` sit at or inside `root`? Path-aware, so /usr/local matches
// /usr/local/lib but NOT a sibling like /usr/localetest. The same
// `p === root || p.startsWith(root + '/')` shape the pre-depscan denylist
// used, kept verbatim: it is the reason the check never flagged /lib64 for
// /lib, and the reason it will not flag a merely-prefix-sharing sibling now.
function underRoot(p, root) {
  return p === root || p.startsWith(`${root}/`);
}

// One finding per offending dependency or search path. Both halves matter and
// neither subsumes the other: a Mach-O records the ABSOLUTE install name of
// each library it links (the dep itself names the prefix), while an ELF
// usually records a bare SONAME plus an RPATH/RUNPATH — there the dep has no
// prefix to judge and the hazard lives entirely in the search path.
//
// WRITE DOWN WHAT THE ELF HALF NO LONGER CATCHES. On a NATIVE ELF leg the old
// ldd-based check resolved SONAMEs through the HOST loader, so it could flag a
// dependency that RESOLVED into a package-manager prefix even with no RPATH
// baked into the file. This check cannot, and should not: DT_NEEDED is a bare
// SONAME, and where it resolves is a fact about the machine doing the looking,
// not about the artifact — which is the whole reason the check now works on
// the 19 legs no host tool could inspect at all. The trade is hugely positive,
// but it IS a narrowed class on the ~10 native ELF legs, and narrowing it
// silently is the kind of thing this file exists to refuse to do.
//
// It follows that ALL ELF detection now rests on DT_RPATH/DT_RUNPATH being
// present in the shipped engine. That holds today only because cmake bakes the
// build-tree RPATH by default and the engine we ship IS the build-tree binary;
// nothing in this repo sets CMAKE_SKIP_BUILD_RPATH. A future
// -DCMAKE_SKIP_BUILD_RPATH=ON would blind the ELF half completely with no test
// going red — if you are about to add it, this comment is the reason not to,
// or the reason to replace this half with something that survives it first.
function hermeticityFindings(parsed, roots) {
  const findings = [];
  for (const s of parsed.slices) {
    const where = s.slice ? ` (slice ${s.slice})` : '';
    for (const dep of s.deps) {
      if (!dep.startsWith('/')) continue;      // a bare SONAME has no prefix to judge
      const hit = roots.find((r) => underRoot(dep, r));
      if (hit) {
        findings.push(`dynamically depends on ${dep}${where}, which resolves inside the `
          + `package-manager prefix ${hit}`);
      }
    }
    for (const run of s.runs) {
      const hit = roots.find((r) => underRoot(run, r));
      if (hit) {
        findings.push(`carries the search path ${run}${where} (RPATH/RUNPATH), which is inside `
          + `the package-manager prefix ${hit}`);
      }
    }
  }
  return findings;
}

module.exports = { PKG_MANAGER_ROOTS, parseDepscan, hermeticityFindings, underRoot };
