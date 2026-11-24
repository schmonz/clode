'use strict';
// Loaded as `node --require <this> --test ...` (test/run.mjs and every CI step); see test/file-watchdog.cjs for why
// and how. Starts the out-of-process sleeper for a test-file process (and nowhere else), then the updater knob below.
const w = require('./file-watchdog.cjs');

if (w.shouldArm(process)) w.arm(process.argv[1], w.limitFor(process.argv[1]));

// Every test process (test/run.mjs and every CI `node --test` step load this file): no Claude Code a test drives updates
// its own install. The knob for everything that inherits this environment, and a refusal for a native spawned with an env
// built without it (test/updater-off.cjs).
const updater = require('./updater-off.cjs');
updater.ambient(process.env);
updater.installSpawnTripwire();
