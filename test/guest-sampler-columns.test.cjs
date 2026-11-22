'use strict';
// The in-guest PROGRESS sampler (spike/quickjs/qemu/ci-guest-smoke.sh) must print the columns
// that say WHO holds memory, not only what is resident. Run 45005386065 (netbsd-sparc, 2.1.330)
// died "template-tjs killed: out of swap" while fam_rss fell and swap_used rose, and RSS alone
// could not name the holder; nor could it rule the scratch filesystem in or out. So each tick
// carries per-process VSZ (resident + swapped) and a df of the build's TMPDIR with its device.
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');

const SCRIPT = path.join(__dirname, '..', 'spike', 'quickjs', 'qemu', 'ci-guest-smoke.sh');

// PURE. Each column checked with its own regex literal over the script's bytes.
function scanSampler({ src }) {
  const findings = [];
  const checks = [
    [/ps -axo rss,vsz,comm/.test(src), 'the sampler must read VSZ beside RSS (ps -axo rss,vsz,comm)'],
    [/fam_vsz_kb=/.test(src), 'PROGRESS must print the family VSZ (fam_vsz_kb=)'],
    [/procs\(rss\/vsz kb\)=/.test(src), 'PROGRESS must print each process\'s rss/vsz, so the holder is named'],
    [/df -k "\$TMPD"/.test(src), 'the sampler must df the build\'s scratch dir (TMPDIR or /tmp)'],
    [/ tmp=%s/.test(src), 'PROGRESS must print the scratch filesystem\'s device and usage (tmp=)'],
  ];
  for (const [ok, why] of checks) if (!ok) findings.push(why);
  return { findings, examined: checks.length, note: 'columns the in-guest PROGRESS sampler must print' };
}

const guard = defineGuard({
  name: 'guest-sampler-names-the-holder',
  floor: 5,
  read: () => ({ src: fs.readFileSync(SCRIPT, 'utf8') }),
  scan: scanSampler,
  // The sampler as it was when the sparc leg died: RSS and swap totals only.
  control: () => ({ src: 'ps -axo rss,comm | awk \'{ printf "PROGRESS t=%ss fam_rss_kb=%d swap_used_kb=%s" }\'' }),
});

guardTests(guard);
