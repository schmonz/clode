// Engine-neutral URL/URLSearchParams characterization core.
//
// Runs the vendored wpt corpus (urltestdata.json, setters_tests.json,
// toascii.json, percent-encoding.json) plus a hand-written URLSearchParams
// corpus through whatever URL/URLSearchParams implementation the current
// engine provides, and returns a plain-JSON results payload.
//
// MUST stay engine-neutral: no node:*, no tjs:*, no I/O, no Date/random.
// The payload must be a deterministic function of (corpora, engine behavior)
// so that host-node and tjs payloads are directly diffable and the tjs
// payload can be frozen as a golden manifest.
//
// Error capture policy: success-vs-throws only (never message text) —
// exception messages are implementation detail.

'use strict';

const PARSE_COMPONENTS = [
    'href', 'protocol', 'username', 'password', 'host', 'hostname',
    'port', 'pathname', 'search', 'hash', 'origin',
];

function snapshot(u) {
    const out = {};
    for (const k of PARSE_COMPONENTS) {
        out[k] = u[k];
    }
    return out;
}

// --- non-ASCII-host tagging -------------------------------------------------
//
// Deterministic function of the INPUT TEXT only (never of parse results), so
// both engines produce identical tags. Heuristic: extract the authority
// region (after scheme "//", or a protocol-relative "//" resolved against a
// base with a special scheme) and flag it when it contains a codepoint >127
// or a percent-encoded high byte (%80-%FF). Overcounts slightly for opaque
// (non-special-scheme) hosts, which percent-encode instead of IDNA-mapping;
// that is acceptable for grading an IDNA ladder (superset, never a miss).

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.\-]*:/;

