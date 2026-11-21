#!/usr/bin/env node
// THE NETBSD/ARM64 CELLS, DRIVEN ON THE LOCAL VM (USER RULING 2026-11-21, every-tool ruling E11): the ONE re-run
// command for the driven-local evidence that test/build-gates/tool-coverage-gates.test.cjs judges (LOCAL_CELL_RUNS).
//
//   node scripts/netbsd-arm64-evidence.mjs [--port 2230] [--host localhost] [--keep]
//
// netbsd-arm64 is a shipping engine with no runner CI can drive at a usable speed: the emulated CI job this replaces
// (netbsd-arm64-cells, TCG on an x64 runner) ran 10-18x slower than hardware, and upstream's fixed 20 s ripgrep timeout
// tripped (CI 44838234742). The local NetBSD/arm64 guest (qemu+HVF, near native; boot it with `nb boot netbsd 10
// arm64`) runs the same files in minutes (2026-11-21: engine, provider, quaude and four lanes in 336 s). This script, on the developer's machine:
//   1. refuses a tree with uncommitted tracked changes (the evidence names the commit it ran);
//   2. ships a tarball of `git ls-files` ONLY (tracked files: a gitignored secret beside them never leaves the box) to
//      a throwaway directory on the guest (`mktemp -d /tmp/clode-evidence.XXXXXX`), over ssh;
//   3. runs itself there with --in-guest: builds the engine from the tree's sources, fetches the pinned provider (its
//      linux carve, as `clode fetch claude` does on NetBSD) into a throwaway store, builds a quaude, installs the PTY
//      harness, and runs the drivers in LANES (four parallel lanes, the layout the CI job used), each test recorded by
//      test/cell-reporter.mjs; native has no NetBSD build, so each test's native half skips there by name;
//   4. writes test/fidelity/evidence/netbsd-arm64.json: the commit, date, the guest's OS, the quaude's and engine's
//      identity, this tree's engine and quaude inputs (scripts/lib/evidence-inputs.cjs), this command, the lanes, every
//      test record, and the cells those records prove (filled in by the gate's own code), then judges it.
// Every remote command has a timeout; the guest work stays inside its throwaway directory (its own HOME, state root,
// caches and stores), which is removed afterwards unless --keep; nothing is searched for on the guest, and nothing on
// this machine outside the repository and a temp directory is written. No API is called: the drivers use mock APIs.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import url, { pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
export const RUN = 'netbsd-arm64-vm';
export const ENGINE = 'netbsd-arm64';
export const EVIDENCE = 'test/fidelity/evidence/netbsd-arm64.json';
export const COMMAND = 'node scripts/netbsd-arm64-evidence.mjs';
// Every wait in the drivers is multiplied by this (CLODE_TIMEOUT_SCALE, test/tool-driver.cjs): HVF runs near native,
// but four lanes share the guest's four vCPUs.
export const TIMEOUT_SCALE = 3;

// THE LANES: disjoint sets of tests by name, their records unioned. The unit is one `run`: a node --test process whose
// file test/file-watchdog.cjs limits to 1800 s. Every heavy turn is its own run (agentic-grep-glob's six took 2750 s
// serially under TCG, CI 44782406152). test/evidence-lanes.test.cjs proves every test of FILES runs exactly once.
const TL = 'test/fidelity/tools-local.test.cjs';
const AG = 'test/fidelity/agentic-grep-glob.test.cjs';
const WF = 'test/fidelity/webfetch.test.cjs';
export const FILES = [AG, TL, WF];
// agentic-grep-glob's heavy turn for one mode: print is the unnamed one, a permission mode names itself
const agentic = (id, mode) => ({ id, file: AG, names: [`rg in a built quaude${mode}: every`] });
const modes = (id, ms) => ({ id, file: TL, names: [`Phase A call in (a built quaude in )?(${ms})[: ]`] });
export const LANES = [
  [{ id: 'rest-tools', file: TL, skips: ['Phase A call in'] }, { id: 'rest-agentic', file: AG, skips: ['rg in a built quaude'] },
    agentic('rest-plan', ' in permission:plan'), { id: 'webfetch', file: WF }],
  [modes('modes1-tools', 'print|permission:acceptEdits|permission:auto'), agentic('modes1-print', '')],
  [modes('modes2-tools', 'permission:bypassPermissions|permission:dontAsk|permission:plan'),
    agentic('modes2-acceptEdits', ' in permission:acceptEdits'), agentic('modes2-auto', ' in permission:auto')],
  [modes('modes3-tools', 'unlisted|interactive'), agentic('modes3-bypassPermissions', ' in permission:bypassPermissions'),
    agentic('modes3-dontAsk', ' in permission:dontAsk')],
];
const runArgs = (r) => [...(r.names || []).map((p) => `--test-name-pattern=${p}`), ...(r.skips || []).map((p) => `--test-skip-pattern=${p}`), r.file];

