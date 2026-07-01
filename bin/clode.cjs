#!/usr/bin/env node
'use strict';
// ES5-SAFE PROLOGUE: runs on ANY node so an old node still prints the friendly
// floor error instead of a syntax crash. No const/arrow/require of modern code here.
var MIN_NODE_MAJOR = 24;
var major = parseInt(String(process.versions.node).split('.')[0], 10);
if (!(major >= MIN_NODE_MAJOR)) {
  process.stderr.write('clode: node v' + process.versions.node + ' is too old; need >= v' + MIN_NODE_MAJOR + '\n');
  process.stderr.write("clode: (the extracted bundle uses newer JS, e.g. 'using' declarations)\n");
  process.exit(1);
}
require(require('path').join(__dirname, '..', 'libexec', 'clode-main.cjs'))
  .main(process.argv.slice(2), { self: __filename })
  .catch(function (e) {
    process.stderr.write('clode: ' + ((e && e.stack) || e) + '\n');
    process.exit(1);
  });
