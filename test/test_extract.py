"""pytest unit + e2e tests for libexec/extract-claude-js."""
import importlib.util, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRIPT = os.path.join(ROOT, "libexec", "extract-claude-js")
BIN = os.path.expanduser("~/.local/share/claude/versions/2.1.183")


def load(name, path):
    spec = importlib.util.spec_from_loader(
        name, importlib.machinery.SourceFileLoader(name, path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ex = load("extract_claude_js", SCRIPT)

# a minimal synthetic Bun block: name NUL, marker, body, NUL terminator
SYN = (b"/$bunfs/root/src/entrypoints/cli.js\x00"
       b"// @bun @bun-cjs\n(function(exports, require, module, __filename, __dirname) {"
       b"console.log(import.meta.url)})\x00")


def test_carve_blocks_finds_named_entry():
    blocks = ex.carve_blocks(SYN)
    assert len(blocks) == 1
    off, size, body, name = blocks[0]
    assert name.endswith("entrypoints/cli.js")
    assert b"console.log" in body


def test_transform_rewrites_import_meta_and_prepends_prelude():
    out = ex.transform(b"x = import.meta.url")
    assert b"import.meta" not in out
    assert b"__import_meta" in out
    assert out.startswith(b"//")  # prelude comment


def test_verify_flags_residual_nul_and_import_meta():
    assert ex.verify(b"ok\n") == []
    assert any("NUL" in p for p in ex.verify(b"bad\x00"))
    assert any("import.meta" in p for p in ex.verify(b"y = import.meta\n"))


def test_content_checks():
    # empty input: too small
    assert any("size" in p for p in ex.content_checks(b""))
    # >= 1MB without sentinels: no size problem but sentinel problem
    big = b"x" * ex.MIN_OUTPUT_BYTES
    problems = ex.content_checks(big)
    assert not any("size" in p for p in problems)
    assert any("sentinel" in p for p in problems)
    # >= 1MB with both sentinels: no problems
    big_with_sentinels = big + b" commander @anthropic-ai/claude-code"
    assert ex.content_checks(big_with_sentinels) == []


def test_pick_entry_rejects_when_no_named_cli():
    nameless = [(0, 99999, b"x" * 99999, None)]
    import pytest
    with pytest.raises(SystemExit):
        ex.pick_entry(nameless)


import pytest

@pytest.mark.skipif(not os.path.exists(BIN), reason="no claude binary present")
def test_end_to_end_extraction_passes_verification():
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, "cli.cjs")
        r = subprocess.run([sys.executable, SCRIPT, BIN, out],
                           capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        assert "entry=" in r.stderr and r.stderr.rstrip().count("import.meta") == 0
        data = open(out, "rb").read()
        assert data.count(b"\x00") == 0
        assert len(data) > 1_000_000

