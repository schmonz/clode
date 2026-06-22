#!/usr/bin/env python3
"""mkfixture.py <out> <label>

Write a fake "claude" binary: a real Bun @bun-cjs entry block named
src/entrypoints/cli.js wrapping a trivial JS body that prints the label. The
real libexec/extract-claude-js carves it and Node boots it -- a hermetic stand-in
for the proprietary bundle. Distinct labels => distinct sizes => distinct sigs.
"""
import sys

MIN_OUTPUT_BYTES = 1_000_000  # must match libexec/extract-claude-js

def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    out, label = sys.argv[1], sys.argv[2]
    # The body must be >= MIN_OUTPUT_BYTES after transform() prepends the prelude
    # (~400 bytes). Build a large block comment with the sentinel tokens and the
    # label (distinct labels => distinct sizes).  No NUL bytes; no import.meta.
    padding_size = MIN_OUTPUT_BYTES + len(label)
    padding = b'x' * padding_size
    body = (b'\n/* ' + padding +
            b' commander @anthropic-ai/claude-code ' +
            label.encode() +
            b' */\nconsole.log("CLODE-FIXTURE ' + label.encode() + b'");\n')
    blob = (b'PADDINGPADDINGPADDING\x00'
            b'src/entrypoints/cli.js\x00'
            b'// @bun @bun-cjs\n'
            b'(function(exports, require, module, __filename, __dirname) {'
            + body +
            b'})\x00TRAILER\x00')
    with open(out, 'wb') as f:
        f.write(blob)

if __name__ == '__main__':
    main()
