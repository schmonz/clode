'use strict';
// Gate 2: mechanical inventory of the Node-API surface of (a) clode's own
// toolchain and (b) the extracted bundle. Phase-1 tooling — runs under node.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BUILTINS = ['assert','async_hooks','buffer','child_process','cluster','console','constants','crypto','dgram','diagnostics_channel','dns','domain','events','fs','http','http2','https','inspector','module','net','os','path','perf_hooks','process','punycode','querystring','readline','repl','sea','stream','string_decoder','sys','timers','tls','trace_events','tty','url','util','v8','vm','wasi','worker_threads','zlib'];
const GLOBALS = ['fetch','Buffer','process','WebSocket','AbortController','AbortSignal','TextEncoder','TextDecoder','URL','URLSearchParams','queueMicrotask','structuredClone','setImmediate','performance','navigator','crypto','ReadableStream','WritableStream','TransformStream','Blob','FormData','Headers','Request','Response','MessageChannel','BroadcastChannel','Worker','SharedArrayBuffer','Atomics','FinalizationRegistry','WeakRef'];

function scan(text) {
  const modules = {}, globals = {};
  for (const b of BUILTINS) {
    const re = new RegExp(String.raw`(?:require\(|from\s*)\s*["'](?:node:)?(?:${b})(?:/[a-z]+)?["']`, 'g');
    const n = (text.match(re) || []).length;
    if (n) modules[b] = n;
  }
  for (const g of GLOBALS) {
    const re = new RegExp(String.raw`(?<![.\w$])${g}\s*[.(]`, 'g');
    const n = (text.match(re) || []).length;
    if (n) globals[g] = n;
  }
  return { modules, globals };
}

const repo = path.resolve(__dirname, '..', '..');
let toolchainText = '';
for (const f of fs.readdirSync(path.join(repo, 'libexec')).filter((f) => f.endsWith('.cjs'))) {
  toolchainText += fs.readFileSync(path.join(repo, 'libexec', f), 'utf8');
}
toolchainText += fs.readFileSync(path.join(repo, 'bin', 'clode'), 'utf8');

const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'clode');
const clis = fs.readdirSync(cache, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => path.join(cache, d.name, 'cli.cjs'))
  .filter((p) => fs.existsSync(p))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
if (!clis.length) { console.error('no extracted cli.cjs in cache'); process.exit(1); }
const bundleText = fs.readFileSync(clis[0], 'utf8');

const result = { generated: new Date().toISOString(), bundlePath: clis[0], toolchain: scan(toolchainText), bundle: scan(bundleText) };
const outDir = path.join(__dirname, 'results');
fs.writeFileSync(path.join(outDir, 'gate2-inventory.json'), JSON.stringify(result, null, 2) + '\n');

function mdSection(name, r) {
  const rows = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join('\n');
  return `## ${name}\n\n### node: modules\n\n| module | refs |\n|---|---|\n${rows(r.modules)}\n\n### globals\n\n| global | refs |\n|---|---|\n${rows(r.globals)}\n`;
}
fs.writeFileSync(path.join(outDir, 'gate2-inventory.md'),
  `# Gate 2 — Node-API surface inventory\n\nBundle: ${clis[0]}\n\n${mdSection('Toolchain (libexec/*.cjs + bin/clode)', result.toolchain)}\n${mdSection('Bundle (extracted cli.cjs)', result.bundle)}`);
console.log('wrote results/gate2-inventory.{json,md}');
