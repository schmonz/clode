'use strict';
// rg-carve-argv-answered: every rg argv the PINNED carve builds is ANSWERED by quaude's rg, never refused.
//
// WHY (grep-native Task 10 fix round, review I-1). Task 10 refused `--max-depth` by name, believing no upstream
// tool passed it; 2.1.283 passes it in production (the orphaned-plugin-version listing whose answer becomes the
// Glob tool's `--glob !...` exclusions, rt's skill listing, the sandbox scan), and `--follow` (the FileIndex
// fallback outside a repo) had been refused all along. A refusal there is silent: upstream catches it and caches
// an empty list. rg-differential judges only the Grep and Glob tools' argv; this judges EVERY argv shape the
// carve builds, read BY STRUCTURE (scripts/lib/rg-probe.cjs carveRgArgvShapes): the RUNNERS (a function that
// destructures the bundle's `{rgPath,rgArgs,argv0}`, or takes the sandbox's `{command:"rg"}`, and any function
// handing its first parameter on to one: bD, NQ, dTo, jv, oX in 2.1.283) and every call of one with an array
// literal or an array variable (what `NAME.push(...)` adds before the call included); each `["--files"` array as
// a net; the Grep builder through grepArgv; the first-use probe; each again with the EAGAIN retry's `-j 1`. Each
// runs through runRg in a scratch tree. A finding: a shape quaude's rg refuses (parseRgRefusal), or one that
// exits other than 0 or 1. (Fix round 2, review N2: reading only `["--files"` arrays missed the environment
// scan eo(), `dTo(["-o","-H",...,"--no-messages",...,"--max-filesize",...,"-e",...])`, which quaude's rg refused.)
//
// FLOOR: the shapes the 2.1.283 carve gives (44, measured 2026-10-04: 9 runner calls (7 listings, eo()'s scan,
// the Grep tool's own builder), the Glob builder's array before its pushes, 11 Grep shapes from grepArgv, the
// version probe, and each again under -j 1). CONTROL: the 2.1.283 snippets verbatim plus one planted `["--files",
// "--frobnicate"]` array, through the same extraction and the same runRg: it must be named.
// The literal relative requires below are load-bearing for the production-gate population sweep
// (test/guards-population.cjs).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { defineGuard, guardTests } = require('../guard.cjs');
const P = require('../../scripts/lib/rg-probe.cjs');
const rgn = require('../../libexec/rg-native.cjs');
const { providerBin } = require('../provider-resolve.cjs');
const { decodeGraphRunner } = require('../../libexec/inspect-claude-bundle.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const EXTRACT = path.join(REPO, 'libexec', 'extract-claude-js.cjs');
const FLOOR = 44;

// VERBATIM from the 2.1.283 darwin-arm64 carve (decoded graph.json, 2026-10-04): each `["--files"` array with
// what follows it (the sandbox scan, the file count, the markdown loader, the orphaned versions, the Glob tool,
// the FileIndex fallback, rt), the first-use probe, and the runner's EAGAIN retry prefix.
const SNIPPETS_2_1_283 = [
  "{D=await jv([\"--files\",\"--hidden\",\"--max-depth\",String(r),...I,\"-g\",\"!**/node_modules/**\"],h,y,e)}catch(L){vt(`[Sandbox] ripgrep scan failed: ${L}`)}for(let L of D){let O=Fr.resolve(h,L),z=!1;for(let Y of[...b,\".git\"]){let X=Gm(Y),ee=O.split(Fr.sep),ie=ee.findIndex((Ee)=>Gm(Ee)===X);if(ie!==-1){if(Y===\".git\"){let Ee=ee.slice(0,ie+1).join(Fr",
  "null;{let b=[\"--files\",\"--hidden\"];n.forEach((S)=>{b.push(\"--glob\",`!${S}`)}),s=await NQ(b,e,r)}if(s===0)return 0;let g=Math.floor(Math.log10(s)),y=Math.pow(10,g);return Math.round(s/y)*y}catch(s){if(s?.name!==\"AbortError\")t(`countFilesRoundedRg failed: ${s}`,{level:\"error\"})}}function uTo(){let e=am();return{mode:e.mode,path:e.command,work",
  "s):await oX([\"--files\",\"--hidden\",\"--follow\",\"--no-ignore\",\"--glob\",\"*.md\"],e,s,{cwd:mjn(n)})}catch(w){if(Ct(w))return[];if(w instanceof cjn)return t(`loadMarkdownFilesFromDir: ripgrep timed out scanning ${e}`),[];throw w}return(await Promise.all(h.map(async(w)=>{try{let D=await LI({stat:y3,readFile:mmn},w,hW);if(D===null)return t(`loadMark",
  " g=await oX([\"--files\",\"--hidden\",\"--no-ignore\",\"--max-depth\",\"4\",\"--glob\",cL],s,new AbortController().signal,{cwd:mjn(n)});return r.orphanedVersionGlobExclusions=g.map((h)=>{let b=qPn(h);return`!**/${(Cbe(b)?Rbe(s,b):b).replaceAll(\"\\\\\",\"/\")}/**`}),r.orphanedVersionGlobExclusions}catch{return r.orphanedVersionGlobExclusions=[],r.orphanedVer",
  "||\"true\"),q=[\"--files\",\"--null\",\"--glob\",n,\"--sort=modified\",...F?[\"--no-ignore\"]:[],...W?[\"--hidden\"]:[]];for(let We of D)q.push(\"--iglob\",We);for(let We of await XX(b)){let He=QX(We,pjn(e));if(He===null)continue;q.push(\"--glob\",He)}let ge=null,ye,ve=!1;ye=await oX(q,e.target,g,{rawLines:!0,rejectOnInputError:!0,cwd:e.spawnCwd,beforeSpawn:",
  "ll,f;{let c=[\"--files\",\"--follow\",\"--hidden\",\"--glob\",\"!.git/\",\"--glob\",\"!.svn/\",\"--glob\",\"!.hg/\",\"--glob\",\"!.bzr/\",\"--glob\",\"!.jj/\",\"--glob\",\"!.sl/\"];if(!o)c.push(\"--no-ignore-vcs\");f=await oX(c,n,r)}let u=f.map((c)=>p.relative(n,c)),m=Date.now()-a;return t(`[FileIndex] ripgrep: ${u.length} files in ${m}ms`),i(\"tengu_file_suggestions_ripgr",
  " l=await oX([\"--files\",\"--hidden\",\"--max-depth\",String(o),\"-g\",\"!.git\",\"-g\",\"!node_modules\",...e.flatMap((i)=>[\"-g\",i])],n,AbortSignal.timeout(Ce));return hn(jr(l,n).filter((i)=>!s||s.test(i)),r)}catch{return[]}}function jr(e,n,r=\"darwin\"){let o=r===\"win32\"?\"\\\\\":\"/\",s=n.endsWith(o)?n:n+o;return e.map((l)=>l.startsWith(s)?l.slice(s.length):l",
  "g}}else n=await Ke(r.command,[...r.args,\"--version\"],{timeout:5000});let s=n.code===0&&!!n.stdout&&n.stdout.startsWith(\"ripgrep \");",
  "w);let I=h?[\"-j\",\"1\"]:[],D=[..",
  // the runners, by structure (fix round 2, review N2), and the environment scan eo()'s call of dTo
  "function bD(e,r,n,s,h=!1,g,y){let{rgPath:b,rgArgs:S,argv0:T}=Q4(),w=g??hc(r,b);om(e,r,w);let I=h?[\"-j\",\"1\"]:[],D=[...S,.", 
  "function NQ(e,r,n){let{rgPath:s,rgArgs:h,argv0:g}=Q4();return new Promise((y,b)=", 
  "function dTo(e,r,n,s){let{rgPath:h,rgArgs:g,argv0:y}=Q4();return new Promise((b,", 
  "async function jv(e,r,n,s={command:\"rg\"}){let{command:h,args:g=[],argv0:y}=s,b=A3(h,[...g,", 
  "async function oX(e,r,n,s){r/* ... */s?.beforeSpawn?.(),bD(e,r,n,(S,T,w)=>{b(S,T,w,!1)},!1,s?.cwd", 
  "let f=await dTo([\"-o\",\"-H\",\"--no-line-number\",\"--no-messages\",\"--no-heading\",\"--color=never\",\"--null\",\"--hidden\",\"-g\",\"!.git\",\"-g\",\"!node_modules\",...[\"*.toml\",\"*.yaml\",\"*.yml\",\"*.json\",\"*.cfg\"].flatMap((c)=>[\"-g\",c]),\"--max-filesize\",Xr,\"-e\",\"[a-z0-9.+-]?(s3|gs|az)://[a-z0-9][a-z0-9._-]*\"],e,i,(c)=>{for(let g of c){let u=g.indexOf(\"\\x00\");if(u<0)continue;let h=g.slice(0,u);for(let w of Te(g.slice(u+1),pn)){if(w.leng", 
];
const CARVE_2_1_283 = SNIPPETS_2_1_283.join(';');

// Each shape run through runRg, the matcher alone deciding (no ugrep needed), in a scratch tree with a file.
function answer(shapes) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-carve-argv-')));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'needle\n');
    return shapes.map((s) => {
      const r = rgn.runRg(s.argv, { cwd: dir, spawnSync: cp.spawnSync, ugrep: () => null, matchFiles: rgn.matchFilesAlone, timeout: 60000 });
      return { where: s.where, argv: s.argv, status: r.status, refusal: rgn.parseRgRefusal(r.stderr), stderr: Buffer.from(r.stderr || '').toString('utf8') };
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function scan({ results, what }) {
  const findings = [];
  for (const r of results) {
    const argv = `rg ${r.argv.join(' ')}`;
    if (r.refusal) findings.push(`${r.where}: quaude's rg REFUSES ${argv} (${r.refusal.flag || 'argv'}: ${r.refusal.reason.slice(0, 160)}), which the bundle builds`);
    else if (r.status !== 0 && r.status !== 1) findings.push(`${r.where}: ${argv} exits ${r.status}: ${r.stderr.split('\n')[0].slice(0, 200)}`);
  }
  return { findings, examined: results.length, note: `${what}: ${results.length} argv shapes` };
}
function readCarve() {
  const bin = providerBin(process.env);
  if (!bin || !fs.existsSync(bin)) return { skip: 'no native provider (CLODE_PROVIDER_BIN or the pinned version) to read the carve of' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-carve-argv-gate-'));
  try {
    const cli = path.join(dir, 'cli.cjs');
    const ex = cp.spawnSync(process.execPath, [EXTRACT, bin, cli], { encoding: 'utf8' });
    if (ex.status !== 0) throw new Error(`extract-claude-js could not carve ${bin}: ${(ex.stderr || '').slice(0, 400)}`);
    const decoded = decodeGraphRunner(cli);
    const text = decoded !== null ? decoded : fs.readFileSync(cli, 'latin1');
    return { results: answer(P.carveRgArgvShapes(text)), what: `the carve of ${bin}` };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const control = () => ({ results: answer(P.carveRgArgvShapes(`${CARVE_2_1_283};let z=await run(["--files","--frobnicate","--hidden"],e)`)),
  what: 'the 2.1.283 snippets plus a planted --frobnicate listing' });

guardTests(defineGuard({ name: 'rg-carve-argv-answered', floor: FLOOR, read: readCarve, scan, control }));

test('carveRgArgvShapes reads 2.1.283\'s runners and the argv they are called with, by structure', () => {
  assert.deepStrictEqual([...P.carveRunners(CARVE_2_1_283).keys()].sort(), ['NQ', 'bD', 'dTo', 'jv', 'oX']);
  const all = P.carveRgArgvShapes(CARVE_2_1_283);
  const listings = all.filter((s) => s.argv[0] === '--files').map((s) => JSON.stringify(s.argv)).sort();
  assert.deepStrictEqual(listings, [
    ['--files', '--hidden', '--max-depth', '4', '-g', '!**/node_modules/**', '.'],
    ['--files', '--hidden', '--glob', '!x', '.'],
    ['--files', '--hidden', '--follow', '--no-ignore', '--glob', '*.md', '.'],
    ['--files', '--hidden', '--no-ignore', '--max-depth', '4', '--glob', 'x*', '.'],
    ['--files', '--null', '--glob', 'x*', '--sort=modified', '--no-ignore', '--hidden', '--iglob', 'x*', '--glob', 'x*', '.'],
    ['--files', '--null', '--glob', 'x*', '--sort=modified', '--no-ignore', '--hidden', '--iglob', 'x*', '.'],
    ['--files', '--follow', '--hidden', '--glob', '!.git/', '--glob', '!.svn/', '--glob', '!.hg/', '--glob', '!.bzr/', '--glob', '!.jj/',
      '--glob', '!.sl/', '--no-ignore-vcs', '.'],
    ['--files', '--hidden', '--max-depth', '4', '-g', '!.git', '-g', '!node_modules', '-g', 'x*', '.'],
  ].map((a) => JSON.stringify(a)).sort());
  // the environment scan eo(), through dTo: the shape the first reading missed
  assert.ok(all.some((s) => JSON.stringify(s.argv) === JSON.stringify(['-o', '-H', '--no-line-number', '--no-messages', '--no-heading', '--color=never',
    '--null', '--hidden', '-g', '!.git', '-g', '!node_modules', '-g', 'x*', '--max-filesize', '4M', '-e', '[a-z0-9.+-]?(s3|gs|az)://[a-z0-9][a-z0-9._-]*', '.'])));
  assert.ok(all.some((s) => s.argv.length === 1 && s.argv[0] === '--version'), 'the first-use probe');
  assert.strictEqual(all.length, 42, 'the snippets\' shapes, each again under the EAGAIN retry\'s -j 1 (the carve adds the Grep tool\'s own call: 44)');
  assert.ok(all.some((s) => s.argv[0] === '-j' && s.argv[2] === '--files'));
});
test('the 2.1.283 shapes are all answered here (no provider needed)', () => {
  const r = scan({ results: answer(P.carveRgArgvShapes(CARVE_2_1_283)), what: 'snippets' });
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.examined, 42);
});
test('the control names the planted refused listing, by its argv', () => {
  const r = scan(control());
  assert.strictEqual(r.findings.length, 2, r.findings.join('\n'));   // it, and it again under -j 1
  for (const f of r.findings) assert.match(f, /REFUSES rg (?:-j 1 )?--files --frobnicate --hidden \. \(--frobnicate: /);
});
