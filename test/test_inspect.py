"""pytest unit + e2e tests for libexec/inspect-claude-bundle."""
import importlib.util, importlib.machinery, os, subprocess, sys, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRIPT = os.path.join(ROOT, "libexec", "inspect-claude-bundle")
SHIM = os.path.join(ROOT, "libexec", "bun-shim.cjs")
BIN = os.path.expanduser("~/.local/share/claude/versions/2.1.183")
# Discover node on PATH (CLODE_NODE overrides); no hardcoded prefix.
NODE = os.environ.get("CLODE_NODE") or shutil.which("node") or "node"


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


ins = load("inspect_claude_bundle", SCRIPT)


def test_count_tallies_regex_groups():
    data = b"Bun.spawn(); Bun.spawn(); Bun.which()"
    out = ins.count(ins.BUN_API, data)
    assert out == {"spawn": 2, "which": 1}


def test_feature_for_asset_maps_native_addon_to_feature():
    assert "image" in ins.feature_for_asset("sharp.node").lower()
    assert ins.feature_for_asset("totally-unknown.node") is None


def test_coverage_classifies_implemented_stubbed_missing():
    r = {"bun_api_real": {"spawn": 1, "serve": 1, "Glob": 1},
         "bun_api_unrecognized": {}, "bun_modules": {}, "disabled_native_features": []}
    shim = {"keys": ["spawn", "serve"], "stubs": ["serve"], "modules": {}}
    cov = ins.coverage(r, shim)
    assert cov["implemented"] == ["spawn"]
    assert cov["stubbed"] == ["serve"]
    assert cov["missing"] == ["Glob"]


import pytest

@pytest.mark.skipif(not (os.path.exists(BIN) and os.path.exists(SHIM)),
                    reason="no claude binary / shim")
