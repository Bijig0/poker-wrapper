/**
 * Login PROFILES and the sign-in driver for the Ignition table window. Port of auth.py.
 *
 * A profile is an account the study tool can sign in as: name, site, e-mail, remember-me. The PASSWORD lives in
 * Windows Credential Manager — under python-keyring's exact scheme (service "ignition-study-wrapper", the profile
 * name as the user; see keyringGet), so a password saved by the Python wrapper is read by this one — never in a
 * file, a session record, or a log line. The session config carries only the profile NAME.
 *
 * NOT automated: a visible reCAPTCHA challenge (the human solves it in the real window) and the 6-digit code itself
 * (typed by the human into the setup page / panel each time, by design).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as cdp from "./cdp";
import { nowMs, sleep, strftime, time } from "./clock";
import { paths } from "./env";
import { js } from "./js";
import { pyJsonDumps, pyReprStr, truthy } from "./py";
import * as W from "./win32";

const profilesPath = () => join(paths().data, "profiles.json");
export const SERVICE = "ignition-study-wrapper";

// ------------------------------------------------------------------ keyring (python-keyring's WinVaultKeyring)
/** Swappable for tests (the trace goldens use an in-memory store). */
export const keyring = {
  get: (service: string, user: string): string | null => {
    let c = W.credRead(service);
    if (!c || (user && c.userName !== user)) c = W.credRead(`${user}@${service}`);
    return c ? W.decodeBlob(c.blob) : null;
  },
  set: (service: string, user: string, password: string): void => {
    const existing = W.credRead(service);
    if (existing) W.credWrite(`${existing.userName}@${service}`, existing.userName, existing.blob);
    W.credWrite(service, user, W.utf16le(String(password)));
  },
  delete: (service: string, user: string): void => {
    let deleted = false;
    for (const t of [service, `${user}@${service}`]) {
      const c = W.credRead(t);
      if (c && c.userName === user) {
        deleted = true;
        W.credDelete(t);
      }
    }
    if (!deleted) throw new Error(`PasswordDeleteError: ${service}`);
  },
};

// ------------------------------------------------------------------ profiles
function load(): any[] {
  try {
    return JSON.parse(readFileSync(profilesPath(), "utf8"));
  } catch {
    return [];
  }
}

function save(rows: any[]): void {
  mkdirSync(paths().data, { recursive: true });
  writeFileSync(profilesPath(), pyJsonDumps(rows, { indent: 2 }), "utf8");
}

function hasPassword(name: string): boolean {
  try {
    return keyring.get(SERVICE, name) !== null;
  } catch {
    return false;
  }
}

/** Every profile, without its secret (a hasPassword flag instead). */
export function profiles(): any[] {
  return load().map((r) => ({ ...r, hasPassword: hasPassword(r.name) }));
}

export function get(name: string | null | undefined): any | null {
  return name ? load().find((r) => r.name === name) ?? null : null;
}

export function saveProfile(name: unknown, site: unknown, email: unknown, password: string | null, remember = true, trustDevice = false) {
  const n = String(name || "").trim();
  if (!n) throw new Error("profile needs a name");
  const rows = load();
  let row = rows.find((r) => r.name === n);
  if (!row) {
    row = { name: n, createdAt: nowMs() };
    rows.push(row);
  }
  Object.assign(row, { site: site || "ignition", email: String(email || "").trim(), rememberMe: !!remember,
                       trustDevice: !!trustDevice, updatedAt: nowMs() });
  if (password) keyring.set(SERVICE, n, password);
  save(rows);
  return { ...row, hasPassword: hasPassword(n) };
}

export function deleteProfile(name: string): boolean {
  const rows = load();
  const keep = rows.filter((r) => r.name !== name);
  if (keep.length === rows.length) return false;
  save(keep);
  try {
    keyring.delete(SERVICE, name);
  } catch {}
  return true;
}

// ------------------------------------------------------------------ CDP input
export async function target(port: number): Promise<cdp.Target | null> {
  for (const t of await cdp.pageTargets(port)) {
    const u = (t.url || "").toLowerCase();
    if (u.includes("ignition") || u.includes("poker-game")) return t;
  }
  return null;
}

export const cmds = cdp.commands;
const ev = (ws: string, code: string, timeoutS = 6.0) => cdp.evaluate(ws, code, timeoutS);

/** Focus the element, clear it, type `text` with real input events (Input.insertText). */
async function typeInto(ws: string, selectorJs: string, text: string): Promise<boolean> {
  const ok = await ev(ws, "(() => { const e = " + selectorJs + "; if (!e) return false; e.focus(); e.select && e.select();"
    + " const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(e, '');"
    + " e.dispatchEvent(new Event('input', {bubbles: true})); return document.activeElement === e; })()");
  if (!truthy(ok)) return false;
  await cmds(ws, [["Input.insertText", { text }]]);
  const got = await ev(ws, "(() => { const e = " + selectorJs + "; return e ? e.value.length : -1; })()");
  if (got !== text.length) {
    await ev(ws, "(() => { const e = " + selectorJs + "; if (!e) return; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;"
      + " setter.call(e, " + pyJsonDumps(text) + "); e.dispatchEvent(new Event('input', {bubbles: true})); e.dispatchEvent(new Event('change', {bubbles: true})); })()");
  }
  return true;
}

