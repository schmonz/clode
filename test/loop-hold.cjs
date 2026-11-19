'use strict';
// loop-hold.cjs — the ONE judgement of "the async twin keeps the event loop turning", for every tjs probe that
// measures its longest timer gap (a 10 ms setInterval's maxGap) over a run of `ms` milliseconds.
//
// WHY NOT A WALL-CLOCK BOUND. Every such gate used to assert `maxGap < 600`. The gap scales with machine load, the
// fixed code's and the defect's alike: rg-walk's failed at 602 ms in the full suite on d40fd9b while passing alone, and
// under 16 CPU hogs the fixed probes below hold the loop up to 462 ms. What does not move with load is the SHARE of the
// run spent in its single longest hold, and a held loop (a defect) is most of the run.
//
// MEASURED (2026-11-19, darwin arm64, 8 cores, tjs; "load" = 16 CPU hogs plus a dd loop; "defect" for rg-walk = its
// BOM sniff's yield removed, for the others = every loop yield in rg-native.cjs made a microtask, so nothing hands the
// timers a turn). maxGap / run ms, and the share:
//   probe                                fixed alone           fixed loaded              defect alone          defect loaded
//   rg-walk 30,000 files                 112-123/3.2k  .038    455-497/14.1k  .035       1289-1408/3.3k .40    5283-5445/13k .41
//   rg-files --sort=modified 30,000      56-66/1.5-1.8k .043   344-353/7.6-10k .046      1725-1739/1.8k .95    10015/10.4k .96
//   rg-multiline -U -c 4 MB              38/6.5k  .006         220-222/32-38k .007       6668-6682/6.7k 1.0    34948/34.9k 1.0
//   rg-native maxBuffer, 4 rows          28-76/1.1-5.3k .027   111-462/5.3-36k .029      1251-6369/1.3-6.5k .98 7835-33099/7.9-33k .98
// Worst fixed share: 0.046. Best defect share: 0.40. SHARE_MAX = 0.15 (3.3x above, 2.7x below).
//
// A SECOND BOUND, independent of the run's length: a share can be diluted (a run made slower elsewhere hides a real
// multi-second hold under 0.15 of a long enough total). MS_MAX = 2,000 ms: 4.3x the worst fixed hold under load (462 ms)
// and below every loaded defect hold above (5,283 ms and up). It misses some unloaded defects (1,251 ms); the share
// catches those. Each bound covers the other's blind side: load inflates the ms, length dilutes the share.
//
// test/loop-hold.test.cjs's guard fails any test that asserts a loop gap in absolute ms instead of calling this.
const SHARE_MAX = 0.15;
const MS_MAX = 2000;

// null when the loop kept turning; otherwise the reason, naming both bounds' evidence.
function judgeHold({ maxGap, ms }) {
  if (!Number.isFinite(maxGap) || !Number.isFinite(ms) || ms <= 0) return `no usable measurement (maxGap ${maxGap}, ms ${ms})`;
  const share = maxGap / ms;
  const why = [];
  if (share >= SHARE_MAX) why.push(`${share.toFixed(3)} of the run in one stretch (bound ${SHARE_MAX}: fixed <= 0.046 under any load, a held loop >= 0.40)`);
  if (maxGap >= MS_MAX) why.push(`${maxGap} ms in one stretch (bound ${MS_MAX} ms: fixed <= 462 ms under any load measured)`);
  return why.length ? `the loop was held ${maxGap} ms of a ${ms} ms run: ${why.join('; ')}` : null;
}

module.exports = { judgeHold, SHARE_MAX, MS_MAX };
