'use strict';

const WATCH_AT = 3; // quaude ÷ naude at/above this = worth watching
const HOT_AT = 15; // at/above this = JIT-sensitive hotspot to offload

function summarize(samplesMs) {
  if (!Array.isArray(samplesMs) || samplesMs.length === 0) {
    throw new Error('summarize: no samples');
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const p90 = sorted[Math.ceil(0.9 * n) - 1];
  return { n, min: sorted[0], median, p90 };
}

function ratio(a, b) {
  return a / b;
}

function classify(r) {
  if (r >= HOT_AT) return 'HOT';
  if (r >= WATCH_AT) return 'WATCH';
  return 'OK';
}

module.exports = { summarize, ratio, classify, WATCH_AT, HOT_AT };
