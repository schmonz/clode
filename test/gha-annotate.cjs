'use strict';
// A GitHub Actions annotation from inside a test, made impossible to miss: a `::warning title=...::` workflow command
// on the job's page and a line in the step summary. Outside GitHub Actions (no GITHUB_ACTIONS) it does nothing; the
// caller prints its own plain warning either way.
//
// THE RUNNER EATS IT: node --test's TAP reporter (CI is not a TTY) prefixes a test file's stdout with "# ", and GitHub
// only reads a workflow command at the start of a line. So under test/run.mjs (which sets CLODE_GHA_ANNOTATIONS to a
// file) the command is appended there and run.mjs prints it raw after the run; run bare, it goes to stdout directly.
const fs = require('node:fs');

// GitHub's escaping for workflow command data and properties.
const escData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

// -> the lines it wrote ({ command, summary }), or null outside GitHub Actions.
function annotate({ level = 'warning', title, message }, env = process.env) {
  if (!env.GITHUB_ACTIONS) return null;
  const command = `::${level} title=${escProp(title)}::${escData(message)}`;
  if (env.CLODE_GHA_ANNOTATIONS) fs.appendFileSync(env.CLODE_GHA_ANNOTATIONS, `${command}\n`);
  else process.stdout.write(`${command}\n`);
  const summary = `**${level.toUpperCase()}: ${title}**: ${message}`;
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `\n${summary}\n`);
  return { command, summary };
}

module.exports = { annotate, escData, escProp };
