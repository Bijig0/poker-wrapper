"""Record every golden file (the Python wrapper is the specification the TypeScript port is checked against).

    aof-model/.venv/Scripts/python.exe tests/golden/record_all.py [reader|pure|cp ...]

Each reader scenario runs in its own process (launch.py is module-level state; a fresh import per scenario is
the only honest reset). Output: tests/golden/corpus/*.jsonl.gz and tests/golden/corpus/INDEX.json.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import GOLDEN  # noqa: E402

PY = sys.executable


def run(args: list[str]) -> tuple[list[str], int, str]:
    p = subprocess.run([PY, "-u", *args], capture_output=True, text=True, encoding="utf-8", errors="replace",
                       cwd=str(HERE.parent.parent))
    return args, p.returncode, (p.stdout + p.stderr).strip()


def main() -> int:
    want = set(sys.argv[1:]) or {"reader", "pure", "cp"}
    jobs: list[list[str]] = []
    if "reader" in want:
        import record_reader
        jobs += [[str(HERE / "record_reader.py"), name] for name in record_reader.SCENARIOS]
    if "pure" in want:
        jobs.append([str(HERE / "record_pure.py")])
    if "cp" in want:
        jobs.append([str(HERE / "record_cp.py")])
    t0 = time.time()
    bad = 0
    with ThreadPoolExecutor(max_workers=6) as ex:
        for args, code, out in ex.map(run, jobs):
            tail = out.splitlines()[-1] if out else ""
            print(f"{'ok ' if code == 0 else 'ERR'} {Path(args[0]).stem} {' '.join(args[1:])}: {tail[:160]}")
            if code:
                bad += 1
                print(out[-2000:])
    files = sorted(p.name for p in GOLDEN.glob("*.jsonl.gz"))
    (GOLDEN / "INDEX.json").write_text(json.dumps({"recordedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
                                                   "files": files}, indent=1), encoding="utf-8")
    total = sum(p.stat().st_size for p in GOLDEN.glob("*.jsonl.gz"))
    print(f"{len(files)} golden files, {total // 1024} KB, {time.time() - t0:.0f} s, {bad} failed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