// THE TARBALL'S RULE (no secrets in off-box tarballs): tracked files only, and never one of these names even if it is
// tracked by mistake. `files`: what `git ls-files` lists; `listed`: what the archive holds. test/build-gates/
// evidence-tarball-gates.test.cjs holds it to the real tree and to a planted secret.
export const SECRET = /(^|\/)(clode_gh_token|\.env(\..*)?|\.?credentials\.json|\.netrc|id_(rsa|ed25519|ecdsa))$/;
export function tarballFindings({ files, listed }) {
  const findings = files.filter((f) => SECRET.test(f)).map((f) => `${f}: a secret's name; it must never leave this machine`);
  const want = new Set(files);
  const got = new Set(listed);
  for (const f of listed) if (!want.has(f)) findings.push(`${f}: in the archive, but not a tracked file (git ls-files)`);
  for (const f of files) if (!got.has(f)) findings.push(`${f}: tracked, but missing from the archive`);
  return { findings, examined: listed.length };
}

// An executable's name on this host (the guest is NetBSD today; nothing here assumes it).
const EXE = process.platform === 'win32' ? '.exe' : '';
// clode's canonical storage name for a fetched provider (libexec/clode-update.cjs binaryFor): carved, never executed.
const PROVIDER_FILE = 'claude';
const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const die = (msg) => { process.stderr.write(`netbsd-arm64-evidence: ${msg}\n`); process.exit(1); };
// inside the guest-directory try: a failure must still reach the cleanup in its finally, so it throws
const fail = (msg) => { throw new Error(msg); };
const say = (msg) => process.stdout.write(`netbsd-arm64-evidence: ${msg}\n`);
const MIN = 60 * 1000;

