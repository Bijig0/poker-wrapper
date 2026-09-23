"""Press buttons on a CoinPoker table (the Unity window) — and prove it happened.

CoinPoker tables are a separate Unity program. Measured 2026-09-22 on practice
tables (client 1.26.0, table build 1.2.191):

- Messages POSTED to the window (PostMessage WM_LBUTTONDOWN/UP) are ignored —
  Unity reads raw input. Only real input works: SendInput with the table in the
  foreground. So every press briefly takes focus + the cursor and gives both back.
- There is no DOM: the buttons are found at fixed positions in the table's
  client area (measured at 1600x1170, scaled to the live size) and CHECKED BY OCR
  before any click — the target button must carry the expected word, and a bet
  box must read back the intended amount, or nothing is pressed. (A click that
  first closed an open menu once dropped a 50% preset and bet the minimum.)
- The press is CONFIRMED from CoinPoker's own log (cpfeed): hero's action must
  appear in the hand within a few seconds, with the right amount.

AUTO-EXECUTE IS PRACTICE-ONLY. `act(..., auto=True)` refuses unless the server
said the table is practice chips (roomProperties.coinType == 2). A table whose
type is unknown is treated as real money. A real-money press needs a person to
ask for it (auto=False) — the tool never plays a real-money table by itself.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as W
import re
import threading
import time

import psutil
from PIL import Image, ImageOps

user32, gdi32 = ctypes.windll.user32, ctypes.windll.gdi32
try:  # physical pixels on every monitor (the Zenbook mixes 200% and 100%)
    user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    pass

REF_W, REF_H = 1600, 1170
# client-area positions at REF size (centre points / crop boxes)
POS = {
    "fold": (1052, 1113), "call": (1270, 1113), "raise": (1490, 1113),
    "p33": (997, 1021), "p50": (1079, 1021), "p75": (1160, 1021), "max": (1241, 1021),
    "amount": (1367, 1021),
    "menu": (50, 1023), "sitout_next": (388, 958), "sitout_all": (388, 1012),
}
BOX = {
    "fold": (952, 1068, 1152, 1160), "call": (1172, 1068, 1370, 1160),
    "raise": (1390, 1068, 1590, 1165), "amount": (1300, 995, 1440, 1050),
    "menu_items": (104, 870, 420, 1045),
}
# the word each button must show before we press it
# Bet and Raise are the same button (it reads "Bet" unopened, "Raise" facing a bet);
# a GTO Wizard pick says RAISE for both, so the verb is not what is checked — the
# typed amount read back from the box and the button is.
LABEL = {"fold": ("fold",), "check": ("check",), "call": ("call",),
         "bet": ("bet", "raise", "all"), "raise": ("bet", "raise", "all"),
         "allin": ("all", "raise", "bet")}
BUTTON_OF = {"fold": "fold", "check": "call", "call": "call",
             "bet": "raise", "raise": "raise", "allin": "raise"}

_press_lock = threading.Lock()
_last_press: dict = {}


# ---- window + capture -------------------------------------------------------

def table_window(room: str) -> int | None:
    """The Unity window for this room: the CoinPoker.exe started with
    roomName=<room> (each table is its own process)."""
    pid = None
    for p in psutil.process_iter(["name", "cmdline"]):
        try:
            if (p.info["name"] or "").lower() != "coinpoker.exe":
                continue
            if any(a == f"roomName={room}" for a in p.info["cmdline"] or []):
                pid = p.pid
                break
        except (psutil.Error, TypeError):
            continue
    if pid is None:
        return None
    found = []
    proto = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)

    def cb(h, _):
        q = W.DWORD()
        user32.GetWindowThreadProcessId(h, ctypes.byref(q))
        if q.value == pid and user32.IsWindowVisible(h):
            found.append(h)
        return 1
    user32.EnumWindows(proto(cb), 0)
    return found[0] if found else None


def client_rect(h: int) -> tuple[int, int, int, int]:
    r = W.RECT()
    user32.GetClientRect(h, ctypes.byref(r))
    pt = W.POINT(0, 0)
    user32.ClientToScreen(h, ctypes.byref(pt))
    return pt.x, pt.y, r.right, r.bottom


def _scale(h: int) -> tuple[float, float]:
    _, _, w, hh = client_rect(h)
    return w / REF_W, hh / REF_H


def capture(h: int) -> Image.Image:
    """The table's client area (PrintWindow full-content: works while covered)."""
    _, _, w, hgt = client_rect(h)
    hdc = user32.GetDC(h)
    mdc = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, hgt)
    gdi32.SelectObject(mdc, bmp)
    user32.PrintWindow(h, mdc, 3)          # PW_CLIENTONLY | PW_RENDERFULLCONTENT

    class BMI(ctypes.Structure):
        _fields_ = [("biSize", W.DWORD), ("biWidth", W.LONG), ("biHeight", W.LONG),
                    ("biPlanes", W.WORD), ("biBitCount", W.WORD), ("biCompression", W.DWORD),
                    ("biSizeImage", W.DWORD), ("biXPelsPerMeter", W.LONG),
                    ("biYPelsPerMeter", W.LONG), ("biClrUsed", W.DWORD), ("biClrImportant", W.DWORD)]
    bmi = BMI(biSize=ctypes.sizeof(BMI), biWidth=w, biHeight=-hgt, biPlanes=1, biBitCount=32)
    buf = ctypes.create_string_buffer(w * hgt * 4)
    gdi32.GetDIBits(mdc, bmp, 0, hgt, buf, ctypes.byref(bmi), 0)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mdc)
    user32.ReleaseDC(h, hdc)
    return Image.frombuffer("RGBA", (w, hgt), buf, "raw", "BGRA", 0, 1).convert("RGB")


