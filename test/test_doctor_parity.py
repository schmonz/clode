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