// ------------------------------------------------------------------ page state
export const STATE_JS = () => js("auth.STATE_JS");

export async function pageState(port: number): Promise<Record<string, any>> {
  if (!(await cdp.available(port))) return { state: "closed", detail: "no table window" };
  const t = await target(port);
  if (!t) return { state: "closed", detail: "CDP up, no Ignition page" };
  let p: any;
  try {
    p = (await ev(t.webSocketDebuggerUrl!, STATE_JS())) || {};
  } catch (e: any) {
    return { state: "closed", detail: `page not answering: ${e?.message || e}` };
  }
  const base = { path: p.path ?? null, codeField: p.codeField ?? null, trustField: p.trustField ?? null, errors: p.errs || [] };
  if (p.seated) return { state: "seated", detail: "table open", ...base };
  if (p.challenge) return { state: "captcha", detail: "reCAPTCHA challenge is showing — solve it in the table window", ...base };
  if (p.hasCode) {
    const errs: string[] = p.errs || [];
    return { state: "code-form", detail: "Authy code requested (LOGIN VERIFICATION)" + (errs.length ? " · " + errs.join(" · ") : ""), ...base };
  }
  if (p.hasLogin) {
    const errs: string[] = p.errs || [];
    if (errs.length) return { state: "error", detail: errs.join(" · "), ...base };
    return { state: "login-form", detail: "e-mail + password form", ...base };
  }
  if (p.lobby) return { state: "signed-in", detail: "lobby / client up", ...base };
  return { state: "unknown", detail: String(p.snippet || "").slice(0, 120), ...base };
}

// ------------------------------------------------------------------ snapshots
const snapsDir = () => join(paths().data, "auth_pages");
export const SNAP_JS = () => js("auth.SNAP_JS");

/** A REDACTED description of the page the login flow is showing — never a field value, never a query string. */
export async function snapshot(port: number, state: string, log: (m: string) => void = console.log): Promise<string | null> {
  const t = await target(port);
  if (!t) return null;
  let p: any;
  try {
    p = (await ev(t.webSocketDebuggerUrl!, SNAP_JS())) || {};
  } catch (e: any) {
    log(`[auth] snapshot failed: ${e?.message || e}`);
    return null;
  }
  mkdirSync(snapsDir(), { recursive: true });
  const name = `${state}-${strftime("%Y%m%d-%H")}.json`;
  const out = join(snapsDir(), name);
  if (existsSync(out)) return out;
  writeFileSync(out, pyJsonDumps({ state, at: strftime("%Y-%m-%d %H:%M:%S"), ...p }, { indent: 1 }), "utf8");
  log(`[auth] page snapshot (${state}) -> data/auth_pages/${name}`);
  return out;
}

export function snapshots(): any[] {
  if (!existsSync(snapsDir())) return [];
  const rows: any[] = [];
  const files = readdirSync(snapsDir()).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, 40);
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(snapsDir(), f), "utf8"));
      rows.push({
        file: f, state: j.state ?? null, at: j.at ?? null, url: j.url ?? null,
        inputs: (j.inputs || []).filter((i: any) => i.visible).map((i: any) => `${i.type ?? "None"}#${i.id || i.name || "?"}`),
        buttons: (j.buttons || []).filter((b: any) => b.visible && b.text).map((b: any) => b.text),
      });
    } catch {}
  }
  return rows;
}