def ocr(img: Image.Image, key: str) -> str:
    import winocr
    sx, sy = img.width / REF_W, img.height / REF_H
    x0, y0, x1, y1 = BOX[key]
    crop = img.crop((int(x0 * sx), int(y0 * sy), int(x1 * sx), int(y1 * sy)))
    g = ImageOps.autocontrast(ImageOps.grayscale(crop))
    g = g.resize((g.width * 2, g.height * 2))
    res = winocr.recognize_pil_sync(g, "en")
    return " ".join(line["text"] for line in res.get("lines", [])).strip()


def parse_amount(text: str) -> float | None:
    """'2,000' / '0.25' / '1.18M' / 'Raise 4,000' -> number."""
    m = re.search(r"(\d[\d,]*(?:\.\d+)?)\s*([KkMm])?", text or "")
    if not m:
        return None
    v = float(m.group(1).replace(",", ""))
    return v * {"k": 1e3, "m": 1e6}.get((m.group(2) or "").lower(), 1)


# ---- real input ---------------------------------------------------------------

class _MI(ctypes.Structure):
    _fields_ = [("dx", W.LONG), ("dy", W.LONG), ("mouseData", W.DWORD), ("dwFlags", W.DWORD),
                ("time", W.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class _KI(ctypes.Structure):
    _fields_ = [("wVk", W.WORD), ("wScan", W.WORD), ("dwFlags", W.DWORD),
                ("time", W.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class _IN(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [("mi", _MI), ("ki", _KI), ("pad", ctypes.c_byte * 32)]
    _anonymous_ = ("u",)
    _fields_ = [("type", W.DWORD), ("u", _U)]


def _send(inp: _IN) -> None:
    user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(_IN))


class Focus:
    """Take the foreground + cursor for the table, give both back on exit."""

    def __init__(self, h: int):
        self.h = h

    def __enter__(self):
        self.old = W.POINT()
        user32.GetCursorPos(ctypes.byref(self.old))
        self.prev = user32.GetForegroundWindow()
        user32.ShowWindow(self.h, 9) if user32.IsIconic(self.h) else None
        user32.SetForegroundWindow(self.h)
        time.sleep(0.15)
        return self

    def click(self, key: str) -> None:
        cx, cy, _, _ = client_rect(self.h)
        sx, sy = _scale(self.h)
        x, y = POS[key]
        user32.SetCursorPos(cx + int(x * sx), cy + int(y * sy))
        time.sleep(0.06)
        for f in (0x0002, 0x0004):                     # LEFTDOWN, LEFTUP
            i = _IN(type=0)
            i.mi = _MI(0, 0, 0, f, 0, None)
            _send(i)
            time.sleep(0.05)

    def key(self, vk: int, up: bool = False) -> None:
        i = _IN(type=1)
        i.ki = _KI(vk, 0, 0x0002 if up else 0, 0, None)
        _send(i)

    def type(self, text: str) -> None:
        for ch in text:
            for up in (False, True):
                i = _IN(type=1)
                i.ki = _KI(0, ord(ch), 0x0004 | (0x0002 if up else 0), 0, None)  # UNICODE
                _send(i)
            time.sleep(0.02)

    def select_all(self) -> None:
        self.key(0x11); self.key(0x41); self.key(0x41, True); self.key(0x11, True)  # ctrl+a

    def __exit__(self, *exc):
        time.sleep(0.05)
        user32.SetCursorPos(self.old.x, self.old.y)
        if self.prev and self.prev != self.h:
            user32.SetForegroundWindow(self.prev)
        return False


# ---- actions ------------------------------------------------------------------

def _fmt(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".") if v != int(v) else str(int(v))


def act(room, get_hand, action: str, amount: float | None = None, *, auto: bool = False,
        confirm_s: float = 4.0) -> dict:
    """Press one action for hero at `room` (a cpfeed.Room).

    get_hand() -> the current ParsedHand export for that room (read fresh; the
    feed thread keeps it live). amount = the bet/raise TOTAL in table chips.
    Returns {ok, ...} — ok only when the log shows hero's action."""
    action = action.lower()
    if action not in LABEL:
        return {"ok": False, "why": f"unknown action {action!r}"}
    if auto and not room.practice:
        return {"ok": False, "why": "auto-execute is practice-only — this table is "
                + ("REAL MONEY (coinType 1)" if room.coin_type == 1 else
                   f"of unknown type (coinType {room.coin_type!r})")}
    if not _press_lock.acquire(blocking=False):
        return {"ok": False, "why": "another press is in progress"}
    try:
        h = get_hand()
        if not h or h.get("ended"):
            return {"ok": False, "why": "no live hand"}
        node = h["currentNode"]
        if not node.get("toActIsHero"):
            return {"ok": False, "why": f"not hero's turn ({h.get('notToActWhy')})"}
        key = (h["clientHandId"], h["street"], len(h["actions"]))
        if _last_press.get("key") == key:
            return {"ok": False, "why": "already pressed for this decision"}
        to_call = node.get("toCall") or 0
        if action == "check" and to_call > 0:
            return {"ok": False, "why": f"cannot check: {to_call} bb to call"}
        if action == "call" and to_call <= 0:
            return {"ok": False, "why": "nothing to call — use check"}
        if action in ("bet", "raise") and not amount:
            return {"ok": False, "why": "bet/raise needs an amount (the total, in table chips)"}
        if action == "allin" and not amount:
            # never press Raise unsized: the box then holds the MINIMUM, not the stack
            return {"ok": False, "why": "all-in needs hero's total (stack + street bet) to verify the Max preset against"}
        hw = table_window(room.name)
        if not hw:
            return {"ok": False, "why": "table window not found"}
        button = BUTTON_OF[action]
        n0 = len(h["actions"])
        t0 = time.time()
        with Focus(hw) as f:
            img = capture(hw)
            if action in ("bet", "raise"):
                f.click("amount")
                time.sleep(0.12)
                f.select_all()
                f.type(_fmt(amount))
                time.sleep(0.35)
                img = capture(hw)
                box = parse_amount(ocr(img, "amount"))
                if box is None or abs(box - amount) > max(0.011, amount * 0.005):
                    return {"ok": False, "why": f"amount box reads {box!r}, wanted {amount} — not pressed",
                            "boxText": ocr(img, "amount")}
            elif action == "allin":
                f.click("max")
                time.sleep(0.35)
                img = capture(hw)
                box = parse_amount(ocr(img, "amount"))
                if box is None or abs(box - amount) > max(0.011, amount * 0.01):
                    return {"ok": False, "why": f"Max put {box!r} in the box, hero's all-in is {amount} — not pressed",
                            "boxText": ocr(img, "amount")}
            label = ocr(img, button)
            if not any(w in label.lower() for w in LABEL[action]):
                return {"ok": False, "why": f"button reads {label!r}, expected {LABEL[action]} — not pressed"}
            h2 = get_hand()   # still our turn, same decision?
            if not h2 or not h2["currentNode"].get("toActIsHero") or len(h2["actions"]) != n0:
                return {"ok": False, "why": "the spot changed before the press — not pressed"}
            f.click(button)
            pressed_at = time.time()
        _last_press.update(key=key, at=pressed_at, action=action)
        # confirmation: hero's action in CoinPoker's own log
        while time.time() - pressed_at < confirm_s:
            h3 = get_hand()
            mine = [a for a in (h3 or {}).get("actions", [])[n0:] if a.get("hero")] if h3 and h3["clientHandId"] == key[0] else []
            if mine:
                a = mine[0]
                return {"ok": True, "action": a, "label": label, "pressMs": round((pressed_at - t0) * 1000),
                        "confirmMs": round((time.time() - pressed_at) * 1000), "practice": room.practice}
            time.sleep(0.08)
        return {"ok": False, "why": f"pressed {label!r} but the log shows no hero action within {confirm_s}s",
                "pressed": True}
    finally:
        _press_lock.release()


def set_sitout(room, want: bool, which: str = "sitOutNextHand", confirm_s: float = 4.0) -> dict:
    """Tick/untick 'Sit Out Next Hand' (or 'Sit Out All') and confirm from the
    server's sitOutMap echo. Table chores are allowed on any table."""
    key = {"sitOutNextHand": "sitout_next", "sitOutAll": "sitout_all"}[which]
    if bool(room.sitout.get(which)) == want:
        return {"ok": True, "already": True, which: want}
    hw = table_window(room.name)
    if not hw:
        return {"ok": False, "why": "table window not found"}
    if not _press_lock.acquire(timeout=5):
        return {"ok": False, "why": "another press is in progress"}
    try:
        with Focus(hw) as f:
            f.click("menu")
            time.sleep(0.6)
            items = ocr(capture(hw), "menu_items").lower()
            if "sit out" not in items:
                f.click("menu")      # close whatever opened
                return {"ok": False, "why": f"menu did not open as expected ({items!r}) — not pressed"}
            # re-read right before the toggle: the SERVER also flips this box
            # (a timed-out seat gets sitOutNextHand=true) — seen 220 ms before a
            # press, which then toggled it back off
            if bool(room.sitout.get(which)) == want:
                f.click("menu")
                return {"ok": True, "already": True, which: want}
            f.click(key)
            time.sleep(0.3)
            f.click("menu")          # close the menu again
        t = time.time()
        while time.time() - t < confirm_s:
            if bool(room.sitout.get(which)) == want:
                return {"ok": True, which: want, "confirmMs": round((time.time() - t) * 1000)}
            time.sleep(0.08)
        return {"ok": False, "why": "clicked, but the server never echoed the new sit-out state", "pressed": True}
    finally:
        _press_lock.release()
