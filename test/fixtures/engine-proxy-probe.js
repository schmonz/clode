// The ENGINE's own proxy support, measured directly (no node-shim, no bundle):
// txiki's `fetch` and its global `XMLHttpRequest` are where essentially all of
// quaude's traffic goes, so "does the engine honour HTTP_PROXY" is a fact the
// suite has to keep checking — an engine bump that lost it would show up as a
// silent bypass with nothing in our own code to blame.
//
// Runs under tjs only (`tjs run`). Prints one JSON line.
const origin = `http://127.0.0.1:${tjs.env.PROBE_ORIGIN}`;
const out = {};

(async () => {
    try {
        const r = await fetch(`${origin}/echo`);
        out.fetch = { status: r.status, len: (await r.text()).length };
    } catch (e) {
        out.fetch = { error: String((e && e.message) || e) };
    }

    await new Promise((resolve) => {
        const x = new XMLHttpRequest();
        x.onload = () => { out.xhr = { status: x.status, len: String(x.responseText || '').length }; resolve(); };
        x.onerror = () => { out.xhr = { error: 'onerror' }; resolve(); };
        x.open('GET', `${origin}/echo`);
        x.send();
    });

    console.log(JSON.stringify(out));
})();
