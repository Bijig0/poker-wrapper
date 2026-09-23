"""Is the connection good enough to get GTO Wizard answers in time?

WHY THIS EXISTS (2026-09-22). In session_20260922_194118 postflop answers took a
median 25 s (normal: 5-8 s), and two hands - pocket fives and T4s - got NO river
answer at all (45 s solver timeout, 42.5 s "hero had already acted"). The Wi-Fi
was fine: 82% signal, 1.6 ms to the router. The damage was past the router - the
Mullvad tunnel to Sydney ran ~290 ms round trips with 20-60% packet loss.

WHAT IS MEASURED, AND WHY THAT AND NOT WI-FI SIGNAL. GTO Wizard's API
(api.gtowizard.com) sits behind Cloudflare; from here it answers at the SYDNEY
edge, the same edge every answer's requests go through. An answer is a CHAIN of
10-30 requests in a row (tree create, solve create, then node fetches polled
every 400 ms), so the per-request cost is multiplied, and a lost packet costs a
TCP retransmit of a second or more EACH time. So the probe measures exactly that
path:
  * rtt  - TCP connect time to api.gtowizard.com:443 (one round trip to the edge)
  * loss - connects that did not complete in 1.5 s (a lost SYN)
  * warm - HTTPS requests on ONE kept-alive connection, like the chain makes them
           (edge round trip + the edge's trip to GTO Wizard's origin)

THE THRESHOLDS (see THRESHOLDS). Measured on the bad connection above: rtt 290-300
ms, loss 3-6 of 10, warm median 600 ms with spikes to 1.7-2.3 s -> answers 25 s.
Jakarta -> Sydney is ~100 ms on a clean tunnel, so a healthy link reads rtt
~100-150 ms and warm ~400 ms. The gate sits between the two, with room for an
ordinary evening: rtt <= 200 ms, at most 1 lost of 10, warm median <= 800 ms and
no warm request over 2 s. Every extra 100 ms of round trip adds roughly 1-3 s to
an answer; every lost packet adds a second or more - which is why loss is the
strictest of the four.

Every probe's numbers go into the session record, so the thresholds can be
re-fitted against real answer latencies once a few sessions carry both.
"""
from __future__ import annotations

import http.client
import socket
import ssl
import statistics
import time

HOST = "api.gtowizard.com"

THRESHOLDS = {
    "rttMs": 200,         # median TCP connect to the edge
    "lostOf10": 1,        # connects not completed in CONNECT_TIMEOUT_S
    "warmMedMs": 800,     # median kept-alive HTTPS request
    "warmMaxMs": 2000,    # worst kept-alive HTTPS request
}
CONNECT_TIMEOUT_S = 1.5
N_CONNECT = 10
N_WARM = 5


def _connects() -> tuple[list[float], int]:
    try:
        addr = socket.getaddrinfo(HOST, 443, socket.AF_INET, socket.SOCK_STREAM)[0][4]
    except Exception:
        return [], N_CONNECT
    ok: list[float] = []
    lost = 0
    for _ in range(N_CONNECT):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(CONNECT_TIMEOUT_S)
        t = time.perf_counter()
        try:
            s.connect(addr)
            ok.append((time.perf_counter() - t) * 1000)
        except Exception:
            lost += 1
        finally:
            s.close()
    return ok, lost


def _warm() -> tuple[list[float], str | None]:
    out: list[float] = []
    try:
        c = http.client.HTTPSConnection(HOST, 443, timeout=5, context=ssl.create_default_context())
        c.connect()
    except Exception as e:
        return out, f"could not open HTTPS to {HOST}: {e}"
    try:
        for _ in range(N_WARM):
            t = time.perf_counter()
            try:
                c.request("GET", "/", headers={"Connection": "keep-alive"})
                c.getresponse().read()
            except Exception as e:
                return out, f"request failed: {e}"
            out.append((time.perf_counter() - t) * 1000)
    finally:
        c.close()
    return out, None


def probe() -> dict:
    """One measurement + a verdict. Takes ~2-3 s on a healthy link, longer on a
    bad one (that is the point). Never raises."""
    t0 = time.time()
    conn, lost = _connects()
    warm, err = _warm()
    rtt = round(statistics.median(conn)) if conn else None
    wmed = round(statistics.median(warm)) if warm else None
    wmax = round(max(warm)) if warm else None
    lost10 = round(lost * 10 / N_CONNECT)
    why: list[str] = []
    if rtt is None:
        why.append(f"could not reach {HOST} at all")
    elif rtt > THRESHOLDS["rttMs"]:
        why.append(f"round trip {rtt} ms (max {THRESHOLDS['rttMs']})")
    if lost10 > THRESHOLDS["lostOf10"]:
        why.append(f"{lost10} of 10 packets lost (max {THRESHOLDS['lostOf10']})")
    if err:
        why.append(err)
    elif wmed is not None and wmed > THRESHOLDS["warmMedMs"]:
        why.append(f"GTO Wizard requests {wmed} ms (max {THRESHOLDS['warmMedMs']})")
    if wmax is not None and wmax > THRESHOLDS["warmMaxMs"]:
        why.append(f"a request stalled {wmax} ms (max {THRESHOLDS['warmMaxMs']})")
    ok = not why
    detail = (f"round trip {rtt} ms · {lost10}/10 lost · GTO Wizard request {wmed} ms (worst {wmax})"
              if rtt is not None else f"{HOST} unreachable")
    return {"ok": ok, "at": t0, "tookS": round(time.time() - t0, 1), "rttMs": rtt, "lostOf10": lost10,
            "warmMedMs": wmed, "warmMaxMs": wmax, "why": why,
            "detail": detail if ok else "TOO SLOW for answers: " + "; ".join(why)}


_cache: dict = {"at": 0.0, "res": None}


def cached(max_age_s: float = 20.0) -> dict:
    """probe(), memoised: the setup page polls preflight every few seconds and a
    probe is a few seconds of traffic itself."""
    if _cache["res"] is None or time.time() - _cache["at"] > max_age_s:
        _cache["res"] = probe()
        _cache["at"] = time.time()
    return _cache["res"]


if __name__ == "__main__":
    import json
    print(json.dumps(probe(), indent=2))
