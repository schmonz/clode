'use strict';
// What a quaude --debug log says that native would not: the scan test/fidelity/debug-log-errors.test.cjs runs over
// quaude's log beside naude's, on the same scenario. Pure functions, no I/O, so the red lines that made it can be
// replayed against it verbatim.
//
// WHY. Three node-shim gaps sat in plain sight in quaude's own --debug log, each caught by a human reading one
// (2026-11-23): every first-party event batch failed on `zlib.gzipSync not implemented`; every start logged, once per
// bundled root, `CA certs: A bundled root does not parse: TypeError: not a function` (no crypto.X509Certificate); and
// every redirect-following axios request hung until "timeout of 5000ms exceeded" (a Writable that never ran _final).
// A fourth was found by this scan's first run: every first-party connection at startup failed "connect ETIMEDOUT"
// (connect-multiple abandoned a TLS handshake node would have kept). The drivers already ran a built quaude with
// --debug; nothing read what it wrote.
//
// THREE CHECKS, each a list of findings (empty is green):
//   shimFaults   any line, any level, in quaude's log that names a shim fault: node-shim's own branded errors,
//                QuickJS's nameless TypeErrors ("not a function", "not a constructor"), "not implemented".
//   timeouts     any line in quaude's log with a request-timeout shape that naude's log does not also have (a
//                request quaude sent and never finished: "timeout of Nms exceeded", ECONNABORTED, ETIMEDOUT, a
//                "fetch ... failed: timeout").
//   newErrors    every [ERROR] shape quaude logs that naude does not, unless KNOWN names it with its reason.
// A shape is a line less its timestamp, with numbers, paths and hex ids folded, so two runs of one fault agree.

const SHIM_FAULT = /node-shim:|\bnot a function\b|\bnot a constructor\b|\bnot implemented\b/i;
const TIMEOUT = /timeout of \d+ms exceeded|\bECONNABORTED\b|\bETIMEDOUT\b|failed: timeout\b/;
const LINE = /^\S+ \[(DEBUG|INFO|WARN|ERROR)\] ?/;

function shape(line) {
  return line.replace(LINE, (m, level) => `[${level}] `)
    .replace(/(?:[A-Za-z]:)?(?:\/[^\s'"():,]+)+/g, '<path>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+/g, 'N')
    .trim();
}
const lines = (log) => String(log).split(/\r?\n/).filter((l) => LINE.test(l));
const errorShapes = (log) => new Set(lines(log).filter((l) => /\[ERROR\]/.test(l.slice(0, 40))).map(shape));

// KNOWN quaude-only [ERROR] shapes: { shape: reason }. Each is a ruled or filed divergence, never "noise".
function findings({ quaude, naude, known = {} }) {
  const out = { shimFaults: [], timeouts: [], newErrors: [] };
  const naudeShapes = new Set(lines(naude).map(shape));
  for (const l of lines(quaude)) {
    if (SHIM_FAULT.test(l)) out.shimFaults.push(l);
    if (TIMEOUT.test(l) && !naudeShapes.has(shape(l))) out.timeouts.push(l);
  }
  const naudeErrors = errorShapes(naude);
  for (const s of errorShapes(quaude)) if (!naudeErrors.has(s) && !(s in known)) out.newErrors.push(s);
  return out;
}

module.exports = { findings, shape, SHIM_FAULT, TIMEOUT };
