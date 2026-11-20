'use strict';
// Loaded as `node --require <this> --test ...` by test/run.mjs (both passes). In a test-file process under a run that
// made a per-run temp root (test/run-tmp.cjs), points TMPDIR, TMP and TEMP at a dir of the file's own under that root,
// before the file asks os.tmpdir(); everything the file and its children make there goes when the runner removes the
// root. Does nothing anywhere else (the runner itself, a standalone `node --test`, a child that is not a test file).
const { shouldArm } = require('./file-watchdog.cjs');
const { ROOT_ENV, makeFileDir, redirect } = require('./run-tmp.cjs');

if (process.env[ROOT_ENV] && shouldArm(process)) redirect(process.env, makeFileDir(process.env[ROOT_ENV], process.argv[1]));
