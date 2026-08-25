#!/usr/bin/env node
'use strict';
// WATCH FOR A NEWER HAIKU GUEST IMAGE — so we stop paying a build to rediscover a
// blocker we already recorded.
//
// Usage: node scripts/haiku-image-watch.mjs
// Driven daily by .github/workflows/upstream-drift.yml.
//
// WHY. The haiku-x64 leg fails because cross-platform-actions ships only an r1beta5
// guest image, Haiku moved HaikuPorts to the current release when beta6 shipped, and the
// guest therefore cannot install packages at all. That is not our bug and not something
// a build can fix; the leg was demoted to publish:false (see BACKLOG). Running it on
// every push spent a runner slot to re-derive a known answer, while the question we
// actually care about — HAS A BETA6 IMAGE APPEARED? — went unasked.
//
// So ask that instead, once a day, in about a second.
//
// WHAT GREEN MEANS HERE, and why this is NOT the mistake made earlier the same day with
// the `next` channel. There, "we cannot build it" was reported as green, which was a
// correctness claim that disagreed with reality. Here the product is not broken: Haiku is
// a platform we have DECIDED not to ship, recorded as such, and this check answers only
// "is the blocker still in place?". Green = no action available. Red = an action just
// became possible. It is a to-do trigger, not a health report — and Haiku's shipping
// status lives in BACKLOG, not in this exit code.
//
// NETWORK FAILURE IS NOT FATAL, deliberately, and this differs from
// upstream-drift-check.mjs on purpose. There, "we could not check" must never read as
// "nothing changed", because that check gates whether clode still works. This one gates
// nothing: a GitHub API blip should not turn a daily job red and teach everyone to ignore
// it. It says so loudly and exits 0.
const REPO = 'cross-platform-actions/haiku-builder';
const KNOWN_IMAGE = /r1beta5/i;
const TRACKING_ISSUE = 3;

async function getJSON(url) {
  const headers = { 'user-agent': 'clode-haiku-image-watch', accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

function bail(why) {
  process.stdout.write(`haiku-image-watch: could not check (${why}).\n`
    + '  This gates nothing — Haiku is deliberately not shipped (see BACKLOG). Exiting 0\n'
    + '  rather than turning a daily job red on a network blip.\n');
  process.exit(0);
}

(async () => {
  let rel;
  try {
    rel = await getJSON(`https://api.github.com/repos/${REPO}/releases/latest`);
  } catch (e) {
    bail(`fetching releases: ${(e && e.message) || e}`);
  }

  const images = (rel.assets || []).map((a) => a.name).filter((n) => /\.qcow2$/i.test(n));
  if (!images.length) bail(`release ${rel.tag_name} lists no .qcow2 image assets`);

  const newer = images.filter((n) => !KNOWN_IMAGE.test(n));

  // Context only; never decides the exit code. The issue can close before an image is
  // published, or an image can appear without the issue closing.
  let issue = null;
  try {
    issue = await getJSON(`https://api.github.com/repos/${REPO}/issues/${TRACKING_ISSUE}`);
  } catch { /* context is optional */ }

  process.stdout.write(`haiku-image-watch: ${REPO} ${rel.tag_name} — images: ${images.join(', ')}\n`);
  if (issue) process.stdout.write(`  tracking issue #${TRACKING_ISSUE} (${issue.title}): ${issue.state}\n`);

  if (!newer.length) {
    process.stdout.write(
      '\nhaiku-image-watch: OK — still only an r1beta5 image, so the blocker stands.\n'
      + '  NOT a health report. It means there is nothing we could do about Haiku today,\n'
      + '  which is why the leg is out of the push matrix. See BACKLOG for the demotion.\n');
    process.exit(0);
  }

  process.stderr.write(
    '\nhaiku-image-watch: A NEWER HAIKU IMAGE IS AVAILABLE — time to try again.\n\n'
    + `  new image(s): ${newer.join(', ')}\n\n`
    + '  Re-enable the haiku-x64 leg: set guest-version/floor to the new release in\n'
    + "  scripts/tjs-legs.mjs, restore publish:true, and put it back in the ci tier.\n"
    + '  The last attempt needed `pkgman drop-repo HaikuPorts` first (add-repo is\n'
    + '  interactive) — see the haiku-x64 entry in BACKLOG for exactly where it got to.\n');
  process.exit(1);
})().catch((e) => bail(`unexpected: ${(e && e.message) || e}`));
