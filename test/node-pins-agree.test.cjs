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

// THE INVARIANT IS NOT "ALL PINS ARE IDENTICAL", and assuming it was is what turned a
// one-line fix into a broken main. Node 24.20.0 exists on nodejs.org — asdf installs it —
// while Docker Hub's newest is node:24.19.0-alpine. Pointing the container at 24.20.0 to
// "match" produced `manifest unknown: manifest unknown` and took both oracle jobs down.
// Publishing is not simultaneous, so the container CANNOT always equal .tool-versions.
//
// What actually matters for the musl oracle is that its reference node is not AHEAD of the
// toolchain and not far behind it: that job diffs a musl engine against a reference node,
// so a reference from a different minor risks measuring libc or a runtime change rather
// than shim fidelity. Same-minor is the honest requirement.
function cmp(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

// EXACT EQUALITY, because ci.yml's oracle guard demands it:
//     want=$(sed -n 's/^nodejs //p' .tool-versions); have=$(node -v)
//     [ "$have" = "$want" ] || exit 1
// so any difference at all takes both oracle jobs down.
//
// AND THE CONSTRAINT RUNS THE OTHER WAY from what I first assumed. Node 24.20.0 exists on
// nodejs.org and asdf installs it, but Docker Hub's newest is node:24.19.0-alpine.
// "Matching" by bumping the container to 24.20.0 produced `manifest unknown` and broke
// main. Publishing is not simultaneous, so the pin that can move is the TOOLCHAIN one:
// .tool-versions may not name a node that no container image exists for, because CI has
// to run that exact node inside a container.
//
// That is why .github/renovate.json sources the .tool-versions nodejs pin from the DOCKER
// datasource — image availability is the binding constraint, so it should drive the bump
// rather than be dragged behind it.
test('every toolchain node pin names exactly the same version', () => {
  const pins = toolchainPins();
  const versions = [...new Set(Object.values(pins))];
  assert.strictEqual(versions.length, 1,
    "toolchain node pins disagree, and ci.yml's oracle guard requires exact equality:\n"
    + Object.entries(pins).map(([k, v]) => `    ${v}  ${k}`).join('\n')
    + '\n  If a bump is stuck because Docker Hub has not published the tag yet, the answer is\n'
    + '  to wait rather than to move .tool-versions ahead — an image that does not exist\n'
    + '  fails as "manifest unknown" before the job runs any of our code.');
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
