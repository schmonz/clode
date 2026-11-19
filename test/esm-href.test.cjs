'use strict';
// No absolute filesystem path reaches an ESM specifier: import(), --test-reporter, --import, --loader. node reads a bare
// absolute path there as a URL, so on Windows `D:\...` has the scheme `d:` and throws ERR_UNSUPPORTED_ESM_URL_SCHEME
// (CI run 44626089671, windows-latest: test/gates-ran-in-ci.test.cjs's live-reporter row). It works on POSIX, so only a
// Windows runner ever saw it. The fix is test/esm-href.cjs's esmHref (pathToFileURL(...).href); this guard reads the
// source for the shape that caused it: a path built in place (path.join / path.resolve / a template) handed straight to
// one of those, or an import() of a bare identifier that names a path. A relative specifier ('../scripts/x.mjs') and
// a URL (pathToFileURL, esmHref, a variable named *href / *url) are fine.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');
const { esmHref } = require('./esm-href.cjs');

const REPO = path.resolve(__dirname, '..');
const SELF = new Set(['test/esm-href.test.cjs']);
// a path built in place, as the argument of import() or the value of an ESM-loading flag
const BUILT = String.raw`(?:path\.(?:join|resolve)\(|\$\{\s*path\.(?:join|resolve)\()`;
const SHAPES = [
  { what: 'import() of a path built in place', re: new RegExp(String.raw`\bimport\(\s*` + BUILT) },
  { what: '--test-reporter/--import/--loader given a path built in place',
    re: new RegExp(String.raw`--(?:test-reporter|import|loader|experimental-loader)(?:=|['"]\s*,\s*)` + BUILT) },
  // import(x) of a bare identifier that names a filesystem path (file, dir, abs, *Path, *File), not a URL
  { what: 'import() of a variable holding a path', re: /\bimport\(\s*(?:[A-Za-z_$][\w$]*(?:Path|File|Dir)|file|abs|full|p)\s*\)/ },
];

function scanEsmSpecifiers({ files }) {
  const findings = [];
  for (const [file, text] of files) {
    text.split('\n').forEach((line, i) => {
      if (/^\s*(?:\/\/|\*|#)/.test(line)) return;
      for (const s of SHAPES) if (s.re.test(line)) findings.push(`${file}:${i + 1}: ${s.what}; wrap it in esmHref() (test/esm-href.cjs) or pathToFileURL(...).href: ${line.trim().slice(0, 120)}`);
    });
  }
  return { findings, examined: files.length, note: `${files.length} source file(s) read` };
}

guardTests(defineGuard({
  name: 'esm-specifier-is-a-url',
  // test/, scripts/, libexec/ and the workflows held 654 such files on 2026-11-19
  floor: 500,
  read: () => {
    const list = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'test', 'scripts', 'libexec', '.github'], { cwd: REPO, encoding: 'utf8' })
      .split('\n').filter((f) => /\.(?:c|m)?js$|\.ya?ml$/.test(f) && !SELF.has(f) && !/node_modules|\/fixtures?\//.test(f) && fs.existsSync(path.join(REPO, f)));
    return { files: list.map((f) => [f, fs.readFileSync(path.join(REPO, f), 'utf8')]) };
  },
  scan: scanEsmSpecifiers,
  // the exact line CI run 44626089671 failed on
  control: () => ({ files: [['test/x.test.cjs', "spawnSync(process.execPath, ['--test', `--test-reporter=${path.join(REPO, 'test', 'cell-reporter.mjs')}`, file]);"]] }),
}));

test('esm-specifier-is-a-url: every shape is named, and the URL forms are clean', () => {
  const bad = [
    "await import(path.join(root, 'a', 'index.js'))",
    "await import(path.resolve(__dirname, 'x.mjs'))",
    "['--test-reporter', path.join(HERE, 'r.mjs')]",
    "['--import', path.join(HERE, 'r.mjs')]",
    '`--loader=${path.join(HERE, "l.mjs")}`',
    'await import(modPath)',
  ];
  for (const l of bad) assert.strictEqual(scanEsmSpecifiers({ files: [['f.js', l]] }).findings.length, 1, l);
  const good = [
    "await import('../scripts/tjs-legs.mjs')",
    "await import(esmHref(path.join(root, 'a.js')))",
    "await import(pathToFileURL(path.join(FIXDIR, 'core.mjs')))",
    "['--test-reporter', pathToFileURL(path.join(HERE, 'cell-reporter.mjs')).href]",
    "['--test-reporter', 'tap']",
    'await import(href)',
    "// await import(path.join(x))",
  ];
  for (const l of good) assert.deepStrictEqual(scanEsmSpecifiers({ files: [['f.js', l]] }).findings, [], l);
});

test('esmHref is a file: URL, also for a Windows-shaped path on Windows', () => {
  assert.match(esmHref(path.join(REPO, 'test', 'cell-reporter.mjs')), /^file:\/\/\/.*cell-reporter\.mjs$/);
  if (path.sep === '\\') assert.match(esmHref('D:\\a\\x.mjs'), /^file:\/\/\/D:\/a\/x\.mjs$/);
});
