#!/usr/bin/env node
// A NEW USER'S FIRST RUN, DRIVEN AND RECORDED (user decision 2026-11-26). On 2026-11-25 a person hit four bugs by hand
// on NetBSD and EndeavourOS — fetch and build disagreeing on the provider, a frozen spinner, an unreadable bare
// `clode`, Remote Control failing — that every PTY test skipped, because each starts past first-run with inputs
// handed in (a seeded profile, CLODE_CLAUDE_BIN, CLODE_TJS). This starts where that person started:
//
//   node scripts/first-run.mjs [--release TAG | --tree] [--port 2230] [--host localhost] [--script FILE] [--keep]
//
// --tree judges THIS tree instead of a release: the guest builds the engine from its sources and blobulates the
// builder (`stage0.mjs bootstrap`, as the release legs do) from the clode-main bundle built here, in a directory of its
// own, and only then does the empty-HOME user start.
//
// On the NetBSD/arm64 VM (boot it with `nb boot netbsd 10 arm64`), in a throwaway directory with an EMPTY HOME and no
// CLODE_* variable at all: the published release asset (default: the latest release) downloaded to ~/Downloads, then
// typed as a person would — bare `clode`, `clode fetch claude`, `clode build quaude` — each under a PTY at 80x24
// (test/tui-screen.cjs, its raw output timestamped with --chunk-log), then the built quaude through its first-run
// screens to a turn, /remote-control and /quit. The ONE thing a real user would not have is the API: quaude talks to a
// local mock (test/mock-anthropic-helper.cjs) through ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY, and the transcript
// says so. No API is called and no credential is read.
//
// Out: a transcript (each command, its seconds, what it printed, quaude's screens) and findings
// (scripts/lib/first-run-report.cjs: silence >= 10 s, a spinner frozen >= 2 s, a line wider than 80, a step that did
// not exit 0) in a local directory it names. The tree is shipped as `git ls-files` only (no secrets in off-box
// tarballs), so commit the harness before running it; every remote command has a timeout; the guest directory is
// removed afterwards unless --keep.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { tarballFindings } from './netbsd-arm64-evidence.mjs';

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const MIN = 60 * 1000;
const COLS = 80;
const ROWS = 24;
const say = (msg) => process.stdout.write(`first-run: ${msg}\n`);
const die = (msg) => { process.stderr.write(`first-run: ${msg}\n`); process.exit(1); };
const fail = (msg) => { throw new Error(msg); };

// quaude's first-run screens, as a person answers them: data, so a version whose screens moved shows up as frames
// that stopped matching (each frame is labelled) rather than as a harness edit. Hex keys: 0d Enter, 1b5b41 Up, 1b5b42 Down.
// The API-key screen defaults to "No (recommended)" and the trust screen to "No, exit" (measured, 2.1.332).
export const QUAUDE_SCRIPT = [
  { label: 'theme: Enter takes the default', send: '0d' },
  { label: 'API key: Up to "Yes"', send: '1b5b41' },
  { label: 'API key: Enter', send: '0d' },
  { label: 'security notes: Enter', send: '0d' },
  { label: 'trust this folder: Down to "Yes"', send: '1b5b42' },
  { label: 'trust this folder: Enter', send: '0d' },
  { label: 'a turn', send: '68690d', until: 'PONG' },
  { label: '/remote-control', send: '2f72656d6f74652d636f6e74726f6c0d' },
  { label: 'wait for remote control', wait: 5000 },
  { label: 'escape', send: '1b' },
  { label: '/quit', send: '2f717569740d' },
];

