'use strict';
// Pinned Unicode Character Database inputs. NEVER vendored: fetched, sha256-verified
// against scripts/unicode-inputs.json, cached. A missing pin or a mismatch refuses.
//
// Plain CommonJS over fs/path/crypto.createHash only, so scripts/gen-unicode-data.cjs can
// run under tjs + node-shim as well as under Node (no Node on the build path).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '..', '..');
const PINS = path.join(REPO, 'scripts', 'unicode-inputs.json');

function pins() { return JSON.parse(fs.readFileSync(PINS, 'utf8')); }

// An offline run (test/run.mjs forces CLODE_OFFLINE=1 by default) must not reach the
// network, and a cache miss it cannot fill is a missing PRECONDITION, not a wrong table —
// so it gets its own name, and gen-unicode-data.cjs its own exit status (3), which the
// freshness gate reports as a skip naming the file instead of a red.
class UcdOfflineMiss extends Error {
  constructor(msg) { super(msg); this.name = 'UcdOfflineMiss'; }
}

// Small text files: an in-memory digest is fine. The pure-JS SHA cost that sent
// clode-net.cjs's sha256Of to a host tool is for the ~265MB provider, not for UCD files
// (the largest pinned here, 17.0.0 DerivedCoreProperties.txt, is 1.1MB).
function sha256Text(text) { return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'); }

function verifyText(text, pin) {
  if (!pin || !pin.sha256) throw new Error(`no sha256 pin for ${pin && pin.url}; run gen-unicode-data.cjs --pin`);
  const got = sha256Text(text);
  if (got !== pin.sha256) throw new Error(`sha256 mismatch for ${pin.url}: pinned ${pin.sha256}, got ${got}`);
  return text;
}

// Three attempts, because the freshness gate downloads on a cold cache and a gate must
// not go red on the network: measured 2026-09-24, one of eighteen requests to
// www.unicode.org/Public answered HTTP 520 (Cloudflare) and the same URL answered 200 on
// each of the next three tries. A retry cannot admit wrong bytes — every caller verifies
// the sha256 pin afterwards (or, under --pin, is the TOFU step the diff reviews).
async function download(url, dest, { attempts = 3, delayMs = 1000, offline = false } = {}) {
  if (offline) throw new UcdOfflineMiss(`offline (CLODE_OFFLINE=1): ${dest} is not cached with its pinned sha256, and fetching ${url} is not allowed; run once online to fill the cache`);
  const { downloadFile } = require(path.join(REPO, 'libexec', 'clode-net.cjs'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const errors = [];
  for (let i = 1; i <= attempts; i++) {
    try { await downloadFile(url, dest); return; } catch (e) { errors.push(`attempt ${i}: ${e.message}`); }
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs * i));
  }
  throw new Error(`could not download ${url} (${errors.join('; ')})`);
}

async function fetchText(url, dest, opts) {
  await download(url, dest, opts);
  return fs.readFileSync(dest, 'utf8');
}

// The cached copy is trusted only when it hashes to the pin; anything else (absent,
// truncated, a different release's bytes) is fetched again and then verified, so a
// mismatch after a fresh download is the refusal, never a silent re-use.
async function fetchVerified(version, name, { cacheDir, offline = false }) {
  const pin = (pins()[version] || {})[name];
  if (!pin) throw new Error(`no pin entry for ${version}/${name} in scripts/unicode-inputs.json`);
  const dest = path.join(cacheDir, version, `${name}.txt`);
  let text = null;
  try { text = fs.readFileSync(dest, 'utf8'); } catch { /* not cached */ }
  if (text === null || !pin.sha256 || sha256Text(text) !== pin.sha256) text = await fetchText(pin.url, dest, { offline });
  return verifyText(text, pin);
}

// `XXXX..YYYY ; Value # comment` and `XXXX ; Value`. With `field`, only lines whose
// first property column equals it, taking the NEXT column as the value — the shape of
// DerivedCoreProperties.txt's `094D ; InCB; Linker`. Comment-only lines, including the
// `# @missing:` default lines, are skipped: they describe UNASSIGNED code points.
function parseRanges(text, field) {
  const out = [];
  for (const line of text.split('\n')) {
    const body = line.split('#')[0].trim();
    if (!body) continue;
    const parts = body.split(';').map((s) => s.trim());
    let value;
    if (field) { if (parts[1] !== field) continue; value = parts[2]; } else value = parts[1];
    const [lo, hi] = parts[0].split('..').map((h) => parseInt(h, 16));
    out.push([lo, hi === undefined ? lo : hi, value]);
  }
  return out;
}

module.exports = { pins, PINS, sha256Text, verifyText, download, fetchVerified, parseRanges, UcdOfflineMiss };
