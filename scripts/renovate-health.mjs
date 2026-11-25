#!/usr/bin/env node
// renovate-health — CAN RENOVATE RUN HERE? Three ways it stopped, each silent on our side (found 2026-11-25):
//
//   1. ITS CONFIG STOPPED COMPILING. Renovate renders every template with Handlebars before it is used, and a newer
//      Renovate validates that. Our customDatasources' JSONata wrote `function($n) {{ "version": ... }}`, and `{{` is a
//      Handlebars mustache: from 2026-10-22 every run ended in `init` with "Invalid template in config path:
//      customDatasources.*.transformTemplates" (exit 5), before one lookup. Three update PRs froze for a month.
//   2. IT SAID SO, AND NOTHING READ IT. Renovate opened issue #74 "Action Required: Fix Renovate Configuration" the same
//      day and kept it current. An open issue is not a red anything.
//   3. A DATASOURCE ANSWERED NOTHING. cross-platform-actions/netbsd-builder moved its images from .qcow2 to .tar.zst
//      (v1.3.0, 2026-11-07); our transform filtered on `-x86-64.qcow2`, so the lookup returned no releases. Renovate
//      only warns about that ("Package lookup failures"), and a pin it cannot look up is a pin nothing bumps.
//
//   node scripts/renovate-health.mjs --jsonata <path to the jsonata package>    (needs GITHUB_TOKEN, GITHUB_REPOSITORY)
//
// Run daily by .github/workflows/upstream-drift.yml (job `renovate`). The pure judgements are exported, and
// test/build-gates/renovate-config-gates.test.cjs holds the checkout's config to (1) offline, on every push.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG = '.github/renovate.json';
export const ACTION_REQUIRED = /^Action Required: /;

// (1) PURE: every string in the config that Renovate renders as a template is one Handlebars can compile. JSONata (a
// customDatasource transformTemplate) must not contain the delimiters at all; any other string may use them only as a
// well-formed mustache: {{path}}, {{{path}}}, {{#helper ...}}, {{/helper}}, {{else}}.
const MUSTACHE = /\{\{\{?\s*(?:[#/^]?[A-Za-z_@][\w.@/-]*(?:\s+[^{}]*)?|else)\s*\}?\}\}/g;
export function templateFindings(config) {
  const findings = [];
  let examined = 0;
  for (const [name, ds] of Object.entries((config && config.customDatasources) || {})) {
    for (const [i, t] of (ds.transformTemplates || []).entries()) {
      examined++;
      if (/\{\{|\}\}/.test(t)) {
        findings.push(`customDatasources.${name}.transformTemplates[${i}]: JSONata containing \`{{\` or \`}}\`, which `
          + 'Renovate reads as a Handlebars mustache and rejects ("Invalid template"); write `{ {` and `} }`');
      }
    }
  }
  const walk = (v, at) => {
    if (typeof v === 'string') {
      if (/^customDatasources\.[^.]+\.transformTemplates/.test(at) || !/\{\{|\}\}/.test(v)) return;
      examined++;
      if (/\{\{|\}\}/.test(v.replace(MUSTACHE, ''))) findings.push(`${at}: a \`{{\`/\`}}\` that is not a well-formed Handlebars mustache`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, at ? `${at}.${k}` : k);
  };
  walk(config, '');
  return { findings, examined };
}

// (2) + (3) PURE: `answers` is [{ name, url, releases | error }], one per custom datasource; `issues` the open issues
// Renovate opened (their titles).
export function healthFindings({ answers, issues }) {
  const findings = [];
  for (const a of answers) {
    if (a.error) findings.push(`customDatasources.${a.name}: ${a.url} could not be judged: ${a.error}`);
    else if (!Array.isArray(a.releases) || !a.releases.length) {
      findings.push(`customDatasources.${a.name}: ${a.url} answered, and the transform found no releases in it `
        + '(Renovate reports this only as a "Package lookup failure", and the pin it feeds is never bumped)');
    }
  }
  for (const t of issues.filter((x) => ACTION_REQUIRED.test(x))) findings.push(`Renovate is asking for action, and stops PRs until it is done: "${t}"`);
  return findings;
}

async function getJson(url, token) {
  const r = await fetch(url, { headers: { accept: 'application/vnd.github+json', ...(token && /^https:\/\/api\.github\.com\//.test(url) ? { authorization: `Bearer ${token}` } : {}) } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  return r.json();
}

async function main(argv) {
  const at = argv.indexOf('--jsonata');
  if (at < 0 || !argv[at + 1]) throw new Error('usage: renovate-health.mjs --jsonata <path to the jsonata package>');
  const jsonata = createRequire(import.meta.url)(path.resolve(argv[at + 1]));
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error('renovate-health: needs GITHUB_TOKEN and GITHUB_REPOSITORY (a check that could not ask is not a pass)');
  const config = JSON.parse(fs.readFileSync(path.join(REPO, CONFIG), 'utf8'));
  const compiled = templateFindings(config);
  const answers = [];
  for (const [name, ds] of Object.entries(config.customDatasources || {})) {
    const url = ds.defaultRegistryUrlTemplate;
    try {
      let doc = await getJson(url, token);
      for (const t of ds.transformTemplates || []) doc = await jsonata(t).evaluate(doc);
      answers.push({ name, url, releases: doc && doc.releases });
    } catch (e) { answers.push({ name, url, error: e.message }); }
  }
  const issues = (await getJson(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100`, token))
    .filter((i) => !i.pull_request && i.user && /renovate/i.test(i.user.login)).map((i) => i.title);
  const findings = [...compiled.findings, ...healthFindings({ answers, issues })];
  for (const a of answers) process.stdout.write(`renovate-health: ${a.name}: ${a.error ? `ERROR ${a.error}` : `${(a.releases || []).length} release(s)`}\n`);
  process.stdout.write(`renovate-health: ${issues.length} open Renovate issue(s): ${issues.join(' | ') || '(none)'}\n`);
  for (const f of findings) process.stderr.write(`renovate-health: ${f}\n`);
  if (!findings.length) process.stdout.write('renovate-health: Renovate can run here\n');
  return findings.length ? 1 : 0;
}

const invoked = (() => { try { return pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return null; } })();
if (invoked === import.meta.url) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 2; });
}