// --tree: the builder a release leg would publish, made from the shipped tree, OUTSIDE the user's HOME
function bootstrapInGuest(dir, repo, PATH, out) {
  const b = path.join(dir, 'bootstrap');
  for (const d of ['home', 'tmp', 'state', 'cache', 'deps']) fs.mkdirSync(path.join(b, d), { recursive: true });
  const env = { PATH, HOME: path.join(b, 'home'), TMPDIR: path.join(b, 'tmp'), LANG: 'C.UTF-8', CLODE_STATE_ROOT: path.join(b, 'state'),
    CLODE_CACHE: path.join(b, 'cache'), CLODE_DEPS: path.join(b, 'deps') };
  const step = (name, args, extra, minutes) => {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, args, { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: minutes * MIN, killSignal: 'SIGKILL', maxBuffer: 256 << 20 });
    fs.writeFileSync(path.join(dir, 'logs', `${name}.log`), `${r.stdout}\n${r.stderr}`);
    say(`tree ${name}: ${r.status === 0 ? 'ok' : `FAILED (${r.status}${r.signal ? `, ${r.signal}` : ''})`} after ${Math.round((Date.now() - t0) / 1000)}s`);
    if (r.status !== 0) fail(`tree ${name} failed:\n${String(r.stderr || r.stdout).slice(-3000)}`);
  };
  step('engine', ['scripts/build-tjs.cjs'], { CLODE_TJS_VENDOR: path.join(b, 'vendor'), CLODE_TJS_OUT: path.join(b, 'eng'), CLODE_TJS_BUILD: path.join(b, 'engbuild') }, 60);
  const exe = process.platform === 'win32' ? '.exe' : '';
  step('bootstrap', ['scripts/stage0.mjs', 'bootstrap', '--out', out], { CLODE_TJS: path.join(b, 'eng', `tjs${exe}`) }, 60);
}

// A NEW USER'S ENVIRONMENT: an empty HOME, a terminal, nothing of clode's and nothing of Claude Code's. The updater
// knob is NOT set (the defaults are what is under test); the PTY driver asks for a written reason instead.
// test/first-run-report.test.cjs holds it to that: a variable added here is an input handed in, the exact thing this
// harness exists not to do.
export function userEnv({ PATH, home, tmp }) {
  return { PATH, HOME: home, LANG: 'C.UTF-8', TERM: 'xterm-256color', TMPDIR: tmp,
    CLODE_AUTOUPDATER_BECAUSE: 'first-run harness: a new user\'s defaults are what is under test' };
}

