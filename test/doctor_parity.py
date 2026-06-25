#!/usr/bin/env python3
"""Parse Claude Code's /doctor screen into blank-separated blocks, and compare a
native render against a clode render, allowing ONLY clode's intended deviations:
it may add the applet-skew block, and it may drop two install-identity-gated
warnings (clode runs from its cache dir, so it is neither the npm-global nor the
native install). Any other added/dropped block or item is reported.

CLI: doctor_parity.py NATIVE_SCREEN CLODE_SCREEN
     prints unlisted deviations (if any) and exits 1; exits 0 on parity.
"""
import re
import sys

TREE_LEADS = ("├", "└", "│")
SKEW_MARKER = "clode: search-applet version skew"

# Items clode may omit from "Installation warnings", matched as substrings on the
# glyph-stripped item text. Each nag is about cleaning up the install you launched
# AS; clode launches as neither the npm-global nor the native install.
ALLOWED_OMISSION_SUBSTRINGS = (
    "is not in your PATH",      # the ~/.local/bin PATH nag
    "export PATH=",             # that nag's "Run:" follow-up
    "Leftover npm global installation",
    "npm -g uninstall",         # that nag's "Run:" follow-up
)


def _normalize(s):
    """Mask runtime-volatile tokens so a parity comparison is stable. The only one
    observed is the background-server PID in 'Version locks'."""
    return re.sub(r"PID \d+", "PID N", s)


def _strip_tree(s):
    """Strip a leading tree connector (├ └ │) and surrounding whitespace."""
    s = s.strip()
    while s[:1] in TREE_LEADS:
        s = s[1:].strip()
    return s


class Block:
    def __init__(self, title):
        self.title = title    # glyph-stripped, normalized first line
        self.items = []       # glyph-stripped, normalized, wrap-joined item strings


def parse_screen(text):
    """Return an ordered list of Block. Leading/trailing blank lines (viewport
    float) are ignored; blank lines separate blocks; within a block the first line
    is the title and each tree-entry line is an item (wrapped continuations joined
    onto the item, or onto the title for the skew/footer multi-line blocks)."""
    blocks = []
    cur = []
    for line in text.split("\n"):
        if line.strip() == "":
            if cur:
                blocks.append(cur)
                cur = []
        else:
            cur.append(line)
    if cur:
        blocks.append(cur)

    out = []
    # Assumes each block's first line is a non-tree-entry title (every /doctor section is).
    for lines in blocks:
        b = Block(_normalize(_strip_tree(lines[0])))
        for line in lines[1:]:
            if line.strip()[:1] in TREE_LEADS:
                b.items.append(_normalize(_strip_tree(line)))
            elif b.items:
                b.items[-1] = b.items[-1] + " " + _normalize(line.strip())
            else:
                b.title = b.title + " " + _normalize(line.strip())
        out.append(b)
    return out


def compare(native, clode):
    """Return a list of UNLISTED deviation strings; empty list means parity holds
    (modulo the allowlisted skew addition and install-warning omissions)."""
    deviations = []
    native_titles = [b.title for b in native]
    clode_titles = [b.title for b in clode]

    # Added blocks: only the skew block is allowed.
    for b in clode:
        if b.title not in native_titles and SKEW_MARKER not in b.title:
            deviations.append("unexpected ADDED block: %r" % b.title)
    # Dropped blocks: none allowed.
    for b in native:
        if b.title not in clode_titles:
            deviations.append("unexpected DROPPED block: %r" % b.title)
    # Relative order of shared blocks must match.
    shared_n = [t for t in native_titles if t in clode_titles]
    shared_c = [t for t in clode_titles if t in native_titles]
    if shared_n != shared_c:
        deviations.append("section order changed: native=%r clode=%r" % (shared_n, shared_c))

    # Item-level diff within shared blocks. Membership-based: order within a block is not compared.
    clode_by_title = {b.title: b for b in clode}
    for nb in native:
        cb = clode_by_title.get(nb.title)
        if cb is None:
            continue
        for item in nb.items:
            if item not in cb.items and not any(s in item for s in ALLOWED_OMISSION_SUBSTRINGS):
                deviations.append("unexpected DROPPED item in %r: %r" % (nb.title, item))
        for item in cb.items:
            if item not in nb.items:
                deviations.append("unexpected ADDED item in %r: %r" % (nb.title, item))
    return deviations


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: doctor_parity.py NATIVE_SCREEN CLODE_SCREEN")
    with open(sys.argv[1]) as f:
        native = parse_screen(f.read())
    with open(sys.argv[2]) as f:
        clode = parse_screen(f.read())
    devs = compare(native, clode)
    for d in devs:
        print(d)
    sys.exit(1 if devs else 0)


if __name__ == "__main__":
    main()
