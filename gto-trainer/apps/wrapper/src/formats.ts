/**
 * Table FORMATS: what we play, where it lives in the Ignition lobby, how to get there, and how to tell which one
 * is actually open. Port of formats.py (formats.json is the data, shared with the Python wrapper).
 *
 *   detect(port)          the format of the table the client has open right now (the table iframe's query
 *                         string), independent of anything the session DECLARED
 *   goto(fid, buyinBb)    drive the lobby wizard to the format's table and take a seat; every step verified
 *                         against the page before the next one runs; the step log comes back
 *   leave(port)           leave OUR table (header X -> YES)
 *
 * All page access is Runtime.evaluate on the client's top page (lobby and table are same-origin iframes).
 * Selectors are deliberately text-based: the client is an Angular app with hashed class names.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as cdp from "./cdp";
import { sleep, time } from "./clock";
import { paths } from "./env";
import { js } from "./js";
import { fmtFixed, pyFloat, pyFloatStr, pyInt, pyJsonDumps, pyRepr, pyReprStr, pyRound, pyStr, truthy } from "./py";

/** str() of a Python float that may be None. */
const fstr = (v: number | null | undefined) => (v === null || v === undefined ? "None" : pyFloatStr(v));
import * as tables from "./tables";

const formatsPath = () => join(paths().root, "formats.json");
const cache: { mtime: number; data: any } = { mtime: 0, data: null };

export function data(): any {
  const m = statSync(formatsPath()).mtimeMs;
  if (cache.data === null || m !== cache.mtime) {
    cache.mtime = m;
    cache.data = JSON.parse(readFileSync(formatsPath(), "utf8"));
  }
  return cache.data;
}

export function allFormats(): any[] {
  return [...data().formats];
}

export function get(fid: string | null | undefined): any | null {
  return fid ? (data().formats as any[]).find((f) => f.id === fid) ?? null : null;
}

/** NLxx enum for a real-money big blind in cents (null for practice chips / unknown). */
export function stakeForBb(bbCents: number | null | undefined): string | null {
  if (!bbCents) return null;
  for (const [k, v] of Object.entries(data().stakes)) {
    if (v && typeof v === "object" && !Array.isArray(v) && (v as any).bbCents === bbCents) return k;
  }
  return null;
}

export function formatIdFor(gameType: string, stake: string | null, seats: number | null): string | null {
  for (const f of data().formats as any[]) {
    if (f.gameType !== gameType) continue;
    if (gameType === "practice") {
      if (((f.path || {}).section ?? null) === (stake === "zone" ? "zone" : "ring")) return f.id;
      continue;
    }
    if (f.stake === stake && (f.seats === null || f.seats === seats)) return f.id;
  }
  return null;
}

// ----------------------------------------------------------------- page JS
export const LOBBY = () => js("formats.LOBBY");
const FRAME_FN = () => js("formats.FRAME_FN");

/** `code` with __FRAME__ defined and __SLOT__ bound to this table's slot. */
export function slotted(code: string, slot: number | null): string {
  return code.split("__FRAME__").join(FRAME_FN()).split("__SLOT__").join(slot === null ? "null" : String(Math.trunc(slot)));
}

export function tableJs(slot: number | null = null): string {
  return slotted(js("formats.TABLE_JS_TMPL"), slot);
}

/** The Ignition page THIS wrapper drives: ONE page for every table (never claimed away). */
export async function target(port: number): Promise<cdp.Target | null> {
  const rank = (u: string) => {
    const low = u.toLowerCase();
    return low.includes("poker-game") ? 1 : low.includes("ignition") ? 2 : null;
  };
  return tables.pin(await cdp.pageTargets(port), rank, null);
}

/** Runtime.evaluate with the page's exception surfaced. */
export const ev = (ws: string, code: string, timeoutS = 6.0) => cdp.evaluateStrict(ws, code, timeoutS);

/** Poll a JS expression until it is truthy; returns the value (or null on timeout). */
export async function wait(ws: string, code: string, secs: number, every = 0.35): Promise<any> {
  const end = time() + secs;
  while (time() < end) {
    let v: any;
    try {
      v = await ev(ws, code);
    } catch {
      v = null;
    }
    if (truthy(v)) return v;
    await sleep(every);
  }
  return null;
}