// ------------------------------------------------------------------ drive
export async function login(name: string, port: number, log: (m: string) => void = console.log, settle = 20.0): Promise<Record<string, any>> {
  const steps: string[] = [];
  const step = (s: string) => {
    steps.push(s);
    log(`[auth] ${s}`);
  };
  const prof = get(name);
  if (!prof) return { ok: false, error: `no profile ${pyReprStr(String(name))}`, steps };
  let pw: string | null = null;
  try {
    pw = keyring.get(SERVICE, name);
  } catch (e: any) {
    return { ok: false, error: `credential store: ${e?.message || e}`, steps };
  }
  if (!pw) return { ok: false, error: `profile ${pyReprStr(String(name))} has no stored password — set it on the setup page`, steps };
  const st = await pageState(port);
  if (st.state !== "login-form" && st.state !== "error") {
    const fine = st.state === "signed-in" || st.state === "seated";
    return { ok: fine, state: st.state, detail: st.detail, steps, error: fine ? null : `not on the login form (${st.state})` };
  }
  const t = await target(port);
  const ws = t!.webSocketDebuggerUrl!;
  for (let i = 0; i < 6; i++) {
    if (!((await pageState(port)).errors || []).length) break;
    await sleep(0.5);
  }
  const emailSel = "document.querySelector('input[type=email], #username, input[name=username]')";
  const pwSel = "document.querySelector('input[type=password]')";
  const email: string = prof.email || "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await typeInto(ws, emailSel, email))) return { ok: false, error: "e-mail field not found", steps };
    if (!(await typeInto(ws, pwSel, pw!))) return { ok: false, error: "password field not found", steps };
    await sleep(0.4);
    const got = (await ev(ws, "(() => { const e = " + emailSel + ", p = " + pwSel + "; return [e ? e.value.length : -1, p ? p.value.length : -1]; })()")) || [-1, -1];
    if (got[0] === email.length && got[1] === pw!.length) break;
    step(attempt === 0 ? `fields read back ${got[0]}/${email.length} and ${got[1]}/${pw!.length} chars - retyping`
                       : `fields still short after retyping (${got[0]}, ${got[1]} chars)`);
  }
  pw = null;
  step(`filled e-mail + password for ${name}`);
  await ev(ws, "(() => { const c = document.querySelector('#remember_me, input[name=remember_me]'); if (c && c.checked !== "
    + pyJsonDumps("rememberMe" in prof ? !!prof.rememberMe : true) + ") c.click(); return c ? c.checked : null; })()");
  const clicked = await ev(ws, "(() => { const b = document.querySelector('#loginSubmit, button[type=submit]'); if (!b) return false; b.click(); return true; })()");
  if (!truthy(clicked)) return { ok: false, error: "LOGIN button not found", steps };
  step("LOGIN clicked");
  const end = time() + settle;
  let last: Record<string, any> = st;
  while (time() < end) {
    await sleep(1.0);
    last = await pageState(port);
    if (["signed-in", "seated", "code-form", "captcha", "error"].includes(last.state)) break;
  }
  step(`→ ${last.state}: ${last.detail}`);
  return { ok: ["signed-in", "seated", "code-form"].includes(last.state), state: last.state, detail: last.detail,
           steps, codeField: last.codeField ?? null };
}

export async function submitCode(code: string, port: number, log: (m: string) => void = console.log, settle = 20.0,
                                 trustDevice: boolean | null = null): Promise<Record<string, any>> {
  let digits: string | null = [...String(code || "")].filter((ch) => /\d/.test(ch)).join("");
  if (digits.length < 4) return { ok: false, error: "code must be the digits from Authy" };
  const st = await pageState(port);
  if (st.state !== "code-form") return { ok: false, error: `no code field on the page (${st.state})`, state: st.state };
  const t = await target(port);
  const ws = t!.webSocketDebuggerUrl!;
  const sel = "[...document.querySelectorAll('input')].find(i => i.getBoundingClientRect().width > 0 && (i.id === 'code' || i.name === 'code' || i.autocomplete === 'one-time-code'"
    + " || /otp|token|2fa|verif/i.test(i.name + ' ' + i.id + ' ' + i.placeholder) || (i.maxLength > 0 && i.maxLength <= 8 && i.type !== 'password' && i.type !== 'checkbox' && i.type !== 'email')))";
  if (!(await typeInto(ws, sel, digits))) return { ok: false, error: "could not type into the code field" };
  digits = null;
  if (trustDevice !== null) {
    await ev(ws, "(() => { const c = document.querySelector('#trusted_device, input[name=trusted_device]'); if (c && c.checked !== "
      + pyJsonDumps(!!trustDevice) + ") c.click(); return c ? c.checked : null; })()");
  }
  let submitted: any = await ev(ws, "(() => { const bs = [...document.querySelectorAll('button')].filter(b => b.getBoundingClientRect().width > 0);"
    + " const b = bs.find(b => /^\\s*CONTINUE\\s*$/i.test(b.innerText || '')) || bs.find(b => /^\\s*(VERIFY|CONFIRM|SUBMIT)\\s*$/i.test(b.innerText || ''));"
    + " if (b) { b.click(); return 'button:' + b.innerText.trim(); } return null; })()");
  if (!truthy(submitted)) {
    await cmds(ws, [["Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }],
                    ["Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }]]);
    submitted = "enter";
  }
  log(`[auth] code submitted via ${submitted}`);
  const end = time() + settle;
  let last: Record<string, any> = st;
  while (time() < end) {
    await sleep(1.0);
    last = await pageState(port);
    if (["signed-in", "seated", "error", "captcha"].includes(last.state)) break;
    if (last.state === "code-form" && (last.errors || []).length) break;
  }
  return { ok: last.state === "signed-in" || last.state === "seated", state: last.state, detail: last.detail, errors: last.errors ?? null };
}
