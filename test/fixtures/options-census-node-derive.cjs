'use strict';
// THE NODE HALF OF THE OPTIONS CENSUS (test/options-census.test.cjs): which option keys host node READS from the
// options object a caller passes each entry point node-shim implements. Derived from node's OWN SOURCE, never typed:
// each entry point names the node functions its options flow through (its call path), and the keys are every
// `options.X` / `opts.X` read and every `{ X } = options` destructuring in those function bodies.
//
// WHY SOURCE AND NOT A RECORDING PROXY. A Proxy passed as the options object records only the reads made on IT, and
// node copies the object first (`options = { __proto__: null, ...options }` opens normalizeSpawnArguments, spawnSync,
// fs.cp, ...), so every later read happens on the copy and a Proxy records almost nothing (measured 2026-11-23,
// node 24.20: spawnSync recorded zero keys). The TLS census (test/node-shim-tls-options.test.cjs) took the same road.
//
// WHAT IS NOT A CALLER'S OPTION. Some keys on the call path are ones node puts on its own copy before reading them
// (spawn's envPairs/file/args, exec's normalized file/options). Each is excluded BY NAME, with the reason, in
// INTERNAL below; an exclusion the source no longer produces is reported (stale), so it cannot hide a renamed key.
//
// Run: node --expose-internals test/fixtures/options-census-node-derive.cjs  -> JSON on stdout:
//   { node: <version>, entries: { '<entry>': [keys...] }, problems: [strings] }
// test/options-census.test.cjs records it into test/fixtures/options-census-node.json (CLODE_RECORD_OPTIONS_CENSUS=1)
// and checks, on every run whose host node has the recorded major version, that the live derivation still agrees.
const { internalBinding } = require('internal/test/binding');

const natives = internalBinding('builtins').natives;

