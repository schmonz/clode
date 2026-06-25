"""pytest unit tests for test/doctor_parity.py (the /doctor slicer + parser + comparator)."""
import importlib.machinery, importlib.util, os

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures", "doctor")


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


dp = load("doctor_parity", os.path.join(HERE, "doctor_parity.py"))


def _read(name):
    with open(os.path.join(FIX, name)) as f:
        return f.read()


def _report(name):
    """Slice a full-capture fixture to its /doctor report (the unit of comparison)."""
    text, complete = dp.slice_to_report(_read(name))
    assert complete, "%s is not a complete capture" % name
    return text


def test_slice_to_report_extracts_report_and_marks_complete():
    report, complete = dp.slice_to_report(_read("native-sample.txt"))
    assert complete is True
    assert report.lstrip().startswith("Diagnostics")   # welcome chrome + leading rule stripped
    assert "Enter to close" in report
    assert "What's new" not in report                   # chrome above the rule is gone


def test_slice_to_report_incomplete_when_top_scrolled_off():
    # A capture whose leading rule scrolled off the top (terminal too short): no rule
    # line present -> must be flagged incomplete, never silently compared.
    truncated = "  Multiple installations found ⚠\n  └ x\n\n  Enter to close · f to fix\n"
    report, complete = dp.slice_to_report(truncated)
    assert complete is False


def test_parse_splits_into_titled_blocks():
    blocks = dp.parse_screen(_report("native-sample.txt"))
    titles = [b.title for b in blocks]
    assert "Diagnostics ✔" in titles
    assert "Multiple installations found ⚠" in titles
    assert "Installation warnings ⚠" in titles
    assert "Remote Control ✔" in titles
    # leading/trailing blank float must not create empty blocks
    assert all(b.title.strip() for b in blocks)


def test_parse_joins_wrapped_continuations_into_one_item():
    blocks = {b.title: b for b in dp.parse_screen(_report("native-sample.txt"))}
    iw = blocks["Installation warnings ⚠"]
    # the PATH "Run:" item and its wrapped "source ~/.zshrc" continuation are one item
    assert any("export PATH=" in it and "source ~/.zshrc" in it for it in iw.items)


def test_parse_strips_tree_glyphs_from_items():
    blocks = {b.title: b for b in dp.parse_screen(_report("native-sample.txt"))}
    for it in blocks["Multiple installations found ⚠"].items:
        assert not it.startswith("├") and not it.startswith("└")


def test_compare_clean_pair_is_parity():
    native = dp.parse_screen(_report("native-sample.txt"))
    clode = dp.parse_screen(_report("clode-sample.txt"))
    # Diagnostics diverges + skew added + two install nags dropped + PID differs → all
    # allowlisted/normalized.
    assert dp.compare(native, clode) == []


def test_compare_flags_a_dropped_section():
    native = dp.parse_screen(_report("native-sample.txt"))
    clode = [b for b in dp.parse_screen(_report("clode-sample.txt"))
             if b.title != "Remote Control ✔"]
    devs = dp.compare(native, clode)
    assert any("DROPPED block" in d and "Remote Control" in d for d in devs)


def test_compare_flags_an_unexpected_added_section():
    native = dp.parse_screen(_report("native-sample.txt"))
    clode = dp.parse_screen(_report("clode-sample.txt"))
    bogus = dp.Block("Surprise telemetry ✔")
    clode.append(bogus)
    devs = dp.compare(native, clode)
    assert any("ADDED block" in d and "Surprise telemetry" in d for d in devs)


def test_compare_flags_a_dropped_non_allowlisted_item():
    native = dp.parse_screen(_report("native-sample.txt"))
    clode = dp.parse_screen(_report("clode-sample.txt"))
    # Remove the keychain warning (NOT on the allowlist) from clode's render.
    iw = next(b for b in clode if b.title == "Installation warnings ⚠")
    iw.items = [it for it in iw.items if "Keychain is not writable" not in it]
    devs = dp.compare(native, clode)
    assert any("DROPPED item" in d and "Keychain is not writable" in d for d in devs)


def test_compare_pid_volatility_does_not_trip():
    native = dp.parse_screen(_report("native-sample.txt"))
    clode = dp.parse_screen(_report("clode-sample.txt"))
    vn = next(b for b in native if b.title == "Version locks ✔")
    vc = next(b for b in clode if b.title == "Version locks ✔")
    assert vn.items == vc.items  # PIDs differ in the fixtures but normalize equal


def test_compare_allows_skew_items_under_installation_warnings():
    native = dp.parse_screen(_report("native-sample.txt"))
    clode = dp.parse_screen(_report("clode-sample.txt"))
    iw = next(b for b in clode if b.title == "Installation warnings ⚠")
    assert any("rejects flags clode" in it for it in iw.items)   # skew issue present
    assert any("set CLODE_" in it for it in iw.items)            # skew fix present
    assert dp.compare(native, clode) == []                       # ...and allowlisted


def test_compare_flags_a_non_skew_added_item():
    native = dp.parse_screen(_report("native-sample.txt"))
    clode = dp.parse_screen(_report("clode-sample.txt"))
    iw = next(b for b in clode if b.title == "Installation warnings ⚠")
    iw.items.append("clode phoned home to evil.example.com")     # not allowlisted
    devs = dp.compare(native, clode)
    assert any("ADDED item" in d and "evil.example.com" in d for d in devs)


def test_compare_allows_diagnostics_divergence():
    native = dp.parse_screen(_report("native-sample.txt"))
    clode = dp.parse_screen(_report("clode-sample.txt"))
    dn = next(b for b in native if "Diagnostics" in b.title)
    dc = next(b for b in clode if "Diagnostics" in b.title)
    # the divergent labels really do differ between the two renders...
    assert any(it.startswith("Currently running:") and "native" in it for it in dn.items)
    assert any(it.startswith("Currently running:") and "unknown" in it for it in dc.items)
    assert any(it.startswith("Invoked:") for it in dc.items)     # clode-only item
    assert not any(it.startswith("Invoked:") for it in dn.items)
    # ...yet compare() treats the whole pair as parity (Diagnostics divergence allowlisted)
    assert dp.compare(native, clode) == []


def test_compare_flags_non_divergent_diagnostics_change():
    native = dp.parse_screen(_report("native-sample.txt"))
    clode = dp.parse_screen(_report("clode-sample.txt"))
    dc = next(b for b in clode if "Diagnostics" in b.title)
    # Platform is NOT a divergent label -> a difference there must still be flagged.
    dc.items = [it for it in dc.items if not it.startswith("Platform:")]
    dc.items.append("Platform: solaris-sparc")
    devs = dp.compare(native, clode)
    assert any("Diagnostics" in d and "solaris-sparc" in d for d in devs)
