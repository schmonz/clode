#!/usr/bin/env node
// RE-RUN A LOCAL RUN AND REWRITE ITS EVIDENCE (every-tool ruling E11): `node scripts/vm-cells.mjs <run>`.
//
// <run> is a run test/local-runs.cjs names (netbsd-arm64-vm). On its VM, from THIS commit:
//   1. ships a tarball of `git ls-files` (tracked files ONLY: nothing untracked or ignored, so no token or local
//      secret beside the checkout can travel) and the provider carve the run builds from;
//   2. builds the engine fresh there (scripts/build-tjs.cjs) and a quaude with it (clode build): a fresh build of this
//      commit, never a binary left on the box; and installs the PTY harness (npm install --prefix test) for the
//      interactive turns;
//   3. runs the run's files against that quaude under test/cell-reporter.mjs, with no provider resolvable, so every
//      native test skips by name and quaude is judged against the answers recorded from native;
//   4. writes the evidence (date, commit, the quaude's sha256, the host, each file's sha, the reporter's records), and
//      has the gate derive its cells from those records (CLODE_LOCAL_DERIVE), so nothing in it is written by hand.
// Refuses a checkout whose tracked files differ from HEAD: the evidence names a commit, and must be that commit's.
// Never searches the guest's home: it works only in <vm.dir> under it.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { LOCAL_RUNS } = require(path.join(REPO, 'test', 'local-runs.cjs'));

const die = (msg) => { process.stderr.write(`vm-cells: ${msg}\n`); process.exit(2); };
const name = process.argv[2];
const r = LOCAL_RUNS.find((x) => x.run === name);
if (!r) die(`usage: node scripts/vm-cells.mjs <run>; runs: ${LOCAL_RUNS.map((x) => x.run).join(', ')}`);
const { vm } = r;

const run = (cmd, args, opts = {}) => {
  const p = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (p.error) die(`${cmd}: ${p.error.message}`);
  return p;
};
const must = (cmd, args, opts) => {
  const p = run(cmd, args, opts);
  if (p.status !== 0) die(`${cmd} ${args.join(' ')} exited ${p.status}:\n${(p.stderr || '').slice(-2000)}`);
  return p.stdout;
};
const git = (...a) => must('git', ['-C', REPO, ...a]).trim();