// A balanced {...} or (...) starting at src[start], skipping strings, comments and template literals.
function balanced(src, start) {
  const open = src[start]; const close = open === '{' ? '}' : ')';
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === "'" || c === '"') { for (i++; src[i] !== c; i++) if (src[i] === '\\') i++; continue; }
    if (c === '`') {
      for (i++; src[i] !== '`'; i++) {
        if (src[i] === '\\') i++;
        else if (src[i] === '$' && src[i + 1] === '{') { const b = balanced(src, i + 1); i += b.length; }
      }
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${open} at ${start}`);
}

// The body of the function NAME in builtin module ID: `function NAME(`, `NAME = function(`, `NAME = (...) =>`, or a
// method `NAME(...) {`. The parameter list is skipped by balance, so a destructured parameter is not the body.
function fnSource(id, name) {
  const src = natives[id];
  if (typeof src !== 'string') throw new Error(`node has no builtin module '${id}'`);
  const heads = [
    new RegExp(`\\bfunction\\s*\\*?\\s*${name}\\s*\\(`),
    new RegExp(`(?:\\bconst|\\blet|\\.|^|\\n)\\s*${name}\\s*=\\s*(?:hideStackFrames\\(\\s*)?(?:async\\s*)?(?:function\\b[^(]*)?\\(`),
    new RegExp(`\\n\\s*(?:async\\s+)?${name}\\s*\\(`),
  ];
  for (const re of heads) {
    const m = re.exec(src);
    if (!m) continue;
    const params = balanced(src, m.index + m[0].length - 1);
    const after = m.index + m[0].length - 1 + params.length;
    const brace = src.indexOf('{', after);
    if (brace < 0 || !/^\s*(?:=>\s*)?$/.test(src.slice(after, brace))) continue;   // a call, not a definition
    return balanced(src, brace);
  }
  throw new Error(`node's '${id}' has no function '${name}'`);
}

const READ = /\b(?:options|opts)\??\.([A-Za-z_]\w*)\b(?!\s*=(?!=))/g;
const DESTRUCTURED = /\{([^{}]*)\}\s*=\s*(?:options|opts)\b/g;
function keysIn(body) {
  const keys = new Set([...body.matchAll(READ)].map((m) => m[1]));
  for (const m of body.matchAll(DESTRUCTURED)) {
    for (const part of m[1].split(',')) {
      const k = part.trim().split(/[:=\s]/)[0];
      if (/^[A-Za-z_]\w*$/.test(k)) keys.add(k);
    }
  }
  return keys;
}

const CP = 'child_process'; const ICP = 'internal/child_process';
const SPAWN_PATH = [[CP, 'normalizeSpawnArguments'], [CP, 'spawn'], [ICP, 'spawn']];
const SPAWNSYNC_PATH = [[CP, 'normalizeSpawnArguments'], [CP, 'spawnSync'], [ICP, 'spawnSync']];
const SPAWN_INTERNAL = {
  envPairs: 'normalizeSpawnArguments computes it from env', file: 'normalizeSpawnArguments sets it from the file argument',
  args: 'normalizeSpawnArguments sets it from the args argument',
};
const SPAWNSYNC_INTERNAL = { file: SPAWN_INTERNAL.file, args: SPAWN_INTERNAL.args };
const EXEC_INTERNAL = { file: "normalizeExecArgs's own result object", options: "normalizeExecArgs's own result object" };
// http.request hands its options to the agent's createConnection, which is net.connect (https: tls.connect)
const NET_PATH = [['net', 'connect'], ['net', 'Socket'], ['net', 'lookupAndConnect'], ['net', 'lookupAndConnectMultiple'],
  ['net', 'addClientAbortSignalOption']];
const TLS_PATH = [['internal/tls/wrap', 'connect'], ['internal/tls/wrap', 'normalizeConnectArgs'],
  ['internal/tls/wrap', 'TLSSocket'], ['net', 'Socket'], ['net', 'lookupAndConnect'], ['net', 'lookupAndConnectMultiple']];
const FSU = 'internal/fs/utils'; const FSP = 'internal/fs/promises';
// THE ENTRY POINTS: each one's call path through node, and what on it is not a caller's option.
const ENTRIES = {
  'child_process.spawn': { path: SPAWN_PATH, internal: SPAWN_INTERNAL },
  'child_process.spawnSync': { path: SPAWNSYNC_PATH, internal: SPAWNSYNC_INTERNAL },
  // execFile builds a FRESH object for spawn from the keys it reads, so its own reads are the whole list
  'child_process.execFile': { path: [[CP, 'execFile']], internal: {} },
  'child_process.execFileSync': { path: [[CP, 'execFileSync'], ...SPAWNSYNC_PATH], internal: SPAWNSYNC_INTERNAL },
  'child_process.exec': { path: [[CP, 'normalizeExecArgs'], [CP, 'execFile']], internal: {} },
  // execSync -> normalizeExecArgs -> spawnSync(opts.file, opts.options), and reads opts.options.stdio itself
  'child_process.execSync': { path: [[CP, 'execSync'], [CP, 'normalizeExecArgs'], ...SPAWNSYNC_PATH],
    internal: { ...SPAWNSYNC_INTERNAL, ...EXEC_INTERNAL } },
  'child_process.fork': { path: [[CP, 'fork'], ...SPAWN_PATH], internal: SPAWN_INTERNAL },

  'http.request': { path: [['_http_client', 'ClientRequest'], ['_http_client', 'tickOnSocket'],
    ['_http_agent', 'addRequest'], ['_http_agent', 'createSocket'], ['_http_agent', 'getName'],
    ['_http_agent', 'createConnection'], ['_http_agent', 'calculateServerName'], ...NET_PATH],
  internal: { _defaultAgent: "set by http.request/https.request's own module, not a documented option" } },
  // an agent's options are merged into every connection it makes (createConnection -> net.connect), so the keys
  // net.connect reads are the agent's too: https.Agent({ ca }) was one of this census's first silent keys
  'http.Agent': { path: [['_http_agent', 'Agent'], ['_http_agent', 'createConnection'], ...NET_PATH], internal: {} },
  'https.request': { path: [['_http_client', 'ClientRequest'], ['_http_client', 'tickOnSocket'],
    ['_http_agent', 'addRequest'], ['_http_agent', 'createSocket'], ['https', 'getName'],
    ['https', 'createConnection'], ['_http_agent', 'calculateServerName'], ['https', 'request'], ...TLS_PATH],
  internal: { _defaultAgent: "set by http.request/https.request's own module, not a documented option",
    _agentKey: 'createSocket sets it to the agent key before createConnection reads it' } },
  'https.Agent': { path: [['_http_agent', 'Agent'], ['https', 'Agent'], ['https', 'createConnection'], ...TLS_PATH],
    internal: { _agentKey: 'createSocket sets it to the agent key before createConnection reads it' } },
  'net.connect': { path: NET_PATH, internal: {} },
  'tls.connect': { path: TLS_PATH, internal: {} },

  'fs.readFileSync': { path: [['fs', 'readFileSync']], internal: {} },
  'fs.readFile': { path: [['fs', 'readFile'], [FSU, 'getOptions']], internal: {} },
  'fs.promises.readFile': { path: [[FSP, 'readFile'], [FSP, 'readFileHandle'], [FSU, 'getOptions']], internal: {} },
  'fs.writeFileSync': { path: [['fs', 'writeFileSync']], internal: {} },
  'fs.writeFile': { path: [['fs', 'writeFile']], internal: {} },
  'fs.promises.writeFile': { path: [[FSP, 'writeFile']], internal: {} },
  'fs.mkdirSync': { path: [['fs', 'mkdirSync']], internal: {} },
  'fs.mkdir': { path: [['fs', 'mkdir']], internal: {} },
  'fs.promises.mkdir': { path: [[FSP, 'mkdir']], internal: {} },
  'fs.rmSync': { path: [['fs', 'rmSync'], [FSU, 'validateRmOptionsSync']], internal: {} },
  'fs.rm': { path: [['fs', 'rm'], [FSU, 'validateRmOptions'], ['internal/fs/rimraf', 'rimraf']], internal: {} },
  // rimrafPromises only wraps rimraf, which reads the retry options
  'fs.promises.rm': { path: [[FSP, 'rm'], [FSU, 'validateRmOptions'], ['internal/fs/rimraf', 'rimrafPromises'], ['internal/fs/rimraf', 'rimraf']], internal: {} },
  'fs.cpSync': { path: [['fs', 'cpSync'], [FSU, 'validateCpOptions'], ['internal/fs/cp/cp-sync', 'cpSyncFn']], internal: {} },
  'fs.cp': { path: [['fs', 'cp'], [FSU, 'validateCpOptions'], ['internal/fs/cp/cp', 'cpFn']], internal: {} },
  'fs.promises.cp': { path: [[FSP, 'cp'], [FSU, 'validateCpOptions'], ['internal/fs/cp/cp', 'cpFn']], internal: {} },
  'fs.watch': { path: [['fs', 'watch'], ['internal/fs/watchers', 'watch']], internal: {} },
  'fs.createReadStream': { path: [['internal/fs/streams', 'ReadStream'], ['internal/fs/streams', 'importFd']], internal: {} },
  'fs.createWriteStream': { path: [['internal/fs/streams', 'WriteStream'], ['internal/fs/streams', 'importFd']], internal: {} },

  // zlib: every deflate/inflate/gzip/gunzip/unzip factory, stream or one-shot, takes the Zlib options; brotli its own
  'zlib.zlib': { path: [['zlib', 'ZlibBase'], ['zlib', 'Zlib']], internal: {} },
  'zlib.brotli': { path: [['zlib', 'ZlibBase'], ['zlib', 'Brotli']], internal: {} },
};

function derive() {
  const entries = {}; const problems = [];
  for (const [entry, spec] of Object.entries(ENTRIES)) {
    const keys = new Set();
    for (const [id, fn] of spec.path) {
      try { for (const k of keysIn(fnSource(id, fn))) keys.add(k); } catch (e) { problems.push(`${entry}: ${e.message}`); }
    }
    for (const k of Object.keys(spec.internal)) {
      if (!keys.has(k)) problems.push(`${entry}: INTERNAL names '${k}', which node's source no longer reads there (stale)`);
      keys.delete(k);
    }
    entries[entry] = [...keys].sort();
  }
  // fs open flags: the strings node's stringToFlags accepts (its `case '...':` labels)
  try {
    const body = fnSource(FSU, 'stringToFlags');
    entries['fs.open:flags'] = [...new Set([...body.matchAll(/case\s+'([^']+)'\s*:/g)].map((m) => m[1]))].sort();
  } catch (e) { problems.push(`fs.open:flags: ${e.message}`); }
  return { node: process.version, entries, problems };
}

module.exports = { derive, ENTRIES };
if (require.main === module) process.stdout.write(`${JSON.stringify(derive(), null, 1)}\n`);
