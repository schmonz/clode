'use strict';
// .github/actions/netbsd-crossbuild: the twelve NetBSD cross legs' `build.sh tools`.
//
// Run 44460009323: every cross leg went red at once in external/gpl2/gmake/dist/ar.c
// (`passing argument 2 of 'ar_scan' from incompatible pointer type`). ubuntu-latest had
// moved to 26.04, whose gcc 15 defaults to -std=gnu23 — where K&R `()` means `(void)` —
// and the tools build had not run on the new image because the toolchain cache key did
// not name the HOST compiler: a restored gcc-13 toolchain hid the break until the cache
// was evicted. This guard pins both halves: the host compile's language, and the key.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');

const ACTION = path.join(__dirname, '..', '.github/actions/netbsd-crossbuild/action.yml');

function scanNetbsdCrossbuild({ yml }) {
  const findings = [];
  let examined = 0;
  const check = (ok, why) => { examined++; if (!ok) findings.push(why); };
  // Executable lines only: the comments explain the flag they decline to use.
  const code = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  const calls = code.match(/\.\/build\.sh -m [^\n]*/g) || [];
  check(calls.length >= 3, `expected the tools/makewrapper/distribution build.sh calls, found ${calls.length}`);
  for (const c of calls) check(c.includes('"${HOSTCFLAGS[@]}"'), `build.sh call without HOST_CFLAGS: ${c.trim()}`);
  check(/HOSTCFLAGS=\(-V "HOST_CFLAGS=-O -std=gnu17"\)/.test(code), 'HOST_CFLAGS is not "-O -std=gnu17"');
  // The TARGET side stays the toolchain's own, and the fix is the language version,
  // never a demoted diagnostic.
  check(!/-V "?(CFLAGS|COPTS|CPPFLAGS)=/.test(code), 'a target-side flag override crept in');
  check(!/-Wno-error|-Wno-incompatible-pointer-types|-fpermissive/.test(code), 'a diagnostic was silenced instead of fixing the language version');

  const key = (code.match(/^\s*key: (netbsd-crossbuild-.*)$/m) || [])[1] || '';
  check(key !== '', 'no netbsd-crossbuild cache key line found');
  check(key.includes('${{ steps.hostcc.outputs.id }}'), `cache key omits the host compiler identity: ${key}`);
  for (const axis of ['inputs.machine', 'inputs.arch', 'inputs.src-rev', 'inputs.sysroot-mode']) {
    check(key.includes(axis), `cache key lost the ${axis} axis: ${key}`);
  }
  // The identity comes from the compiler build.sh actually uses (HOST_CC defaults to cc),
  // is printed, and is computed BEFORE the restore that consumes it.
  const hostcc = code.indexOf('id: hostcc');
  const restore = code.indexOf('id: nbcache');
  check(hostcc >= 0 && hostcc < restore, 'the host compiler identity is not computed before the cache restore');
  const step = hostcc >= 0 ? code.slice(hostcc, restore) : '';
  check(/cc --version/.test(step), 'the host compiler identity is not derived from `cc --version`');
  check(/echo "build\.sh host compiler: \$V"/.test(step), 'the host compiler is not printed to the log');
  // No restore-keys: a rolling prefix restores another compiler's toolchain.
  check(!/restore-keys/.test(code), 'restore-keys would let a different host compiler\'s toolchain restore');
  return { findings, examined };
}

const netbsdCrossbuildGuard = defineGuard({
  name: 'netbsd-crossbuild-host-compiler',
  read: () => ({ yml: fs.readFileSync(ACTION, 'utf8') }),
  scan: scanNetbsdCrossbuild,
  // 3 build.sh calls x1 + 1 calls-count + 3 flag checks + 1 key-present + 1 hostcc + 4 axes
  // + 3 hostcc-step + 1 restore-keys = 17.
  floor: 17,
  // The action as run 44460009323 ran it: no HOST_CFLAGS, a compiler-blind -v1 key.
  control: () => ({
    yml: [
      '    - name: Restore the build.sh toolchain + sysroot',
      '      id: nbcache',
      '        key: netbsd-crossbuild-${{ inputs.machine }}-${{ inputs.arch }}-${{ inputs.src-rev }}${{ inputs.sysroot-mode == \'light\' && \'-light\' || \'\' }}-v1',
      '        ./build.sh -m "${{ inputs.machine }}" "${ARCHOPT[@]}" -U -T "$TOOL" -D "$DEST" -j "$J" tools',
      '          ./build.sh -m "${{ inputs.machine }}" "${ARCHOPT[@]}" -U -T "$TOOL" -D "$DEST" -j "$J" makewrapper',
      '          ./build.sh -m "${{ inputs.machine }}" "${ARCHOPT[@]}" -U -T "$TOOL" -D "$DEST" -j "$J" distribution',
    ].join('\n'),
  }),
});
guardTests(netbsdCrossbuildGuard);

test('the guard reports the specific gcc-15 regressions, not just "something"', () => {
  const r = scanNetbsdCrossbuild(netbsdCrossbuildGuard.control());
  assert.ok(r.findings.some((f) => f.startsWith('build.sh call without HOST_CFLAGS')), r.findings.join('\n'));
  assert.ok(r.findings.some((f) => f.startsWith('cache key omits the host compiler')), r.findings.join('\n'));
  const silenced = scanNetbsdCrossbuild({ yml: fs.readFileSync(ACTION, 'utf8').replace('"HOST_CFLAGS=-O -std=gnu17"', '"HOST_CFLAGS=-O -std=gnu17 -Wno-error=incompatible-pointer-types"') });
  assert.ok(silenced.findings.some((f) => f.includes('silenced')), silenced.findings.join('\n'));
});
