// tjs entry point for the URL characterization runner.
// Usage: build/tjs/tjs run test/fixtures/url/urlchar-tjs-main.mjs
// Reads the vendored corpus JSON beside itself, runs urlchar-core, and
// prints the results payload as a single JSON document on stdout.

import { runAll } from './urlchar-core.mjs';

const here = new URL('.', import.meta.url).pathname;
// ignoreBOM: tjs's default TextDecoder strips U+FEFF anywhere in the stream
// (not just a leading BOM); urltestdata.json contains a mid-string BOM case
// (http://example.com/<U+FEFF>/foo) that must reach URL intact. The corpus
// files themselves have no leading BOM, so ignoreBOM is safe.
const dec = new TextDecoder('utf-8', { ignoreBOM: true });

async function readJSON(name) {
    const buf = await tjs.readFile(here + name);
    return JSON.parse(dec.decode(buf));
}

const corpora = {
    urltestdata: await readJSON('urltestdata.json'),
    settersTests: await readJSON('setters_tests.json'),
    toascii: await readJSON('toascii.json'),
    percentEncoding: await readJSON('percent-encoding.json'),
};

console.log(JSON.stringify(runAll(corpora)));
