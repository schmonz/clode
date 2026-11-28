'use strict';
// KEYCHAIN CAPABILITY: a security(1) that cannot do what upstream asks gets upstream's plaintext
// store, exactly as Linux does; a capable one keeps upstream's keychain store.
//
// WHY (measured 2026-11-27, Mac OS X 10.4.11 Intel VM, quaude 2.1.332): logging in ended "OAuth
// error: Couldn't save your login. If your Mac's keychain is locked, unlock it and log in again."
// Tiger's security(1) has no `find-generic-password -w` (every upstream read exits 2), no
// `delete-generic-password` ("unknown command"), and its add-generic-password takes only
// `[-a accountName] [-s serviceName] [-p passwordData] [keychain]` (no -U, no -X). Upstream reads
// exit 2 as a transient failure and refuses to write over a store it could not read, so nothing
// was saved anywhere. libexec/extract-claude-js.cjs (KEYCHAIN_PRELUDE, patchKeychainCapability)
// asks the tool for its usage once per process and, when a verb or option upstream passes is
// missing, takes the plaintext store at upstream's own darwin store selection.
//
// Three layers: the rewrite against the verbatim 2.1.332 selections (darwin rewritten, linux
// and win32 untouched); the verdict against a verbatim modern capture (test/fixtures/security,
// macOS 27.2.1) and a Tiger fake; and a REAL staged 2.1.332 graph under the quaude engine
// (tjs + node-shim) driving upstream's own store with a fake `security` first on PATH: the
// Tiger fake must land the login in ~/.claude/.credentials.json (0600) and read it back in a
// second process, the modern fake must keep the keychain and write no plaintext file. Every
// fake answers without touching the real binary (no real Keychain, throwaway HOMEs).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ex = require('../libexec/extract-claude-js.cjs');
const { runQuaudeModel, stageProviderCli, providerSkipReason } = require('./oracle-models.cjs');
const { tjsPath } = require('./node-shim-helper.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');

const FIX = path.join(__dirname, 'fixtures', 'security');
// `printf 'find-generic-password -h\nadd-generic-password -h\ndelete-generic-password -h\n' |
// security -i` on macOS 27.2.1 (build 26B131), 2026-11-28: exactly what the probe sends. `-h`
// prints usage and touches no keychain. stdout was empty; the usages are on stderr.
const MODERN_STDERR = fs.readFileSync(path.join(FIX, 'macos-27-i-h.stderr'), 'utf8');
const MODERN_STDOUT = fs.readFileSync(path.join(FIX, 'macos-27-i-h.stdout'), 'utf8');

// The selections verbatim from the 2.1.332 carves (darwin-arm64, linux-x64, win32-x64).
const DARWIN_332 = 'var J;function OAe(){return"keychain"}function Io(){if(J)return J;return ce(L,B,{proveWrites:!0})}function CKs(){if(J)return[];return[]}';
const LINUX_332 = 'var k;function gCe(){return"file"}function Or(){if(k)return k;return C}function nVs(){if(k)return[];return[]}';
const WIN32_332 = 'var K;function mRe(){return yWr()?"credential-manager":"file"}function Or(){if(K)return K;if(yWr())return ee(L,T);return T}function LVs(){if(K)return[];return!yWr()?[L]:[]}';

function preludeIn(fakeRequire) {
  const g = {};
  new Function('require', 'globalThis', ex.KEYCHAIN_PRELUDE)(fakeRequire, g);
  return g;
}
const verdict = preludeIn(() => { throw new Error('unused'); }).__clodeKeychainVerdict;

// ---- the rewrite ---------------------------------------------------------------------------

function runSelection(src, usable) {
  const g = { __clodeKeychainUsable: () => usable };
  return new Function('globalThis', 'ce', 'L', 'B',
    `${src};return {name:OAe(),store:Io()};`)(g, (a, b, o) => ({ composed: [a, b], o }), 'KEYCHAIN', 'PLAINTEXT');
}

