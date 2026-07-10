'use strict';
// URL/URLSearchParams characterization: grades the pinned tjs URL parser
// against the frozen ada-era golden manifest under the ada-ectomy L1'
// GRADING RULE (wurl is now the default parser in our tjs recipe).
//
// Three layers:
//   1. host node runs the corpus in-process (node's URL is ada-backed, so
//      node-vs-tjs divergences are findings, NOT failures — reported in
//      full as diagnostics);
//   2. tjs runs the identical corpus via test/fixtures/url/urlchar-tjs-main.mjs;
//   3. the tjs payload is GRADED against the frozen golden manifest
//      test/fixtures/url/golden-tjs-url.json — captured from the ada build;
//      its DATA stays frozen. The grade is NOT strict byte-equality:
//        - every case NOT tagged nonAsciiHost must match byte-exactly;
//        - tagged cases may REJECT where the golden succeeds (parse: throws;
//          toascii: throws and/or host-setter no-op; setters: forgiving
//          no-op leaving the URL at its pre-setter state, verified by
//          re-probing the engine under test) but must NEVER value-diverge
//          from the golden;
//        - the accepted-reject SET is pinned byte-for-byte in
//          test/fixtures/url/accepted-rejects.json — a NEW reject or a
//          DISAPPEARING reject fails loudly (either direction is a real
//          behavior change; regen only with review).
//      The rule grades an ada build trivially green too (zero rejects, all
//      exact — regen the reject fixture to []), so it is parser-agnostic.
//      wurl's IDNA sits at L1' (punycode + oracle-generated allow-bitmap,
//      never more permissive than the golden by construction); at L2 (full
//      UTS-46) the reject set should shrink toward empty and this test
//      tightens naturally back to byte-equality.
//
// Regenerating fixtures is explicit, never automatic:
//   golden (engine snapshot; only on a deliberate contract change):
//     CLODE_REGEN_URL_GOLDEN=1 node --test test/url-characterization.test.cjs
//     then update GOLDEN_SHA256 below with the printed value.
//   accepted-reject set (parser swap or IDNA level change):
//     CLODE_REGEN_URL_REJECTS=1 node --test test/url-characterization.test.cjs
//
// Corpus: vendored wpt url test data (see test/fixtures/url/README.md for
// provenance) plus a hand-written URLSearchParams corpus in urlchar-core.mjs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { tjsPath, skipUnlessTjs } = require('./node-shim-helper.cjs');

const FIXDIR = path.join(__dirname, 'fixtures/url');
const GOLDEN_PATH = path.join(FIXDIR, 'golden-tjs-url.json');
const REJECTS_PATH = path.join(FIXDIR, 'accepted-rejects.json');
const TJS_MAIN = path.join(FIXDIR, 'urlchar-tjs-main.mjs');

// sha256 of golden-tjs-url.json. Drift in the file itself (not just in tjs
// behavior) is loud. Update only alongside an explicit, reviewed regen.
const GOLDEN_SHA256 = '3debd9afc5ae84c5f3825f8d9054ca47698fbc767625bad392c67253ad1dd4f7';

function loadCorpora() {
    const rd = (n) => JSON.parse(fs.readFileSync(path.join(FIXDIR, n), 'utf8'));
    return {
        urltestdata: rd('urltestdata.json'),
        settersTests: rd('setters_tests.json'),
        toascii: rd('toascii.json'),
        percentEncoding: rd('percent-encoding.json'),
    };
}

