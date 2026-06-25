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


# A realistic minified doctor footer fragment (createElement alias uA.default,
# Box=U, Text=h) — the shape patch_doctor anchors on.
SYN_DOCTOR = (
    b'uA.default.createElement(Bf,null,'
    b'uA.default.createElement(U,{flexDirection:"column"},I),'
    b'uA.default.createElement(U,{marginTop:1},'
    b'uA.default.createElement(h,{dimColor:!0},"Still having issues? Run /feedback to report details.")))'
)


def test_patch_doctor_injects_skew_section_with_captured_identifiers():
    out, applied = ex.patch_doctor(SYN_DOCTOR)
    assert applied is True
    # guard + clode-owned data path present
    assert b"globalThis.__clodeDoctor.appletSkew" in out
    # built from the CAPTURED aliases (uA.default.createElement / U / h), not hardcoded
    assert b'uA.default.createElement(U,{flexDirection:"column",marginTop:1}' in out
    assert b'uA.default.createElement(h,{color:"yellow"}' in out
    # inserted BEFORE the footer; footer string still present exactly once and intact
    assert out.count(b"Still having issues?") == 1
    assert b'{marginTop:1},uA.default.createElement(h,{dimColor:!0},"Still having issues?' in out


SYN_DOCTOR_JSX = (
    b'ls.jsxs(Nu,{children:['
    b'ls.jsx(U,{flexDirection:"column",children:x}),'
    b'ls.jsx(U,{marginTop:1,children:ls.jsx(w,{dimColor:!0,children:"Still having issues? Run /feedback to report details."})}),'
    b'ls.jsx(U,{marginTop:1,children:ls.jsx(w,{dimColor:!0,italic:!0,children:"x"})})'
    b']})')


def test_patch_doctor_injects_jsx_form_when_footer_uses_automatic_runtime():
    out, applied = ex.patch_doctor(SYN_DOCTOR_JSX)
    assert applied is True
    assert b"globalThis.__clodeDoctor.appletSkew" in out
    assert b'ls.jsxs(U,{flexDirection:"column",marginTop:1,children:[ls.jsx(w,{color:"yellow",children:' in out
    assert b'ls.jsx(w,{dimColor:!0,children:globalThis.__clodeDoctor.appletSkew.map(' in out
    assert b'):null),ls.jsx(U,{marginTop:1,children:ls.jsx(w,{dimColor:!0,children:"Still having issues?' in out


def test_patch_doctor_matches_the_real_2_1_191_fixture():
    import os
    body = open(os.path.join(ROOT, "test", "fixtures", "doctor", "footer-2.1.191.js"), "rb").read()
    out, applied = ex.patch_doctor(body)
    assert applied is True
    assert b"search-applet version skew" in out


def test_patch_doctor_is_linear_on_pathological_padding():
    # A long run of identifier chars with no match must NOT backtrack O(n^2).
    # (The ~1MB synthetic fixture is exactly this; an unbounded `+` hung extraction.)
    import time
    body = b"x" * 2_000_000
    t = time.time()
    out, applied = ex.patch_doctor(body)
    assert applied is False and out == body
    assert time.time() - t < 2.0, "patch_doctor regex is super-linear on identifier-run padding"


def test_patch_doctor_noop_when_anchor_absent():
    out, applied = ex.patch_doctor(b"no doctor screen here")
    assert applied is False and out == b"no doctor screen here"


def test_patch_doctor_noop_when_anchor_ambiguous():
    # exactly-once or we don't touch it (fail-loud contract)
    out, applied = ex.patch_doctor(SYN_DOCTOR + SYN_DOCTOR)
    assert applied is False


def test_transform_applies_doctor_patch_on_realistic_body():
    out = ex.transform(SYN_DOCTOR)
    assert b"globalThis.__clodeDoctor.appletSkew" in out


# Realistic minified shapes patch_doctor_eager anchors on: the no-arg snapshot
# generator and the /doctor local-jsx command's `load`.
SYN_GEN = b'async function Tp7(){let H=await Gp7();return{provider:await I_q(H)}}'
SYN_DOC_CMD = (
    b'qlL={name:"doctor",description:"Diagnose",isEnabled:()=>!cH.X,'
    b'type:"local-jsx",immediate:!0,requires:{ink:!0},'
    b'load:()=>Promise.resolve().then(() => (L4K(),f4K))}')
SYN_EAGER = SYN_GEN + b';var rwA;var M4K=E(()=>{' + SYN_DOC_CMD + b'});'


def test_patch_doctor_eager_wires_both_anchors():
    out, applied = ex.patch_doctor_eager(SYN_EAGER)
    assert applied is True
    # bridge exposed right after the generator definition
    assert b'}globalThis.__clodeEnsureSnapshot=Tp7;' in out
    # load now ensures the snapshot before yielding the screen, and stays BALANCED
    assert (b'load:()=>Promise.resolve().then(()=>{var g=globalThis.__clodeEnsureSnapshot;'
            b'return g?Promise.resolve().then(g).catch(function(){}):void 0})'
            b'.then(() => (L4K(),f4K))}') in out
    # the original callback's parens are not doubled (the earlier f4K))) bug)
    assert b'f4K)))' not in out


def test_patch_doctor_eager_noop_when_generator_absent():
    body = b'var x;var M4K=E(()=>{' + SYN_DOC_CMD + b'});'
    out, applied = ex.patch_doctor_eager(body)
    assert applied is False and out == body


def test_patch_doctor_eager_noop_when_doctor_load_absent():
    body = SYN_GEN + b';var y=1;'
    out, applied = ex.patch_doctor_eager(body)
    assert applied is False and out == body


def test_patch_doctor_eager_noop_when_ambiguous():
    out, applied = ex.patch_doctor_eager(SYN_EAGER + SYN_EAGER)
    assert applied is False


def test_transform_applies_eager_patch_on_realistic_body():
    out = ex.transform(SYN_DOCTOR + b';' + SYN_EAGER)
    assert b"globalThis.__clodeEnsureSnapshot=Tp7;" in out
    assert b"globalThis.__clodeDoctor.appletSkew" in out  # the render section too


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