// ==========================================================================
// IN THE GUEST
// ==========================================================================
async function inGuest(dir) {
  const t0 = Date.now();
  const el = () => `${Math.round((Date.now() - t0) / 1000)}s`;
  const repo = path.join(dir, 'repo');
  for (const d of ['home', 'cache', 'deps', 'state', 'fetch-state', 'build-state', 'no-providers', 'cells', 'logs', 'npm-cache', 'tmp']) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }
  // EVERYTHING under the throwaway directory: HOME, XDG, clode's state/cache/deps, npm's cache, TMPDIR.
  const base = { PATH: '/opt/pkg/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(dir, 'home'), LANG: 'C.UTF-8', TERM: 'xterm-256color',
    TMPDIR: path.join(dir, 'tmp'), XDG_CACHE_HOME: path.join(dir, 'home', '.cache'), XDG_CONFIG_HOME: path.join(dir, 'home', '.config'),
    XDG_DATA_HOME: path.join(dir, 'home', '.local', 'share'), npm_config_cache: path.join(dir, 'npm-cache'),
    CLODE_CACHE: path.join(dir, 'cache'), CLODE_DEPS: path.join(dir, 'deps'), CLODE_STATE_ROOT: path.join(dir, 'state') };
  const steps = [];
  const step = (name, cmd, args, { env = {}, timeout }) => {
    const log = path.join(dir, 'logs', `${name}.log`);
    const s = Date.now();
    const fd = fs.openSync(log, 'w');
    const r = spawnSync(cmd, args, { cwd: repo, env: { ...base, ...env }, stdio: ['ignore', fd, fd], timeout, killSignal: 'SIGKILL' });
    fs.closeSync(fd);
    const rec = { name, seconds: Math.round((Date.now() - s) / 1000), status: r.status, signal: r.signal };
    steps.push(rec);
    say(`${name}: ${r.status === 0 ? 'ok' : `FAILED (status ${r.status}${r.signal ? `, ${r.signal}` : ''}${r.error ? `, ${r.error.code}` : ''})`} after ${el()}`);
    if (r.status !== 0) {
      const tail = fs.readFileSync(log, 'utf8').split('\n').slice(-40).join('\n');
      throw new Error(`${name} failed (log ${log}):\n${tail}`);
    }
    return log;
  };
  const node = process.execPath;
  // 1. the engine, from this tree's sources
  step('engine', node, ['scripts/build-tjs.cjs'], { timeout: 60 * MIN, env: { CLODE_TJS_VENDOR: path.join(dir, 'vendor'),
    CLODE_TJS_OUT: path.join(dir, 'eng'), CLODE_TJS_BUILD: path.join(dir, 'engbuild') } });
  const tjs = path.join(dir, 'eng', `tjs${EXE}`);
  if (!fs.existsSync(tjs)) throw new Error(`the engine build left no ${tjs}`);
  // 2. the pinned provider, into its own store (the lanes' store stays empty, so native resolves nowhere and skips)
  const pin = /^claude-code (\S+)$/m.exec(fs.readFileSync(path.join(repo, 'UPSTREAM_PIN'), 'utf8'))[1];
  step('provider', node, ['scripts/stage0.mjs', 'fetch', 'claude', pin], { timeout: 30 * MIN, env: { CLODE_STATE_ROOT: path.join(dir, 'fetch-state') } });
  const provRoot = path.join(dir, 'fetch-state', 'share', 'clode', 'providers', pin);
  const prov = fs.existsSync(provRoot) ? fs.readdirSync(provRoot).map((p) => path.join(provRoot, p, PROVIDER_FILE)).find((f) => fs.existsSync(f)) : null;
  if (!prov) throw new Error(`clode fetch claude ${pin} left no provider under ${provRoot}`);
  // 3. the quaude
  const quaude = path.join(dir, `quaude${EXE}`);
  step('quaude', node, ['scripts/stage0.mjs', 'build', '--out', quaude], { timeout: 60 * MIN,
    env: { CLODE_CLAUDE_BIN: prov, CLODE_TJS: tjs, CLODE_STATE_ROOT: path.join(dir, 'build-state') } });
  // 4. the PTY harness for the interactive turns: node-pty has no netbsd-arm64 prebuild, and its source build misses
  // three headers and libutil there (measured 2026-11-20 on this guest)
  const py = ['/opt/pkg/bin/python3.13', '/opt/pkg/bin/python3'].find((p) => fs.existsSync(p)) || 'python3';
  step('harness', 'npm', ['install', '--prefix', 'test', '--no-audit', '--no-fund'], { timeout: 30 * MIN,
    env: { PYTHON: py, CXXFLAGS: '-include termios.h -include sys/ioctl.h -include util.h', LDFLAGS: '-lutil' } });
  step('harness-preflight', node, ['test/harness-preflight.cjs'], { timeout: 5 * MIN });
  // 5. the lanes, in parallel; each run is one node --test process with its own timeout
  const laneEnv = { ...base, CLODE_TJS: tjs, CLODE_QUAUDE: quaude, CLODE_TIMEOUT_SCALE: String(TIMEOUT_SCALE),
    CLODE_TEST_PROVIDER_STORE: path.join(dir, 'no-providers') };
  const runs = [];
  const runOne = (lane, r) => new Promise((resolve) => {
    const s = Date.now();
    const args = ['--require', './test/file-watchdog-preload.cjs', '--test', '--test-concurrency=1',
      '--test-reporter=spec', `--test-reporter-destination=${path.join(dir, 'logs', `lane-${r.id}.log`)}`,
      '--test-reporter=./test/cell-reporter.mjs', `--test-reporter-destination=${path.join(dir, 'cells', `${r.id}.jsonl`)}`, ...runArgs(r)];
    const c = spawn(node, args, { cwd: repo, env: laneEnv, stdio: 'ignore' });
    const kill = setTimeout(() => c.kill('SIGKILL'), 40 * MIN);
    c.on('close', (status, signal) => {
      clearTimeout(kill);
      const rec = { lane, id: r.id, status, signal, seconds: Math.round((Date.now() - s) / 1000) };
      runs.push(rec);
      say(`run ${r.id} (lane ${lane}): ${status === 0 ? 'every test passed or skipped' : `exited ${status}${signal ? ` (${signal})` : ''}`} after ${el()}`);
      resolve();
    });
  });
  await Promise.all(LANES.map(async (lane, i) => { for (const r of lane) await runOne(i + 1, r); }));
  // 6. what ran
  const records = [];
  for (const f of fs.readdirSync(path.join(dir, 'cells')).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const l of fs.readFileSync(path.join(dir, 'cells', f), 'utf8').split('\n')) {
      if (!l.trim()) continue;
      const r = JSON.parse(l);
      const abs = String(r.file || '').startsWith('file:') ? url.fileURLToPath(r.file) : String(r.file || '');
      records.push({ ...r, file: path.isAbsolute(abs) ? path.relative(repo, abs).split(path.sep).join('/') : abs });
    }
  }
  const ver = (bin) => {
    const r = spawnSync(bin, ['--version'], { env: base, encoding: 'utf8', timeout: 2 * MIN, killSignal: 'SIGKILL' });
    return r.status === 0 ? r.stdout.trim() : `(--version exited ${r.status}${r.signal ? `, ${r.signal}` : ''})`;
  };
  const uname = spawnSync('uname', ['-srm'], { encoding: 'utf8', timeout: MIN }).stdout.trim();
  const result = { host: { platform: process.platform, arch: process.arch, os: uname, node: process.version },
    quaude: { sha256: sha256File(quaude), bytes: fs.statSync(quaude).size, version: ver(quaude), provider: pin,
      engine: { sha256: sha256File(tjs), bytes: fs.statSync(tjs).size } },
    steps, runs: runs.sort((a, b) => a.lane - b.lane || a.id.localeCompare(b.id)), seconds: Math.round((Date.now() - t0) / 1000),
    records };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result));
  say(`done after ${el()}: ${records.length} test record(s)`);
}