// ----------------------------------------------------------------- detect
const isDigits = (s: unknown) => /^\d+$/.test(String(s ?? ""));

/** Normalise the iframe params into the format vocabulary. */
export function describe(p: Record<string, any>) {
  const practice = p.playMode === "fun";
  const section: string = p.gameTableUrl || "";
  const zone = section.includes("zone") || String(p.gameFormat || "").toLowerCase().startsWith("zone");
  const gameType = practice ? "practice" : zone ? "zone" : "ring";
  let bb: number | null = isDigits(p.quickSeatBigBlind || "") && String(p.quickSeatBigBlind || "") !== "" ? pyInt(String(p.quickSeatBigBlind)) : null;
  let sb: number | null = isDigits(p.quickSeatSmallBlind || "") && String(p.quickSeatSmallBlind || "") !== "" ? pyInt(String(p.quickSeatSmallBlind)) : null;
  if (bb === null) {
    const m = /\$?([\d.,]+)\s*\/\s*\$?([\d.,]+)/.exec(p._title || "");
    if (m) {
      try {
        sb = Math.trunc(pyRound(pyFloat(m[1]!.replace(/,/g, "")) * 100));
        bb = Math.trunc(pyRound(pyFloat(m[2]!.replace(/,/g, "")) * 100));
      } catch {}
    }
  }
  const seats = isDigits(p.seat || "") && String(p.seat || "") !== "" ? pyInt(String(p.seat)) : null;
  const stake = practice ? null : stakeForBb(bb);
  const fid = formatIdFor(gameType, practice ? (zone ? "zone" : "ring") : stake, seats);
  const buyin = isDigits(p.quickSeatBuyInAmount || "") && String(p.quickSeatBuyInAmount || "") !== "" ? pyInt(String(p.quickSeatBuyInAmount)) : null;
  return {
    formatId: fid, site: "ignition", gameType, stake, seats,
    practice, sbCents: sb, bbCents: bb,
    buyInCents: buyin, buyInBb: buyin && bb ? pyRound(buyin / bb, 1) : null,
    waitForBigBlind: p.waitForBigBlind === "true", section,
    gameFormat: p.gameFormat ?? null, tableName: p.tableName || null, title: p._title ?? null,
    name: (get(fid) || {}).name || `${stake || (bb ? `${pyStr(sb)}/${bb}c` : "unknown stake")} ${gameType} ${seats || "?"}-max`,
  } as Record<string, any>;
}

export const MINE = Symbol("this wrapper's own slot");

/** Format of the table currently open in the client window, or null. `settle` keeps re-reading while the blinds
 *  are unknown; `slot` names another table than this wrapper's own. */
export async function detect(port: number, settle = 0.0, slot: number | null | typeof MINE = MINE): Promise<Record<string, any> | null> {
  const t = await target(port);
  if (!t) return null;
  const dom = slot === MINE ? tables.domSlot() : slot;
  const end = time() + settle;
  for (;;) {
    let p: any;
    try {
      p = await ev(t.webSocketDebuggerUrl!, tableJs(dom));
    } catch {
      return null;
    }
    const d = p && typeof p === "object" && !Array.isArray(p) ? describe(p) : null;
    if (d === null || d.bbCents || time() >= end) return d;
    await sleep(0.5);
  }
}

/** The guardrail verdict the panel badge shows. */
export function compare(declared: string | null | undefined, observed: Record<string, any> | null | undefined): Record<string, any> {
  if (!declared) return { state: "undeclared", text: "no format declared" };
  const d = get(declared);
  const dname = d ? d.name : declared;
  if (!observed || !Object.keys(observed).length) return { state: "unknown", text: `declared ${dname} · no table open yet` };
  if (observed.formatId === declared) return { state: "ok", text: observed.name };
  const gt = observed.gameType ?? null;
  if (!observed.bbCents && (gt === null || gt === ((d || {}).gameType ?? null))) {
    return { state: "unknown", text: `declared ${dname} · seated, stake not read yet` };
  }
  if (d && observed.gameType === d.gameType && observed.stake === d.stake && d.seats && observed.seats !== d.seats) {
    return { state: "warn", text: `seats: ${pyStr(observed.seats ?? null)}-max table, ${d.seats}-max declared`, observed: observed.name, declared: dname };
  }
  return { state: "warn", text: `off format: ${observed.name} (declared ${dname})`, observed: observed.name, declared: dname };
}

