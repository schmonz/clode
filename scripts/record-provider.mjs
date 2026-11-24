#!/usr/bin/env node
// Record WHICH provider binary a CI job installed, so a later step can prove it still has it.
//
// CI 45354661143 and 45381323279 (linux-x64-pty): the pinned 2.1.330 was installed at 11:13 and
// decoded fine there (reproduced: npm 11 and npm 12, node 24.22, linux-x64), yet the step that staged
// it at 12:06 found a binary it could not decode ("byteCount runs off the front of the file"). Between
// the two, the job's tests drove native Claude Code interactively; nothing recorded what the file was,
// so nothing could say whether it had changed. The CLASS: an instrument mutated mid-job. This step
// runs right after the pin is installed and writes the binary's path, size and SHA-256 to $GITHUB_ENV;
// scripts/stage-provider.mjs refuses a provider that no longer matches, naming both.
//
// Run as `node scripts/record-provider.mjs` (no $GITHUB_ENV: prints the record and writes nothing).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const prov = execFileSync(process.execPath, [path.join(here, 'find-provider.mjs')], { encoding: 'utf8' }).trim();
const sha = crypto.createHash('sha256').update(fs.readFileSync(prov)).digest('hex');
const size = fs.statSync(prov).size;
const lines = [`CLODE_PROVIDER_RECORDED_PATH=${prov}`, `CLODE_PROVIDER_RECORDED_SHA256=${sha}`, `CLODE_PROVIDER_RECORDED_SIZE=${size}`];
process.stdout.write(`record-provider: ${prov} ${size} bytes sha256 ${sha}\n`);
if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, lines.join('\n') + '\n');