test('the darwin 2.1.332 store selection is rewritten: a capable security keeps upstream\'s keychain store', () => {
  const [out, applied] = ex.patchKeychainCapability(DARWIN_332);
  assert.strictEqual(applied, true);
  assert.deepStrictEqual(runSelection(out, true),
    { name: 'keychain', store: { composed: ['KEYCHAIN', 'PLAINTEXT'], o: { proveWrites: true } } });
  // The untouched selection behaves the same: the capable side IS upstream's darwin path.
  assert.deepStrictEqual(runSelection(DARWIN_332, true), runSelection(out, true));
  assert.ok(out.endsWith('function CKs(){if(J)return[];return[]}'), 'nothing past the selection moves');
});

test('an incapable security takes upstream\'s plaintext store under linux\'s name for it', () => {
  const [out] = ex.patchKeychainCapability(DARWIN_332);
  assert.deepStrictEqual(runSelection(out, false), { name: 'file', store: 'PLAINTEXT' });
  // The test override (J) still wins first, as upstream's does.
  const forced = new Function('globalThis', 'ce', 'L', 'B',
    `${out.replace('var J;', 'var J="OVERRIDE";')};return Io();`)({ __clodeKeychainUsable: () => false }, null, 'K', 'P');
  assert.strictEqual(forced, 'OVERRIDE');
});

test('linux and win32 selections are not touched, and report the hook as benignly absent', () => {
  for (const src of [LINUX_332, WIN32_332]) {
    assert.strictEqual(ex.patchKeychainCapability(src)[1], false);
    const { sources, report } = ex.transformGraph({ '/$bunfs/root/chunk-x.js': src });
    assert.strictEqual(sources['/$bunfs/root/chunk-x.js'], src);
    const r = report.find((e) => e.key === 'keychain_capability');
    assert.strictEqual(r.benign, true, r.why);
  }
});

test('a darwin store name the anchor cannot read is a dead hook, not benign', () => {
  const changed = DARWIN_332.replace('{proveWrites:!0}', '{proveWrites:!0,x:1}');
  const r = ex.transformGraph({ '/$bunfs/root/chunk-x.js': changed }).report.find((e) => e.key === 'keychain_capability');
  assert.strictEqual(r.applied, false);
  assert.ok(!r.benign, r.why);
  const two = ex.transformGraph({ '/a.js': DARWIN_332, '/b.js': DARWIN_332 }).report.find((e) => e.key === 'keychain_capability');
  assert.strictEqual(two.applied, false, 'two selections must not both be rewritten');
});

test('a minified name the replacement syntax would read as a group reference is carried literally', () => {
  const [out] = ex.patchKeychainCapability(DARWIN_332.replace(/\bIo\b/g, '$1'));
  assert.ok(out.includes('function $1(){if(J)return J;'), out);
});

// ---- the verdict ---------------------------------------------------------------------------

test('verdict: the modern macOS usage has every verb and option upstream passes', () => {
  assert.deepStrictEqual(verdict(MODERN_STDOUT + '\n' + MODERN_STDERR), { usable: true, missing: [], why: 'all present' });
});

test('verdict: Tiger\'s usage lacks -w, -U, -X and delete-generic-password', () => {
  const r = verdict(TIGER_I_H_OUTPUT);
  assert.strictEqual(r.usable, false);
  assert.deepStrictEqual(r.missing, ['find-generic-password -w', 'add-generic-password -U',
    'add-generic-password -w', 'add-generic-password -X', 'delete-generic-password -a', 'delete-generic-password -s']);
});

test('verdict: one missing option is enough, and options are judged per verb', () => {
  // add's usage lists -w on a modern Mac; that must not satisfy find's -w.
  const noFindW = MODERN_STDERR.replace(/^ +-w +Display only the password on stdout\n/m, '');
  assert.notStrictEqual(noFindW, MODERN_STDERR, 'the fixture must carry find\'s -w line');
  assert.deepStrictEqual(verdict(noFindW).missing, ['find-generic-password -w']);
});