// ----------------------------------------------------------------- goto
const SECTION_LINK: Record<string, string> = { ring: "Cash games", zone: "Zone poker" };
const SECTION_HEAD: Record<string, string> = { ring: "Start Cash Game", zone: "Start Zone Game" };

export function jsClickText(sel: string, text: string): string {
  return LOBBY() + "if(!L) 'nolobby'; else { const e=[...L.querySelectorAll(" + pyJsonDumps(sel) + ")]"
    + ".filter(e=>(e.innerText||'').trim()===" + pyJsonDumps(text) + ").pop(); if(e) e.click(); !!e }";
}

export const SIGNED_OUT_JS = () => js("formats.SIGNED_OUT_JS");

export async function signedOut(ws: string): Promise<boolean> {
  try {
    return truthy(await ev(ws, SIGNED_OUT_JS(), 4.0));
  } catch {
    return false;
  }
}

/** Wait for the lobby, coming back at once if the window shows the sign-in form: 'lobby' | 'signed-out' | null. */
export async function waitLobby(ws: string, secs: number): Promise<"lobby" | "signed-out" | null> {
  const end = time() + secs;
  while (time() < end) {
    try {
      if (truthy(await ev(ws, LOBBY() + "!!L", 4.0))) return "lobby";
    } catch {}
    if (await signedOut(ws)) return "signed-out";
    await sleep(0.5);
  }
  return null;
}

async function closeModal(ws: string): Promise<void> {
  await ev(ws, LOBBY() + "(() => { const c=L && L.querySelector('button.close-btn'); if (c) c.click(); return !!c; })()");
}

export type Log = (m: string) => void;

/** Drive the lobby to `fid` and sit with `buyinBb` big blinds. {ok, steps, detected, slot, error?}. Refuses when
 *  a table is already open — UNLESS `adding` (a multi-table session's second, third and fourth seats). */
export async function goto(fid: string, buyinBb: number, port: number, waitForBb = true, log: Log = console.log,
                           adding = false): Promise<Record<string, any>> {
  const steps: string[] = [];
  try {
    return await gotoInner(fid, buyinBb, port, waitForBb, log, steps, adding);
  } catch (e: any) {
    log(`[goto] EXCEPTION: ${e?.message || e}`);
    return { ok: false, error: `${e?.name || "Error"}: ${e?.message || e}`, steps };
  }
}

