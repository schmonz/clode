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
// FLOOR: 2 (the Grep builder and the Glob builder, each found exactly once).
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

// The two builders' argv spans, VERBATIM from the 2.1.283 darwin-arm64 carve (decoded graph.json,
// 2026-10-03), as one text: the Grep builder from its `["--hidden"]` to its --iglob push, the
// Glob builder from its argv array to its --iglob push.
const CARVE_2_1_283 = "Me=[\"--hidden\"],Ne=[],Fe=new Set,We=(Pn)=>{Fe.add(Me.length),Me.push(\"--glob\",Pn)};for(let Pn of fIn)We(`!${Pn}`);if(Me.push(\"--max-columns\",\"500\"),ve)Me.push(\"-U\",\"--multiline-dotall\");if(W)Me.push(\"-i\");if(g===\"files_with_matches\")Me.push(\"-l\");else if(g===\"count\")Me.push(\"-c\",\"-H\");if(Me.push(g===\"content\"?\"--json\":\"--null\"),g===\"content\")Me.push(\"-n\");if(q&&g===\"content\")Me.push(\"-o\");if(g===\"content\")if(D!==void 0)Me.push(\"-C\",D.toString());else if(w!==void 0)Me.push(\"-C\",w.toString());else{if(h!==void 0)Me.push(\"-B\",h.toString());if(b!==void 0)Me.push(\"-A\",b.toString())}if(n.startsWith(\"-\"))Me.push(\"-e\",n);else Me.push(n);if(s)Me.push(\"--type\",s);if(r){let Pn=[],zn=r.split(/\\s+/);for(let Zn of zn)if(Zn.includes(\"{\")&&Zn.includes(\"}\"))Pn.push(Zn);else Pn.push(...Zn.split(\",\").filter(Boolean));for(let Zn of Pn.filter(Boolean))Ne.push(Me.length),We(Zn)}let He=cct(Ee.permissions()),ze=Vin(He,e),mt=e.judgeEveryResult===!0||fjn(He,e);for(let Pn of ze)Me.push(\"--iglob\",Pn)"
  + ';' + "q=[\"--files\",\"--null\",\"--glob\",n,\"--sort=modified\",...F?[\"--no-ignore\"]:[],...W?[\"--hidden\"]:[]];for(let We of D)q.push(\"--iglob\",We)";

function scanBuilders({ text, what }) {
  const found = P.builderFlagLiterals(text);
  const findings = P.matrixDrift(text);
  const examined = ['grep', 'glob'].filter((k) => !found[k].missing).length;
  return { findings, examined, note: `${what}: ${examined} of 2 builders found` };
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
  floor: 2,
  read: readCarve,
  scan: scanBuilders,
  control: () => ({ text: controlText(), what: 'synthetic control' }),
}));

test('the verbatim 2.1.283 builders agree with the matrix (the fixture the control edits is clean)', () => {
  const r = scanBuilders({ text: CARVE_2_1_283, what: 'the 2.1.283 fixture' });
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.examined, 2);
});

test('the control differs from the fixture by exactly the one planted flag, and the finding names the Grep builder', () => {
  assert.notStrictEqual(controlText(), CARVE_2_1_283);
  const r = scanBuilders({ text: controlText(), what: 'control' });
  assert.strictEqual(r.findings.length, 1);
  assert.match(r.findings[0], /^grep: the carve's builder writes .*"--multiline-dotall","--crlf"/);
});

test('a builder that is not in the carve is a finding and is not counted as examined', () => {
  const r = scanBuilders({ text: CARVE_2_1_283.replace('"--files","--null","--glob"', '"--files","--glob"'), what: 'no Glob' });
  assert.strictEqual(r.examined, 1);
  assert.match(r.findings.join('\n'), /^glob: .* is not in the carve exactly once/m);
});

test('a builder found twice is not trusted: it is a finding, not a pick', () => {
  const r = scanBuilders({ text: CARVE_2_1_283 + ';' + CARVE_2_1_283, what: 'twice' });
  assert.strictEqual(r.examined, 0);
  assert.strictEqual(r.findings.length, 2);
});
