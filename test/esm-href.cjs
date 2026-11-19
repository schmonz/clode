'use strict';
// esmHref(absolutePath): the file: URL an ESM specifier needs. node's ESM loader reads a bare absolute path as a URL,
// so on Windows `D:\a\x.mjs` is a URL whose scheme is `d:` (ERR_UNSUPPORTED_ESM_URL_SCHEME, "Received protocol
// 'd:'": CI run 44626089671, windows-latest, test/gates-ran-in-ci.test.cjs). POSIX paths happen to work, so the
// mistake is invisible off Windows. Use this for import(), --test-reporter, --import and --loader; test/esm-href.test.cjs
// refuses an absolute path built in place there.
const { pathToFileURL } = require('node:url');
const esmHref = (abs) => pathToFileURL(abs).href;
module.exports = { esmHref };