async function gotoInner(fid: string, buyinBb: number, port: number, waitForBb: boolean, log: Log, steps: string[],
                         adding: boolean): Promise<Record<string, any>> {
  const say = (msg: string) => {
    try { log(msg); } catch {}
  };
  const step = (s: string) => {
    steps.push(s);
    say(`[goto] ${s}`);
  };
  const fail = (err: string, extra: Record<string, unknown> = {}) => {
    say(`[goto] FAILED: ${err}`);
    return { ok: false, error: err, steps, ...extra };
  };

  const f = get(fid);
  if (!f) return fail(`unknown format ${pyReprStr(String(fid))}`);
  const path = f.path;
  const t = await target(port);
  if (!t) return fail("table window not open (no Ignition page on CDP)");
  const ws = t.webSocketDebuggerUrl!;

  const before = new Set(await seatedSlots(port));
  const already = await detect(port);
  if (already && !adding) return fail(`a table is already open: ${already.name}`, { detected: already });
  if (adding) step(`adding a table — ${before.size} already seated (slots ${pyRepr([...before].sort((a, b) => a - b))})`);

  // 1. lobby section
  const section: string = path.section;
  if (!(await wait(ws, LOBBY() + "!!L", 8)) && String(((await target(port)) || {}).url || "").includes("/static/poker-game")) {
    step("client shell is up — waiting for the lobby to boot (no navigation)");
    const got = await waitLobby(ws, 75);
    if (got === "signed-out") return fail("signed out — the window shows the sign-in form", { signedOut: true });
    if (got !== "lobby") return fail("lobby did not boot inside the client shell");
  }
  if (!(await wait(ws, LOBBY() + "!!L", 8))) {
    if (adding) return fail("no lobby frame in the page — not navigating with tables already seated");
    const entry = data().lobby.entry || "https://www.ignitioncasino.uno/poker-lobby";
    await ev(ws, "location.href = " + pyJsonDumps(entry) + "; true");
    step(`no lobby in the window — navigated to the poker lobby entry (${entry})`);
    let got = await waitLobby(ws, 25);
    if (got === "signed-out") return fail("signed out — the window shows the sign-in form", { signedOut: true });
    if (got !== "lobby") {
      const client = data().lobby.client + String(data().lobby.sections[section]).split("/").join("%2F");
      await ev(ws, "location.href = " + pyJsonDumps(client) + "; true");
      step(`entry did not boot the lobby in 25 s — ${section} deep link`);
      got = await waitLobby(ws, 120);
      if (got === "signed-out") return fail("signed out — the window shows the sign-in form", { signedOut: true });
      if (got !== "lobby") return fail("lobby did not load");
    }
  }
  if (truthy(await ev(ws, LOBBY() + "!!(L && L.querySelector('button.close-btn') && /Select Stake/.test(L.body.innerText))"))) {
    await closeModal(ws);
    step("closed a Buy-In modal that was already open");
    await sleep(0.8);
  }
  let r = await ev(ws, jsClickText("a", SECTION_LINK[section]!));
  if (r !== true) return fail(`could not click ${pyReprStr(SECTION_LINK[section]!)} (${pyStr(r)})`);
  const head = SECTION_HEAD[section]!;
  if (!(await wait(ws, LOBBY() + "!!L && L.body.innerText.includes(" + pyJsonDumps(head) + ")", 25))) {
    return fail(`${pyReprStr(head)} did not appear`);
  }
  step(`${SECTION_LINK[section]} → ${head}`);

  // 2. wizard — set EVERY field (the wizard remembers the last choice per section)
  const wiz = data().lobby.wizard;
  for (const txt of [wiz.cardGame, wiz.limit]) await ev(ws, jsClickText("button,[role=button]", txt));
  const wantPractice = !!path.practice;
  const tog = await ev(ws, LOBBY() + "(() => { const lab = L.querySelector('.custom-toggle label'); if (!lab) return 'notoggle';"
    + " const on = /switch-btn-on/.test(lab.className); if (on !== " + pyJsonDumps(wantPractice) + ") lab.click();"
    + " return /switch-btn-on/.test(L.querySelector('.custom-toggle label').className); })()");
  if (tog !== wantPractice) return fail(`practice toggle would not settle (${pyStr(tog)})`);
  const seats = String(path.seats);
  const seatRes = await ev(ws, LOBBY() + "(() => { const b=[...L.querySelectorAll('button,[role=button]')].filter(e=>(e.innerText||'').trim()==="
    + pyJsonDumps(seats) + ").pop(); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click();"
    + " return /active/.test(b.className) ? 'active' : String(b.className); })()");
  if (seatRes !== "active") step(`seats ${seats}: ${pyStr(seatRes)} — continuing with the client's own choice`);
  step(`wizard: ${wiz.cardGame} · ${wiz.limit} · ${seats} seats · practice ${wantPractice ? "on" : "off"}`);
  let opened = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    r = await ev(ws, jsClickText("button", "NEXT"));
    if (r !== true) return fail("NEXT button not found");
    if (await wait(ws, LOBBY() + "!!L && L.body.innerText.includes('Select Stake')", attempt < 3 ? 8 : 12)) {
      opened = true;
      if (attempt) step(`Buy-In modal opened on NEXT press ${attempt + 1}`);
      break;
    }
    await sleep(1.5);
  }
  if (!opened) return fail("Buy-In modal did not open (NEXT pressed 4 times)");
  step("Buy-In modal open");

  // 3. stake
  let label: string = path.stakeLabel;
  await ev(ws, LOBBY() + "(() => { const s=[...L.querySelectorAll('span')].filter(e=>(e.innerText||'').trim()==='Select Stake').pop();"
    + " if (s) { s.click(); s.parentElement && s.parentElement.click(); } return !!s; })()");
  let li = await wait(ws, LOBBY() + "(() => { const li=[...L.querySelectorAll('li')].filter(e=>(e.innerText||'').trim()==="
    + pyJsonDumps(label) + ").pop(); if (li) { li.click(); return true; } return false; })()", 8);
  if (!truthy(li)) {
    const opts = await ev(ws, LOBBY() + "[...L.querySelectorAll('li')].map(e=>(e.innerText||'').trim()).filter(t=>/\\//.test(t)&&t.length<30)");
    const numeric = ((opts || []) as string[]).filter((o) => /^[\d.,]+\s*\/\s*[\d.,]+$/.test(o));
    if (wantPractice && numeric.length === 1) {
      li = await wait(ws, LOBBY() + "(() => { const li=[...L.querySelectorAll('li')].filter(e=>(e.innerText||'').trim()==="
        + pyJsonDumps(numeric[0]) + ").pop(); if (li) { li.click(); return true; } return false; })()", 8);
      if (truthy(li)) {
        step(`declared stake ${pyReprStr(label)} not offered; took the only practice stake there is, ${pyReprStr(numeric[0]!)}`);
        label = numeric[0]!;
      }
    }
    if (!truthy(li)) {
      await closeModal(ws);
      return fail(`no ${label} table right now (lobby offers ${pyRepr(opts)})`, { stakeMissing: true, offered: opts });
    }
  }
  const modal = await wait(ws, LOBBY() + "(() => { const t=L.body.innerText; return /TAKE MY SEAT/.test(t) ? t.slice(t.indexOf('Buy-In')) : null; })()", 8);
  if (!truthy(modal)) {
    await closeModal(ws);
    return fail("buy-in amount controls did not appear");
  }
  step(`stake ${label}`);

  // 4. amount — the OTHER input, in the modal's units (dollars, or practice chips)
  const mx = /MAXIMUM\s*\$?([\d,]+\.\d\d)/.exec(modal);
  const mn = /MINIMUM\s*\$?([\d,]+\.\d\d)/.exec(modal);
  const bbUnits = pyFloat(label.split("/")[1]!.trim().replace(/^\$+/, "").replace(/,/g, ""));
  const want = pyRound(pyFloat(buyinBb) * bbUnits, 2);
  const lo = mn ? pyFloat(mn[1]!.replace(/,/g, "")) : null;
  const hi = mx ? pyFloat(mx[1]!.replace(/,/g, "")) : null;
  let amount = hi !== null ? Math.min(want, hi) : want;
  if (lo !== null && amount < lo) amount = lo;
  if (amount !== want) step(`buy-in ${fmtFixed(want, 2)} clamped to the table's bounds ${fstr(lo)}–${fstr(hi)} → ${fmtFixed(amount, 2)}`);
  const amountS = fmtFixed(amount, 2);
  let setRes: any = null;
  if (hi !== null && amount >= hi) {
    setRes = await ev(ws, LOBBY() + "(() => { const b=[...L.querySelectorAll('button,[role=button]')].find(b => /^MAXIMUM/i.test((b.innerText||'').trim()));"
      + " if (!b) return 'nomax'; b.click(); const inp = L.querySelector('input[name=otherAmount], #small-input');"
      + " return inp ? inp.value : 'noinput'; })()");
    if (setRes === "nomax" || setRes === "noinput" || String(setRes || "").split(",").join("") !== amountS) {
      step(`MAXIMUM preset gave ${pyRepr(setRes)} — typing the amount instead`);
    } else {
      step("buy-in: MAXIMUM preset (full stack)");
    }
  }
  if (!(hi !== null && amount >= hi && String(setRes || "").split(",").join("") === amountS)) {
    setRes = await ev(ws, LOBBY() + "(() => {"
      + " let inp = L.querySelector('input[name=otherAmount], #small-input');"
      + " if (!inp) { const inputs=[...L.querySelectorAll('input[type=text]')].filter(i => /^[\\d,]*\\.?\\d*$/.test(i.value) && !/\\//.test(i.value)); inp = inputs[inputs.length-1]; }"
      + " if (!inp) return 'noinput';"
      + " const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;"
      + " inp.focus(); setter.call(inp, " + pyJsonDumps(amountS) + ");"
      + " inp.dispatchEvent(new Event('input', {bubbles:true})); inp.dispatchEvent(new Event('change', {bubbles:true})); inp.blur();"
      + " return inp.value; })()");
  }
  if (String(setRes || "").split(",").join("") !== amountS) {
    await closeModal(ws);
    return fail(`could not set the buy-in amount (${pyStr(setRes)})`);
  }
  await ev(ws, LOBBY() + "(() => { const cb=[...L.querySelectorAll('input[type=checkbox]')].filter(e=>/Wait for Big Blind/i.test(((e.closest('label')||e.parentElement).innerText||''))).pop();"
    + " if (cb && cb.checked !== " + pyJsonDumps(!!waitForBb) + ") cb.click(); return cb ? cb.checked : null; })()");
  const state = await ev(ws, LOBBY() + "(() => { const b=[...L.querySelectorAll('button')].filter(e=>/TAKE MY SEAT/i.test(e.innerText)).pop();"
    + " if (!b) return 'nobutton'; return b.disabled ? ('disabled: ' + (L.body.innerText.match(/Your available balance[^\\n]*/)||['balance or limit'])[0]) : 'ready'; })()");
  if (state !== "ready") {
    await closeModal(ws);
    return fail(`TAKE MY SEAT not available — ${pyStr(state)}`);
  }
  step(`buy-in ${amountS} (${fstr(buyinBb)} bb requested) · wait for BB ${waitForBb ? "on" : "off"}`);

  // 5. seat
  await ev(ws, LOBBY() + "(() => { const b=[...L.querySelectorAll('button')].filter(e=>/TAKE MY SEAT/i.test(e.innerText)).pop(); b.click(); return true; })()");
  let det: Record<string, any> | null = null;
  let newSlot: number | null = null;
  const end = time() + 25;
  while (time() < end) {
    if (adding) {
      const fresh = (await seatedSlots(port)).filter((x) => !before.has(x));
      if (fresh.length) {
        newSlot = fresh[0]!;
        det = await detect(port, 8, newSlot);
      }
    } else {
      det = await detect(port, 8);
    }
    if (det) break;
    await sleep(0.5);
  }
  if (!det) {
    return fail("seat taken but no table iframe appeared within 25 s"
      + (adding ? ` (slots before: ${pyRepr([...before].sort((a, b) => a - b))})` : ""));
  }
  if (!det.bbCents) {
    det = (await detect(port, 30, adding ? newSlot : MINE)) || det;
    if (!det!.bbCents) step("table title not rendered yet — stake unread (the router keeps re-reading)");
  }
  if (det!.buyInCents === null || det!.buyInCents === undefined) {
    det!.buyInCents = Math.trunc(pyRound(amount * 100));
    det!.buyInBb = bbUnits ? pyRound(amount / bbUnits, 1) : null;
    det!.buyInSource = "modal";
  } else {
    det!.buyInSource = "iframe";
  }
  const verdict = compare(fid, det);
  step(`seated${adding ? ` (table slot ${pyStr(newSlot)})` : ""}: ${det!.name} · ${fstr(det!.buyInBb)} bb · ${verdict.text}`);
  return { ok: true, steps, detected: det, verdict, slot: newSlot };
}

