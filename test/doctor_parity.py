#!/usr/bin/env python3
"""Slice a captured /doctor SCREEN to its report, parse it into blank-separated
blocks, and compare a native render against a clode render, allowing ONLY clode's
intended deviations:
  - it may add the applet-skew items to the Installation warnings block;
  - it may drop two install-identity-gated warnings (clode runs from its cache
    dir, so it is neither the npm-global nor the native install);
  - its Diagnostics section may diverge on the labels in DIAGNOSTICS_DIVERGENT_LABELS
    (clode runs node + extracted JS, so "Currently running"/"Path"/"Invoked" differ).
Any other added/dropped block or item is reported.

The /doctor report is taller than a typical terminal and does NOT scroll, so the
capture must be tall enough to contain the whole thing. slice_to_report() extracts
the report (from its leading full-width rule to the 'Enter to close' footer) and
flags an INCOMPLETE capture when that boundary is missing — i.e. the terminal was
too short and the top scrolled off. A truncated capture is never silently compared.

CLI: doctor_parity.py NATIVE_SCREEN CLODE_SCREEN
     exits 0 on parity, 1 on unlisted deviations, 2 on an incomplete capture.
"""
import re
import sys

TREE_LEADS = ("├", "└", "│")

# Items clode may ADD to a shared block — the applet-skew finding now renders as
# native "Installation warnings" data: an `issue` line + its `Run: fix` line.
ALLOWED_ADDED_ITEM_SUBSTRINGS = (
    "rejects flags clode",   # the skew issue line
    "set CLODE_",            # the skew fix line ("Run: set CLODE_<APPLET> …")
)

# Items clode may omit from "Installation warnings", matched as substrings on the
# glyph-stripped item text. Each nag is about cleaning up the install you launched
# AS; clode launches as neither the npm-global nor the native install.
ALLOWED_OMISSION_SUBSTRINGS = (
    "is not in your PATH",      # the ~/.local/bin PATH nag
    "export PATH=",             # that nag's "Run:" follow-up
    "Leftover npm global installation",
    "npm -g uninstall",         # that nag's "Run:" follow-up
)

# In the Diagnostics section, clode legitimately diverges from native: it runs the
# extracted JS under host node, so it reports installType "unknown", a host node
# Path, and an extra "Invoked" (the cache cli.cjs). These item LABELS may differ in
# value OR presence (either direction) ONLY within the Diagnostics block.
DIAGNOSTICS_DIVERGENT_LABELS = ("Currently running:", "Path:", "Invoked:")

# The /doctor report's top boundary: a full-width horizontal rule (pure dashes, no
# box corners) that sits just above the first section. The session welcome box uses
# corner glyphs (╰…╯), so it does not match. Unique per report -> also our
# completeness signal.
_REPORT_RULE = re.compile(r"^\s*─{40,}\s*$")
_REPORT_FOOTER = "Enter to close"


def slice_to_report(text):
    """Return (report_text, complete). The report runs from the line AFTER the
    leading full-width rule through the 'Enter to close' footer. complete is False
    when the rule isn't present exactly once or the footer is missing (terminal too
    short -> the top of the report scrolled off); callers must treat an incomplete
    capture as a hard error, never compare it."""
    lines = text.split("\n")
    rules = [i for i, l in enumerate(lines) if _REPORT_RULE.match(l)]
    feet = [i for i, l in enumerate(lines) if _REPORT_FOOTER in l]
    if len(rules) != 1 or not feet:
        return text, False
    return "\n".join(lines[rules[0] + 1:feet[-1] + 1]), True


def _allowed_dropped(block_title, item):
    if any(s in item for s in ALLOWED_OMISSION_SUBSTRINGS):
        return True
    return "Diagnostics" in block_title and any(item.startswith(l) for l in DIAGNOSTICS_DIVERGENT_LABELS)


def _allowed_added(block_title, item):
    if any(s in item for s in ALLOWED_ADDED_ITEM_SUBSTRINGS):
        return True
    return "Diagnostics" in block_title and any(item.startswith(l) for l in DIAGNOSTICS_DIVERGENT_LABELS)


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

    # Added blocks: none allowed (skew is now a native warnings item, not a block).
    for b in clode:
        if b.title not in native_titles:
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
            if item not in cb.items and not _allowed_dropped(nb.title, item):
                deviations.append("unexpected DROPPED item in %r: %r" % (nb.title, item))
        for item in cb.items:
            if item not in nb.items and not _allowed_added(nb.title, item):
                deviations.append("unexpected ADDED item in %r: %r" % (nb.title, item))
    return deviations


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: doctor_parity.py NATIVE_SCREEN CLODE_SCREEN")
    with open(sys.argv[1]) as f:
        nat_report, nat_ok = slice_to_report(f.read())
    with open(sys.argv[2]) as f:
        clo_report, clo_ok = slice_to_report(f.read())
    if not nat_ok or not clo_ok:
        print("INCOMPLETE CAPTURE: /doctor report boundary (rule/footer) not found — "
              "increase capture --rows (native_complete=%s clode_complete=%s)" % (nat_ok, clo_ok))
        sys.exit(2)
    devs = compare(parse_screen(nat_report), parse_screen(clo_report))
    for d in devs:
        print(d)
    sys.exit(1 if devs else 0)


if __name__ == "__main__":
    main()
