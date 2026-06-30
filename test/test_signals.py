"""pytest unit tests for libexec/clode-signals (warn-only update signals)."""
import importlib.machinery, importlib.util, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRIPT = os.path.join(ROOT, "libexec", "clode-signals")


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


sig = load("clode_signals", SCRIPT)

CHANGELOG = """# Changelog

## 2.1.195

- Added a mouse-click toggle
- Fixed a hook matcher bug

## 2.1.186

- Improved voice mode

## 2.1.181

- Upgraded the bundled Bun runtime to 1.4
- Changed a memory line

## 2.1.178

- Removed the TeamCreate tool
- Now requires Node 24 to run
"""


def test_parse_changelog_splits_sections():
    secs = dict((v, lines) for v, lines in sig.parse_changelog(CHANGELOG))
    assert set(secs) == {"2.1.195", "2.1.186", "2.1.181", "2.1.178"}
    assert any("Bun runtime" in l for l in secs["2.1.181"])


def test_high_signal_flagged_in_own_section():
    flags = sig.scan_changelog(CHANGELOG, "2.1.181")
    assert any(f["tier"] == "high" and "Bun runtime" in f["line"] for f in flags)


def test_range_excludes_the_prev_version_itself():
    # updating 2.1.181 -> 2.1.195 must NOT re-flag 2.1.181's own Bun line
    flags = sig.scan_changelog(CHANGELOG, "2.1.195", "2.1.181")
    assert all("Bun runtime" not in f["line"] for f in flags)
    # but a wider range that still excludes 181 and includes 186 is empty of highs
    assert [f for f in flags if f["tier"] == "high"] == []


def test_range_includes_intermediate_versions():
    # 178 -> 195 includes 181's Bun-runtime HIGH and 178 is excluded (== prev)
    flags = sig.scan_changelog(CHANGELOG, "2.1.195", "2.1.178")
    assert any(f["version"] == "2.1.181" and f["tier"] == "high" for f in flags)
    assert all(f["version"] != "2.1.178" for f in flags)


def test_node_requirement_is_a_high_signal():
    flags = sig.scan_changelog(CHANGELOG, "2.1.178")
    assert any(f["tier"] == "high" and "Node 24" in f["line"] for f in flags)


def test_bare_removed_is_not_a_false_positive():
    # "Removed the TeamCreate tool" must not flag on its own (no runtime/npm term)
    flags = sig.scan_changelog(CHANGELOG, "2.1.178")
    assert all("TeamCreate" not in f["line"] for f in flags)


def test_scan_bundle_counts_phrases(tmp_path):
    b = tmp_path / "fakebin"
    b.write_bytes(b"...requires the native binary... and again requires the native binary...")
    counts = sig.scan_bundle(str(b))
    assert counts["requires the native binary"] == 2
    assert counts["install.sh instead of npm"] == 0


def test_phrase_deltas_new_and_changed():
    cur = {"requires the native binary": 4, "typeof Bun": 6}
    prev = {"bundle_phrases": {"requires the native binary": 2}}
    d = dict((p, (was, now)) for p, was, now in sig.phrase_deltas(cur, prev))
    assert d["requires the native binary"] == (2, 4)   # changed
    assert d["typeof Bun"] == (None, 6)                 # new


def test_snapshot_is_per_version_not_range(tmp_path):
    # the written snapshot stores the version's OWN notes (reproducible), even
    # when --prev is given (which only affects the printed digest).
    cl = tmp_path / "CHANGELOG.md"
    cl.write_text(CHANGELOG)
    out = tmp_path / "signals"
    rc = sig.main(["--version", "2.1.195", "--prev", "2.1.178",
                   "--changelog-file", str(cl), "--snapshot-dir", str(out)])
    assert rc == 0
    snap = json.loads((out / "2.1.195.json").read_text())
    assert snap["version"] == "2.1.195"
    # 2.1.195's own notes carry no high/med signal, despite 181 being in the range
    assert snap["changelog_flags"] == []


def test_main_is_warn_only_on_garbage(tmp_path, capsys):
    rc = sig.main(["--version", "9.9.9", "--bundle", "/nonexistent",
                   "--changelog-file", "/nonexistent"])
    assert rc == 0
    assert "9.9.9" in capsys.readouterr().out
