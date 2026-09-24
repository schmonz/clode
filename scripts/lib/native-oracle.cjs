'use strict';
// Run a JS program INSIDE native Claude Code's own Bun runtime.
//
// Measured 2026-09-24: `BUN_OPTIONS="--preload prog.js" <native claude> --version` runs
// prog.js in native Bun (1.4.3 in 2.1.278) with the private Bun.ant.* namespace live,
// before Claude's own code starts. BUN_BE_BUN=1 is NOT honoured. This is a TEST/DEV
// instrument only; nothing in libexec/ may depend on it.
//
// SAFETY: stripped environment (PATH, a throwaway HOME, and our three variables only),
// and the wrapper exits the process as soon as the program returns, so Claude never
// reaches its credential, network or Keychain code.
//
// REFUSAL IS THE POINT. A preload that did not run looks exactly like "native had
// nothing to say", so every such case throws NativeOracleRefusal instead of returning.
//
// TWO RESOLVERS, not one, because they answer different questions (controller ruling
// R1, phase-3 task 1). resolveNativeClaude() is the FRAME gate's reference: it must be a
// SAME-VERSION native build (test/fidelity/interactive-frame-diff.test.cjs proves
// version equality against the quaude under test), so it consults only
// CLODE_NATIVE_CLAUDE, never CLODE_NATIVE_ORACLE — an operator pointing CLODE_NATIVE_ORACLE
// at 2.1.278 to get CellSegmenter must not silently become the frame gate's reference
// too, comparing a 251 quaude against a 278 native and reporting nonsense. resolveNativeOracle()
// is the TEXT oracle every other phase-3 consumer wants (this file's own tests, a future
// Unicode-table generator, the freshness gate): CLODE_NATIVE_ORACLE first (so an operator
// can point it at whichever build has the feature under test), falling back to
// resolveNativeClaude() when unset.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

class NativeOracleRefusal extends Error {
  constructor(msg) { super(msg); this.name = 'NativeOracleRefusal'; }
}

function resolveNativeClaude(env = process.env) {
  if (env.CLODE_NATIVE_CLAUDE) {
    return fs.existsSync(env.CLODE_NATIVE_CLAUDE) ? env.CLODE_NATIVE_CLAUDE : null;
  }
  const r = spawnSync('command', ['-v', 'claude'], { shell: true, encoding: 'utf8' });
  const p = (r.stdout || '').trim();
  return p && fs.existsSync(p) ? p : null;
}

// CLODE_NATIVE_ORACLE, else whatever resolveNativeClaude() finds. Existence-checked the
// same way: a CLODE_NATIVE_ORACLE naming a path that is not there returns null OUTRIGHT —
// it does NOT fall through to resolveNativeClaude(), because a caller who set it meant a
// SPECIFIC build (e.g. the one that has Bun.ant.CellSegmenter) and a silent fallback to
// whatever `claude` happens to be on PATH would answer a different question than the one
// asked.
function resolveNativeOracle(env = process.env) {
  if (env.CLODE_NATIVE_ORACLE) {
    return fs.existsSync(env.CLODE_NATIVE_ORACLE) ? env.CLODE_NATIVE_ORACLE : null;
  }
  return resolveNativeClaude(env);
}

function nativeVersion(bin) {
  const env = { ...process.env, DISABLE_AUTOUPDATER: '1' };
  delete env.NODE_PATH;
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', env, timeout: 60000 });
  return ((r.stdout || '') + (r.stderr || '')).split('\n')[0].trim();
}

function runInNative(bin, programSource, opts = {}) {
  if (!bin || !fs.existsSync(bin)) throw new NativeOracleRefusal(`native claude ${bin} does not exist`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-oracle-'));
  try {
    const prog = path.join(dir, 'prog.js');
    const outf = path.join(dir, 'out.json');
    const inf = path.join(dir, 'in.json');
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(inf, JSON.stringify(opts.input === undefined ? null : opts.input));
    fs.writeFileSync(prog, [
      "const fs = require('fs');",
      'let r;',
      'try {',
      "  const input = JSON.parse(fs.readFileSync(process.env.INF, 'utf8'));",
      '  const value = (function (input) {', programSource, '\n  })(input);',
      '  r = { ok: true, value };',
      '} catch (e) { r = { ok: false, error: String(e && e.stack || e) }; }',
      'fs.writeFileSync(process.env.OUTF, JSON.stringify(r));',
      'process.exit(0);',
    ].join('\n'));
    const env = { PATH: '/usr/bin:/bin', HOME: home, OUTF: outf, INF: inf, BUN_OPTIONS: `--preload ${prog}` };
    if (process.platform === 'win32') { env.USERPROFILE = home; env.SystemRoot = process.env.SystemRoot; }
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', env, timeout: opts.timeoutMs || 120000, maxBuffer: 64 * 1024 * 1024 });
    let raw = '';
    try { raw = fs.readFileSync(outf, 'utf8'); } catch { /* absent */ }
    if (!raw) {
      throw new NativeOracleRefusal(`preload did not run in ${bin} (no output; exit ${r.status}, `
        + `signal ${r.signal}); stdout: ${(r.stdout || '').slice(0, 200)} stderr: ${(r.stderr || '').slice(0, 400)}`);
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      throw new NativeOracleRefusal(`native output is not JSON (${e.message}): ${raw.slice(0, 200)}`);
    }
    if (!parsed.ok) throw new NativeOracleRefusal(`the program failed inside native: ${parsed.error}`);
    return parsed.value;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

module.exports = { resolveNativeClaude, resolveNativeOracle, nativeVersion, runInNative, NativeOracleRefusal };