test('verdict: no answer at all is inconclusive and keeps the keychain', () => {
  assert.strictEqual(verdict('').usable, true);
  assert.strictEqual(verdict(' \n').usable, true);
});

test('probe: one `security -i` asking only for usage, cached per process; anything that is not an answer keeps the keychain', () => {
  const calls = [];
  const fakeCp = (result) => ({ spawnSync(cmd, args, opts) { calls.push({ cmd, args, input: opts.input }); return result(); } });
  let g = preludeIn(() => fakeCp(() => ({ status: 0, stdout: '', stderr: TIGER_I_H_OUTPUT })));
  assert.strictEqual(g.__clodeKeychainUsable(), false);
  assert.strictEqual(g.__clodeKeychainUsable(), false);
  assert.strictEqual(calls.length, 1, 'the verdict is cached per process');
  assert.deepStrictEqual(calls[0].args, ['-i']);
  // Only -h: nothing that reads, writes or unlocks a keychain, so a locked keychain cannot matter.
  assert.deepStrictEqual(calls[0].input.trim().split('\n').map((l) => l.split(' ').pop()), ['-h', '-h', '-h']);
  for (const result of [
    () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' }),       // timeout
    () => ({ error: Object.assign(new Error('spawn security ENOENT'), { code: 'ENOENT' }), status: null }),
    () => { throw new Error('spawnSync threw'); },
    () => ({ status: 0, stdout: '', stderr: '' }),                             // the suite's central stub
  ]) {
    g = preludeIn(() => fakeCp(result));
    assert.strictEqual(g.__clodeKeychainUsable(), true);
  }
  g = preludeIn(() => fakeCp(() => ({ status: 2, stdout: MODERN_STDOUT, stderr: MODERN_STDERR })));
  assert.strictEqual(g.__clodeKeychainUsable(), true, 'the modern answer exits 2 (find -h does) and is still capable');
});

test('the probe ships in the prelude both build paths carry', () => {
  assert.ok(ex.PRELUDE.includes(ex.KEYCHAIN_PRELUDE));
  assert.ok(/^[\x00-\x7f]*$/.test(ex.KEYCHAIN_PRELUDE), 'the prelude text stays ASCII');
});

// ---- the fakes -------------------------------------------------------------------------------

// What Tiger's security answers. Measured on the 10.4.11 VM: `find-generic-password ... -w` exits
// 2, `delete-generic-password` is an unknown command, and add-generic-password's usage is
// `[-a accountName] [-s serviceName] [-p passwordData] [keychain]` (verbatim). The find usage line
// is not a capture: it is written without the -w that Tiger's lacks.
const TIGER_FIND_USAGE = 'Usage: find-generic-password [-a accountName] [-s serviceName] [-g] [keychain...]';
const TIGER_ADD_USAGE = 'Usage: add-generic-password [-a accountName] [-s serviceName] [-p passwordData] [keychain]';
const TIGER_I_H_OUTPUT = `security: illegal option -- h\n${TIGER_FIND_USAGE}\n`
  + `security: illegal option -- h\n${TIGER_ADD_USAGE}\n`
  + 'delete-generic-password: unknown command\n';

const NOT_FOUND = 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.';

function tigerSecurity(log) {
  return `#!/bin/sh
one() {
  echo "CALL: $*" >> "${log}"
  cmd=$1; shift
  case "$cmd" in
    find-generic-password)
      for a in "$@"; do case "$a" in -w|-h) echo "security: illegal option -- \${a#-}" 1>&2; echo "${TIGER_FIND_USAGE}" 1>&2; return 2 ;; esac; done
      echo "${NOT_FOUND}" 1>&2; return 44 ;;
    add-generic-password)
      for a in "$@"; do case "$a" in -U|-X|-w|-h) echo "security: illegal option -- \${a#-}" 1>&2; echo "${TIGER_ADD_USAGE}" 1>&2; return 2 ;; esac; done
      return 0 ;;
    *) echo "$cmd: unknown command" 1>&2; return 2 ;;
  esac
}
if [ "$1" = -i ]; then
  rc=0
  while IFS= read -r line; do eval "one $line" || rc=$?; done
  exit $rc
fi
one "$@"
`;
}

