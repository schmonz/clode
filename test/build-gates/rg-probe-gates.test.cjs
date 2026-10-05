'use strict';
// rg-probe-gates: the build gate over scripts/lib/rg-probe.cjs's argv matrix (RG_MATRIX's
// grepArgv and globArgv), the argv test/fidelity/rg-differential.test.cjs judges native's
// embedded rg and quaude's rg on. It reads the PINNED carve's own Grep and Glob argv builders
// (`_In` and `eIn` in 2.1.283, found BY STRUCTURE, never by those names) and requires the
// matrix's builders to write the same flag literals in the same order (rg-probe.cjs
// matrixDrift). The day upstream adds, drops, reorders or re-values a flag, as 2.1.251 did when
// content mode became --json, this goes red, instead of the differential going on judging an
// argv the tools no longer build. upstream-drift.yml runs it daily against upstream's `next`.
//
// It is also what CONTROLS rg-probe.cjs (test/guards-population.cjs): the module derives a
// verdict from bytes and refuses (a native that does not run, a probe that answers short), so
// it is a gate by the sweep's reading, and a gate needs a guard that can fail.
//
// AND it reads the consumer's usage-error regex (`TQ`, found by structure beside the "Search
// failed ... ripgrep rejected the pattern" class it throws) and requires quaude's refusal
// (rg-native.cjs rgRefusal) to pass it: a refusal that fails it reaches the model as "no
// results", the silent wrong answer the refusal exists to replace. Read from the carve, never
// copied into a test.
//
// FLOOR: 3 (the Grep builder, the Glob builder and the usage-error regex, each found once).
// CONTROL: the 2.1.283 builders verbatim, with ONE more flag pushed beside -U.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { defineGuard, guardTests } = require('../guard.cjs');
const P = require('../../scripts/lib/rg-probe.cjs');
const { decodeGraphRunner } = require('../../libexec/inspect-claude-bundle.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const EXTRACT = path.join(REPO, 'libexec', 'extract-claude-js.cjs');

// VERBATIM from the 2.1.283 darwin-arm64 carve (decoded graph.json, 2026-10-03), as one text: the
// Grep builder from its `["--hidden"]` to its --iglob push, the Glob builder from its argv array to
// its --iglob push, the consumer's usage-error regex with the class it throws, and the test that
// throws it.
const CARVE_2_1_283 = "Me=[\"--hidden\"],Ne=[],Fe=new Set,We=(Pn)=>{Fe.add(Me.length),Me.push(\"--glob\",Pn)};for(let Pn of fIn)We(`!${Pn}`);if(Me.push(\"--max-columns\",\"500\"),ve)Me.push(\"-U\",\"--multiline-dotall\");if(W)Me.push(\"-i\");if(g===\"files_with_matches\")Me.push(\"-l\");else if(g===\"count\")Me.push(\"-c\",\"-H\");if(Me.push(g===\"content\"?\"--json\":\"--null\"),g===\"content\")Me.push(\"-n\");if(q&&g===\"content\")Me.push(\"-o\");if(g===\"content\")if(D!==void 0)Me.push(\"-C\",D.toString());else if(w!==void 0)Me.push(\"-C\",w.toString());else{if(h!==void 0)Me.push(\"-B\",h.toString());if(b!==void 0)Me.push(\"-A\",b.toString())}if(n.startsWith(\"-\"))Me.push(\"-e\",n);else Me.push(n);if(s)Me.push(\"--type\",s);if(r){let Pn=[],zn=r.split(/\\s+/);for(let Zn of zn)if(Zn.includes(\"{\")&&Zn.includes(\"}\"))Pn.push(Zn);else Pn.push(...Zn.split(\",\").filter(Boolean));for(let Zn of Pn.filter(Boolean))Ne.push(Me.length),We(Zn)}let He=cct(Ee.permissions()),ze=Vin(He,e),mt=e.judgeEveryResult===!0||fjn(He,e);for(let Pn of ze)Me.push(\"--iglob\",Pn)"
  + ';' + "q=[\"--files\",\"--null\",\"--glob\",n,\"--sort=modified\",...F?[\"--no-ignore\"]:[],...W?[\"--hidden\"]:[]];for(let We of D)q.push(\"--iglob\",We)"
  + ';' + "var TQ=/^rg: (?:regex parse error|error parsing glob|unrecognized file type|error parsing flag|compiled regex exceeds size limit)/m;class CD extends P{constructor(e){super(`Search failed \\u2014 ripgrep rejected the pattern, glob, or file type without searching:\n${re(e.trim(),2000)}`,\"ripgrep usage error (input rejected, stderr redacted)\")"
  + ';' + "&&S.code===2&&X.length===0&&TQ.test(w)){g(new CD(w));return}";

// Three things examined: the Grep builder, the Glob builder, and the consumer's usage-error
// regex (each counted only when found exactly once).
function scanBuilders({ text, what }) {
  const found = P.builderFlagLiterals(text);
  const usage = P.consumerUsageErrorRegex(text);
  const findings = [...P.matrixDrift(text), ...P.refusalDrift(text)];
  const examined = ['grep', 'glob'].filter((k) => !found[k].missing).length + (usage.missing ? 0 : 1);
  return { findings, examined, note: `${what}: ${examined} of 3 found (the Grep and Glob builders, the usage-error regex)` };
}

// The carve of CLODE_PROVIDER_BIN, decoded the way inspect-claude-bundle reads it: the seventh
// copy of this reader in test/build-gates (BACKLOG.md, "readCarve has seven copies"), by the
// same convention.
function readCarve() {
  const bin = process.env.CLODE_PROVIDER_BIN;
  if (!bin || !fs.existsSync(bin)) return { skip: 'no CLODE_PROVIDER_BIN (point it at a real claude binary to run this gate)' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-probe-gate-'));
  try {
    const cli = path.join(dir, 'cli.cjs');
    const ex = spawnSync(process.execPath, [EXTRACT, bin, cli], { encoding: 'utf8' });
    if (ex.status !== 0) throw new Error(`extract-claude-js could not carve ${bin}: ${(ex.stderr || '').slice(0, 400)}`);
    const decoded = decodeGraphRunner(cli);
    return { text: decoded !== null ? decoded : fs.readFileSync(cli, 'latin1'), what: `the carve of ${bin}` };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const controlText = () => CARVE_2_1_283.replace('Me.push("-U","--multiline-dotall")', 'Me.push("-U","--multiline-dotall","--crlf")');

guardTests(defineGuard({
  name: 'rg-matrix-from-carve',
  floor: 3,
  read: readCarve,
  scan: scanBuilders,
  control: () => ({ text: controlText(), what: 'synthetic control' }),
}));

test('the verbatim 2.1.283 builders agree with the matrix (the fixture the control edits is clean)', () => {
  const r = scanBuilders({ text: CARVE_2_1_283, what: 'the 2.1.283 fixture' });
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.examined, 3);
});

test('the control differs from the fixture by exactly the one planted flag, and the finding names the Grep builder', () => {
  assert.notStrictEqual(controlText(), CARVE_2_1_283);
  const r = scanBuilders({ text: controlText(), what: 'control' });
  assert.strictEqual(r.findings.length, 1);
  assert.match(r.findings[0], /^grep: the carve's builder writes .*"--multiline-dotall","--crlf"/);
});

test('a builder that is not in the carve is a finding and is not counted as examined', () => {
  const r = scanBuilders({ text: CARVE_2_1_283.replace('"--files","--null","--glob"', '"--files","--glob"'), what: 'no Glob' });
  assert.strictEqual(r.examined, 2);
  assert.match(r.findings.join('\n'), /^glob: .* is not in the carve exactly once/m);
});

test('a builder found twice is not trusted: it is a finding, not a pick', () => {
  const r = scanBuilders({ text: CARVE_2_1_283 + ';' + CARVE_2_1_283, what: 'twice' });
  assert.strictEqual(r.examined, 0);
  assert.strictEqual(r.findings.length, 3);
});

test('the consumer\'s usage-error regex is found in the fixture by structure, and quaude\'s refusal passes it', () => {
  const r = scanBuilders({ text: CARVE_2_1_283, what: 'the 2.1.283 fixture' });
  assert.strictEqual(r.examined, 3);
  assert.deepStrictEqual(r.findings, []);
});

test('a usage-error regex that no longer passes quaude\'s refusal is a finding (the model would read "no results")', () => {
  const r = scanBuilders({ text: CARVE_2_1_283.replace('|error parsing flag|', '|'), what: 'narrowed' });
  assert.strictEqual(r.examined, 3);
  assert.strictEqual(r.findings.length, 2, r.findings.join('\n'));
  for (const f of r.findings) assert.match(f, /^usage-error regex: the carve's .* does not pass quaude's refusal/);
});

test('a consumer whose usage-error test cannot be found is a finding and is not counted as examined', () => {
  const r = scanBuilders({ text: CARVE_2_1_283.replace('TQ.test(w)', 'TQ.exec(w)'), what: 'no test' });
  assert.strictEqual(r.examined, 2);
  assert.match(r.findings.join('\n'), /^usage-error regex: the test that throws CD is in the carve 0 times/m);
});

// The linux-x64 2.1.283 carve (found by grep-native Task 11's Linux run, where this gate was BROKEN, 2 of 3): its
// minifier binds the consumer's regex name twice, in two modules (`_Q=/^rg: (?:regex parse error|.../m` beside the
// consumer, `_Q=/^\/?_blob\/[0-9a-f]{32}$/` in another). A minified name is a module's own, so the binding read is the
// one in the module of the test that uses it; two there are still not trusted.
const HDR = (name) => `\nimport.meta.require = globalThis.__quaudeRequire; import.meta.url = "file://${name}";\n`;
test('the usage-error regex is the binding in the consumer\'s own module when the name is bound in another too (linux-x64 2.1.283)', () => {
  const other = `${HDR('/$bunfs/root/chunk-blob.js')}var a=new Set(["x"]),TQ=/^\\/?_blob\\/[0-9a-f]{32}$/;function f(){}`;
  const consumer = `${HDR('/$bunfs/root/chunk-grep.js')}${CARVE_2_1_283}`;
  for (const text of [other + consumer, consumer + other]) {
    const r = scanBuilders({ text, what: 'two modules' });
    assert.strictEqual(r.examined, 3, r.findings.join('\n'));
    assert.deepStrictEqual(r.findings, []);
  }
  const twice = `${HDR('/$bunfs/root/chunk-grep.js')}var TQ=/^x/;${CARVE_2_1_283}`;
  const r = scanBuilders({ text: twice, what: 'one module, twice' });
  assert.strictEqual(r.examined, 2);
  assert.match(r.findings.join('\n'), /^usage-error regex: the regex TQ is bound in the consumer's module 2 times, not once/m);
});