// 0. This commit, exactly.
const dirty = git('status', '--porcelain', '--untracked-files=no');
if (dirty) die(`tracked files differ from HEAD; commit first (the evidence names a commit):\n${dirty}`);
const commit = git('rev-parse', 'HEAD');
const pin = (fs.readFileSync(path.join(REPO, 'UPSTREAM_PIN'), 'utf8').match(/^claude-code\s+(\S+)/m) || [])[1];
const { providerBinFor, platformSkipReason } = require(path.join(REPO, 'test', 'provider-resolve.cjs'));
const provider = providerBinFor(vm.provider);
if (!provider) die(platformSkipReason(vm.provider));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// 1. The tarball: tracked files only.
const stage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vm-cells-')));
try {
  const tgz = path.join(stage, 'repo.tgz');
  const list = must('git', ['-C', REPO, 'ls-files', '-z']);
  must('tar', ['--null', '-T', '-', '-czf', tgz], { cwd: REPO, input: list, env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const ssh = (script, opts) => run('ssh', [...vm.ssh, `/bin/sh -s`], { input: script, ...opts });
  const D = `$HOME/${vm.dir}/${r.run}`;
  const prep = ssh(`set -e\nmkdir -p ${D}\nrm -rf ${D}/repo ${D}/out\nmkdir -p ${D}/repo ${D}/out\necho "$HOME"\n`);
  if (prep.status !== 0) die(`cannot reach the ${r.run} guest (ssh ${vm.ssh.join(' ')}): ${prep.stderr.trim()}`);
  const home = prep.stdout.trim().split('\n').pop();
  const dir = `${home}/${vm.dir}/${r.run}`;
  must('scp', ['-q', ...vm.scp, tgz, `${vm.host}:${dir}/repo.tgz`]);
  must('scp', ['-q', ...vm.scp, provider, `${vm.host}:${dir}/provider`]);

  // 2 and 3, on the guest. Each phase's log stays there and comes back.
  process.stderr.write(`vm-cells: ${r.run}: building the engine and a quaude of ${commit.slice(0, 12)} on the guest, then running ${r.files.join(', ')}\n`);
  const guest = [
    'set -u',
    `export PATH=${vm.path}`,
    `D=${dir}`,
    'cd "$D/repo" && tar xzf ../repo.tgz || exit 3',
    'mkdir -p "$D/state" "$D/cache" "$D/deps" "$D/no-providers"',
    'CLODE_TJS_VENDOR="$D/vendor" CLODE_TJS_OUT="$D/tjs-out" CLODE_TJS_LOCAL_ROOT="$D/scratch" node scripts/build-tjs.cjs > "$D/out/engine.log" 2>&1 || { echo "engine build failed" >&2; tail -40 "$D/out/engine.log" >&2; exit 4; }',
    // the PTY harness, for the interactive turns (test/package.json; test/harness-preflight.cjs spawns through it)
    `${Object.entries(vm.harnessEnv || {}).map(([k, v]) => `${k}='${v}'`).join(' ')} npm install --prefix test --no-audit --no-fund > "$D/out/harness.log" 2>&1 && node test/harness-preflight.cjs >> "$D/out/harness.log" 2>&1 || { echo "the PTY harness did not install" >&2; tail -40 "$D/out/harness.log" >&2; exit 6; }`,
    'rm -f "$D/quaude"',
    'CLODE_TJS="$D/tjs-out/tjs" CLODE_CLAUDE_BIN="$D/provider" CLODE_CACHE="$D/cache" CLODE_DEPS="$D/deps" CLODE_STATE_ROOT="$D/state" node scripts/stage0.mjs build --out "$D/quaude" > "$D/out/build.log" 2>&1 || { echo "quaude build failed" >&2; tail -40 "$D/out/build.log" >&2; exit 5; }',
    // no provider resolvable (an empty store, a private state root): every native test skips by name
    `CLODE_QUAUDE="$D/quaude" CLODE_TJS="$D/tjs-out/tjs" CLODE_CACHE="$D/cache" CLODE_DEPS="$D/deps" CLODE_STATE_ROOT="$D/state" CLODE_TEST_PROVIDER_STORE="$D/no-providers" `
      + 'node --test --test-concurrency=1 --test-reporter=spec --test-reporter-destination=stdout '
      + `--test-reporter=./test/cell-reporter.mjs --test-reporter-destination="$D/out/cells.jsonl" ${r.files.join(' ')} > "$D/out/tests.log" 2>&1`,
    'echo "tests rc=$?" >> "$D/out/tests.log"',
    'node -e \'const c=require("crypto"),fs=require("fs");console.log(JSON.stringify({platform:process.platform,arch:process.arch,'
      + 'quaude:c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"),size:fs.statSync(process.argv[1]).size,'
      + 'uname:require("child_process").execSync("uname -srm").toString().trim()}))\' "$D/quaude" > "$D/out/host.json"',
  ].join('\n');
  const g = ssh(guest, { stdio: ['pipe', 'inherit', 'inherit'] });
  if (g.status !== 0) die(`the guest run failed (exit ${g.status}); its logs are in ${dir}/out on the guest`);
  must('scp', ['-q', ...vm.scp, `${vm.host}:${dir}/out/cells.jsonl`, `${vm.host}:${dir}/out/tests.log`, `${vm.host}:${dir}/out/host.json`, stage]);

  // 4. The evidence.
  const host = JSON.parse(fs.readFileSync(path.join(stage, 'host.json'), 'utf8'));
  const prefix = `${dir}/repo/`;
  const records = fs.readFileSync(path.join(stage, 'cells.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .map((x) => ({ ...x, file: String(x.file || '').replace(/^file:\/\//, '').replace(prefix, '') }));
  const fileSha = (f) => sha(fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n'));
  const evidence = {
    run: r.run, engine: r.engine, date: new Date().toISOString().slice(0, 10), commit,
    quaude: { sha256: host.quaude, size: host.size },
    provider: { version: pin, carve: vm.provider, sha256: sha(fs.readFileSync(provider)) },
    host: { platform: host.platform, arch: host.arch, uname: host.uname },
    rerun: r.rerun,
    files: Object.fromEntries(r.files.map((f) => [f, fileSha(f)])),
    records, cells: [],
  };
  const out = path.join(REPO, r.evidence);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(evidence, null, 1)}\n`);
  const derive = run(process.execPath, ['--test', '--test-name-pattern=driven-local: the cells a local run', 'test/build-gates/tool-coverage-gates.test.cjs'],
    { cwd: REPO, env: { ...process.env, CLODE_LOCAL_DERIVE: out } });
  if (derive.status !== 0) die(`the gate could not derive the cells:\n${derive.stdout.slice(-3000)}${derive.stderr.slice(-2000)}`);
  const written = JSON.parse(fs.readFileSync(out, 'utf8'));
  const tail = fs.readFileSync(path.join(stage, 'tests.log'), 'utf8').split('\n').filter((l) => /^(ℹ (tests|pass|fail|skipped)|✖|tests rc=)/.test(l));
  process.stdout.write(`${r.evidence}: ${written.cells.length} tool x mode cell(s) on ${r.engine}, ${records.length} test record(s), `
    + `quaude ${host.quaude.slice(0, 12)}, commit ${commit.slice(0, 12)}\n${tail.join('\n')}\n`);
  for (const l of derive.stdout.split('\n').filter((x) => /# finding: /.test(x))) process.stdout.write(`${l.replace(/^.*# finding: /, 'finding: ')}\n`);
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
