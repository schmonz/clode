'use strict';
// Renovate's config compiles: every template in .github/renovate.json is one Renovate's Handlebars pass accepts.
//
// WHY A GUARD. From 2026-10-22 every Renovate run on this repo ended in `init` ("Invalid template in config path:
// customDatasources.*.transformTemplates", exit 5): our JSONata wrote `{{ "version": ... }}`, a Handlebars mustache, and
// a newer Renovate validates templates. No lookup ran, three update PRs froze for a month, and Renovate's own issue (#74)
// was the only signal. scripts/renovate-health.mjs judges the live side daily (datasources answer, no "Action Required"
// issue); this judges the checkout's config on every push, offline. The literal relative require below is load-bearing
// for the population sweep (test/guards-population.cjs).
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');
const { defineGuard, guardTests } = require('../guard.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const { templateFindings, healthFindings } = require('../../scripts/renovate-health.mjs');

// The cpa-netbsd transform as it was through 2026-11-25 (the shape all four had).
const OCTOBER = '{ "releases": $[0].assets.name[$contains($, "-x86-64.qcow2")] ~> $map(function($n) {{ "version": '
  + '$match($n, /netbsd-(.+)-x86-64/).groups[0] }}) }';

guardTests(defineGuard({
  name: 'renovate-config-templates',
  floor: 4,
  read: () => JSON.parse(fs.readFileSync(path.join(REPO, '.github', 'renovate.json'), 'utf8')),
  scan: templateFindings,
  control: () => ({ customDatasources: { a: { transformTemplates: [OCTOBER] }, b: { transformTemplates: [OCTOBER] },
    c: { transformTemplates: [OCTOBER] }, d: { transformTemplates: [OCTOBER] } } }),
}));

test('renovate config: what the template rule passes and names', () => {
  const f = (c) => templateFindings(c).findings;
  assert.strictEqual(f({ customDatasources: { x: { transformTemplates: [OCTOBER] } } }).length, 1, 'JSONata with {{');
  assert.deepStrictEqual(f({ customDatasources: { x: { transformTemplates: [OCTOBER.replace('{{', '{ {').replace('}}', '} }')] } } }), []);
  assert.deepStrictEqual(f({ commitMessageTopic: '{{depName}} to {{{newVersion}}}', prBodyNotes: ['{{#if isMajor}}major{{/if}}'] }), [],
    'a well-formed mustache elsewhere');
  assert.strictEqual(f({ commitMessageTopic: 'x {{ "a": 1 }}' }).length, 1, 'a malformed one elsewhere');
});

test('renovate health: a datasource that answers nothing, and Renovate asking for action, are findings', () => {
  const ok = { name: 'n', url: 'u', releases: [{ version: '1' }] };
  assert.deepStrictEqual(healthFindings({ answers: [ok], issues: ['Dependency Dashboard'] }), []);
  assert.match(healthFindings({ answers: [{ ...ok, releases: undefined }], issues: [] }).join(), /found no releases/,
    'netbsd-builder after its .tar.zst move');
  assert.match(healthFindings({ answers: [{ ...ok, error: 'HTTP 404' }], issues: [] }).join(), /could not be judged/);
  assert.match(healthFindings({ answers: [ok], issues: ['Action Required: Fix Renovate Configuration'] }).join(), /stops PRs/,
    'issue #74, open a month');
});
