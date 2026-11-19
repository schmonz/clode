'use strict';
// Loaded by test/run.mjs as `node --require <this> --test ...`; see test/file-watchdog.cjs for why and how.
const w = require('./file-watchdog.cjs');

if (w.shouldArm(process)) w.arm(process.argv[1], w.limitFor(process.argv[1]));
