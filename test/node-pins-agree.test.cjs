'use strict';
// EVERY PLACE WE PIN NODE MUST AGREE — checked here, not discovered in CI.
//
// There are four, and they are four different dependencies as far as Renovate is
// concerned, so nothing made them move together:
//
//   .tool-versions                                  the node this repo builds with
//   .github/workflows/ci.yml   container image:     the node the musl oracles run in
//   spike/.../Dockerfile.xfuse FROM node:           the node the xfuse docker loop uses
//   package.json "node"                             the node NAUDE EMBEDS — deliberately
//                                                   a different major; NOT part of this check
//
// WHY THIS EXISTS. On 2026-08-27, Renovate bumped .tool-versions 24.19.0 -> 24.20.0 and
// left the oracle container at 24.19.0. Both node-shim-oracle jobs then refused to run —
// correctly, because that job diffs a MUSL engine against a reference node, and a drifted
// reference means "measuring libc, not shim fidelity". The guard was right; the gap
// should never have reached CI. While writing this test, Dockerfile.xfuse turned out to
// ALREADY be skewed at 24.19.0 — a second drift nobody had noticed.
//
// package.json's "node" is EXCLUDED on purpose. It pins the Node that a built naude
// embeds in its SEA (26.x), which tracks a different line from the toolchain entirely.
// Folding it in would force two unrelated things to move together.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

function toolchainPins() {
  const pins = {};

  const tv = read('.tool-versions').match(/^nodejs\s+(\S+)$/m);
  assert.ok(tv, '.tool-versions has no nodejs line');
  pins['.tool-versions'] = tv[1];

  const ci = read('.github/workflows/ci.yml').match(/image:\s*node:(\S+?)-alpine/);
  assert.ok(ci, "ci.yml has no `image: node:<version>-alpine` container");
  pins['ci.yml container'] = ci[1];

  const df = 'spike/quickjs/qemu/docker-loop/Dockerfile.xfuse';
  const xf = read(df).match(/^FROM\s+node:(\S+?)-/m);
  assert.ok(xf, `${df} has no \`FROM node:<version>-\` line`);
  pins[df] = xf[1];

  return pins;
}

test('every toolchain node pin names the same version', () => {
  const pins = toolchainPins();
  const versions = [...new Set(Object.values(pins))];
  assert.strictEqual(versions.length, 1,
    'toolchain node pins disagree — a bump landed in some places and not others:\n'
    + Object.entries(pins).map(([k, v]) => `    ${v}  ${k}`).join('\n')
    + '\n  Bump them together. Renovate groups them (see .github/renovate.json), but a\n'
    + '  hand-edit or a partially-merged PR can still split them, which is why this gate\n'
    + '  exists rather than trusting the grouping alone.');
});

test("naude's embedded node is deliberately NOT part of that set", () => {
  // Guards the exclusion itself: if someone "helpfully" aligns package.json to the
  // toolchain, this says why that is wrong before it becomes a confusing revert.
  // It lives in "engines", which is also how a consumer's npm would enforce it.
  const embedded = JSON.parse(read('package.json')).engines?.node;
  assert.ok(embedded, 'package.json no longer pins the embedded node');
  const toolchain = Object.values(toolchainPins())[0];
  assert.notStrictEqual(embedded.split('.')[0], toolchain.split('.')[0],
    `package.json "node" (${embedded}) and the toolchain (${toolchain}) are on the same\n`
    + '  major. That is not automatically wrong, but it is not what this repo intends: the\n'
    + '  embedded node is what a built naude carries and tracks its own line. If upstream\n'
    + '  really did converge them, update this test deliberately.');
});
