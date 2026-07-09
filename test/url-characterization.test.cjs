'use strict';
// URL/URLSearchParams characterization: freezes tjs-today URL behavior as
// the contract for the ada-ectomy (replacing deps/ada with plain C).
//
// Three layers:
//   1. host node runs the corpus in-process (node's URL is ada-backed too,
//      so node-vs-tjs divergences are findings, NOT failures — reported in
//      full as diagnostics);
//   2. tjs runs the identical corpus via test/fixtures/url/urlchar-tjs-main.mjs;
//   3. the tjs payload is compared against the frozen golden manifest
//      test/fixtures/url/golden-tjs-url.json — THE CONTRACT the future C
//      implementation must reproduce byte-for-byte. Drift fails loudly.
//
// Regenerating the golden is explicit, never automatic:
//   CLODE_REGEN_URL_GOLDEN=1 node --test test/url-characterization.test.cjs
// then update GOLDEN_SHA256 below with the printed value.
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

test('url characterization: corpus, node-vs-tjs report, tjs golden', { timeout: 180000 }, async (t) => {
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
        t.diagnostic(`DIVERGENCE ${d.section}#${d.index}: ` +
            `node=${JSON.stringify(d.node)} tjs=${JSON.stringify(d.tjs)}`);
    }

    // --- golden: frozen tjs-today behavior (the ada-ectomy contract) ---
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
    assert.deepStrictEqual(tjsRes, JSON.parse(onDisk),
        'tjs URL behavior drifted from the frozen golden manifest ' +
        '(the ada-ectomy contract); investigate before regenerating');
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