function authorityOf(s) {
    // WHATWG parsers strip tab/newline before parsing.
    s = s.replace(/[\t\n\r]/g, '');
    let rest = null;
    const m = SCHEME_RE.exec(s);
    if (m) {
        rest = s.slice(m[0].length);
    } else if (s.startsWith('//')) {
        rest = s; // protocol-relative against base
    }
    if (rest === null || !/^[/\\]{2}/.test(rest)) {
        return null;
    }
    rest = rest.replace(/^[/\\]+/, '');
    const end = rest.search(/[/\\?#]/);
    let auth = end === -1 ? rest : rest.slice(0, end);
    const at = auth.lastIndexOf('@');
    if (at !== -1) {
        auth = auth.slice(at + 1);
    }
    return auth;
}

function isNonAsciiHostText(auth) {
    if (auth === null) {
        return false;
    }
    return /[^\x00-\x7f]/.test(auth) || /%[89a-fA-F][0-9a-fA-F]/.test(auth);
}

export function tagNonAsciiHost(input, base) {
    const a = authorityOf(String(input));
    if (isNonAsciiHostText(a)) {
        return true;
    }
    // A relative input inherits the base's host.
    if (a === null && base != null && isNonAsciiHostText(authorityOf(String(base)))) {
        return true;
    }
    return false;
}

// --- corpus runners ---------------------------------------------------------

export function runParseCorpus(urltestdata) {
    const out = [];
    for (const entry of urltestdata) {
        if (typeof entry !== 'object' || entry === null) {
            continue; // section comment strings
        }
        const { input, base } = entry;
        const rec = { input, base: base ?? null };
        rec.nonAsciiHost = tagNonAsciiHost(input, base);
        let threw = false;
        try {
            const u = base != null ? new URL(input, base) : new URL(input);
            rec.result = snapshot(u);
        } catch (e) {
            threw = true;
            rec.result = 'throws';
        }
        try {
            rec.canParse = base != null ? URL.canParse(input, base) : URL.canParse(input);
        } catch (e) {
            rec.canParse = 'throws';
        }
        try {
            const p = base != null ? URL.parse(input, base) : URL.parse(input);
            rec.staticParseNull = p === null;
        } catch (e) {
            rec.staticParseNull = 'throws';
        }
        // corpus expectation, kept for readability of divergences
        rec.expectFailure = entry.failure === true;
        void threw;
        out.push(rec);
    }
    return out;
}

export function runSettersCorpus(settersTests) {
    const out = [];
    for (const property of Object.keys(settersTests)) {
        if (property === 'comment') {
            continue;
        }
        for (const c of settersTests[property]) {
            const rec = { property, href: c.href, new_value: c.new_value };
            rec.nonAsciiHost = tagNonAsciiHost(c.href) || tagNonAsciiHost(c.new_value) ||
                ((property === 'host' || property === 'hostname' || property === 'href') &&
                 /[^\x00-\x7f]|%[89a-fA-F][0-9a-fA-F]/.test(String(c.new_value)));
            let u;
            try {
                u = new URL(c.href);
            } catch (e) {
                rec.constructThrew = true;
                out.push(rec);
                continue;
            }
            try {
                u[property] = c.new_value;
                rec.setterThrew = false;
            } catch (e) {
                rec.setterThrew = true;
            }
            rec.result = snapshot(u);
            out.push(rec);
        }
    }
    return out;
}

export function runToAsciiCorpus(toascii) {
    const out = [];
    for (const entry of toascii) {
        if (typeof entry !== 'object' || entry === null) {
            continue;
        }
        const rec = {
            input: entry.input,
            expectedOutput: entry.output ?? null,
            nonAsciiHost: /[^\x00-\x7f]|%[89a-fA-F][0-9a-fA-F]/.test(entry.input),
        };
        // Via constructor host parsing.
        try {
            rec.viaURL = new URL(`https://${entry.input}/x`).host;
        } catch (e) {
            rec.viaURL = 'throws';
        }
        // Via host setter on an existing special-scheme URL (setters are
        // forgiving: on failure the host is unchanged, i.e. stays "y").
        try {
            const u = new URL('https://y/x');
            u.host = entry.input;
            rec.viaHostSetter = u.host;
        } catch (e) {
            rec.viaHostSetter = 'throws';
        }
        out.push(rec);
    }
    return out;
}

export function runPercentEncodingCorpus(percentEncoding) {
    // wpt drives these through documents in several legacy encodings; only
    // the utf-8 expectation is exercisable through the URL API directly.
    const out = [];
    for (const entry of percentEncoding) {
        if (typeof entry !== 'object' || entry === null) {
            continue;
        }
        const rec = { input: entry.input, expectedUtf8: (entry.output && entry.output['utf-8']) ?? null };
        try {
            const u = new URL(`https://doesnotmatter/?${entry.input}#${entry.input}`);
            rec.search = u.search;
            rec.hash = u.hash;
        } catch (e) {
            rec.search = 'throws';
            rec.hash = 'throws';
        }
        out.push(rec);
    }
    return out;
}

// --- URLSearchParams hand corpus ---------------------------------------------
//
// wpt's urlsearchparams-*.any.js suites are executable scripts, not data, so
// they are not vendored; this hand corpus freezes the same surface
// (constructor forms, parsing edge cases, mutation, sort stability,
// iteration order, URL coupling). Each case is a list of ops executed in
// order; every op appends its observable outcome to a trace.

export const SEARCH_PARAMS_CASES = [
    // constructor forms
    { name: 'ctor-empty', ops: [['new'], ['toString'], ['size']] },
    { name: 'ctor-empty-string', ops: [['new', ''], ['toString'], ['size']] },
    { name: 'ctor-leading-question', ops: [['new', '?a=1&b=2'], ['toString'], ['get', 'a']] },
    { name: 'ctor-double-question', ops: [['new', '??a=1'], ['toString'], ['getAll', '?a']] },
    { name: 'ctor-basic', ops: [['new', 'a=1&b=2&a=3'], ['toString'], ['get', 'a'], ['getAll', 'a'], ['size']] },
    { name: 'ctor-empty-pairs', ops: [['new', 'a=1&&b=2&'], ['toString'], ['size']] },
    { name: 'ctor-equals-only', ops: [['new', '='], ['toString'], ['getAll', ''], ['size']] },
    { name: 'ctor-key-only', ops: [['new', 'a&b=2&c'], ['toString'], ['get', 'a'], ['get', 'c'], ['size']] },
    { name: 'ctor-value-only', ops: [['new', '=v'], ['get', ''], ['toString']] },
    { name: 'ctor-multi-equals', ops: [['new', 'a=b=c&d=e=f=g'], ['get', 'a'], ['get', 'd'], ['toString']] },
    { name: 'ctor-plus-decodes-to-space', ops: [['new', 'a=b+c&d+e=f'], ['get', 'a'], ['get', 'd e'], ['toString']] },
    { name: 'ctor-percent-20', ops: [['new', 'a=b%20c'], ['get', 'a'], ['toString']] },
    { name: 'ctor-percent-2B', ops: [['new', 'a=b%2Bc'], ['get', 'a'], ['toString']] },
    { name: 'ctor-invalid-percent', ops: [['new', 'a=%zz&b=%'], ['get', 'a'], ['get', 'b'], ['toString']] },
    { name: 'ctor-truncated-percent', ops: [['new', 'a=%e2%80'], ['get', 'a'], ['toString']] },
    { name: 'ctor-unicode', ops: [['new', 'kéy=väl&†=‡'], ['get', 'kéy'], ['get', '†'], ['toString']] },
    { name: 'ctor-encoded-unicode', ops: [['new', 'a=%e2%80%a0'], ['get', 'a'], ['toString']] },
    { name: 'ctor-semicolon-not-separator', ops: [['new', 'a=1;b=2'], ['get', 'a'], ['get', 'a;b'], ['size'], ['toString']] },
    { name: 'ctor-hash-in-value', ops: [['new', 'a=b#c'], ['get', 'a'], ['toString']] },
    { name: 'ctor-array-pairs', ops: [['new', [['a', '1'], ['b', '2'], ['a', '3']]], ['toString'], ['getAll', 'a']] },
    { name: 'ctor-array-empty', ops: [['new', []], ['toString'], ['size']] },
    { name: 'ctor-object', ops: [['new', { a: '1', b: '2' }], ['toString'], ['size']] },
    { name: 'ctor-object-needs-encoding', ops: [['new', { 'a b': 'c&d=e', 'f+g': 'h' }], ['toString']] },
    { name: 'ctor-copy-searchparams', ops: [['new', 'a=1&b=2'], ['copyCtor'], ['toString']] },

    // encoding on serialize
    { name: 'serialize-space-plus-amp-eq', ops: [['new'], ['append', 'a b', 'c+d'], ['append', 'e&f', 'g=h'], ['toString']] },
    { name: 'serialize-controls-and-unicode', ops: [['new'], ['append', 'k', 'é†'], ['toString']] },
    { name: 'serialize-percent-passthrough', ops: [['new'], ['append', 'a', '%20'], ['toString'], ['get', 'a']] },
    { name: 'serialize-empty-key-value', ops: [['new'], ['append', '', ''], ['append', '', 'v'], ['append', 'k', ''], ['toString'], ['size']] },
    { name: 'serialize-tilde-star-quote', ops: [['new'], ['append', 'a', "~*'()!"], ['toString']] },
    { name: 'serialize-slash-question', ops: [['new'], ['append', 'p', '/x?y#z'], ['toString']] },

    // mutation semantics
    { name: 'append-then-get', ops: [['new'], ['append', 'a', '1'], ['append', 'a', '2'], ['get', 'a'], ['getAll', 'a'], ['toString']] },
    { name: 'set-replaces-first-drops-rest', ops: [['new', 'a=1&b=2&a=3&a=4'], ['set', 'a', 'X'], ['toString']] },
    { name: 'set-appends-when-missing', ops: [['new', 'b=2'], ['set', 'a', '1'], ['toString']] },
    { name: 'delete-key', ops: [['new', 'a=1&b=2&a=3'], ['delete', 'a'], ['toString'], ['has', 'a'], ['size']] },
    { name: 'delete-key-value', ops: [['new', 'a=1&a=2&a=1'], ['delete', 'a', '1'], ['toString'], ['getAll', 'a']] },
    { name: 'delete-missing', ops: [['new', 'a=1'], ['delete', 'zz'], ['toString']] },
    { name: 'has-with-value', ops: [['new', 'a=1&a=2'], ['has', 'a', '2'], ['has', 'a', '3'], ['has', 'a']] },
    { name: 'get-missing-null', ops: [['new', 'a=1'], ['get', 'zz'], ['getAll', 'zz']] },
    { name: 'coerce-non-strings', ops: [['new'], ['append', 'n', 1], ['append', 'b', true], ['append', 'u', null], ['toString']] },

    // sort
    { name: 'sort-basic', ops: [['new', 'z=1&a=2&m=3'], ['sort'], ['toString']] },
    { name: 'sort-stable-equal-keys', ops: [['new', 'a=3&b=x&a=1&a=2'], ['sort'], ['toString'], ['getAll', 'a']] },
    { name: 'sort-unicode-codeunit-order', ops: [['new', '！=full&!=ascii&~=tilde'], ['sort'], ['toString']] },
    { name: 'sort-empty-key', ops: [['new', 'b=2&=1&a=3'], ['sort'], ['toString']] },

    // iteration
    { name: 'iterate-entries-keys-values', ops: [['new', 'a=1&b=2&a=3'], ['entries'], ['keys'], ['values']] },
    { name: 'iterate-spread-symbol-iterator', ops: [['new', 'a=1&b=2'], ['spread']] },
    { name: 'iterate-foreach', ops: [['new', 'a=1&b=2'], ['forEach']] },
    { name: 'iterate-order-after-mutation', ops: [['new', 'a=1&b=2&c=3'], ['set', 'b', 'X'], ['delete', 'a'], ['append', 'a', '9'], ['entries']] },

    // URL coupling
    { name: 'url-searchparams-reflects-url', ops: [['newFromURL', 'https://h/p?a=1&b=2'], ['toString'], ['urlHref']] },
    { name: 'url-mutation-updates-href', ops: [['newFromURL', 'https://h/p?a=1'], ['append', 'b', '2'], ['urlHref'], ['set', 'a', 'X'], ['urlHref']] },
    { name: 'url-delete-all-clears-search', ops: [['newFromURL', 'https://h/p?a=1'], ['delete', 'a'], ['urlHref'], ['urlSearch']] },
    { name: 'url-set-search-resets-params', ops: [['newFromURL', 'https://h/p?a=1'], ['setUrlSearch', 'x=9&y=8'], ['toString'], ['getAll', 'x']] },
    { name: 'url-set-empty-search', ops: [['newFromURL', 'https://h/p?a=1'], ['setUrlSearch', ''], ['toString'], ['urlHref']] },
    { name: 'url-sort-updates-href', ops: [['newFromURL', 'https://h/p?z=1&a=2'], ['sort'], ['urlHref']] },
    { name: 'url-searchparams-plus-space', ops: [['newFromURL', 'https://h/p?a=b+c'], ['get', 'a'], ['append', 'd', 'e f'], ['urlHref']] },
];

export function runSearchParamsCorpus(cases = SEARCH_PARAMS_CASES) {
    const out = [];
    for (const c of cases) {
        const rec = { name: c.name, trace: [] };
        let sp = null;
        let url = null;
        for (const op of c.ops) {
            const [kind, ...args] = op;
            try {
                switch (kind) {
                    case 'new':
                        sp = args.length === 0 ? new URLSearchParams() : new URLSearchParams(args[0]);
                        rec.trace.push(['new', sp.toString()]);
                        break;
                    case 'copyCtor':
                        sp = new URLSearchParams(sp);
                        rec.trace.push(['copyCtor', sp.toString()]);
                        break;
                    case 'newFromURL':
                        url = new URL(args[0]);
                        sp = url.searchParams;
                        rec.trace.push(['newFromURL', sp.toString()]);
                        break;
                    case 'append':
                    case 'set':
                        sp[kind](args[0], args[1]);
                        rec.trace.push([kind, sp.toString()]);
                        break;
                    case 'delete':
                        if (args.length > 1) {
                            sp.delete(args[0], args[1]);
                        } else {
                            sp.delete(args[0]);
                        }
                        rec.trace.push(['delete', sp.toString()]);
                        break;
                    case 'sort':
                        sp.sort();
                        rec.trace.push(['sort', sp.toString()]);
                        break;
                    case 'get':
                        rec.trace.push(['get', args[0], sp.get(args[0])]);
                        break;
                    case 'getAll':
                        rec.trace.push(['getAll', args[0], sp.getAll(args[0])]);
                        break;
                    case 'has':
                        rec.trace.push(['has', ...args, args.length > 1 ? sp.has(args[0], args[1]) : sp.has(args[0])]);
                        break;
                    case 'size':
                        rec.trace.push(['size', sp.size]);
                        break;
                    case 'toString':
                        rec.trace.push(['toString', sp.toString()]);
                        break;
                    case 'entries':
                        rec.trace.push(['entries', [...sp.entries()].map(e => [e[0], e[1]])]);
                        break;
                    case 'keys':
                        rec.trace.push(['keys', [...sp.keys()]]);
                        break;
                    case 'values':
                        rec.trace.push(['values', [...sp.values()]]);
                        break;
                    case 'spread':
                        rec.trace.push(['spread', [...sp].map(e => [e[0], e[1]])]);
                        break;
                    case 'forEach': {
                        const seen = [];
                        sp.forEach((v, k) => seen.push([k, v]));
                        rec.trace.push(['forEach', seen]);
                        break;
                    }
                    case 'urlHref':
                        rec.trace.push(['urlHref', url.href]);
                        break;
                    case 'urlSearch':
                        rec.trace.push(['urlSearch', url.search]);
                        break;
                    case 'setUrlSearch':
                        url.search = args[0];
                        rec.trace.push(['setUrlSearch', url.href]);
                        break;
                    default:
                        rec.trace.push([kind, 'UNKNOWN-OP']);
                }
            } catch (e) {
                rec.trace.push([kind, 'throws']);
            }
        }
        out.push(rec);
    }
    return out;
}

// --- entry point --------------------------------------------------------------

export function runAll(corpora) {
    return {
        parse: runParseCorpus(corpora.urltestdata),
        setters: runSettersCorpus(corpora.settersTests),
        toascii: runToAsciiCorpus(corpora.toascii),
        percentEncoding: runPercentEncodingCorpus(corpora.percentEncoding),
        searchParams: runSearchParamsCorpus(),
    };
}