function modernSecurity(log) {
  fs.writeFileSync(log + '.usage', MODERN_STDERR);
  return `#!/bin/sh
echo "CALL: $*" >> "${log}"
case "$1" in
  -i)
    rc=0
    while IFS= read -r line; do
      echo "STDIN: $line" >> "${log}"
      case "$line" in
        "find-generic-password -h") cat "${log}.usage" 1>&2; rc=2 ;;
        *" -h") ;;
        add-generic-password*) ;;
        *) rc=1 ;;
      esac
    done
    exit $rc ;;
  find-generic-password|delete-generic-password) echo "${NOT_FOUND}" 1>&2; exit 44 ;;
  add-generic-password) exit 0 ;;
  *) exit 1 ;;
esac
`;
}

// ---- the real store, through a real staged graph under quaude --------------------------------

// The staged graph plus one ENTRY module of our own that imports the store chunk and drives
// upstream's store exactly as login does (mutate: read strictly, then write) or reads it back.
// Nothing else in the graph changes: the runner, the prelude and the patched chunk are the ones
// a built quaude runs.
function harness(staged) {
  const text = fs.readFileSync(staged.cli, 'utf8');
  const a = text.indexOf('JSON.parse(') + 'JSON.parse('.length;
  const b = text.indexOf(');\n', a);
  const doc = JSON.parse(JSON.parse(text.slice(a, b)));
  const SEL = /function ([\w$]+)\(\)\{if\(([\w$]+)\)return \2;if\(!\(typeof globalThis\.__clodeKeychainUsable/;
  const NAME = /function ([\w$]+)\(\)\{return \(typeof globalThis\.__clodeKeychainUsable[^?]*\?"keychain":"file"\}/;
  const chunk = Object.keys(doc.sources).find((n) => SEL.test(doc.sources[n]));
  if (!chunk) return null;
  const src = doc.sources[chunk];
  const select = SEL.exec(src)[1];
  const name = NAME.exec(src)[1];
  const exported = /export\{([^}]*)\}/.exec(src)[1].split(',');
  assert.ok(exported.includes(select) && exported.includes(name), `the store chunk must export ${select} and ${name}`);
  const entry = '/clode-test/keychain-entry.js';
  doc.sources[entry] = `import{${select} as S,${name} as N}from${JSON.stringify(chunk)};`
    + 'const mode=process.env.KC_TEST_MODE;'
    + 'if(process.env.KC_TEST_FORCE_KEYCHAIN==="1")globalThis.__clodeKeychainUsable=()=>!0;'
    + 'const s=S();const out={store:N(),name:s.name};'
    + 'if(mode==="write"){out.result=await s.mutate((c)=>({...c,claudeAiOauth:{accessToken:"at-test",'
    + 'refreshToken:"rt-test",expiresAt:4102444800000,scopes:["user:inference"],subscriptionType:null}}));}'
    + 'else{out.read=await s.readAsync();}'
    + 'process.stdout.write("KCTEST "+JSON.stringify(out)+"\\n");process.exit(0);';
  doc.order = [...doc.order, entry];
  doc.entry = entry;
  const cli = path.join(staged.dir, 'keychain-harness.cjs');
  fs.writeFileSync(cli, text.slice(0, a) + JSON.stringify(JSON.stringify(doc)) + text.slice(b));
  return cli;
}

function setup(t) {
  const tjs = tjsPath();
  if (!tjs) { t.skip('no tjs binary (CLODE_TJS or build/tjs/tjs): the quaude engine is what ships'); return null; }
  const staged = stageProviderCli();
  const skip = providerSkipReason(staged, 'no resolvable Claude Code provider (CLODE_PROVIDER_BIN / CLODE_CLAUDE_BIN / provider store)');
  if (skip) { t.skip(skip); return null; }
  const cli = harness(staged);
  if (!cli) { t.skip('the staged provider keeps no macOS keychain store (not a darwin carve), so there is no selection to steer'); return null; }
  t.after(() => fs.rmSync(staged.dir, { recursive: true, force: true }));
  return { tjs, cli, staged };
}

function run(ctx, fake, mode, extraEnv = {}) {
  const scratch = ctx.scratch;
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(ANTHROPIC|CLAUDE)_/i.test(k)) env[k] = v;
  Object.assign(env, {
    HOME: scratch.home, PATH: [scratch.bin, process.env.PATH || ''].join(path.delimiter),
    KC_TEST_MODE: mode, ...extraEnv,
  });
  fs.writeFileSync(path.join(scratch.bin, 'security'), fake, { mode: 0o755 });
  const r = runQuaudeModel(ctx.cli, [], { cwd: ctx.staged.dir, timeout: 120000, env, tjs: ctx.tjs });
  const line = r.stdout.split('\n').find((l) => l.startsWith('KCTEST '));
  assert.ok(line, `no KCTEST line (status ${r.status}, signal ${r.signal})\nstdout: ${r.stdout.slice(-2000)}\nstderr: ${r.stderr.slice(-2000)}`);
  return JSON.parse(line.slice('KCTEST '.length));
}

function scratchFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-cap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(bin);
  return { home, bin, log: path.join(root, 'security.log'), creds: path.join(home, '.claude', '.credentials.json') };
}

const calls = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

test('quaude on a Tiger-like security: login lands in ~/.claude/.credentials.json (0600) and reads back', { timeout: 600000 }, (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.scratch = scratchFor(t);
  const fake = tigerSecurity(ctx.scratch.log);

  // The failure, reproduced first (the selection forced back to the keychain, as unpatched
  // upstream has it): the strict read exits 2, the write is refused, nothing is saved.
  const before = run(ctx, fake, 'write', { KC_TEST_FORCE_KEYCHAIN: '1' });
  assert.strictEqual(before.name, 'keychain-with-plaintext-fallback');
  assert.deepStrictEqual(before.result, { success: false, transient: true }, JSON.stringify(before));
  assert.ok(!fs.existsSync(ctx.scratch.creds), 'the unpatched path must save nothing, or this test proves nothing');
  fs.rmSync(ctx.scratch.log, { force: true });

  const wrote = run(ctx, fake, 'write');
  assert.deepStrictEqual({ store: wrote.store, name: wrote.name }, { store: 'file', name: 'plaintext' });
  assert.strictEqual(wrote.result.success, true, JSON.stringify(wrote));
  const st = fs.statSync(ctx.scratch.creds);
  assert.strictEqual(st.mode & 0o777, 0o600, `mode ${(st.mode & 0o777).toString(8)}`);
  assert.strictEqual(JSON.parse(fs.readFileSync(ctx.scratch.creds, 'utf8')).claudeAiOauth.accessToken, 'at-test');
  // The keychain was asked for its usage once, and never consulted for the login.
  const seen = calls(ctx.scratch.log);
  assert.strictEqual(seen.length, 3, `one probe (three usage questions): ${JSON.stringify(seen)}`);
  assert.ok(seen.every((c) => / -h$/.test(c)), `only usage was asked of security: ${JSON.stringify(seen)}`);

  const read = run(ctx, fake, 'read');
  assert.strictEqual(read.store, 'file');
  assert.strictEqual(read.read && read.read.claudeAiOauth && read.read.claudeAiOauth.accessToken, 'at-test', JSON.stringify(read));
});

test('control: quaude on a modern security keeps the keychain store and writes no plaintext file', { timeout: 600000 }, (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.scratch = scratchFor(t);
  const out = run(ctx, modernSecurity(ctx.scratch.log), 'write');
  assert.deepStrictEqual({ store: out.store, name: out.name }, { store: 'keychain', name: 'keychain-with-plaintext-fallback' });
  assert.strictEqual(out.result.success, true, JSON.stringify(out));
  assert.ok(!fs.existsSync(ctx.scratch.creds), 'a capable keychain must not be downgraded to a plaintext file');
  const seen = calls(ctx.scratch.log);
  assert.ok(seen.some((c) => /^CALL: find-generic-password .*-w/.test(c)), `upstream read the keychain: ${JSON.stringify(seen)}`);
  assert.ok(seen.some((c) => /^STDIN: add-generic-password -U .* -X /.test(c)), `upstream wrote the keychain: ${JSON.stringify(seen)}`);
});

// ---- the ratchet: every security(1) verb and option the carve passes is probed ---------------
//
// The probe can only downgrade a tool that lacks something it ASKS about. If upstream starts
// passing a verb or option the probe does not ask about, a security(1) without it passes the
// probe, the keychain path stays, and login breaks the way Tiger's did, silently. So this guard
// reads every `security` invocation in the staged darwin carve (argv arrays, command strings
// handed to a runner, and the generic-password lines `security -i` reads from stdin) and requires each verb and option to be in the prelude's
// own table (__clodeKeychainNeeds), or exempt here with the reason a missing one cannot cost the
// login. It is the class this fix belongs to — a host tool upstream drives by name, judged by
// what upstream actually passes it — for the one tool whose capability decides the store.
const NEEDS = preludeIn(() => { throw new Error('unused'); }).__clodeKeychainNeeds;
const EXEMPT_VERBS = {
  '-i': 'the probe\'s own transport: a security(1) without interactive mode answers the probe with no verb '
    + 'usage at all, which the verdict reads as every verb missing',
  'show-keychain-info': 'used only to tell a LOCKED keychain (exit 36) from other write failures; a tool '
    + 'without it reads as not locked and upstream proceeds, with no wrong store',
};

function securityUses(sources) {
  const uses = [];
  for (const src of Object.values(sources)) {
    if (!src.includes('security') && !src.includes('-generic-password')) continue;
    for (const m of src.matchAll(/"security",\[([^\]]*)\]/g)) {
      const lits = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
      uses.push({ verb: lits[0], opts: lits.slice(1).filter((l) => /^-[A-Za-z]$/.test(l)), at: m[0].slice(0, 120) });
    }
    // A command string handed straight to a runner (lrt(`security <verb> ...`)): any verb.
    // The -i stdin lines and any other spelling of the keychain verbs (`add-generic-password -U
    // ...`): the generic-password family by name. Prose that only MENTIONS a command (an
    // "unlock it with `security unlock-keychain`" hint, a deny-list regexp) is neither.
    const OPTS = String.raw`((?:[ \t]+(?:-[A-Za-z](?![\w-])|\\?"\$\{[^}]*\}\\?"|\$\{[^}]*\}|[A-Za-z0-9_.-]+))*)`;
    for (const re of [new RegExp(String.raw`\(\x60security ([a-z]+(?:-[a-z]+)+)` + OPTS, 'g'),
      new RegExp(String.raw`(?<![\w-])((?:find|add|delete)-generic-password)` + OPTS, 'g')]) {
      for (const m of src.matchAll(re)) {
        const opts = [...m[2].matchAll(/(?:^|\s)(-[A-Za-z])(?![\w-])/g)].map((x) => x[1]);
        uses.push({ verb: m[1], opts, at: m[0].slice(0, 120) });
      }
    }
  }
  return uses;
}