function runTjs() {
    const r = spawnSync(tjsPath(), ['run', TJS_MAIN], {
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 64 * 1024 * 1024,
    });
    assert.strictEqual(r.status, 0, `tjs runner failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
}

function probeTjs(script) {
    const p = spawnSync(tjsPath(), ['eval', script], {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 16 * 1024 * 1024,
    });
    return p.stdout.trim();
}

function diffPayloads(nodeRes, tjsRes) {
    const sections = Object.keys(nodeRes);
    assert.deepStrictEqual(Object.keys(tjsRes), sections, 'payload sections differ');
    let total = 0;
    const divergences = [];
    for (const sec of sections) {
        assert.strictEqual(tjsRes[sec].length, nodeRes[sec].length, `case count differs in section ${sec}`);
        for (let i = 0; i < nodeRes[sec].length; i++) {
            total++;
            if (JSON.stringify(nodeRes[sec][i]) !== JSON.stringify(tjsRes[sec][i])) {
                divergences.push({ section: sec, index: i, node: nodeRes[sec][i], tjs: tjsRes[sec][i] });
            }
        }
    }
    return { total, divergences };
}

// The L1' grading rule (see header). Returns { stats, failures,
// acceptedRejects }; any failure means the engine under test either
// value-diverged from the golden or rejected an untagged case.
function gradeAgainstGolden(golden, mine) {
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const stats = {};
    const failures = [];
    const acceptedRejects = [];
    for (const sec of Object.keys(golden)) {
        stats[sec] = { total: golden[sec].length, exact: 0, acceptReject: 0, fail: 0 };
        assert.ok(mine[sec] && mine[sec].length === golden[sec].length,
            `section ${sec}: case count mismatch vs golden`);
        for (let i = 0; i < golden[sec].length; i++) {
            const g = golden[sec][i];
            const m = mine[sec][i];
            if (eq(g, m)) { stats[sec].exact++; continue; }
            const tagged = g.nonAsciiHost === true;
            let ok = false;
            let kind = '';
            if (tagged && sec === 'parse') {
                // acceptable: we throw where the golden succeeded, and every
                // other field of the case record is identical
                ok = g.result !== 'throws' && m.result === 'throws' &&
                    m.canParse === false && m.staticParseNull === true &&
                    eq({ ...g, result: 0, canParse: 0, staticParseNull: 0 },
                        { ...m, result: 0, canParse: 0, staticParseNull: 0 });
                kind = 'parse-throws';
            } else if (tagged && sec === 'toascii') {
                // acceptable: viaURL throws where golden has a value, and/or
                // viaHostSetter left the host unchanged ('y') where golden
                // changed it; everything else identical
                const urlOK = eq(g.viaURL, m.viaURL) ||
                    (g.viaURL !== 'throws' && m.viaURL === 'throws');
                const setOK = eq(g.viaHostSetter, m.viaHostSetter) ||
                    (g.viaHostSetter !== 'y' && m.viaHostSetter === 'y');
                ok = urlOK && setOK &&
                    eq({ ...g, viaURL: 0, viaHostSetter: 0 }, { ...m, viaURL: 0, viaHostSetter: 0 });
                kind = 'toascii-reject';
            } else if (tagged && sec === 'setters') {
                // acceptable: forgiving no-op — the engine's result equals the
                // PRE-setter snapshot of new URL(href) in the engine under
                // test, verified by re-probing it (not assumed from golden)
                if (g.constructThrew !== true && m.constructThrew !== true &&
                    m.setterThrew === g.setterThrew) {
                    const script = `
                        const u = new URL(${JSON.stringify(g.href)});
                        const out = {};
                        for (const k of ['href','protocol','username','password','host','hostname','port','pathname','search','hash','origin']) out[k] = u[k];
                        console.log(JSON.stringify(out));
                    `;
                    try {
                        ok = eq(m.result, JSON.parse(probeTjs(script)));
                    } catch { ok = false; }
                }
                kind = 'setter-noop';
            }
            if (ok) {
                stats[sec].acceptReject++;
                acceptedRejects.push({ section: sec, index: i, kind, case: g.input ?? g.href ?? g.name });
            } else {
                stats[sec].fail++;
                failures.push({ section: sec, index: i, tagged, golden: g, mine: m });
            }
        }
    }
    return { stats, failures, acceptedRejects };
}

test('url characterization: corpus, node-vs-tjs report, golden L1\' grade', { timeout: 180000 }, async (t) => {
    if (skipUnlessTjs(t)) {
        return;
    }

    const core = await import(pathToFileURL(path.join(FIXDIR, 'urlchar-core.mjs')));
    const corpora = loadCorpora();
    const nodeRes = core.runAll(corpora);
    const tjsRes = runTjs();

    // --- node-vs-tjs differential (findings, not failures) ---
    const { total, divergences } = diffPayloads(nodeRes, tjsRes);
    const nonAscii = {
        parse: nodeRes.parse.filter((c) => c.nonAsciiHost).length,
        setters: nodeRes.setters.filter((c) => c.nonAsciiHost).length,
        toascii: nodeRes.toascii.filter((c) => c.nonAsciiHost).length,
    };
    t.diagnostic(`corpus: ${total} cases ` +
        `(parse ${nodeRes.parse.length}, setters ${nodeRes.setters.length}, ` +
        `toascii ${nodeRes.toascii.length}, percentEncoding ${nodeRes.percentEncoding.length}, ` +
        `searchParams ${nodeRes.searchParams.length})`);
    t.diagnostic(`node-vs-tjs: ${total - divergences.length} agree, ${divergences.length} diverge ` +
        `(node ${process.versions.node}/ada ${process.versions.ada})`);
    t.diagnostic(`nonAsciiHost-tagged: parse ${nonAscii.parse}, setters ${nonAscii.setters}, toascii ${nonAscii.toascii}`);
    for (const d of divergences) {
        t.diagnostic(`node-vs-tjs divergence ${d.section}#${d.index}: ` +
            `node=${JSON.stringify(d.node)} tjs=${JSON.stringify(d.tjs)}`);
    }

    // --- golden: frozen ada-era behavior, graded under the L1' rule ---
    const goldenBytes = JSON.stringify(tjsRes, null, 1) + '\n';
    if (process.env.CLODE_REGEN_URL_GOLDEN === '1') {
        fs.writeFileSync(GOLDEN_PATH, goldenBytes);
        const sha = crypto.createHash('sha256').update(goldenBytes).digest('hex');
        t.diagnostic(`golden REGENERATED: ${GOLDEN_PATH}`);
        t.diagnostic(`update GOLDEN_SHA256 in ${__filename} to: ${sha}`);
        return;
    }

    assert.ok(fs.existsSync(GOLDEN_PATH),
        `missing golden ${GOLDEN_PATH}; generate with CLODE_REGEN_URL_GOLDEN=1`);
    const onDisk = fs.readFileSync(GOLDEN_PATH, 'utf8');
    const onDiskSha = crypto.createHash('sha256').update(onDisk).digest('hex');
    assert.strictEqual(onDiskSha, GOLDEN_SHA256,
        'golden-tjs-url.json does not match the sha recorded in this test; ' +
        'if a regen was intended, update GOLDEN_SHA256 alongside it');

    const { stats, failures, acceptedRejects } = gradeAgainstGolden(JSON.parse(onDisk), tjsRes);
    for (const sec of Object.keys(stats)) {
        const s = stats[sec];
        t.diagnostic(`grade ${sec}: ${s.exact}/${s.total} exact, ` +
            `${s.acceptReject} accepted-rejects (tagged), ${s.fail} failures`);
    }
    for (const f of failures.slice(0, 20)) {
        t.diagnostic(`GRADE FAILURE ${f.section}#${f.index} ${f.tagged ? '(tagged)' : '(UNTAGGED)'}: ` +
            `golden=${JSON.stringify(f.golden)} mine=${JSON.stringify(f.mine)}`);
    }
    assert.strictEqual(failures.length, 0,
        `tjs URL behavior fails the L1' grade against the frozen golden: ` +
        `${failures.length} case(s) either value-diverge or reject untagged input; ` +
        'see GRADE FAILURE diagnostics; investigate before touching fixtures');

    // --- accepted-reject set: pinned, both directions loud ---
    const rejectsBytes = JSON.stringify(acceptedRejects, null, 1) + '\n';
    if (process.env.CLODE_REGEN_URL_REJECTS === '1') {
        fs.writeFileSync(REJECTS_PATH, rejectsBytes);
        t.diagnostic(`accepted-reject set REGENERATED (${acceptedRejects.length} entries): ${REJECTS_PATH}`);
        return;
    }
    assert.ok(fs.existsSync(REJECTS_PATH),
        `missing reject-set fixture ${REJECTS_PATH}; generate with CLODE_REGEN_URL_REJECTS=1`);
    assert.deepStrictEqual(acceptedRejects, JSON.parse(fs.readFileSync(REJECTS_PATH, 'utf8')),
        'accepted-reject set drifted from test/fixtures/url/accepted-rejects.json — ' +
        'a new reject means lost parsing capability; a disappearing reject means ' +
        'new acceptance that must be reviewed against the spec (or IDNA L2 landed: ' +
        'regen the fixture deliberately)');
});