async function inGuest(dir, clodeName) {
  const repo = path.join(dir, 'repo');
  const home = path.join(dir, 'home');
  for (const d of ['home/Downloads', 'home/project', 'tmp', 'logs', 'npm-cache', 'out']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const PATH = '/opt/pkg/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  if (!fs.existsSync(path.join(dir, clodeName))) bootstrapInGuest(dir, repo, PATH, path.join(dir, clodeName));
  const clode = path.join(home, 'Downloads', clodeName);
  fs.renameSync(path.join(dir, clodeName), clode);
  fs.chmodSync(clode, 0o755);
  // the harness's own install (node-pty for the PTY), outside the user's HOME
  const py = ['/opt/pkg/bin/python3.13', '/opt/pkg/bin/python3'].find((p) => fs.existsSync(p)) || 'python3';
  const npm = spawnSync(process.execPath, [require(path.join(repo, 'scripts', 'lib', 'npm-cli.cjs')).npmCliPath(), 'install', '--prefix', 'test', '--no-audit', '--no-fund'], { cwd: repo, encoding: 'utf8', timeout: 30 * MIN,
    killSignal: 'SIGKILL', env: { PATH, HOME: path.join(dir, 'tmp'), TMPDIR: path.join(dir, 'tmp'), npm_config_cache: path.join(dir, 'npm-cache'), PYTHON: py,
      CXXFLAGS: '-include termios.h -include sys/ioctl.h -include util.h', LDFLAGS: '-lutil' } });
  if (npm.status !== 0) fail(`npm install --prefix test exited ${npm.status}:\n${String(npm.stderr).slice(-3000)}`);

  const { startMockAnthropic } = require(path.join(repo, 'test', 'mock-anthropic-helper.cjs'));
  const mock = await startMockAnthropic();
  const user = userEnv({ PATH, home, tmp: path.join(dir, 'tmp') });
  const mockEnv = { ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-first-run-mock-0000000000000000' };
  const steps = [];
  const run = (name, command, argv, { env = {}, script = null } = {}) => new Promise((resolve) => {
    const n = steps.length + 1;
    const chunkLog = path.join(dir, 'out', `${n}.chunks.jsonl`);
    const args = [path.join(repo, 'test', 'tui-screen.cjs'), script ? '0' : '3600', '--cols', String(COLS), '--rows', String(ROWS), '--chunk-log', chunkLog];
    if (script) {
      const f = path.join(dir, 'out', `${n}.script.json`);
      fs.writeFileSync(f, JSON.stringify(script));
      args.push('--script', f, '--max-settle-ms', '120000', '--boot-max-ms', '180000');
    }
    args.push('--', ...argv);
    const t0 = Date.now();
    say(`step ${n}: $ ${command}`);
    const c = spawn(process.execPath, args, { cwd: path.join(home, 'project'), env: { ...user, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    const kill = setTimeout(() => c.kill('SIGKILL'), 70 * MIN); // spawn-watchdog: the driver's own 3600 s window, plus its stop
    c.on('close', (status) => {
      clearTimeout(kill);
      const rec = { n, name, command, seconds: Math.round((Date.now() - t0) / 1000), driver: status, driverStderr: err.slice(-2000), chunkLog: path.basename(chunkLog) };
      if (script) rec.frames = out; else rec.screen = out;
      steps.push(rec);
      say(`step ${n}: done after ${rec.seconds}s`);
      resolve(rec);
    });
  });

  await run('bare', clodeName, [clode]);
  await run('fetch', `${clodeName} fetch claude`, [clode, 'fetch', 'claude']);
  const build = await run('build', `${clodeName} build quaude`, [clode, 'build', 'quaude']);
  const R = require(path.join(repo, 'scripts', 'lib', 'first-run-report.cjs'));
  const printed = R.plain(R.parseChunkLog(fs.readFileSync(path.join(dir, 'out', build.chunkLog), 'utf8')).chunks.map((c) => c.text).join(''));
  // a terminal-width wrap may break the line anywhere a space was
  const m = /run\s+'([^']+)'\s+to\s+use\s+it/.exec(printed);
  const quaude = m ? m[1] : null;
  if (quaude && fs.existsSync(quaude)) {
    const script = process.env.FIRST_RUN_SCRIPT ? JSON.parse(fs.readFileSync(process.env.FIRST_RUN_SCRIPT, 'utf8')) : QUAUDE_SCRIPT;
    await run('quaude', `${path.basename(quaude)}    (ANTHROPIC_BASE_URL=<local mock> ANTHROPIC_API_KEY=<mock key>)`, [quaude], { env: mockEnv, script });
  } else {
    say(`the build printed no quaude to run (${quaude ? `${quaude} is missing` : 'no "run \'…\' to use it" line'}); the quaude steps are skipped`);
  }
  mock.close && mock.close();
  const uname = spawnSync('uname', ['-srm'], { encoding: 'utf8', timeout: MIN }).stdout.trim();
  fs.writeFileSync(path.join(dir, 'out', 'steps.json'), JSON.stringify({ host: uname, clode: clodeName, mockRequests: mock.requests.length, steps }));
}

async function main(argv) {
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const port = opt('--port', '2230');
  const host = opt('--host', 'localhost');
  const keep = argv.includes('--keep');
  const scriptFile = opt('--script', null);
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-first-run-'));
  const sh = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 10 * MIN, ...o });

  const tree = argv.includes('--tree');
  let asset;
  if (tree) {
    const b = sh(process.execPath, ['scripts/build-clode-main.mjs'], { cwd: REPO });
    if (b.status !== 0) die(`build-clode-main: ${b.stderr}`);
    const head = sh('git', ['rev-parse', '--short=10', 'HEAD'], { cwd: REPO }).stdout.trim();
    const dirty = sh('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: REPO }).stdout.trim() ? '-dirty' : '';
    asset = `clode-${head}${dirty}-netbsd-arm64`;
    say(`this tree: ${asset} (the guest builds it)`);
  } else {
  // the release asset a NetBSD/arm64 user downloads
  let tag = opt('--release', null);
  if (!tag) tag = sh('gh', ['release', 'view', '--json', 'tagName', '--jq', '.tagName'], { cwd: REPO }).stdout.trim();
  if (!/^v\d/.test(tag || '')) die(`could not name a release (got ${JSON.stringify(tag)}); pass --release TAG`);
  const assets = sh('gh', ['release', 'view', tag, '--json', 'assets', '--jq', '.assets[].name'], { cwd: REPO }).stdout.split('\n');
  asset = assets.find((a) => /^clode-.*-netbsd-[\d.]+-arm64$/.test(a));
  if (!asset) die(`release ${tag} has no netbsd arm64 asset`);
  const dl = sh('gh', ['release', 'download', tag, '-p', asset, '-D', local], { cwd: REPO });
  if (dl.status !== 0) die(`gh release download ${tag} ${asset}: ${dl.stderr}`);
  say(`release ${tag}: ${asset}`);
  }

  // the harness, as tracked files only
  const files = sh('git', ['ls-files', '-z'], { cwd: REPO }).stdout.split('\0').filter(Boolean).filter((f) => fs.existsSync(path.join(REPO, f)));
  fs.writeFileSync(path.join(local, 'files'), `${files.join('\0')}\0`);
  const tgz = path.join(local, 'src.tgz');
  const tar = sh('tar', ['-czf', tgz, '-C', REPO, '--null', '-T', path.join(local, 'files')], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (tar.status !== 0) die(`tar failed: ${tar.stderr}`);
  const listed = sh('tar', ['-tzf', tgz]).stdout.split('\n').filter((f) => f && !f.endsWith('/'));
  const bad = tarballFindings({ files, listed }).findings;
  if (bad.length) die(`refusing to ship the tarball:\n  ${bad.slice(0, 20).join('\n  ')}`);
  if (!files.includes('scripts/first-run.mjs')) die('scripts/first-run.mjs is not tracked: commit the harness first (only tracked files ship)');

  const ssh = (cmd, { timeout, input, inherit } = {}) => {
    const r = spawnSync('ssh', ['-p', port, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=10',
      host, cmd], { input, timeout, killSignal: 'SIGKILL', maxBuffer: 1 << 30, stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'] });
    if (r.error) fail(`ssh ${host}:${port} \`${cmd.slice(0, 120)}\`: ${r.error.code === 'ETIMEDOUT' ? `timed out after ${timeout / 1000}s` : r.error.message}`);
    return r;
  };
  const must = (cmd, o) => {
    const r = ssh(cmd, o);
    if (r.status !== 0) fail(`on the guest, \`${cmd.slice(0, 160)}\` exited ${r.status}: ${String(r.stderr || '').slice(0, 2000)}`);
    return String(r.stdout || '');
  };
  const uname = must('uname -sm', { timeout: 30000 }).trim();
  if (!/^NetBSD (evbarm|aarch64)/.test(uname)) die(`${host}:${port} is ${uname}, not a NetBSD/arm64 guest (boot it: nb boot netbsd 10 arm64)`);
  const dir = must('mktemp -d /tmp/clode-first-run.XXXXXX', { timeout: 30000 }).trim();
  if (!/^\/tmp\/clode-first-run\.[A-Za-z0-9]+$/.test(dir)) die(`mktemp answered ${JSON.stringify(dir)}`);
  say(`guest directory ${dir}`);
  let result = null;
  try {
    must(`cat > ${dir}/src.tgz`, { timeout: 10 * MIN, input: fs.readFileSync(tgz) });
    if (!tree) must(`cat > ${dir}/${asset}`, { timeout: 10 * MIN, input: fs.readFileSync(path.join(local, asset)) });
    if (scriptFile) must(`cat > ${dir}/script.json`, { timeout: MIN, input: fs.readFileSync(scriptFile) });
    must(`mkdir ${dir}/repo && tar -xzf ${dir}/src.tgz -C ${dir}/repo`, { timeout: 10 * MIN });
    if (tree) {
      // the clode-main bundle, built here (pure JS, platform-independent: build/bundle is our own esbuild output)
      const bt = path.join(local, 'bundle.tgz');
      const t = sh('tar', ['-czf', bt, '-C', REPO, 'build/bundle/clode-main.bundle.cjs', 'build/bundle/naude-entry.bundle.cjs'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
      if (t.status !== 0) die(`tar of build/bundle failed: ${t.stderr}`);
      must(`cat > ${dir}/bundle.tgz && tar -xzf ${dir}/bundle.tgz -C ${dir}/repo`, { timeout: 10 * MIN, input: fs.readFileSync(bt) });
    }
    const g = ssh(`cd ${dir}/repo && ${scriptFile ? `FIRST_RUN_SCRIPT=${dir}/script.json ` : ''}/opt/pkg/bin/node scripts/first-run.mjs --in-guest ${dir} ${asset}`,
      { timeout: 240 * MIN, inherit: true });
    const outs = ssh(`cd ${dir} && tar -czf - out`, { timeout: 10 * MIN });
    if (outs.status === 0) {
      fs.writeFileSync(path.join(local, 'out.tgz'), outs.stdout);
      sh('tar', ['-xzf', path.join(local, 'out.tgz'), '-C', local]);
    }
    if (g.status !== 0) fail(`the guest run exited ${g.status}`);
    result = JSON.parse(fs.readFileSync(path.join(local, 'out', 'steps.json'), 'utf8'));
  } finally {
    if (keep) say(`kept ${dir} on the guest (--keep)`);
    else ssh(`rm -rf ${dir}`, { timeout: 15 * MIN });
  }

  const R = require(path.join(REPO, 'scripts', 'lib', 'first-run-report.cjs'));
  const { frameText } = require(path.join(REPO, 'test', 'e2e-pty.cjs'));
  const findings = []; const shown = [];
  for (const s of result.steps) {
    const { chunks, exit } = R.parseChunkLog(fs.readFileSync(path.join(local, 'out', s.chunkLog), 'utf8'));
    const tui = s.frames !== undefined;
    let screen;
    if (tui) {
      let parsed = null;
      try { parsed = JSON.parse(s.frames); } catch { /* the driver failed; its stderr says why */ }
      screen = parsed ? parsed.frames.map((f) => `── ${f.label}${f.settled ? '' : ' (UNSETTLED)'} [${(f.ms / 1000).toFixed(1)}s]\n${frameText(f.frame).replace(/\n+$/, '')}`).join('\n')
        : `(no frames: driver exited ${s.driver}: ${s.driverStderr})`;
      for (const f of (parsed ? parsed.frames : []).filter((x) => !x.settled)) findings.push({ kind: 'unsettled', step: s.name, detail: `frame "${f.label}" never settled` });
    }
    findings.push(...R.stepFindings({ name: s.name, chunks, exit, lineMode: !tui, cols: COLS }).filter((f) => !(tui && (f.kind === 'no-exit' || f.kind === 'silence'))));   // a TUI quiet is a screen awaiting its keys
    shown.push({ command: s.command, chunks, exit, screen });
  }
  const transcript = `first run of ${result.clode} on ${result.host}, ${new Date().toISOString()}, ${COLS}x${ROWS}, mock API (${result.mockRequests} requests)\n\n`
    + R.renderTranscript(shown)
    + `\nFINDINGS (${findings.length})\n${findings.map((f) => `  ${f.kind.padEnd(14)} ${f.step.padEnd(7)} ${f.ms ? `${(f.ms / 1000).toFixed(1)}s ` : ''}${f.width ? `${f.width} cols ` : ''}${f.detail}`).join('\n')}\n`;
  fs.writeFileSync(path.join(local, 'transcript.txt'), transcript);
  fs.writeFileSync(path.join(local, 'findings.json'), `${JSON.stringify(findings, null, 2)}\n`);
  process.stdout.write(`\n${transcript}`);
  say(`transcript: ${path.join(local, 'transcript.txt')}`);
}

if (process.argv[2] === '--in-guest') {
  inGuest(process.argv[3], process.argv[4]).then(() => process.exit(0), (e) => { process.stderr.write(`first-run (guest): ${e.stack || e}\n`); process.exit(1); });
} else if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => die(e.stack || String(e)));
}