def test_coverage_report_runs_and_is_machine_readable():
    r = subprocess.run([sys.executable, SCRIPT, BIN, "--shim", SHIM,
                        "--node", NODE,
                        "--json"], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    import json
    doc = json.loads(r.stdout)
    assert "coverage" in doc and "missing" in doc["coverage"]


def test_detects_known_search_applets():
    blob = (b'OYr("find","bfs",["-S","dfs","-regextype","findutils-default"]),'
            b'OYr("grep","ugrep",["-G","--ignore-files"])')
    assert ins.search_applets(blob) == {"bfs", "ugrep"}

def test_flags_an_unknown_applet():
    blob = b'OYr("grep","ugrep",["-G"]),OYr("sk","skim",["--tac"])'
    assert ins.unknown_search_applets(ins.search_applets(blob)) == ["skim"]

def test_no_unknown_applets_for_the_known_set():
    blob = b'OYr("find","bfs",["-S"]),OYr("grep","ugrep",["-G"])'
    assert ins.unknown_search_applets(ins.search_applets(blob)) == []

def test_ignores_non_shadow_calls():
    # self-exec re-tags via argv0 (e.g. seccomp) and two-string calls whose args
    # array does NOT start with a flag must NOT be detected as applets.
    blob = b'argv0:"apply-seccomp";Qyd("apply-seccomp");Zz("arch","apply-seccomp",["amd64"])'
    assert ins.search_applets(blob) == set()

def test_ripgrep_lever_tracked():
    assert ins.ripgrep_lever_present(b'x USE_BUILTIN_RIPGREP y') is True
    assert ins.ripgrep_lever_present(b'no lever here') is False


def test_gate_problems_includes_unknown_applet():
    cov = {'stubbed': [], 'missing': [], 'bun_modules_unhandled': [],
           'modules_missing': [], 'search_applets_unknown': ['skim'],
           'ripgrep_lever_present': True}
    problems = ins.gate_problems(cov)
    assert 'skim (search applet unhandled)' in problems

def test_gate_problems_flags_missing_ripgrep_lever():
    cov = {'stubbed': [], 'missing': [], 'bun_modules_unhandled': [],
           'modules_missing': [], 'search_applets_unknown': [],
           'ripgrep_lever_present': False}
    problems = ins.gate_problems(cov)
    assert any('ripgrep' in p.lower() for p in problems)

def test_gate_problems_clean_for_known_applets_and_present_lever():
    cov = {'stubbed': [], 'missing': [], 'bun_modules_unhandled': [],
           'modules_missing': [], 'search_applets_unknown': [],
           'ripgrep_lever_present': True}
    assert ins.gate_problems(cov) == []


def test_unreviewed_externals_filters_accepted():
    assert ins.unreviewed_externals(['undici', 'esbuild']) == ['undici']
    assert ins.unreviewed_externals(['esbuild', 'react', 'typescript']) == []


def test_gate_problems_returns_unreviewed_items():
    # An unreviewed external AND an unreviewed stubbed Bun member both appear.
    cov_bad = {
        'stubbed': ['serve', 'newfeature'],   # 'serve' accepted, 'newfeature' not
        'missing': [],
        'bun_modules_unhandled': [],
        'modules_missing': ['undici', 'esbuild'],  # 'esbuild' accepted, 'undici' not
    }
    problems = ins.gate_problems(cov_bad)
    assert 'Bun.newfeature (stubbed)' in problems
    assert 'undici (external require MISSING)' in problems
    assert len(problems) == 2  # serve and esbuild are accepted

    # A cov whose only items are all on the accepted lists returns [].
    cov_clean = {
        'stubbed': list(ins.ACCEPTED_STUBBED_BUN),
        'missing': list(ins.ACCEPTED_MISSING_BUN),
        'bun_modules_unhandled': list(ins.ACCEPTED_BUN_MODULES),
        'modules_missing': list(ins.ACCEPTED_MISSING_EXTERNALS),
    }
    assert ins.gate_problems(cov_clean) == []


# Prefer build/2.1.185 if it exists, else fall back to the versioned user install.
_BUNDLE_185 = os.path.join(ROOT, 'build', '2.1.185', 'cli.cjs')
_STRICT_BIN = _BUNDLE_185 if os.path.exists(_BUNDLE_185) else BIN

@pytest.mark.skipif(not (os.path.exists(_STRICT_BIN) and os.path.exists(SHIM)),
                    reason="no bundle / shim for strict test")
def test_strict_gate_clean_on_known_good_bundle():
    """undici must appear as host-stub, not MISSING.  The full --strict gate
    must exit 0 (all items on reviewed allowlists).  We also verify via --json
    that undici is classified as host-stub rather than MISSING."""
    import json as _json
    # --json run to verify undici classification
    r_json = subprocess.run(
        [sys.executable, SCRIPT, _STRICT_BIN, "--shim", SHIM,
         "--node", NODE, "--json"],
        capture_output=True, text=True)
    assert r_json.returncode == 0, r_json.stderr
    doc = _json.loads(r_json.stdout)
    cov = doc.get("coverage", {})
    assert "undici" not in cov.get("modules_missing", []), \
        "undici still MISSING — host stub not active"
    assert "undici" in cov.get("modules_host_stub", []), \
        "undici not classified as host-stub"

    # --strict run: must exit 0 (clean gate on the known-good bundle)
    r_strict = subprocess.run(
        [sys.executable, SCRIPT, _STRICT_BIN, "--shim", SHIM,
         "--node", NODE, "--strict"],
        capture_output=True, text=True)
    assert r_strict.returncode == 0, \
        "--strict exited %d; unreviewed items:\n%s" % (r_strict.returncode, r_strict.stderr)


@pytest.mark.skipif(not os.path.exists(_STRICT_BIN),
                    reason="no bundle for strict test")
def test_strict_without_shim_is_an_error_not_a_silent_pass():
    r = subprocess.run(
        [sys.executable, SCRIPT, _STRICT_BIN, "--node", NODE, "--strict"],
        capture_output=True, text=True)
    assert r.returncode != 0, "--strict without --shim must not exit 0 (it would bypass the gate)"
    assert "shim" in (r.stderr + r.stdout).lower()
