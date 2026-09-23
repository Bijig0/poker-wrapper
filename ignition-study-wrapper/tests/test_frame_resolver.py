"""Which iframe is MY table, whatever numbers the client tags them with.

    aof-model/.venv/Scripts/python.exe tests/test_frame_resolver.py

Ignition keeps up to four tables in ONE page as sibling iframes carrying
`data-multitableslot`. Every reader, every press and every leave resolves its own
frame through one snippet — `launch._FRAME_JS` — and this runs that exact
snippet, lifted out of the source, against DOM shapes the client might serve.

WHY IT IS AN ORDINAL AND NOT THE TAG'S VALUE. The resolver used to look the tag
up literally: slot 1 asked for `[data-multitableslot="0"]`. In the live session of
2026-09-21 the leader's lookup for 0 matched NOTHING while slot 2's lookup for 1
matched a table — whatever base that build tags from, it was not the one the fake
rig renders. The leader therefore had no frame, so no `seatQa`, so no hero seat,
so the tap could never identify its own socket: its panel read "no hand in
progress" for the whole session while slot 2 read fine. We never needed the
client's numbers, only its ORDER.

The snippet is JavaScript, so it is run in node against a ~40-line DOM shim —
the resolver only ever calls querySelectorAll and getAttribute. Running the real
string is the point: a Python re-implementation would be a second thing to keep
in step, which is precisely the failure mode here (there were FIVE copies of this
lookup in the tree when the bug was found).
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

FAILS: list[str] = []


def check(label: str, got, want) -> None:
    if got == want:
        print(f"  ok  {label}")
    else:
        FAILS.append(f"{label}: got {got!r}, want {want!r}")
        print(f"  FAIL {label}: got {got!r}, want {want!r}")


NODE = shutil.which("node") or shutil.which("node.exe")

# (id, data-multitableslot, is a table page). The lobby frame never carries
# playMode, so it must never be a candidate however it is tagged.
CASES: dict[str, list] = {
    "zero-based, 2 tables": [("lobby", "-1", False), ("t1", "0", True), ("t2", "1", True)],
    # what the live client did on 2026-09-21
    "one-based, 2 tables": [("lobby", "0", False), ("t1", "1", True), ("t2", "2", True)],
    "one table, no attribute at all": [("t1", None, True)],
    "4 tables, DOM order != tag order": [("t3", "2", True), ("t1", "0", True), ("t4", "3", True),
                                         ("lobby", "-1", False), ("t2", "1", True)],
    "tags with gaps in them": [("t1", "5", True), ("t2", "9", True)],
    "the lobby alone": [("lobby", "-1", False)],
}

SHIM = r"""
// The smallest DOM the resolver actually uses.
class El {
  constructor(id, tag, play) { this.id = id; this._tag = tag; this._play = play; }
  getAttribute(name) {
    if (name === 'data-multitableslot') return this._tag;
    if (name === 'src') return this._play ? ('x?playMode=real#' + this.id) : ('x#' + this.id);
    return null;
  }
}
const FRAMES = __FRAMES__.map(([id, tag, play]) => new El(id, tag, play));
globalThis.document = {
  querySelectorAll(sel) {
    if (sel !== 'iframe') throw new Error('the resolver asked for ' + sel);
    return FRAMES;
  },
};
__RESOLVER__
const out = __SLOTS__.map((s) => { const f = __frame(s); return f ? f.id : null; });
console.log(JSON.stringify(out));
"""


def resolver_js() -> str:
    src = (ROOT / "launch.py").read_text(encoding="utf-8")
    m = re.search(r'_FRAME_JS = r"""(.*?)"""', src, re.S)
    assert m, "could not lift _FRAME_JS out of launch.py"
    return m.group(1)


def resolve(frames: list, slots: list) -> list:
    js = (SHIM.replace("__FRAMES__", json.dumps([[i, t, p] for i, t, p in frames]))
             .replace("__RESOLVER__", resolver_js())
             .replace("__SLOTS__", json.dumps(slots)))
    with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False, encoding="utf-8") as f:
        f.write(js)
        path = f.name
    try:
        r = subprocess.run([NODE, path], capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            raise AssertionError(r.stderr.strip()[:400])
        return json.loads(r.stdout.strip().splitlines()[-1])
    finally:
        Path(path).unlink(missing_ok=True)


if not NODE:
    print("node not found — skipping (the resolver is JavaScript)")
    sys.exit(0)

print("the resolver takes the Nth table frame, in the client's own order")
# the tags differ; the answer must not
for label in ("zero-based, 2 tables", "one-based, 2 tables"):
    got = resolve(CASES[label], [0, 1, 2, None])
    check(f"{label}: 0,1 are the two tables; 2 is nothing; null is the first",
          got, ["t1", "t2", None, "t1"])

print("\nshapes the client might serve")
check("one untagged table: ordinal 0 is it",
      resolve(CASES["one table, no attribute at all"], [0, None]), ["t1", "t1"])
check("  ... and there is no second table to read",
      resolve(CASES["one table, no attribute at all"], [1]), [None])
check("four tables sort by their own tag, not by DOM order",
      resolve(CASES["4 tables, DOM order != tag order"], [0, 1, 2, 3, 4]),
      ["t1", "t2", "t3", "t4", None])
check("gaps in the numbering change nothing",
      resolve(CASES["tags with gaps in them"], [0, 1, 2]), ["t1", "t2", None])

print("\nthe lobby is never a table")
check("a page with only the lobby resolves to nothing",
      resolve(CASES["the lobby alone"], [0, 1, None]), [None, None, None])
check("  ... and it is skipped even when it sorts first",
      resolve(CASES["4 tables, DOM order != tag order"], [0]), ["t1"])

print("\nformats.py resolves through the same snippet, not a copy of it")
# there were FIVE copies of this lookup in the tree when the bug was found, and
# the one that mattered was the one nobody remembered was there
fmt = (ROOT / "formats.py").read_text(encoding="utf-8")
lch = (ROOT / "launch.py").read_text(encoding="utf-8")
m = re.search(r"_FRAME_FN = r\"\"\"(.*?)\"\"\"", fmt, re.S)
check("formats.py carries the identical resolver", bool(m) and m.group(1) == resolver_js(), True)
literal = [ln for f, txt in (("launch.py", lch), ("formats.py", fmt))
           for ln in txt.splitlines()
           if 'data-multitableslot="' in ln and "//" not in ln and "#" not in ln]
check("no literal [data-multitableslot=\"N\"] lookup is left anywhere", literal, [])

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: " + "; ".join(FAILS))
    sys.exit(1)
print("all passed")