function scanSecurityUses({ uses, needs, exempt }) {
  const findings = new Set();
  for (const u of uses) {
    if (Object.prototype.hasOwnProperty.call(exempt, u.verb)) continue;
    if (!Object.prototype.hasOwnProperty.call(needs, u.verb)) {
      findings.add(`upstream runs \`security ${u.verb}\` (${u.at}), which the keychain probe never asks about: add it `
        + 'to __clodeKeychainNeeds (libexec/extract-claude-js.cjs KEYCHAIN_PRELUDE), or exempt it here with the reason a '
        + 'tool without it cannot cost the login');
      continue;
    }
    for (const o of u.opts) {
      if (!needs[u.verb].includes(o)) {
        findings.add(`upstream passes \`security ${u.verb} ${o}\` (${u.at}), which the keychain probe never checks: add `
          + `${o} to __clodeKeychainNeeds['${u.verb}']`);
      }
    }
  }
  return { findings: [...findings], examined: uses.length,
    note: 'security(1) invocations in the staged darwin carve (argv arrays, command strings, -i stdin lines)' };
}

function readSecurityUses() {
  const staged = stageProviderCli();
  const skip = providerSkipReason(staged, 'no resolvable Claude Code provider (CLODE_PROVIDER_BIN / CLODE_CLAUDE_BIN / provider store)');
  if (skip) return { skip };
  try {
    const text = fs.readFileSync(staged.cli, 'utf8');
    const a = text.indexOf('JSON.parse(') + 'JSON.parse('.length;
    const { sources } = JSON.parse(JSON.parse(text.slice(a, text.indexOf(');\n', a))));
    if (!Object.values(sources).some((s) => s.includes('globalThis.__clodeKeychainUsable'))) {
      return { skip: 'the staged provider keeps no macOS keychain store (not a darwin carve): upstream drives no security(1)' };
    }
    return { uses: securityUses(sources), needs: NEEDS, exempt: EXEMPT_VERBS };
  } finally {
    fs.rmSync(staged.dir, { recursive: true, force: true });
  }
}