/** Leave OUR table: the header's close control (a real click), then YES — both inside OUR table's frame. */
export async function leave(port: number, log: Log = console.log, slot: number | null | typeof MINE = MINE): Promise<Record<string, any>> {
  const t = await target(port);
  if (!t) return { ok: false, error: "no table window" };
  const ws = t.webSocketDebuggerUrl!;
  const dom = slot === MINE ? tables.domSlot() : slot;
  if (!(await detect(port, 0, dom))) return { ok: true, note: "no table open" };
  const findX = slotted(String.raw`(() => {__FRAME__
      const f = __frame(__SLOT__);
      if (!f || !f.contentDocument) return null;
      const fr=f.getBoundingClientRect(); const d=f.contentDocument;
      const el = [...d.querySelectorAll('.iconItem.close')].find(e=>{const b=e.getBoundingClientRect(); return b.width>0 && b.height>0;});
      if (!el) return null; const b=el.getBoundingClientRect();
      return {x: Math.round(fr.x + b.x + b.width/2), y: Math.round(fr.y + b.y + b.height/2)}; })()`, dom);
  const clickYes = slotted(String.raw`(() => {__FRAME__
      const f = __frame(__SLOT__); try {
      const b=[...f.contentDocument.querySelectorAll('button')].filter(e=>(e.innerText||'').trim()==='YES').pop(); if (b) { b.click(); return true; } } catch(e) {} return false; })()`, dom);
  let yes: any = false;
  let spot = await wait(ws, findX, 12);
  for (let i = 0; i < 5; i++) {
    if (!truthy(spot)) break;
    const lk = await tables.pressLock();
    try {
      await cdp.dispatchClick(ws, spot.x, spot.y);
    } finally {
      lk.release();
    }
    yes = await wait(ws, clickYes, 4);
    if (truthy(yes)) break;
    spot = await ev(ws, findX);
  }
  if (!truthy(spot)) return { ok: false, error: "could not find the table close control" };
  if (!truthy(yes)) return { ok: false, error: "leave confirmation did not appear" };
  const end = time() + 10;
  while (time() < end && (await detect(port, 0, dom))) await sleep(0.4);
  const ok = (await detect(port, 0, dom)) === null;
  log(`[goto] left table: ${ok ? "True" : "False"}`);
  return { ok };
}

