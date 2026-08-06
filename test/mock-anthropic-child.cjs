'use strict';
// A standalone child wrapper around startMockAnthropic, so a SYNCHRONOUS driver
// (scripts/apicheck.mjs, whose model dispatch is spawnSync) can still front a
// live mock: the in-process helper needs an event loop the sync driver does not
// have. Writes its URL to --url-file once listening; runs until killed.
//
// --script takes a JSON array of rules applied IN ORDER to each /v1/messages
// request; the first whose `match` substring appears in the request body wins
// (a rule with no `match` always matches, so put it last as the default):
//   [{"match":"toolu_1","text":"DONE"},
//    {"tool":{"name":"Bash","input":{"command":"echo HI"},"id":"toolu_1"}}]
// That is enough to script a full agentic round-trip — tool_use, then the final
// text turn once the tool_result carrying the id comes back — with no network.
const fs = require('node:fs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('./mock-anthropic-helper.cjs');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const urlFile = arg('--url-file');
const rules = JSON.parse(arg('--script', '[]'));
const text = arg('--text', 'PONG');

startMockAnthropic({
  text,
  respond: rules.length ? (body) => {
    for (const r of rules) {
      if (r.match && !String(body).includes(r.match)) continue;
      if (r.tool) return cannedToolUseSSE(r.tool.name, r.tool.input || {}, r.tool.id);
      return cannedSSE(r.text != null ? r.text : text);
    }
    return cannedSSE(text);
  } : undefined,
}).then((m) => {
  if (urlFile) fs.writeFileSync(urlFile, m.url);
  process.stdout.write(m.url + '\n');
  // Report what the mock actually saw, so a caller can assert a POST landed.
  process.on('SIGTERM', () => {
    try {
      if (arg('--requests-file')) {
        fs.writeFileSync(arg('--requests-file'),
          JSON.stringify(m.requests.map((q) => ({ method: q.method, url: q.url })), null, 2));
      }
    } catch { /* best effort */ }
    process.exit(0);
  });
});
