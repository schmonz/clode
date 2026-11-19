'use strict';
// Loaded as `node --require <this> --test ...` (test/run.mjs and every CI step); see test/file-watchdog.cjs for why
// and how. Starts the out-of-process sleeper for a test-file process; does nothing anywhere else.
const w = require('./file-watchdog.cjs');

if (w.shouldArm(process)) w.arm(process.argv[1], w.limitFor(process.argv[1]));
