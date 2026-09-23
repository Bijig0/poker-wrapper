"""Write every JS snippet constant of the Python wrapper to gto-trainer/apps/wrapper/src/js/<module>.<NAME>.js,
byte for byte (the TypeScript port loads them from there; the golden corpus checks the assembled scripts)."""
import contextlib, io, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
OUT = ROOT.parent / "gto-trainer" / "apps" / "wrapper" / "src" / "js"
with contextlib.redirect_stdout(io.StringIO()):
    import launch, formats, auth, balances
    from scout import cdp
NAMES = {
    launch: ["_EXTRACT_DEEP_JS", "_FRAME_JS", "_TABLE_JS_TMPL", "_WATCH_JS_TMPL", "_SITOUT_READ_JS_TMPL",
             "_FIND_INPUT_JS_TMPL", "_TOPUP_READ_JS_TMPL", "_TOPUP_FILL_JS_TMPL"],
    formats: ["_LOBBY", "_TABLE_JS_TMPL", "_FRAME_FN", "_SIGNED_OUT_JS", "_SEATED_JS", "_LOBBY_BTN_JS"],
    auth: ["_STATE_JS", "_SNAP_JS"],
    balances: ["_SCRAPE_JS", "_IN_PLAY_JS"],
    cdp: ["_EXTRACT_JS"],
}
OUT.mkdir(parents=True, exist_ok=True)
for mod, names in NAMES.items():
    for n in names:
        (OUT / f"{mod.__name__.split('.')[-1]}.{n.strip('_')}.js").write_bytes(getattr(mod, n).encode("utf-8"))
        print(f"{mod.__name__}.{n}: {len(getattr(mod, n))} chars")
