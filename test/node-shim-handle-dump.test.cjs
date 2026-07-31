'use strict';
// CLODE_SHIM_HANDLE_DUMP=1 diagnostic (darwin-ppc -p stall investigation): a
// SIGUSR2 handler in the loader that dumps every live libuv handle via
// globalThis.__tjs_dump_handles(), so a stalled/parked process can be asked
// from the outside whether the event loop actually has active work queued.
// Two contracts, exercised against the real tjs binary:
//   1. enabled: sending SIGUSR2 prints a "[handles]" header plus at least one
//      handle line on stderr.
//   2. unset: sending SIGUSR2 prints NOTHING (proving the feature is inert
//      with no listener/output/cost when the env var is absent).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { tjsPath, skipUnlessTjs, LOADER } = require('./node-shim-helper.cjs');

const writeProg = (name, body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-handledump-'));
  const f = path.join(dir, name);
  fs.writeFileSync(f, body);
  return f;
};

// Spawn PROG under tjs+loader with the given extra env; collect stdout/stderr.
function spawnLoader(prog, env = {}) {
  const child = spawn(tjsPath(), ['run', LOADER, prog], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
  const waitFor = (pred, ms, what) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); res(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout waiting for ${what}; out=${JSON.stringify(out)} err=${JSON.stringify(err)}`)); }
    }, 50);
  });
  return { child, exited, waitFor, getOut: () => out, getErr: () => err };
}

const PROG = `
console.log('ready');
setInterval(() => {}, 1000); // keep the loop alive to dispatch/observe SIGUSR2
setTimeout(() => process.exit(0), 6000); // fail-safe so the test never hangs
`;

test('CLODE_SHIM_HANDLE_DUMP=1: SIGUSR2 dumps handles to stderr', async (t) => {
  if (skipUnlessTjs(t)) return;
  const prog = writeProg('dump-on.cjs', PROG);
  const s = spawnLoader(prog, { CLODE_SHIM_HANDLE_DUMP: '1' });
  try {
    await s.waitFor(() => s.getOut().includes('ready'), 5000, 'ready');
    execFileSync('kill', ['-USR2', String(s.child.pid)]);
    // Give the signal a moment to be delivered and dispatched.
    await s.waitFor(() => /\[handles\]/.test(s.getErr()), 5000, '[handles] header');
    const err = s.getErr();
    assert.match(err, /\[handles\]/);
    // At least one handle line beyond the header (the loop always has the
    // setInterval/setTimeout handles above alive while dumping).
    const afterHeader = err.slice(err.indexOf('[handles]') + '[handles]'.length);
    assert.ok(afterHeader.trim().length > 0, `expected handle lines after header; err=${err}`);
  } finally {
    try { s.child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

test('CLODE_SHIM_HANDLE_DUMP unset: SIGUSR2 is inert (no output)', async (t) => {
  if (skipUnlessTjs(t)) return;
  const prog = writeProg('dump-off.cjs', PROG);
  const env = { ...process.env };
  delete env.CLODE_SHIM_HANDLE_DUMP;
  const child = spawn(tjsPath(), ['run', LOADER, prog], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  try {
    await new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (out.includes('ready')) { clearInterval(iv); res(); }
        else if (Date.now() - t0 > 5000) { clearInterval(iv); rej(new Error(`timeout waiting for ready; out=${JSON.stringify(out)}`)); }
      }, 50);
    });
    execFileSync('kill', ['-USR2', String(child.pid)]);
    // No handler is armed, so nothing should appear; give it the same grace
    // period the positive case uses before asserting silence.
    await new Promise((res) => setTimeout(res, 500));
    assert.strictEqual(err, '', `expected no stderr output; err=${JSON.stringify(err)}`);
    assert.ok(!/\[handles\]/.test(out), `expected no [handles] output; out=${JSON.stringify(out)}`);
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});
