'use strict';
// node:perf_hooks — the -p bundle reads `require('perf_hooks').performance`
// (OpenTelemetry + timing helpers). txiki exposes a WHATWG `performance` global
// with .now()/.timeOrigin, which IS Node's perf_hooks.performance surface for the
// members the bundle uses. Characterized by test/node-shim-core.test.cjs
// (perf_hooks row).
//
// DIVERGENCE (deferred): PerformanceObserver / monitorEventLoopDelay / marks &
// measures are NOT implemented — the -p path only reads performance.now()/
// timeOrigin. If a boot constructs a PerformanceObserver or takes measures, that
// is a later wall; wire it test-first then.
module.exports = {
  performance: globalThis.performance,
};
module.exports.default = module.exports;
