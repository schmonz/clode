'use strict';
// THE MODULE'S OWN import.meta FIELDS, derived from its graph NAME, in ONE place for every host that runs a carved
// module: the graph runner (libexec/extract-claude-js.cjs moduleWithMeta, under node and tjs) and quaude's compiled
// blob (libexec/quaude-blobulate.js). Dependency-free on purpose: the blobulate worker runs under tjs with no module
// resolver and loads this file's text (loadLibexecCjs).
//
// What Bun reports for `/$bunfs/root/chunk-x.js`, and so what upstream reads: url `file:///$bunfs/root/chunk-x.js`,
// dirname and its alias dir `/$bunfs/root`. Neither node nor tjs supplies dirname to a module compiled from a name
// rather than loaded from a file (measured 2026-09-26 for the runner; 2026-11-25 for quaude's blob, where tjs's
// engine derives only the url). The runner always had both; quaude's blob had neither, and node-shim's path.resolve
// quietly turned the undefined into a cwd-relative path until it learned node's argument checks (2026-11-25): then
// 2.1.332's builtin-hooks home, `resolve(import.meta.dirname,"../../../../../..")`, threw in every interactive
// quaude (test/fidelity/debug-log-interactive.test.cjs). test/module-meta.test.cjs holds both hosts to this.
function moduleMeta(name) {
  const abs = /^[/\\]/.test(name) || /^[A-Za-z]:/.test(name);
  const url = abs ? 'file://' + (name[0] === '/' ? '' : '/') + name.replace(/\\/g, '/') : null;
  const cut = abs ? name.search(/[/\\][^/\\]*$/) : -1;          // the last separator, either kind
  const dir = cut > 0 ? name.slice(0, cut) : (cut === 0 ? name[0] : null);
  return { url, dir };
}
// The statements that assign them, without a trailing newline (the caller decides whether lines may move).
function moduleMetaAssignments(name, { url: withUrl = true } = {}) {
  const { url, dir } = moduleMeta(name);
  return (withUrl && url ? ' import.meta.url = ' + JSON.stringify(url) + ';' : '')
    + (dir ? ' import.meta.dirname = import.meta.dir = ' + JSON.stringify(dir) + ';' : '');
}
module.exports = { moduleMeta, moduleMetaAssignments };