guardTests(defineGuard({
  name: 'keychain-probe-covers-security-calls',
  read: readSecurityUses,
  scan: scanSecurityUses,
  // Measured 48 invocations in the 2.1.332 darwin-arm64 carve (a command string counts once per
  // form that reads it). Floored well below, at 10: a provider bump can move the count, but
  // fewer than that means a form stopped being collected.
  floor: 10,
  // The real 2.1.332 write line plus one option the probe does not ask about (-T, which a real
  // add-generic-password takes): exactly the drift this guard exists to catch.
  control: () => ({
    uses: [...securityUses({ a: 'x=`add-generic-password -U -a "${e}" -s "${r}" -X "${fe(n)}"\n`;'
      + 'zS("security",["add-generic-password","-U","-a",o,"-s",n,"-T","",fe(i)])' })],
    needs: NEEDS, exempt: EXEMPT_VERBS,
  }),
}));

test('the security-call collector reads all three forms the 2.1.332 carve uses', () => {
  const uses = securityUses({ x: 'lrt(`security find-generic-password -a "${g}" -w -s "${l}"`,{});'
    + 'zS("security",["-i"],{input:`add-generic-password -U -a "${e}" -s "${Re}" -X "${Pe}" "${n}"\n`});'
    + 'vt("security",["delete-generic-password","-a",n,"-s",r],{});vt("security",["show-keychain-info"])' });
  const by = (v) => [...new Set(uses.filter((u) => u.verb === v).flatMap((u) => u.opts))].sort();
  assert.deepStrictEqual(by('find-generic-password'), ['-a', '-s', '-w']);
  assert.deepStrictEqual(by('add-generic-password'), ['-U', '-X', '-a', '-s']);
  assert.deepStrictEqual(by('delete-generic-password'), ['-a', '-s']);
  assert.ok(uses.some((u) => u.verb === '-i') && uses.some((u) => u.verb === 'show-keychain-info'));
  assert.deepStrictEqual(scanSecurityUses({ uses, needs: NEEDS, exempt: EXEMPT_VERBS }).findings, []);
  // A verb the probe never asks about is a finding too.
  const unlock = securityUses({ x: 'vt("security",["unlock-keychain","-p",p])' });
  assert.strictEqual(scanSecurityUses({ uses: unlock, needs: NEEDS, exempt: EXEMPT_VERBS }).findings.length, 1);
});