// ==========================================================================
// ON THE DEVELOPER'S MACHINE
// ==========================================================================
function git(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) die(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

async function main(argv) {
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const port = opt('--port', '2230');
  const host = opt('--host', 'localhost');
  const keep = argv.includes('--keep');
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).trim();
  if (dirty) die(`the tree has uncommitted tracked changes, and the evidence names the commit it ran; commit first:\n${dirty}`);
  const commit = git(['rev-parse', 'HEAD']).trim();
  const date = new Date().toISOString().slice(0, 10);
  const require = createRequire(import.meta.url);
  const inputs = require(path.join(REPO, 'scripts', 'lib', 'evidence-inputs.cjs')).evidenceInputs(REPO, FILES);
  const ssh = (cmd, { timeout, input, inherit } = {}) => {
    const r = spawnSync('ssh', ['-p', port, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=10', host, cmd], { input, timeout, killSignal: 'SIGKILL', maxBuffer: 1 << 30,
      stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'] });
    if (r.error) fail(`ssh ${host}:${port} \`${cmd.slice(0, 120)}\`: ${r.error.code === 'ETIMEDOUT' ? `timed out after ${timeout / 1000}s` : r.error.message}`);
    return r;
  };
  const must = (cmd, o) => {
    const r = ssh(cmd, o);
    if (r.status !== 0) fail(`on the guest, \`${cmd.slice(0, 160)}\` exited ${r.status}: ${String(r.stderr || '').slice(0, 2000)}`);
    return String(r.stdout || '');
  };

  // THE TARBALL: tracked files only, listed by git, checked before it moves.
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-evidence-'));
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean).filter((f) => fs.existsSync(path.join(REPO, f)));
  fs.writeFileSync(path.join(local, 'files'), `${files.join('\0')}\0`);
  const tgz = path.join(local, 'src.tgz');
  const tar = spawnSync('tar', ['-czf', tgz, '-C', REPO, '--null', '-T', path.join(local, 'files')],
    { env: { ...process.env, COPYFILE_DISABLE: '1' }, encoding: 'utf8', timeout: 10 * MIN });
  if (tar.status !== 0) die(`tar failed: ${tar.stderr}`);
  const listed = spawnSync('tar', ['-tzf', tgz], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 5 * MIN }).stdout.split('\n').filter(Boolean)
    .filter((f) => !f.endsWith('/'));
  const bad = tarballFindings({ files, listed }).findings;
  if (bad.length) die(`refusing to ship the tarball:\n  ${bad.slice(0, 20).join('\n  ')}`);
  say(`tarball: ${files.length} tracked files at ${commit.slice(0, 12)} (${fs.statSync(tgz).size} bytes)`);

  // THE GUEST: a throwaway directory, and nothing outside it.
  const uname = must('uname -sm', { timeout: 30000 }).trim();
  if (uname !== 'NetBSD evbarm' && !/^NetBSD (evbarm|aarch64)/.test(uname)) die(`${host}:${port} is ${uname}, not a NetBSD/arm64 guest (boot it: nb boot netbsd 10 arm64)`);
  const dir = must('mktemp -d /tmp/clode-evidence.XXXXXX', { timeout: 30000 }).trim();
  if (!/^\/tmp\/clode-evidence\.[A-Za-z0-9]+$/.test(dir)) die(`mktemp answered ${JSON.stringify(dir)}`);
  say(`guest directory ${dir}`);
  let ok = false;
  try {
    must(`cat > ${dir}/src.tgz`, { timeout: 10 * MIN, input: fs.readFileSync(tgz) });
    must(`mkdir ${dir}/repo && tar -xzf ${dir}/src.tgz -C ${dir}/repo`, { timeout: 10 * MIN });
    say('building and driving in the guest (about 6 min measured; the timeouts allow far more)');
    const g = ssh(`cd ${dir}/repo && /opt/pkg/bin/node scripts/netbsd-arm64-evidence.mjs --in-guest ${dir}`, { timeout: 180 * MIN, inherit: true });
    // the logs, for whoever reads a red result
    const logs = ssh(`cd ${dir} && tar -czf - logs`, { timeout: 5 * MIN });
    if (logs.status === 0) { fs.writeFileSync(path.join(local, 'logs.tgz'), logs.stdout); say(`guest logs: ${path.join(local, 'logs.tgz')}`); }
    if (g.status !== 0) fail(`the guest run exited ${g.status}; its logs are in ${path.join(local, 'logs.tgz')}`);
    const result = JSON.parse(must(`cat ${dir}/result.json`, { timeout: 5 * MIN }));
    const draft = { run: RUN, engine: ENGINE, commit, date, host: result.host, quaude: result.quaude, inputs, command: COMMAND,
      timeoutScale: TIMEOUT_SCALE, seconds: result.seconds, steps: result.steps,
      lanes: LANES.map((lane, i) => lane.map((r) => ({ lane: i + 1, id: r.id, file: r.file, ...(r.names ? { names: r.names } : {}),
        ...(r.skips ? { skips: r.skips } : {}), ...(result.runs.find((x) => x.id === r.id) || {}) }))).flat(),
      tests: result.records.map(({ type, file, line, name, nesting, skip, todo }) => ({ type, file, line, name, nesting,
        ...(skip !== undefined ? { skip } : {}), ...(todo !== undefined ? { todo } : {}) }))
        .sort((a, b) => (a.file + a.name < b.file + b.name ? -1 : a.file + a.name > b.file + b.name ? 1 : 0)) };
    const out = path.join(REPO, ...EVIDENCE.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(draft, null, 2)}\n`);
    // the cells and counts, by the gate's own code
    const fill = spawnSync(process.execPath, ['--test', '--test-name-pattern=CLODE_LOCAL_EVIDENCE_WRITE', 'test/build-gates/tool-coverage-gates.test.cjs'],
      { cwd: REPO, env: { ...process.env, CLODE_LOCAL_EVIDENCE_WRITE: out }, encoding: 'utf8', timeout: 10 * MIN });
    if (fill.status !== 0) fail(`filling the evidence's cells failed:\n${fill.stdout}\n${fill.stderr}`);
    const ev = JSON.parse(fs.readFileSync(out, 'utf8'));
    say(`wrote ${EVIDENCE}: cells ${JSON.stringify(ev.counts)}`);
    for (const c of ev.cells.filter((x) => !x.passed)) {
      say(`  NOT PASSED ${c.tool} x ${c.mode}: ${c.tests.filter((t) => t.outcome !== 'passed').map((t) => `"${t.name}" ${t.outcome}`).join('; ')}`);
    }
    // the verdict on it, as a release judges it: fresh, true to its tests, every lane exited 0
    const judge = spawnSync(process.execPath, ['--test', '--test-name-pattern=driven-local-evidence', 'test/build-gates/tool-coverage-gates.test.cjs'],
      { cwd: REPO, env: { ...process.env, CLODE_EVIDENCE_RELEASE: '1' }, encoding: 'utf8', timeout: 10 * MIN });
    process.stdout.write(judge.stdout.split('\n').filter((l) => /^(✔|✖)|VIOLATION|examined/.test(l)).join('\n') + '\n');
    ok = judge.status === 0;
  } finally {
    if (keep) say(`kept ${dir} on the guest (--keep)`);
    else ssh(`rm -rf ${dir}`, { timeout: 15 * MIN });
    // the local directory too, unless a red run's logs are in it (or --keep)
    if (ok && !keep) fs.rmSync(local, { recursive: true, force: true });
    else say(`kept ${local} (${keep ? '--keep' : 'the run was not green: its guest logs are there'})`);
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--in-guest');
  if (i >= 0) inGuest(process.argv[i + 1]).catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
  else main(process.argv.slice(2)).catch((e) => die(e.message || String(e)));
}
