"""Login PROFILES and the sign-in driver for the Ignition table window.

A profile is an account the study tool can sign in as: name, site, e-mail,
remember-me. The PASSWORD lives in Windows Credential Manager (keyring,
service "ignition-study-wrapper", username = profile name) — never in a file,
a session record, or a log line. The session config carries only the profile
NAME.

page_state(port)  what the table window's login flow is showing:
                  closed | login-form | code-form | captcha | error | signed-in | seated
login(name, port) fill e-mail + password from the profile, tick Remember Me,
                  click LOGIN, and report the state that follows.
submit_code(code) put the 6-digit Authy code into the one-time-code field and
                  submit it. The code is used once and dropped.

What is NOT automated: a visible reCAPTCHA challenge (the page carries an
invisible badge; if the site escalates to a picture challenge, the human
solves it in the real window) and the 6-digit code itself (typed by the human
into the setup page / panel each time, by design).
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import websocket
import keyring

from scout import cdp

ROOT = Path(__file__).resolve().parent
PROFILES = ROOT / "data" / "profiles.json"
SERVICE = "ignition-study-wrapper"


# ------------------------------------------------------------------ profiles

def _load() -> list[dict]:
    try:
        return json.loads(PROFILES.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save(rows: list[dict]) -> None:
    PROFILES.parent.mkdir(exist_ok=True)
    PROFILES.write_text(json.dumps(rows, indent=2), encoding="utf-8")


def _has_password(name: str) -> bool:
    try:
        return keyring.get_password(SERVICE, name) is not None
    except Exception:
        return False


def profiles() -> list[dict]:
    """Every profile, without its secret (a hasPassword flag instead)."""
    return [{**r, "hasPassword": _has_password(r["name"])} for r in _load()]


def get(name: str | None) -> dict | None:
    return next((r for r in _load() if r["name"] == name), None) if name else None


def save_profile(name: str, site: str, email: str, password: str | None, remember: bool = True, trust_device: bool = False) -> dict:
    name = (name or "").strip()
    if not name:
        raise ValueError("profile needs a name")
    rows = _load()
    row = next((r for r in rows if r["name"] == name), None)
    if row is None:
        row = {"name": name, "createdAt": int(time.time() * 1000)}
        rows.append(row)
    row.update({"site": site or "ignition", "email": (email or "").strip(), "rememberMe": bool(remember),
                "trustDevice": bool(trust_device), "updatedAt": int(time.time() * 1000)})
    if password:
        keyring.set_password(SERVICE, name, password)
    _save(rows)
    return {**row, "hasPassword": _has_password(name)}


def delete_profile(name: str) -> bool:
    rows = _load()
    keep = [r for r in rows if r["name"] != name]
    if len(keep) == len(rows):
        return False
    _save(keep)
    try:
        keyring.delete_password(SERVICE, name)
    except Exception:
        pass
    return True


# ------------------------------------------------------------------ CDP input

def _target(port: int) -> dict | None:
    for t in cdp.page_targets(port):
        u = (t.get("url") or "").lower()
        if "ignition" in u or "poker-game" in u:
            return t
    return None


def _cmds(ws_url: str, cmds: list[tuple[str, dict]], timeout: float = 6.0) -> list:
    """Run CDP commands in order on one socket; returns their results."""
    conn = websocket.create_connection(ws_url, timeout=timeout, suppress_origin=True)
    out = []
    try:
        for i, (method, params) in enumerate(cmds, start=1):
            conn.send(json.dumps({"id": i, "method": method, "params": params}))
            while True:
                m = json.loads(conn.recv())
                if m.get("id") == i:
                    out.append(m.get("result"))
                    break
    finally:
        conn.close()
    return out


def _eval(ws_url: str, js: str, timeout: float = 6.0):
    return cdp._eval(ws_url, js, timeout=timeout)


def _type_into(ws_url: str, selector_js: str, text: str) -> bool:
    """Focus the element `selector_js` evaluates to, clear it, and type `text`
    with real input events (Input.insertText) so the page's form binding sees
    it exactly as a keyboard would have produced it."""
    ok = _eval(ws_url, "(() => { const e = " + selector_js + "; if (!e) return false; e.focus(); e.select && e.select();"
               " const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(e, '');"
               " e.dispatchEvent(new Event('input', {bubbles: true})); return document.activeElement === e; })()")
    if not ok:
        return False
    _cmds(ws_url, [("Input.insertText", {"text": text})])
    got = _eval(ws_url, "(() => { const e = " + selector_js + "; return e ? e.value.length : -1; })()")
    if got != len(text):
        # fall back to the framework-friendly native setter
        _eval(ws_url, "(() => { const e = " + selector_js + "; if (!e) return; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;"
              " setter.call(e, " + json.dumps(text) + "); e.dispatchEvent(new Event('input', {bubbles: true})); e.dispatchEvent(new Event('change', {bubbles: true})); })()")
    return True


# ------------------------------------------------------------------ page state

_STATE_JS = r"""(() => {
  const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const path = location.pathname;
  const text = (document.body.innerText || '').replace(/\s+/g, ' ');
  const inputs = [...document.querySelectorAll('input')].filter(vis);
  const login = inputs.find(i => i.type === 'password') && inputs.find(i => i.type === 'email' || /user|email/i.test(i.name + i.id));
  // Ignition's 2FA step: a "LOGIN VERIFICATION" modal with input#code (type=number) drawn OVER the login form,
  // whose inputs stay in the DOM — so the code field takes precedence over the login form.
  const code = inputs.find(i => i.id === 'code' || i.name === 'code' || i.autocomplete === 'one-time-code'
                          || /otp|token|2fa|verif/i.test(i.name + ' ' + i.id + ' ' + i.placeholder)
                          || (i.maxLength > 0 && i.maxLength <= 8 && i.type !== 'password' && i.type !== 'checkbox' && i.type !== 'email'));
  const codeText = /verification code|6-digit code|authentication code|security code|one.time|two.factor|2FA|Authy|authenticator/i.test(text);
  const trust = inputs.find(i => i.type === 'checkbox' && /trust/i.test(i.name + i.id));
  const challenge = [...document.querySelectorAll('iframe')].some(f => /recaptcha.*bframe/.test(f.src || '') && vis(f) && f.getBoundingClientRect().width > 200);
  const errs = [...document.querySelectorAll('[role=alert], [class*=error], [class*=alert], [class*=invalid]')]
    .filter(vis).map(e => (e.innerText || '').trim().replace(/\s+/g, ' '))
    .filter(t => t && t.length > 3 && t.length < 200 && t !== 'PASTE' && !/enter the code to proceed|6-digit code\*?\s*(PASTE)?$/i.test(t) && !/^\s*6-digit code/i.test(t));
  const seated = [...document.querySelectorAll('iframe')].some(f => /playMode=/.test(f.getAttribute('src') || ''));
  const lobby = /poker-lobby|poker-game/.test(path) && !login;
  return { path, hasLogin: !!login, hasCode: !!code, codeText, challenge, errs: [...new Set(errs)].slice(0, 4), seated, lobby,
           trustField: trust ? { id: trust.id, checked: trust.checked } : null,
           codeField: code ? { name: code.name, id: code.id, ac: code.autocomplete, max: code.maxLength, type: code.type } : null,
           snippet: text.slice(0, 240) };
})()"""


def page_state(port: int) -> dict:
    if not cdp.available(port):
        return {"state": "closed", "detail": "no table window"}
    t = _target(port)
    if not t:
        return {"state": "closed", "detail": "CDP up, no Ignition page"}
    try:
        p = _eval(t["webSocketDebuggerUrl"], _STATE_JS) or {}
    except Exception as e:
        return {"state": "closed", "detail": f"page not answering: {e}"}
    base = {"path": p.get("path"), "codeField": p.get("codeField"), "trustField": p.get("trustField"), "errors": p.get("errs") or []}
    if p.get("seated"):
        return {"state": "seated", "detail": "table open", **base}
    if p.get("challenge"):
        return {"state": "captcha", "detail": "reCAPTCHA challenge is showing — solve it in the table window", **base}
    if p.get("hasCode"):
        errs = p.get("errs") or []
        return {"state": "code-form", "detail": "Authy code requested (LOGIN VERIFICATION)" + (" · " + " · ".join(errs) if errs else ""), **base}
    if p.get("hasLogin"):
        errs = p.get("errs") or []
        if errs:
            return {"state": "error", "detail": " · ".join(errs), **base}
        return {"state": "login-form", "detail": "e-mail + password form", **base}
    if p.get("lobby"):
        return {"state": "signed-in", "detail": "lobby / client up", **base}
    return {"state": "unknown", "detail": (p.get("snippet") or "")[:120], **base}


# ------------------------------------------------------------------ snapshots

SNAPS = ROOT / "data" / "auth_pages"
_SNAP_JS = r"""(() => {
  const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const inputs = [...document.querySelectorAll('input, select, textarea')].map(i => ({
    tag: i.tagName.toLowerCase(), type: i.type, id: i.id, name: i.name, placeholder: i.placeholder, autocomplete: i.autocomplete,
    maxLength: i.maxLength, visible: vis(i), checked: i.type === 'checkbox' ? i.checked : undefined,
    label: (i.labels && i.labels[0] ? i.labels[0].innerText : '').trim().slice(0, 60) }));
  const buttons = [...document.querySelectorAll('button, [role=button], input[type=submit], a.btn')].map(b => ({
    text: (b.innerText || b.value || '').trim().replace(/\s+/g, ' ').slice(0, 60), id: b.id, type: b.type, visible: vis(b) }));
  const iframes = [...document.querySelectorAll('iframe')].map(f => ({ src: (f.src || '').replace(/[?#].*$/, '').slice(0, 120), visible: vis(f) }));
  const text = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1500);
  return { url: location.href.replace(/[?#].*$/, ''), title: document.title, inputs, buttons, iframes, text };
})()"""


def snapshot(port: int, state: str, log=print) -> str | None:
    """Write a REDACTED description of the page the login flow is showing —
    input ids/types/labels, button labels, iframe hosts, visible text — never a
    field value, never a query string. One file per state per hour, so the
    selectors in _STATE_JS / login() / submit_code() can be checked against
    what Ignition actually renders without a live sign-in."""
    t = _target(port)
    if not t:
        return None
    try:
        p = _eval(t["webSocketDebuggerUrl"], _SNAP_JS) or {}
    except Exception as e:
        log(f"[auth] snapshot failed: {e}")
        return None
    SNAPS.mkdir(parents=True, exist_ok=True)
    name = f"{state}-{time.strftime('%Y%m%d-%H')}.json"
    out = SNAPS / name
    if out.exists():
        return str(out)
    out.write_text(json.dumps({"state": state, "at": time.strftime("%Y-%m-%d %H:%M:%S"), **p}, indent=1), encoding="utf-8")
    log(f"[auth] page snapshot ({state}) -> data/auth_pages/{name}")
    return str(out)


def snapshots() -> list[dict]:
    if not SNAPS.exists():
        return []
    rows = []
    for f in sorted(SNAPS.glob("*.json"), reverse=True)[:40]:
        try:
            j = json.loads(f.read_text(encoding="utf-8"))
            rows.append({"file": f.name, "state": j.get("state"), "at": j.get("at"), "url": j.get("url"),
                         "inputs": [f"{i.get('type')}#{i.get('id') or i.get('name') or '?'}" for i in j.get("inputs", []) if i.get("visible")],
                         "buttons": [b.get("text") for b in j.get("buttons", []) if b.get("visible") and b.get("text")]})
        except Exception:
            continue
    return rows


# ------------------------------------------------------------------ drive

def login(name: str, port: int, log=print, settle: float = 20.0) -> dict:
    """Sign in as profile `name`. Returns {ok, state, detail, steps}."""
    steps: list[str] = []

    def step(s: str):
        steps.append(s)
        log(f"[auth] {s}")

    prof = get(name)
    if not prof:
        return {"ok": False, "error": f"no profile {name!r}", "steps": steps}
    pw = None
    try:
        pw = keyring.get_password(SERVICE, name)
    except Exception as e:
        return {"ok": False, "error": f"credential store: {e}", "steps": steps}
    if not pw:
        return {"ok": False, "error": f"profile {name!r} has no stored password — set it on the setup page", "steps": steps}
    st = page_state(port)
    if st["state"] not in ("login-form", "error"):
        return {"ok": st["state"] in ("signed-in", "seated"), "state": st["state"], "detail": st["detail"], "steps": steps,
                "error": None if st["state"] in ("signed-in", "seated") else f"not on the login form ({st['state']})"}
    t = _target(port)
    ws = t["webSocketDebuggerUrl"]
    if not _type_into(ws, "document.querySelector('input[type=email], #username, input[name=username]')", prof.get("email") or ""):
        return {"ok": False, "error": "e-mail field not found", "steps": steps}
    if not _type_into(ws, "document.querySelector('input[type=password]')", pw):
        return {"ok": False, "error": "password field not found", "steps": steps}
    pw = None
    step(f"filled e-mail + password for {name}")
    _eval(ws, "(() => { const c = document.querySelector('#remember_me, input[name=remember_me]'); if (c && c.checked !== "
          + json.dumps(bool(prof.get("rememberMe", True))) + ") c.click(); return c ? c.checked : null; })()")
    clicked = _eval(ws, "(() => { const b = document.querySelector('#loginSubmit, button[type=submit]'); if (!b) return false; b.click(); return true; })()")
    if not clicked:
        return {"ok": False, "error": "LOGIN button not found", "steps": steps}
    step("LOGIN clicked")
    end = time.time() + settle
    last = st
    while time.time() < end:
        time.sleep(1.0)
        last = page_state(port)
        if last["state"] in ("signed-in", "seated", "code-form", "captcha", "error"):
            break
    step(f"→ {last['state']}: {last['detail']}")
    return {"ok": last["state"] in ("signed-in", "seated", "code-form"), "state": last["state"], "detail": last["detail"],
            "steps": steps, "codeField": last.get("codeField")}


def submit_code(code: str, port: int, log=print, settle: float = 20.0, trust_device: bool | None = None) -> dict:
    code = "".join(ch for ch in (code or "") if ch.isdigit())
    if len(code) < 4:
        return {"ok": False, "error": "code must be the digits from Authy"}
    st = page_state(port)
    if st["state"] != "code-form":
        return {"ok": False, "error": f"no code field on the page ({st['state']})", "state": st["state"]}
    t = _target(port)
    ws = t["webSocketDebuggerUrl"]
    sel = ("[...document.querySelectorAll('input')].find(i => i.getBoundingClientRect().width > 0 && (i.id === 'code' || i.name === 'code' || i.autocomplete === 'one-time-code'"
           " || /otp|token|2fa|verif/i.test(i.name + ' ' + i.id + ' ' + i.placeholder) || (i.maxLength > 0 && i.maxLength <= 8 && i.type !== 'password' && i.type !== 'checkbox' && i.type !== 'email')))")
    if not _type_into(ws, sel, code):
        return {"ok": False, "error": "could not type into the code field"}
    code = None
    if trust_device is not None:
        _eval(ws, "(() => { const c = document.querySelector('#trusted_device, input[name=trusted_device]'); if (c && c.checked !== "
              + json.dumps(bool(trust_device)) + ") c.click(); return c ? c.checked : null; })()")
    # The modal's own submit is the button reading CONTINUE. The page also has LOGIN (the form
    # underneath), "CAN'T ACCESS YOUR 2FA APP? RESET 2FA" and a cancel — none of those, ever.
    submitted = _eval(ws, "(() => { const bs = [...document.querySelectorAll('button')].filter(b => b.getBoundingClientRect().width > 0);"
                      " const b = bs.find(b => /^\\s*CONTINUE\\s*$/i.test(b.innerText || '')) || bs.find(b => /^\\s*(VERIFY|CONFIRM|SUBMIT)\\s*$/i.test(b.innerText || ''));"
                      " if (b) { b.click(); return 'button:' + b.innerText.trim(); } return null; })()")
    if not submitted:
        _cmds(ws, [("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13}),
                   ("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13})])
        submitted = "enter"
    log(f"[auth] code submitted via {submitted}")
    end = time.time() + settle
    last = st
    while time.time() < end:
        time.sleep(1.0)
        last = page_state(port)
        if last["state"] in ("signed-in", "seated", "error", "captcha"):
            break
        if last["state"] == "code-form" and last.get("errors"):
            break
    return {"ok": last["state"] in ("signed-in", "seated"), "state": last["state"], "detail": last["detail"], "errors": last.get("errors")}
