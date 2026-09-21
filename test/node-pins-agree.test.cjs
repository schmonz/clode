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
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');

const REPO = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const DOCKERFILE = 'spike/quickjs/qemu/docker-loop/Dockerfile.xfuse';

// PURE: parses the four pins out of already-read text and derives findings. A
// pattern that fails to match is itself a finding (a parse break), not a thrown
// error — the guard must say so rather than going silently blind.
function scanNodePins({ toolVersions, ciYml, dockerfile, pkg }) {
  const findings = [];
  let examined = 0;
  const pins = {};

  examined++;
  const tv = toolVersions.match(/^nodejs\s+(\S+)$/m);
  if (!tv) findings.push('.tool-versions has no `nodejs <version>` line');
  else pins['.tool-versions'] = tv[1];

  examined++;
  const ci = ciYml.match(/image:\s*node:(\S+?)-alpine/);
  if (!ci) findings.push('ci.yml has no `image: node:<version>-alpine` container');
  else pins['ci.yml container'] = ci[1];

  examined++;
  const xf = dockerfile.match(/^FROM\s+node:(\S+?)-/m);
  if (!xf) findings.push(`${DOCKERFILE} has no \`FROM node:<version>-\` line`);
  else pins[DOCKERFILE] = xf[1];

  // THE INVARIANT IS NOT "ALL PINS ARE IDENTICAL" — see the header note on
  // publish lag. What actually matters is that these three toolchain pins name
  // exactly the same version: the musl oracle diffs a musl engine against a
  // reference node, so any difference at all risks measuring libc or a runtime
  // change instead of shim fidelity. Only meaningful once all three parsed.
  if (Object.keys(pins).length === 3) {
    examined++;
    const versions = [...new Set(Object.values(pins))];
    if (versions.length !== 1) {
      findings.push('toolchain node pins disagree, and the oracle guard requires exact equality: '
        + JSON.stringify(pins));
    }
  }

  examined++;
  const embedded = pkg.engines && pkg.engines.node;
  if (!embedded) {
    findings.push('package.json no longer pins the embedded node (engines.node)');
  } else if (pins['.tool-versions'] && embedded.split('.')[0] === pins['.tool-versions'].split('.')[0]) {
    findings.push(`package.json "node" (${embedded}) is on the same major as the toolchain `
      + `(${pins['.tool-versions']}) — the embedded node is what a built naude carries and `
      + 'should track its own line, deliberately different from the toolchain');
  }

  return { findings, examined };
}

const guard = defineGuard({
  name: 'node-pins-agree',
  read: () => ({
    toolVersions: read('.tool-versions'),
    ciYml: read('.github/workflows/ci.yml'),
    dockerfile: read(DOCKERFILE),
    pkg: JSON.parse(read('package.json')),
  }),
  scan: scanNodePins,
  // I2 (coordinator, 2026-09-04): table-driven — four fixed named files. Floored at
  // the exact measured count (5).
  floor: 5,
  // Models the actual 2026-08-27 incident: .tool-versions bumped, the oracle
  // container left behind. Also exercises the embedded-node-converged finding.
  control: () => ({
    toolVersions: 'nodejs 24.20.0\n',
    ciYml: 'image: node:24.19.0-alpine\n',
    dockerfile: 'FROM node:24.19.0-bookworm-slim\n',
    pkg: { engines: { node: '24.1.0' } },
  }),
});
guardTests(guard);

// renovate.json's toolchain rule NAMES two mechanisms in its own prose — an exclusion
// rule for package.json's engines.node, and an allowedVersions clamp — that a reader
// takes as documentation of what the config DOES. Neither was backed by a rule: PR #45
// swept engines.node into the toolchain's branch anyway (2026-09-20), and the missing
// allowedVersions is the same gap the 2026-08-27 `manifest unknown` incident exploited.
// This is the class the coordinator's SDD note calls "config prose that no rule
// implements", not a one-off — this repo has now found roughly seventeen of those. The
// gate below does not evaluate Renovate's behavior (it cannot, from here); it asserts
// only that a claim the description MAKES about a mechanism is backed by an actual rule
// object, so a future edit to one side without the other goes red instead of silent.
const RENOVATE_PATH = '.github/renovate.json';

function findToolchainRule(rules) {
  return rules.find((r) => Array.isArray(r.matchDepNames) && r.matchDepNames.includes('node')
    && Array.isArray(r.matchDatasources) && r.matchDatasources.includes('node-version'));
}

function scanRenovateRulesAgree({ renovate }) {
  const findings = [];
  let examined = 0;
  const rules = (renovate && Array.isArray(renovate.packageRules)) ? renovate.packageRules : [];

  examined++;
  const toolchain = findToolchainRule(rules);
  if (!toolchain) {
    findings.push('no packageRule matches node/nodejs against the node-version datasource — '
      + 'cannot check its prose against its rules');
    return { findings, examined };
  }
  const desc = toolchain.description || '';

  // Claim 1: the description says package.json's engines.node is excluded/grouped
  // separately from this rule. If it says so, a SIBLING rule must actually give
  // engines.node its own group.
  examined++;
  if (/engines\.node/.test(desc)) {
    const sibling = rules.some((r) => r !== toolchain
      && Array.isArray(r.matchDepTypes) && r.matchDepTypes.includes('engines')
      && Array.isArray(r.matchDepNames) && r.matchDepNames.includes('node'));
    if (!sibling) {
      findings.push('the toolchain rule\'s description talks about package.json engines.node, '
        + 'but no packageRule matches matchDepTypes:["engines"] + matchDepNames:["node"] — '
        + 'the toolchain rule\'s own matchDepNames/matchDatasources also matches engines.node, '
        + 'so without a sibling rule it rides the toolchain\'s branch (this is what PR #45 did)');
    }
  }

  // Claim 2: the description says allowedVersions holds this group to something. If it
  // says so, the rule must actually carry an allowedVersions field.
  examined++;
  if (/allowedVersions/.test(desc) && !/no allowedVersions/i.test(desc)) {
    if (!('allowedVersions' in toolchain)) {
      findings.push('the toolchain rule\'s description claims an allowedVersions constraint, '
        + 'but the rule object has no allowedVersions key — this is the 2026-08-27 `manifest '
        + 'unknown` gap the description claims is closed');
    }
  }

  return { findings, examined };
}

const renovateGuard = defineGuard({
  name: 'renovate-rules-agree-with-description',
  read: () => ({ renovate: JSON.parse(read(RENOVATE_PATH)) }),
  scan: scanRenovateRulesAgree,
  // Three checks always run once the toolchain rule is found: find-the-rule, the
  // engines.node claim, the allowedVersions claim.
  floor: 3,
  // Models the actual pre-fix state (2026-09-20): the toolchain rule's description
  // names both mechanisms, and NEITHER packageRule exists.
  control: () => ({
    renovate: {
      packageRules: [
        {
          description: 'toolchain node. package.json engines.node is EXCLUDED deliberately. '
            + 'allowedVersions holds this group to what an image actually exists for.',
          matchDepNames: ['node', 'nodejs'],
          matchDatasources: ['node-version', 'docker'],
          groupName: 'node toolchain',
        },
      ],
    },
  }),
});
guardTests(renovateGuard);
