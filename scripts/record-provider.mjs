#!/usr/bin/env node
// Record WHICH Claude Code binary a CI job installed, so a later step can prove it still has it.
//
// CI 45354661143 and 45381323279 (linux-x64-pty): the pinned 2.1.330 was installed at 11:13 and
// decoded fine there (reproduced: npm 11 and npm 12, node 24.22, linux-x64), yet the step that staged
// it at 12:06 found a binary it could not decode ("byteCount runs off the front of the file"). Between
// the two, the job's tests drove native Claude Code interactively; nothing recorded what the file was,
// so nothing could say whether it had changed. The CLASS: an instrument mutated mid-job. Every native
// a job installs is such an instrument: the provider (`npm i -g`, resolved by find-provider.mjs) and
// each oracle installed on its own (`npm i --prefix`, e.g. CLODE_NATIVE_ORACLE). Read from the carve
// (2.1.330): a native whose path holds /node_modules/@anthropic-ai/ takes itself for an npm-global
// install, and its TUI updater runs `npm install -g @anthropic-ai/claude-code@<latest>`, which rewrites
// the GLOBAL provider whichever native ran it; test/updater-off.cjs is the prevention, this the detection.
//
//   node scripts/record-provider.mjs                  record the provider find-provider resolves, as PROVIDER
//   node scripts/record-provider.mjs --as NAME BIN    record BIN as NAME (e.g. NATIVE_ORACLE)
//   node scripts/record-provider.mjs --verify [NAME...] every instrument this job recorded (or each NAME) is still the
//                                                     file it was; exit 1 naming each one that is not, 2 for a NAME
//                                                     never recorded
//
// A record is CLODE_<NAME>_RECORDED_{PATH,SIZE,SHA256}, appended to $GITHUB_ENV (no $GITHUB_ENV: printed, nothing
// written). verifyRecorded() is the one comparison; scripts/stage-provider.mjs uses it for PROVIDER.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const keys = (name) => ({ path: `CLODE_${name}_RECORDED_PATH`, size: `CLODE_${name}_RECORDED_SIZE`,
  sha: `CLODE_${name}_RECORDED_SHA256` });

function measure(file) {
  return { path: file, size: fs.statSync(file).size, sha: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}

// The names this environment holds a record for.
export function recordedNames(env = process.env) {
  return Object.keys(env).map((k) => /^CLODE_([A-Z0-9_]+)_RECORDED_SHA256$/.exec(k)).filter(Boolean).map((m) => m[1]).sort();
}

// null when NAME's recorded file is still `file` (default: the recorded path) byte for byte; else the refusal, naming
// both. A name with no record is null: there is nothing to hold it to.
export function verifyRecorded(name, env = process.env, file = undefined) {
  const k = keys(name);
  if (!env[k.sha]) return null;
  const want = { path: env[k.path], size: env[k.size], sha: env[k.sha] };
  const at = file || want.path;
  let now;
  try { now = measure(at); } catch (e) { now = { path: at, size: '?', sha: `unreadable (${e.code || e.message})` }; }
  if (now.path === want.path && now.sha === want.sha) return null;
  return `${name} changed since this job installed it: recorded ${want.path} ${want.size} bytes sha256 ${want.sha}; `
    + `now ${now.path} ${now.size} bytes sha256 ${now.sha}. Something this job ran between the install and here rewrote `
    + 'it (a native Claude Code auto-update is the first suspect: every driver must set DISABLE_AUTOUPDATER, '
    + 'test/updater-off.cjs).';
}

function record(name, file) {
  if (!NAME_RE.test(name)) throw new Error(`record-provider: --as wants an UPPER_SNAKE name, got ${JSON.stringify(name)}`);
  const m = measure(file);
  const k = keys(name);
  process.stdout.write(`record-provider: ${name} ${m.path} ${m.size} bytes sha256 ${m.sha}\n`);
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `${k.path}=${m.path}\n${k.sha}=${m.sha}\n${k.size}=${m.size}\n`);
  }
}

function main(argv) {
  if (argv[0] === '--verify') {
    const asked = argv.slice(1);
    for (const n of asked) if (!recordedNames().includes(n)) throw new Error(`record-provider: --verify ${n}: this job recorded no ${n}`);
    const names = asked.length ? asked : recordedNames();
    const bad = names.map((n) => verifyRecorded(n)).filter(Boolean);
    for (const b of bad) process.stderr.write(`record-provider: ${b}\n`);
    if (!bad.length) process.stdout.write(`record-provider: unchanged: ${names.join(', ') || '(nothing recorded)'}\n`);
    return bad.length ? 1 : 0;
  }
  if (argv[0] === '--as') {
    if (!argv[1] || !argv[2]) throw new Error('usage: record-provider.mjs --as NAME BIN');
    record(argv[1], path.resolve(argv[2]));
    return 0;
  }
  const prov = execFileSync(process.execPath, [path.join(here, 'find-provider.mjs')], { encoding: 'utf8' }).trim();
  record('PROVIDER', prov);
  return 0;
}

// Run as a script (not imported by stage-provider.mjs). realpath: the module URL is the real path, argv[1] may not be.
const invoked = (() => { try { return pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return null; } })();
if (invoked === import.meta.url) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 2; }
}