test('url characterization: node-side corpus sanity', async (t) => {
    // Runs without tjs: the corpus itself and the node-side runner must be
    // healthy on any machine (guards against corrupted fixture edits).
    const core = await import(pathToFileURL(path.join(FIXDIR, 'urlchar-core.mjs')));
    const corpora = loadCorpora();
    const res = core.runAll(corpora);
    assert.ok(res.parse.length >= 800, `urltestdata unexpectedly small: ${res.parse.length}`);
    assert.ok(res.setters.length >= 250, `setters_tests unexpectedly small: ${res.setters.length}`);
    assert.ok(res.toascii.length >= 80, `toascii unexpectedly small: ${res.toascii.length}`);
    assert.ok(res.searchParams.length >= 40, `searchParams hand corpus too small: ${res.searchParams.length}`);
    // wpt expectations should mostly agree with node's ada on throw/no-throw.
    // A small residue is expected where wpt master tracks spec changes ahead
    // of ada (as vendored: 8 cases, all invalid-punycode xn-- labels that a
    // spec change now allows). A jump in this number means corpus corruption
    // or a real behavior shift — investigate.
    const bad = res.parse.filter((c) => (c.result === 'throws') !== c.expectFailure);
    for (const b of bad) {
        t.diagnostic(`node-vs-wpt-expectation: ${JSON.stringify(b.input)} ` +
            `expectFailure=${b.expectFailure} got=${b.result === 'throws' ? 'throws' : 'parses'}`);
    }
    assert.ok(bad.length <= 10,
        `node disagrees with wpt corpus throw-expectations on ${bad.length} cases (expected <= 10)`);
});
