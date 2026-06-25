"""pytest unit tests for test/doctor_parity.py (the /doctor parser + comparator)."""
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


def test_parse_splits_into_titled_blocks():
    blocks = dp.parse_screen(_read("native-sample.txt"))
    titles = [b.title for b in blocks]
    assert "Multiple installations found ⚠" in titles
    assert "Installation warnings ⚠" in titles
    assert "Remote Control ✔" in titles
    # leading/trailing blank float must not create empty blocks
    assert all(b.title.strip() for b in blocks)


def test_parse_joins_wrapped_continuations_into_one_item():
    blocks = {b.title: b for b in dp.parse_screen(_read("native-sample.txt"))}
    iw = blocks["Installation warnings ⚠"]
    # the PATH "Run:" item and its wrapped "source ~/.zshrc" continuation are one item
    assert any("export PATH=" in it and "source ~/.zshrc" in it for it in iw.items)


def test_parse_strips_tree_glyphs_from_items():
    blocks = {b.title: b for b in dp.parse_screen(_read("native-sample.txt"))}
    for it in blocks["Multiple installations found ⚠"].items:
        assert not it.startswith("├") and not it.startswith("└")


def test_compare_clean_pair_is_parity():
    native = dp.parse_screen(_read("native-sample.txt"))
    clode = dp.parse_screen(_read("clode-sample.txt"))
    # Skew added + two install nags dropped + PID differs → all allowlisted/normalized.
    assert dp.compare(native, clode) == []


def test_compare_flags_a_dropped_section():
    native = dp.parse_screen(_read("native-sample.txt"))
    clode = [b for b in dp.parse_screen(_read("clode-sample.txt"))
             if b.title != "Remote Control ✔"]
    devs = dp.compare(native, clode)
    assert any("DROPPED block" in d and "Remote Control" in d for d in devs)


def test_compare_flags_an_unexpected_added_section():
    native = dp.parse_screen(_read("native-sample.txt"))
    clode = dp.parse_screen(_read("clode-sample.txt"))
    bogus = dp.Block("Surprise telemetry ✔")
    clode.append(bogus)
    devs = dp.compare(native, clode)
    assert any("ADDED block" in d and "Surprise telemetry" in d for d in devs)


def test_compare_flags_a_dropped_non_allowlisted_item():
    native = dp.parse_screen(_read("native-sample.txt"))
    clode = dp.parse_screen(_read("clode-sample.txt"))
    # Remove the keychain warning (NOT on the allowlist) from clode's render.
    iw = next(b for b in clode if b.title == "Installation warnings ⚠")
    iw.items = [it for it in iw.items if "Keychain is not writable" not in it]
    devs = dp.compare(native, clode)
    assert any("DROPPED item" in d and "Keychain is not writable" in d for d in devs)


def test_compare_pid_volatility_does_not_trip():
    native = dp.parse_screen(_read("native-sample.txt"))
    clode = dp.parse_screen(_read("clode-sample.txt"))
    vn = next(b for b in native if b.title == "Version locks ✔")
    vc = next(b for b in clode if b.title == "Version locks ✔")
    assert vn.items == vc.items  # PIDs differ in the fixtures but normalize equal
