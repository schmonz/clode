'use strict';
// host-provision — one KAT-verified resolver for required host tools.
//
// Every artifact (the clode builder, quaude, naude) resolves host tools the
// SAME way at runtime: probe PATH for a candidate, RUN it on a known input and
// verify the exact expected output (the KAT — "does this actually work"), cache
// the winner to ~/.local/share/clode/hosttools.json, and fail loud with an
// install hint if none works. The registry is just code, so it already ships in
// every artifact; the bake injects nothing and never resolves target-runtime
// tools (cross-build safety). Dependency-free: Node stdlib + sibling requires.
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const hosttools = require('./clode-hosttools.cjs');
const cpaths = require('./clode-paths.cjs');

// Normalize any sha256 tool's output to a lowercase 64-hex digest, or null.
// Handles `<hex>  file`, `SHA256 (file) = <hex>`, `SHA256(file)= <hex>`, bare
// `<hex>`, and certutil's space-separated bytes on their own line.
function parseSha256(out) {
  const clean = String(out).match(/\b[0-9a-f]{64}\b/i);
  if (clean) return clean[0].toLowerCase();
  for (const line of String(out).split(/\r?\n/)) {
    const squished = line.replace(/[^0-9a-fA-F]/g, '');
    if (/^[0-9a-f]{64}$/i.test(squished)) return squished.toLowerCase();
  }
  return null;
}

const SHA256_KAT = { input: 'clode', expected: '300fd6ab1ddbf36ccacc4c9f21c6ad497b421906f337c032ec8d4396eebc5e2c' };

const REGISTRY = {
  sha256: {
    id: 'sha256',
    overrideEnv: 'CLODE_SHA256',
    // Ordered, most-universal first.
    candidates: [
      { name: 'sha256sum', args: (f) => [f] },
      { name: 'shasum', args: (f) => ['-a', '256', f] },
      { name: 'gsha256sum', args: (f) => [f] },
      { name: 'sha256', args: (f) => [f] },
      { name: 'cksum', args: (f) => ['-a', 'sha256', f] },
      { name: 'openssl', args: (f) => ['dgst', '-sha256', f] },
      { name: 'digest', args: (f) => ['-a', 'sha256', f] },
      { name: 'certutil', args: (f) => ['-hashfile', f, 'SHA256'] },
    ],
    parse: parseSha256,
    // Run the candidate on a temp file of known bytes; verify the parsed digest.
    verify({ candidate, path: bin, run, fs }) {
      const tmp = path.join(os.tmpdir(), `clode-kat-sha256-${process.pid}`);
      fs.writeFileSync(tmp, SHA256_KAT.input);
      try {
        const r = run(bin, candidate.args(tmp));
        return !!r && r.status === 0 && parseSha256(r.stdout) === SHA256_KAT.expected;
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* absent */ }
      }
    },
    installHint: 'install one of: sha256sum, shasum, gsha256sum, sha256, cksum, openssl, digest, certutil (or set CLODE_SHA256 to a sha256sum-compatible program). Needed to verify downloads.',
  },
};
// Introspection alias.
const SHA256_TOOLS = REGISTRY.sha256.candidates;

function cachePath(dataDir) {
  return path.join(dataDir, 'hosttools.json');
}
function readCache(fs, file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function writeCache(fs, file, cache) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2) + '\n');
  } catch { /* cache is an optimization; a write failure must not break provisioning */ }
}

function candidateList(req, env) {
  const list = req.candidates.slice();
  if (req.overrideEnv && env[req.overrideEnv]) {
    list.unshift({ name: env[req.overrideEnv], args: req.candidates[0].args });
  }
  return list;
}

function provision(id, opts = {}) {
  const req = REGISTRY[id];
  if (!req) throw new Error(`host-provision: unknown requirement '${id}'`);
  const {
    env = process.env,
    findTool = hosttools.findTool,
    spawn = spawnSync,
    fs = nodeFs,
    dataDir = cpaths.clodeDataDir(env),
    isExec = hosttools.isExecutableFile,
  } = opts;

  const file = cachePath(dataDir);
  const cache = readCache(fs, file);

  // 1. Cache hit: revalidate cheaply (the tool still executes) and return.
  const hit = cache[id];
  if (hit && hit.path && isExec(hit.path)) {
    const cand = req.candidates.find((c) => c.name === hit.candidate)
      || { name: hit.candidate, args: req.candidates[0].args };
    return { candidate: cand, path: hit.path };
  }

  // 2. Probe: first candidate whose KAT passes wins.
  const run = (bin, args) => spawn(bin, args, { encoding: 'utf8', maxBuffer: 1 << 20 });
  for (const cand of candidateList(req, env)) {
    const bin = findTool(cand.name, { env });
    if (!bin) continue;
    let ok = false;
    try { ok = req.verify({ candidate: cand, path: bin, run, fs, env }); } catch { ok = false; }
    if (!ok) continue;
    // 3. Persist and return.
    cache[id] = { candidate: cand.name, path: bin };
    writeCache(fs, file, cache);
    return { candidate: cand, path: bin };
  }

  throw new Error(`clode: no ${id} tool found on PATH — ${req.installHint}`);
}

module.exports = { provision, parseSha256, REGISTRY, SHA256_TOOLS };
