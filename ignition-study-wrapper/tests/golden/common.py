"""Shared helpers for the golden recorder (tests/golden/record_*.py).

THE GOLDEN CORPUS (2026-09-24). The wrapper is being ported from Python to TypeScript
(gto-trainer/apps/wrapper). Before a line of it moved, these scripts replay recorded inputs through
the PYTHON modules and write down exactly what they produced; the TypeScript port replays the same
inputs and has to produce the same outputs (apps/wrapper/test/golden*.test.ts). A difference is a
porting bug by definition — the Python is the specification.

Determinism: every module under test reads the clock through `time`, so each recorder swaps the
module's `time` for FakeTime (the clock is whatever the recording says it was) and formats wall-clock
strings in UTC, never the machine's zone.

Normalisation (`norm`) turns Python-only shapes into plain JSON the other side can build too:
dict keys -> str (None -> "null", a tuple key -> its JSON), set -> list sorted by its JSON, tuple ->
list, NaN/±inf -> strings, dataclasses -> dicts.
"""
from __future__ import annotations

import calendar
import dataclasses
import gzip
import json
import math
import time as _real
from collections import deque
from pathlib import Path

GOLDEN = Path(__file__).resolve().parent / "corpus"


class FakeTime:
    """A drop-in for the `time` module, driven by the recording's own timestamps."""

    def __init__(self, now: float = 1_790_000_000.0):
        self.now = float(now)
        self.struct_time = _real.struct_time
        self.slept = 0.0

    def time(self) -> float:
        return self.now

    def perf_counter(self) -> float:
        return self.now

    def monotonic(self) -> float:
        return self.now

    def sleep(self, s: float) -> None:
        # never block a replay; the clock moves as if the wait happened
        self.slept += max(0.0, float(s))
        self.now += max(0.0, float(s))

    def gmtime(self, t=None):
        return _real.gmtime(self.now if t is None else t)

    localtime = gmtime          # wall-clock strings are UTC in a replay (machine-independent)

    def strftime(self, fmt: str, t=None) -> str:
        return _real.strftime(fmt, t if t is not None else _real.gmtime(self.now))

    def mktime(self, st) -> float:
        return float(calendar.timegm(st))

    def strptime(self, s, fmt):
        return _real.strptime(s, fmt)


def norm(x):
    if dataclasses.is_dataclass(x) and not isinstance(x, type):
        return norm(dataclasses.asdict(x))
    if isinstance(x, dict):
        out = {}
        for k, v in x.items():
            if k is None:
                key = "null"
            elif isinstance(k, bool):
                key = "true" if k else "false"
            elif isinstance(k, tuple):
                key = json.dumps(norm(list(k)), ensure_ascii=False)
            else:
                key = str(k)
            out[key] = norm(v)
        return out
    if isinstance(x, (set, frozenset)):
        items = [norm(v) for v in x]
        return sorted(items, key=lambda v: json.dumps(v, sort_keys=True, ensure_ascii=False))
    if isinstance(x, (list, tuple, deque)):
        return [norm(v) for v in x]
    if isinstance(x, float):
        if math.isnan(x):
            return "NaN"
        if math.isinf(x):
            return "Infinity" if x > 0 else "-Infinity"
        return x
    if x is None or isinstance(x, (bool, int, str)):
        return x
    return repr(x)


def dumps(x) -> str:
    return json.dumps(x, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class Writer:
    """One golden file: JSON lines, gzipped. `delta()` keeps only top-level keys that changed."""

    def __init__(self, name: str):
        GOLDEN.mkdir(parents=True, exist_ok=True)
        self.path = GOLDEN / f"{name}.jsonl.gz"
        self.fh = gzip.open(self.path, "wt", encoding="utf-8", compresslevel=9)
        self.prev: dict = {}
        self.n = 0

    def write(self, rec: dict) -> None:
        self.fh.write(dumps(rec) + "\n")
        self.n += 1

    def delta(self, snap: dict) -> dict:
        out = {}
        for k, v in snap.items():
            enc = dumps(v)
            if self.prev.get(k) != enc:
                out[k] = v
                self.prev[k] = enc
        return out

    def close(self) -> None:
        self.fh.close()