// ----------------------------------------------------------------- window state
/** closed | signed-out | signed-in | seated — the auth gate the setup page and the router wait on. */
export async function windowState(port: number): Promise<Record<string, any>> {
  if (!(await cdp.available(port))) return { state: "closed", cdp: false, url: null, detected: null };
  const t = await target(port);
  if (!t) {
    const pages = (await cdp.pageTargets(port)).map((p) => p.url || "");
    return { state: "closed", cdp: true, url: pages.length ? pages[0] : null, detected: null, note: "CDP up but no Ignition page" };
  }
  const url = t.url || "";
  if (url.includes("/login") || url.includes("originURL") || (await signedOut(t.webSocketDebuggerUrl!))) {
    return { state: "signed-out", cdp: true, url: url.split("?")[0], detected: null };
  }
  const det = await detect(port);
  if (det) return { state: "seated", cdp: true, url: url.split("?")[0], detected: det };
  return { state: "signed-in", cdp: true, url: url.split("?")[0], detected: null };
}

// ---- several tables in one client ----
export const SEATED_JS = () => js("formats.SEATED_JS");
export const LOBBY_BTN_JS = () => js("formats.LOBBY_BTN_JS");

/** Which table slots are seated right now, by the client's own numbering. */
export async function seatedSlots(port: number): Promise<number[]> {
  const t = await target(port);
  if (!t) return [];
  try {
    const raw = await ev(t.webSocketDebuggerUrl!, SEATED_JS(), 6);
    return raw ? [...(JSON.parse(raw).slots || [])] : [];
  } catch {
    return [];
  }
}

/** Bring the lobby forward from a seated table (a REAL mouse event on the top strip's Lobby control). */
export async function toLobby(port: number, log: Log = console.log): Promise<Record<string, any>> {
  const t = await target(port);
  if (!t) return { ok: false, error: "no table window" };
  const ws = t.webSocketDebuggerUrl!;
  let raw: any;
  try {
    raw = await ev(ws, LOBBY_BTN_JS(), 6);
  } catch (e: any) {
    return { ok: false, error: `could not look for the Lobby control: ${e?.message || e}` };
  }
  if (!raw) return { ok: false, error: "no Lobby control in the top strip" };
  const b = JSON.parse(raw);
  try {
    const lk = await tables.pressLock();
    try {
      await cdp.dispatchClick(ws, b.x, b.y);
    } finally {
      lk.release();
    }
  } catch (e: any) {
    return { ok: false, error: `clicking Lobby failed: ${e?.message || e}` };
  }
  log(`[seat] back to the lobby (Lobby at ${b.x},${b.y})`);
  await sleep(1.5);
  return { ok: true, at: [b.x, b.y] };
}
