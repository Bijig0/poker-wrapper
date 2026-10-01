/**
 * DECLARED SESSIONS — launch.py's session layer: start / join / leave / end, the table ROUTER (auth gate → the
 * declared format → watch), the answer chain keeper, several tables in one session, the fake-table test mode,
 * stand-down, and packaged-install updates.
 *
 * A session is declared ONCE, on the leader's setup page; every other live table joins it. A follower never
 * writes a session record, never takes a balance reading and never ends anything — and never signs in or drives
 * the lobby: its router only watches (followSession).
 */
import { spawn } from "node:child_process";
import * as W from "./win32";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as A from "./auth";
import * as BAL from "./balances";
import * as cdp from "./cdp";
import { nowMs, sleep, time } from "./clock";
import { C, profileDir } from "./config";
import { REPO } from "./env";
import * as F from "./formats";
import { feedAdd, log } from "./feed";
import { fetchBytes, fetchJson, getJson, postJson } from "./http";
import { pyFloat, pyInt, pyRepr, pyRound, pyStr, truthy } from "./py";
import * as SES from "./sessions";
import { CGG, CP, S, TupleSet, inAHand, isCgg, isClientSite, isCp, seams } from "./state";
import * as TABLES from "./tables";
import * as faketable from "./faketable";
import { SITE as CP_SITE, FORMATS as CP_FORMATS } from "./sites/coinpoker";
import { SITE as CGG_SITE, FORMATS as CGG_FORMATS, Site as CggSite, dirBytes, label as cggLabel, recordingDir as cggRecordingDir } from "./sites/clubgg";
import { archiveHand, sessionHands } from "./archive";
import { setDebug } from "./ignition/recorder";
import { forgetFrame, mySel, slotted, unpinnedTableIssue } from "./ignition/dom";
import { setAuto } from "./relay";
import { applyLayout, chromeWindow, closeBrowser, killProfileWindows, leaderHwnd, otherArea, panelHwnd, targetArea } from "./windows";
import { chartsUrl, livePort, port } from "../../api/src/services/ports";

const layout = () => applyLayout(seams.ignitionTarget);

/** The lobby call a test replaces (Python's tests stubbed formats.leave). */
export const sessionSeams = {
  leave: (port: number) => F.leave(port),
  // a table lost the poker server: close the client so it cannot reconnect (maybeEndForDisconnect)
  closeClient: async (): Promise<string> => {
    if (await closeBrowser(C.CDP_PORT)) return "closed (Browser.close)";
    return (await killProfileWindows(C.PROFILE_TABLE)) ? "closed (its processes stopped)" : "no client was open";
  },
  // a table that is not the leader tells the leader, which owns the session
  tellLeader: (body: Record<string, any>) => postJson(`http://127.0.0.1:${TABLES.leaderPort()}/session/disconnected`, body, 20),
  // a table whose connection check failed tells the leader, which ends the session (maybeEndForNetDrop)
  tellLeaderNetDrop: (body: Record<string, any>) => postJson(`http://127.0.0.1:${TABLES.leaderPort()}/session/net-drop`, body, 20),
  // the site closed a table under its wrapper: the leader seats a new one (maybeReseatAfterSiteClose → sessionTableClosed)
  tellLeaderTableClosed: (body: Record<string, any>) => postJson(`http://127.0.0.1:${TABLES.leaderPort()}/session/table-closed`, body, 20),
  hands: (sid: string) => sessionHands(sid),
  join: (body: Record<string, any>) => sessionJoin(body),
  // this wrapper's panel window: found / opened. Inert under bun test — a unit test must never pop a window.
  panelWindow: (): number | null => (process.env.NODE_ENV === "test" ? null : panelHwnd()),
  openWindow: (url: string, profile: string, x: number, y: number, w: number, h: number): number | null =>
    (process.env.NODE_ENV === "test" ? null : chromeWindow(url, profile, x, y, w, h)),
};
const later = (s: number, f: () => unknown) => setTimeout(() => { Promise.resolve().then(f).catch((e) => log(`[bg] ${e?.message ?? e}`)); }, s * 1000);

// ---- the answer chain, kept connected for the session ----------------------------------------------------
export async function apiPost(path: string, body: unknown = null, timeoutS = 5.0): Promise<Record<string, any>> {
  try {
    const r = await fetchJson(`${SES.API()}${path}`, { body: body || {}, timeoutS });
    if (r.status >= 400) return { ok: false, error: `HTTP Error ${r.status}: ${r.statusText}` };
    return r.json ?? {};
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** Point the poller here and get GTO Wizard connected — never twice at once, one launch attempt per 2 min. */
export async function ensureAnswerChain(reason: string): Promise<void> {
  const pub = C.PANEL_PUBLIC_URL || `http://127.0.0.1:${C.PANEL_PORT}`;
  // the session's GTO Wizard allowlist rides every start (the keeper re-posts it), so the API's pool mirrors the session
  const gtowAccounts = (S.session.rec?.config as any)?.gtowAccounts ?? null;
  const r = await apiPost("/api/study-poller/start", { assistiveUrl: pub, gtowAccounts });
  if (!("ok" in (r || {}) ? r.ok : true)) log(`[chain] poller start: ${pyRepr(r)}`);
  const reg = await SES.fetchRegistry();
  const g = ((reg || {}).armed || {}).gtow || {};
  if (g.tokenLive && ("multiwayLive" in g ? g.multiwayLive : true)) return;
  if (S.chain.attempting || time() - S.chain.lastAt < 120) return;
  S.chain.attempting = true;
  S.chain.lastAt = time();
  log(`[chain] GTO Wizard ${g.tokenLive ? "has no multiway session" : "not connected"} (${reason}) — connecting`);
  const res = await apiPost("/api/dashboard/gtow-connect", {}, 95);
  S.chain.attempting = false;
  S.chain.lastResult = { at: time(), connected: !!(res || {}).connected, text: (res || {}).text || (res || {}).hint || (res || {}).error || null };
  log(`[chain] connect -> ${pyRepr(S.chain.lastResult)}`);
}

export async function chainKeeper(): Promise<void> {
  for (;;) {
    await sleep(20);
    try {
      const rec = S.session.rec;
      if (rec && (rec.config || {}).answers) await ensureAnswerChain("keeper");
    } catch (e: any) {
      log(`[chain] keeper: ${e?.message ?? e}`);
    }
  }
}

// ---- the table router ---------------------------------------------------------------------------------------
export function routerSet(state: string, text: string, steps: string[] | null = null): void {
  const changed = state !== S.router.state || text !== S.router.text;
  Object.assign(S.router, { state, text, at: time() });
  if (steps !== null) S.router.steps = [...steps];
  if (changed) log(`[router] ${state}: ${text}`);
}

function routerSeats(have: number, want: number, leader = true): void {
  S.router.seats = { have: Math.max(0, Math.trunc(have)), want: Math.max(1, Math.trunc(want)), leader: !!leader };
}

export function tablesClosed(): Set<number> {
  const out = new Set(S.closedTables);
  for (const e of (S.session.rec || {}).events || []) {
    if (e.kind === "table-closed" && (e.data || {}).slot) out.add(pyInt(e.data.slot));
  }
  return out;
}

export function tablesWanted(cfg: Record<string, any>): number {
  let declared = 1;
  try {
    declared = pyInt(cfg.tables || 1);
  } catch {
    declared = 1;
  }
  return Math.max(1, declared - tablesClosed().size);
}

function nextUnclosedSlot(cfg: Record<string, any>): number {
  let declared = 1;
  try {
    declared = pyInt(cfg.tables || 1);
  } catch {
    declared = 1;
  }
  const closed = tablesClosed();
  for (let k = Math.min(declared, TABLES.MAX_TABLES); k > 1; k--) if (!closed.has(k)) return k;
  return declared;
}

/** How long the leader keeps a site's close waiting for the seat count to drop — past it the count never fell (the
 *  client kept the frame, or moved hero itself) and the note must not turn a later close by hand into a re-seat. */
export const SITE_CLOSE_WINDOW_S = 120;
/** A close-by-hand verdict this young is undone by a site's notice arriving for the same drop (the router's pass and
 *  the other table's POST race; the notice is a few seconds behind the count at most). */
export const HONOUR_UNDO_S = 30;

/** The site's closes the leader has yet to match to a seat-count drop, stale ones dropped. */
function siteClosesPending(): number[] {
  const now = time();
  S.siteClosed.pending = S.siteClosed.pending.filter((t) => now - t <= SITE_CLOSE_WINDOW_S);
  return S.siteClosed.pending;
}

/** A table that went away AFTER we had them all was closed on purpose: honour it — unless the site closed it under
 *  its wrapper (siteClosesPending, one per table gone): that one is asked for again, not given up. */
export function honourClosedTables(cfg: Record<string, any>, seatedNow: number): number {
  let want = tablesWanted(cfg);
  const reached = S.seating.reached || 0;
  if (!reached || seatedNow >= reached) return want;
  const gone = reached - seatedNow;
  S.seating.reached = seatedNow;
  const pending = siteClosesPending();
  const bySite = Math.min(gone, pending.length);
  S.siteClosed.pending = pending.slice(bySite);
  if (bySite) {
    feedAdd(`${bySite === 1 ? "A table" : `${bySite} tables`} closed by the site — seating ${bySite === 1 ? "a new one" : "new ones"} (the session still wants ${want})`);
    log(`[tables] seated count fell to ${seatedNow}: ${bySite} closed by the site — re-seating, wanted stays ${want}`);
    if (S.session.id) S.sessions.event(S.session.id, "table-reseat", { bySite, seatedNow, want });
  }
  const byHand = gone - bySite;
  if (!byHand) return want;
  const slots: number[] = [];
  for (let i = 0; i < byHand; i++) {
    const k = nextUnclosedSlot(cfg);
    S.closedTables.add(k);
    slots.push(k);
  }
  S.siteClosed.lastHonour = { at: time(), slots };
  want = tablesWanted(cfg);
  feedAdd(`A table was closed — not re-seating it (the session now wants ${want})`);
  log(`[tables] seated count fell to ${seatedNow}; honouring it, wanted is now ${want}`);
  if (S.session.id) S.sessions.event(S.session.id, "table-closed", { slot: null, why: "closed by hand" });
  return want;
}

/** THE LEADER LEARNS THE SITE CLOSED A TABLE (its own, from the reader; another's, over /session/table-closed): the
 *  next seat-count drop is not a close by hand (honourClosedTables) — and a drop the router already took for one in the
 *  last HONOUR_UNDO_S is given back. */
export function noteSiteClosePending(slotN: number | null, why: string): void {
  const h = S.siteClosed.lastHonour;
  if (h.slots.length && time() - h.at <= HONOUR_UNDO_S) {
    const k = h.slots.pop()!;
    S.closedTables.delete(k);
    const want = tablesWanted((S.session.rec || {}).config || {});
    feedAdd(`Table ${pyStr(slotN ?? 1)} was closed by the site, not by hand — asking for it back (the session wants ${want})`);
    log(`[tables] the drop taken as table ${k} closed by hand ${pyRound(time() - h.at, 1)} s ago was the site's close of table ${pyStr(slotN)} (${why}) — wanted is ${want} again`);
    return;
  }
  siteClosesPending().push(time());
  log(`[tables] the site closed table ${pyStr(slotN ?? 1)} (${why}) — the next seat-count drop is not a close by hand; a new table is seated`);
}

type SeatFns = { count: () => Promise<number[]>; toLobby: () => Promise<Record<string, any>>; goto: () => Promise<Record<string, any>> };

/** Take ONE more seat, if fewer than `want` tables are seated (the leader's job alone). */
export async function seatNextTable(fid: string, cfg: Record<string, any>, want: number, fns: SeatFns | null = null): Promise<Record<string, any>> {
  const stepLog = (prefix: string) => (m: string) => { S.router.steps.push(m.replace(prefix, "")); log(m); };
  const f: SeatFns = fns || {
    count: () => F.seatedSlots(C.CDP_PORT),
    toLobby: () => F.toLobby(C.CDP_PORT, stepLog("[seat] ")),
    goto: () => F.goto(fid, Number(cfg.buyinBb || 100), C.CDP_PORT, cfg.waitForBb !== false, stepLog("[goto] "), true),
  };
  const have = await f.count();
  if (have.length >= want) return { done: true, have: have.length };
  const seat = have.length + 1;
  const back = await f.toLobby();
  if (!back.ok) log(`[seat] table ${seat}: could not raise the lobby (${pyStr(back.error ?? null)}) — trying the seat anyway`);
  const res = await f.goto();
  const now = await f.count();
  if (res.ok && now.length > have.length) {
    return { done: now.length >= want, ok: true, have: now.length, seat, detected: res.detected ?? null,
             text: `table ${now.length} of ${want} seated` };
  }
  return { done: false, ok: false, have: have.length, seat, error: res.error || "the seat did not take", steps: res.steps ?? null,
           text: `table ${seat} of ${want}: ${res.error || "the seat did not take"}` };
}

/** The session's table keeper: auth gate → route to the declared format → watch, for the life of the session. */
async function routeSession(cfg: Record<string, any>, sid: string): Promise<void> {
  const gen = ++S.router.generation;
  const fid: string | null = cfg.format ?? null;
  const profile: string | null = cfg.profile ?? null;
  if (S.fakeMode) {
    routerSet("idle", "test rig — no routing");
    return;
  }
  const f = fid ? F.get(fid) : null;
  if (fid && !f) {
    routerSet("failed", `unknown format ${fid}`);
    return;
  }
  Object.assign(S.router, { format: fid, cancel: false, loginAt: 0.0, loginTries: 0 });
  let seatedByUs = false;
  let wasSignedOut = false;
  const alive = () => !S.router.cancel && S.router.generation === gen && S.session.id === sid;
  const stepLog = (prefix: string) => (m: string) => { S.router.steps.push(m.replace(prefix, "")); log(m); };
  while (alive()) {
    // ---- 1. the auth gate: the window, then sign-in
    const st = await F.windowState(C.CDP_PORT);
    if (st.state === "closed") {
      routerSet("waiting-window", "waiting for the table window");
      await sleep(2);
      continue;
    }
    if (st.state === "signed-out") {
      wasSignedOut = true;
      const a = await A.pageState(C.CDP_PORT);
      if (["login-form", "code-form", "error", "captcha"].includes(a.state) && a.state !== S.router.snapState) {
        S.router.snapState = a.state;
        try {
          await A.snapshot(C.CDP_PORT, a.state);
        } catch (e: any) {
          log(`[auth] snapshot: ${e?.message ?? e}`);
        }
      }
      if (a.state === "code-form") {
        if (S.router.state !== "waiting-code") S.sessions.event(sid, "code-needed", {});
        routerSet("waiting-code", "Authy code needed — type the 6 digits on the setup page or the panel");
      } else if (a.state === "captcha") {
        routerSet("waiting-captcha", "reCAPTCHA challenge — solve it in the table window");
      } else if ((a.state === "login-form" || a.state === "error") && profile && A.get(profile)) {
        const tries = S.router.loginTries || 0;
        if (a.state === "error" && S.router.loginAt && (time() - S.router.loginAt < 15 || tries >= 3)) {
          routerSet("login-error", `sign-in as ${profile} failed: ${pyStr(a.detail ?? null)}` + (tries >= 3 ? " (3 attempts)" : ""));
          await sleep(5);
        } else if (tries >= 3 && S.router.loginAt) {
          routerSet("login-error", `sign-in as ${profile} failed 3 times — press Retry after checking the window`);
          await sleep(5);
        } else if (time() - S.router.loginAt > 15) {
          routerSet("logging-in", `signing in as ${profile}` + (tries ? ` (attempt ${tries + 1})` : ""));
          S.router.loginAt = time();
          S.router.loginTries = tries + 1;
          const res = await A.login(profile, C.CDP_PORT, stepLog("[auth] "));
          S.sessions.event(sid, "login", { profile, ok: res.ok ?? null, state: res.state ?? null });
          if (!res.ok) routerSet("login-error", res.error || res.detail || "sign-in failed");
        }
      } else if (a.state === "error") {
        routerSet("login-error", pyStr(a.detail ?? null));
      } else {
        if (S.router.state !== "waiting-signin") S.sessions.event(sid, "sign-in-needed", { profile });
        routerSet("waiting-signin", "table window is on the Ignition login page — no profile on this session, sign in there (e-mail, password, Authy)");
      }
      await sleep(2);
      continue;
    }
    if (wasSignedOut) {
      wasSignedOut = false;
      S.router.loginTries = 0;
      S.sessions.event(sid, "signed-in", { profile });
      await autoOpenBalance(sid, profile, "after sign-in");
    }
    resumeRecordingIfPending();

    // ---- 2. the table
    if (S.router.reseat) {
      S.router.reseat = false;
      if (st.state === "seated") {
        routerSet("routing", "re-seat: leaving the current table", []);
        markLeaving();
        const res = await F.leave(C.CDP_PORT, stepLog("[leave] "));
        S.sessions.event(sid, "reseat", { left: res.ok ?? null, was: st.detected ?? null });
        if (!res.ok) {
          routerSet("failed", `could not leave the table: ${res.error || "unknown"}`, res.steps ?? null);
          await sleep(5);
          continue;
        }
        await sleep(2);
        continue;
      }
      routerSet("routing", "re-seat: no table open — routing", []);
    }
    // THE LEADER'S OWN TABLE GONE, THE OTHERS UP (the site closed it, 2026-10-01): windowState reads OUR frame, so it
    // says "signed-in, no table" — but the client still holds the other tables, and the lobby navigation below would
    // reload the page under them. The seat-count path is the one: honourClosedTables → seatNextTable adds a table
    // beside the others, and our frame is re-pinned to it (ignition/reader.ts repinAfterSiteClose).
    let seated = st.state === "seated";
    if (!seated && st.state === "signed-in" && TABLES.slot() !== null && TABLES.isLeader() && (await F.seatedSlots(C.CDP_PORT)).length) {
      seated = true;
    }
    if (seated) {
      await autoOpenBalance(sid, profile, "seated");
      const leader = TABLES.isLeader();
      const seatedNow = leader ? (await F.seatedSlots(C.CDP_PORT)).length : 1;
      const want = leader ? honourClosedTables(cfg, seatedNow) : tablesWanted(cfg);
      routerSeats(seatedNow, want, leader);
      if (want > 1 && leader) {
        const step = await seatNextTable(fid!, cfg, want);
        routerSeats(step.have || seatedNow, want, leader);
        if (step.done) {
          S.seating.reached = Math.max(S.seating.reached || 0, step.have || want);
          if (S.router.state === "seating") {
            routerSet("routing", `all ${want} tables seated`, S.router.steps);
            S.sessions.event(sid, "tables-seated", { tables: step.have });
          }
        } else {
          routerSet("seating", step.text, S.router.steps);
          if (step.ok) {
            S.sessions.event(sid, "seated", { table: step.have, of: want, detected: step.detected ?? null });
          } else {
            routerSet("failed", step.text, step.steps ?? null);
            S.sessions.event(sid, "seat-failed", { table: step.seat, error: step.error ?? null });
            await sleep(10);
          }
          continue;
        }
      }
      if (!st.detected) {
        // the tables are up but ours is not read yet (its frame not re-pinned after the site's close): look again
        await sleep(2);
        continue;
      }
      const v = fid ? F.compare(fid, st.detected) : { state: "undeclared", text: st.detected.name };
      if (!["done", "off-format"].includes(S.router.state)) {
        routerSet(v.state === "ok" || v.state === "undeclared" ? "done" : "off-format", `seated: ${st.detected.name} — ${v.text}`);
        S.sessions.event(sid, "routed", { format: fid, seated: st.detected, verdict: v, byRouter: seatedByUs });
        seatedByUs = false;
      }
      await sleep(5);
      continue;
    }
    // signed in, no table
    if (!fid) {
      routerSet("idle", "signed in · no format declared, nothing to route to");
      await sleep(5);
      continue;
    }
    if (["done", "off-format", "left"].includes(S.router.state) && siteClosesPending().length) {
      // THE SITE CLOSED THE TABLE WE WERE ON (the last one open): ask for the format again — there is no seat count to
      // fall here, so the note is spent now rather than by honourClosedTables
      S.siteClosed.pending.shift();
      routerSet("routing", `the site closed the table — going back to ${f.name}`, []);
      S.sessions.event(sid, "table-reseat", { bySite: 1, seatedNow: 0, want: tablesWanted(cfg) });
    } else if (S.router.state === "done" || S.router.state === "off-format") {
      routerSet("left", `table closed — not re-seating (declared ${f.name})`);
      await sleep(5);
      continue;
    }
    if (S.router.state === "left" || S.router.state === "failed") {
      await sleep(5);
      continue;
    }
    routerSeats(0, tablesWanted(cfg), TABLES.isLeader());
    routerSet("routing", `going to ${f.name} · buy-in ${pyStr(cfg.buyinBb ?? 100)} bb`, []);
    const res = await F.goto(fid, Number(cfg.buyinBb || 100), C.CDP_PORT, cfg.waitForBb !== false, stepLog("[goto] "));
    if (res.ok) {
      seatedByUs = true;
      routerSeats(1, tablesWanted(cfg), TABLES.isLeader());
      const v = res.verdict || {};
      routerSet(v.state === "ok" ? "done" : "off-format", v.text || "seated", res.steps ?? null);
      S.sessions.event(sid, "routed", { format: fid, seated: res.detected ?? null, verdict: v, byRouter: true });
    } else if (res.stakeMissing) {
      routerSet("waiting-stake", `${pyStr(res.error ?? null)} — checking again in 60 s`, res.steps ?? null);
      for (let i = 0; i < 60; i++) {
        if (!alive()) break;
        await sleep(1);
      }
      continue;
    } else if (res.signedOut) {
      routerSet("routing", "signed out on the way to the lobby — signing in first", res.steps ?? null);
      S.router.loginAt = 0.0;
      continue;
    } else {
      routerSet("failed", res.error || "routing failed", res.steps ?? null);
      S.sessions.event(sid, "route-failed", { format: fid, error: res.error ?? null, steps: res.steps ?? null });
    }
  }
  if (S.router.generation === gen) routerSet(S.router.cancel ? "cancelled" : "idle", "session ended");
}

/** A FOLLOWER'S ROUTER WATCHES — IT NEVER DRIVES (session_20260925_134058: all four tables set off for the lobby at
 *  once, then all four signed in, two of them typing into the one e-mail field). The client is ONE page with one
 *  login and one lobby: signing in and every seat are the leader's (routeSession, seatNextTable), and a follower
 *  driving the lobby pulls it out from under the tables its siblings are reading. This loop only reads: it says
 *  what its table is waiting for, and reports the table once the leader has seated it. */
async function followSession(cfg: Record<string, any>, sid: string): Promise<void> {
  const gen = ++S.router.generation;
  const fid: string | null = cfg.format ?? null;
  const me = TABLES.slot();
  const leader = `table ${TABLES.LEADER}`;
  if (S.fakeMode) {
    routerSet("idle", "test rig — no routing");
    return;
  }
  Object.assign(S.router, { format: fid, cancel: false, reseat: false, loginAt: 0.0, loginTries: 0 });
  let seated = false;
  const alive = () => !S.router.cancel && S.router.generation === gen && S.session.id === sid;
  while (alive()) {
    if (S.router.reseat) {
      S.router.reseat = false;
      log(`[router] slot ${pyStr(me)}: re-seating is ${leader}'s job — not driving the lobby from here`);
    }
    const st = await F.windowState(C.CDP_PORT);
    routerSeats(st.state === "seated" ? 1 : 0, tablesWanted(cfg), false);
    if (st.state === "closed") {
      routerSet("waiting-window", `waiting for ${leader} to open the client`);
    } else if (st.state === "signed-out") {
      routerSet("waiting-signin", `the client is on the sign-in page — ${leader} signs in (the Authy code goes on its panel)`);
    } else if (st.state === "seated") {
      resumeRecordingIfPending();
      if (!["done", "off-format"].includes(S.router.state)) {
        const v = fid ? F.compare(fid, st.detected) : { state: "undeclared", text: st.detected.name };
        routerSet(v.state === "ok" || v.state === "undeclared" ? "done" : "off-format", `seated: ${st.detected.name} — ${v.text}`);
        if (!seated) S.sessions.event(sid, "routed", { format: fid, seated: st.detected, verdict: v, byRouter: false, slot: me });
      }
      seated = true;
      await sleep(5);
      continue;
    } else {
      resumeRecordingIfPending();
      routerSet("waiting-leader", seated ? `table ${pyStr(me)} is not seated any more — seating is ${leader}'s`
                                         : `waiting for ${leader} to seat table ${pyStr(me)}`);
      seated = false;
    }
    await sleep(2);
  }
  if (S.router.generation === gen) routerSet(S.router.cancel ? "cancelled" : "idle", "session ended");
}

/** Start this table's router: the leader's routes (sign-in, lobby, seats), a follower's only watches. */
export function startRouter(cfg: Record<string, any>, sid: string): void {
  S.router.cancel = true;
  const route = TABLES.isLeader() ? routeSession : followSession;
  later(0.1, () => route(cfg, sid));
}

export function resumeRecordingIfPending(): void {
  if (S.recPending.on) {
    S.recPending.on = false;
    setDebug(true);
  }
}

// ---- preflight, the checklist, the brief ------------------------------------------------------------------
/** The GTO Wizard row's per-account list gains the registry's name, light and last-hour meter (2026-09-27) — best
 *  effort, 4 s: the row still renders from the pool's own state when the accounts endpoint is down. */
export async function enrichGtowRow(pf: any): Promise<void> {
  const row = (pf?.checks || []).find((c: any) => c.id === "gtow");
  if (!row || !Array.isArray(row.sessions)) return;
  try {
    const raw = await fetchBytes(`${SES.API()}/api/gtow/accounts`, 4);
    const j = raw ? JSON.parse(new TextDecoder().decode(raw)) : null;
    if (!j?.ok) return;
    const byId = new Map<string, any>((j.accounts || []).map((a: any) => [a.id, a]));
    row.sessions = row.sessions.map((s: any) => {
      const a = byId.get(s.id);
      return a ? { ...s, name: a.name, light: a.light, lightText: a.lightText, h1: a.windows?.h1?.n ?? 0, h24: a.windows?.h24?.n ?? 0, cap: j.cap, walled: !!a.wall?.walled } : s;
    });
    row.gtowAllow = j.allow ?? null;
  } catch { /* informational */ }
}

export async function preflight(preset: string, cfg: Record<string, any>, registry: any = undefined): Promise<Record<string, any>> {
  const pf: any = await SES.runPreflight(preset, cfg, S.fakeMode, registry !== undefined ? registry : await SES.fetchRegistry(), C.CDP_PORT);
  await enrichGtowRow(pf);
  if (cfg.site === CP_SITE || cfg.site === CGG_SITE) {
    pf.checks = [...pf.checks, ...(cfg.site === CP_SITE ? CP.preflight(cfg.cpTable ?? null) : CGG.preflight(cfg.cggTable ?? null))];
    const blockers = pf.checks.filter((c: any) => c.required && !c.ok);
    Object.assign(pf, { ok: !blockers.length, blockers: blockers.map((c: any) => c.label) });
  }
  return pf;
}

export async function sessionChecks(): Promise<Record<string, any>> {
  const rec = S.session.rec;
  const registry = await SES.fetchRegistry();
  const presets = await SES.presets();
  let preset: string, cfg: Record<string, any>;
  if (rec && rec.preset in presets) {
    preset = rec.preset;
    cfg = rec.config || {};
  } else {
    preset = Object.keys(presets)[0]!;
    cfg = { answers: false, sources: {}, recording: false, budget: {} };
  }
  if (cfg.site === CP_SITE || cfg.site === CGG_SITE) {
    const pf = await preflight(preset, cfg, registry);
    const t = cfg.site === CP_SITE ? CP.table() : null;
    if (t && rec) for (const c of pf.checks) if (c.id === "cp-table") c.required = !!cfg.answers;
    S.chain.lastCheck = time();
    return { ok: pf.ok, checks: pf.checks, blockers: pf.blockers, checkedAt: nowMs(), preset: rec ? rec.preset ?? null : null,
             session: await sessionBrief(), chain: { attempting: S.chain.attempting, lastResult: S.chain.lastResult } };
  }
  const pf: any = await SES.runPreflight(preset, cfg, S.fakeMode, registry, C.CDP_PORT);
  await enrichGtowRow(pf);
  const cdpUp = await cdp.available(C.CDP_PORT);
  const tgt = cdpUp ? await seams.ignitionTarget() : null;
  const table = {
    id: "table", label: "Table window linked (CDP)", required: !!(rec && cfg.answers), ok: !!tgt,
    detail: tgt ? `${tgt.title || "table page"} · CDP :${C.CDP_PORT}` : cdpUp ? `CDP :${C.CDP_PORT} up, no table page yet`
      : "no table window — it opens when a session starts",
  };
  const wst = !S.fakeMode ? await F.windowState(C.CDP_PORT) : { state: "signed-in", detected: null };
  const details: Record<string, string> = {
    closed: "no table window", "signed-out": `Ignition login page · ${S.router.text || "waiting"}`,
    "signed-in": "lobby up", seated: `seated: ${pyStr((wst.detected || {}).name ?? null)}`,
  };
  const signin = { id: "signin", label: "Table window signed in", required: !!(rec && !S.fakeMode),
                   ok: wst.state === "signed-in" || wst.state === "seated", detail: details[wst.state] ?? wst.state };
  const fid = cfg.format ?? null;
  const verdict = fid ? F.compare(fid, wst.detected ?? null) : null;
  const fmt = { id: "format", label: "Table format matches the declaration", required: false,
                ok: !!verdict && (verdict.state === "ok" || verdict.state === "unknown"),
                detail: (verdict ? verdict.text : "no format declared")
                  + (S.router.state !== "idle" && S.router.state !== "done" ? ` · router: ${S.router.text}` : "") };
  const checks = [table, signin, ...(fid ? [fmt] : []), ...pf.checks];
  const blockers = checks.filter((c: any) => c.required && !c.ok).map((c: any) => c.label);
  S.chain.lastCheck = time();
  return { ok: !blockers.length, checks, blockers, checkedAt: nowMs(), preset: rec ? rec.preset ?? null : null,
           session: await sessionBrief(), chain: { attempting: S.chain.attempting, lastResult: S.chain.lastResult } };
}

/** What /state carries every second: the panel's session card and the poller's provenance. */
export async function sessionBrief(): Promise<Record<string, any> | null> {
  const rec = S.session.rec;
  if (!rec) return null;
  const cfg = rec.config || {};
  const budget = cfg.budget || {};
  const elapsedMin = S.session.started ? (time() - S.session.started) / 60 : 0;
  const hands = sessionHands(rec.id);
  const fid = cfg.format ?? null;
  let cpf: any = null, observed: any, verdict: any;
  if (cfg.site === CP_SITE) {
    const t = CP.table();
    cpf = CP_FORMATS.find((f: any) => f.id === fid) ?? null;
    observed = t ? { name: t.room, practice: t.practice, coinType: t.coinType } : null;
    verdict = t ? { state: "ok", text: `at ${t.room} (${t.practice ? "practice chips" : "real money"})` }
      : { state: "unknown", text: "no CoinPoker table open yet — sit down in the client" };
  } else if (cfg.site === CGG_SITE) {
    const t = CGG.table();
    cpf = CGG_FORMATS.find((f: any) => f.id === fid) ?? null;
    observed = t ? { name: t.title, practice: false } : null;
    verdict = t ? { state: t.status ? "unknown" : "ok", text: `reading ${t.label}${t.status ? ` — ${t.status}` : ""}` }
      : { state: "unknown", text: "no ClubGG table open — open one in the client" };
  } else {
    observed = !S.fakeMode && (await cdp.available(C.CDP_PORT)) ? await F.detect(C.CDP_PORT) : null;
    verdict = fid ? F.compare(fid, observed) : null;
  }
  const prof = cfg.profile ?? null;
  const bal = prof ? BAL.latest(prof) : null;
  const fmtRec = F.get(fid) || {};
  return {
    id: rec.id, preset: rec.preset ?? null, label: rec.label ?? null,
    strategy: cfg.strategy ?? null, strategyName: cfg.strategyName ?? null,
    balance: bal ? { amountCents: bal.amountCents, at: bal.ts, phase: bal.phase, source: bal.source } : null,
    format: fid, formatName: (cpf || F.get(fid) || {}).name ?? null, buyinBb: cfg.buyinBb ?? null,
    testOf: fmtRec.test ? fmtRec.testOf ?? null : null,
    testOfName: fmtRec.test ? (F.get(fmtRec.testOf) || {}).name ?? null : null,
    site: cfg.site || "ignition",
    observed, verdict,
    profile: cfg.profile ?? null,
    routing: { state: S.router.state, text: S.router.text, steps: S.router.steps, at: S.router.at, seats: S.router.seats },
    answers: cfg.answers ?? null, recording: cfg.recording ?? null,
    startedAt: rec.started_at ?? null, elapsedMin: pyRound(elapsedMin, 1), hands,
    budget,
    budgetHit: !!((budget.hands && hands >= budget.hands) || (budget.minutes && elapsedMin >= budget.minutes)),
  };
}

/** The session's config applied to this process: the site, the answers toggle, the auto / top-up settings. */
export async function applySessionConfig(cfg: Record<string, any>): Promise<void> {
  S.site.id = cfg.site === CP_SITE ? CP_SITE : cfg.site === CGG_SITE ? CGG_SITE : "ignition";
  CP.attach(cfg.site === CP_SITE ? cfg.cpTable ?? null : null);
  CGG.attach(cfg.site === CGG_SITE ? cfg.cggTable ?? null : null, cfg.site === CGG_SITE ? cfg.cggTitle ?? null : null);
  const st = S.study;
  st.on = !!cfg.answers;
  st.text = null;
  Object.assign(st, {
    auto: false, executed: null, autoTried: null, lastExec: null, autoDue: null,
    autoDelay: cfg.autoDelay === "instant" || cfg.autoDelay === "random" ? cfg.autoDelay : "instant",
    timeBank: "autoTimeBank" in cfg ? !!cfg.autoTimeBank : true, timeBankAt: 0.0, lastTimeBank: null, timeBankDecision: null,
    topUp: "autoTopUp" in cfg ? !!cfg.autoTopUp : true, topUpAt: 0.0, topUpHand: null, lastTopUp: null,
    foldNoAnswer: !!cfg.autoFoldNoAnswer, noAnswerTurn: null, lastNoAnswerFold: null,
    sitBackIn: !!cfg.autoSitBackIn, sitBackTurn: null, lastSitBackIn: null,
    topUpDue: null, topUpTrigger: null, stackStable: { text: null, ticks: 0 },
    autoRealUntil: 0.0, autoRealHands: 0, autoRealFrom: null, autoRealReason: null,
  });
  Object.assign(S.topupKpi, { hand: null, hands: 0, short: 0, worstBb: 0.0 });
  S.topupPanel.open = false;
  S.topupAbort = false;
  // ON DEMAND (2026-09-30): the strategy says so (the API's catalogue, carried on the preset's config); it answers only
  // when Solve is pressed and never auto-executes, whatever else the config declares
  st.onDemand = !!cfg.onDemand;
  st.solveRequest = null;
  st.autoDeclared = !!cfg.autoExecute && !st.onDemand;
  st.autoDeclaredReal = !!cfg.autoRealMoney;
  st.autoDeclaredBudget = { ...(cfg.autoBudget || { minutes: 30, hands: 50 }) };
  if (st.autoDeclared) {
    const res = setAuto(true, {
      allowReal: st.autoDeclaredReal, minutes: st.autoDeclaredBudget?.minutes ?? null, hands: st.autoDeclaredBudget?.hands ?? null,
      reason: "declared at session setup", by: { via: "session setup (declared)" },
    });
    if (!res.ok) log(`[pick] declared auto not armed yet: ${pyStr(res.error ?? null)}`);
  }
  if (isCp()) {
    S.recPending.on = false;
    setDebug(false);
  } else if (isCgg()) {
    // ClubGG records its own frames (PNG + index.jsonl, tools/cggReplay.ts) — never the Ignition debug recorder
    S.recPending.on = false;
    setDebug(false);
    CGG.recordDir = cfg.recording && S.session.id ? cggRecordingDir(S.session.id) : null;
    CGG.stats.recorded = 0;
    CGG.stats.recordBytes = CGG.recordDir ? dirBytes(CGG.recordDir) : 0;
  } else if (cfg.recording && !S.fakeMode && ["closed", "signed-out"].includes((await F.windowState(C.CDP_PORT)).state)) {
    S.recPending.on = true;
    setDebug(false);
  } else {
    S.recPending.on = false;
    setDebug(!!cfg.recording);
  }
}

/** The setup page's "clear its cache" box: HTTP / script / service-worker caches, never cookies or storage. */
export async function clearTableCache(): Promise<void> {
  if (S.fakeMode) return;
  if (await cdp.available(C.CDP_PORT)) {
    let n = 0;
    for (const t of (await cdp.pageTargets(C.CDP_PORT)) || []) {
      if (!t.webSocketDebuggerUrl || (t.url || "").startsWith("devtools")) continue;
      try {
        await A.cmds(t.webSocketDebuggerUrl, [["Network.enable", {}], ["Network.clearBrowserCache", {}], ["Network.disable", {}]], 10);
        n++;
      } catch (e: any) {
        log(`[table] cache clear via CDP failed: ${e?.message ?? e}`);
      }
    }
    log(`[table] browser cache cleared via CDP on ${n} page(s)`);
    return;
  }
  const prof = join(profileDir(C.PROFILE_TABLE), "Default");
  const removed: string[] = [];
  for (const rel of ["Cache", "Code Cache", "GPUCache", "Service Worker/CacheStorage", "Service Worker/ScriptCache", "DawnCache"]) {
    const d = join(prof, rel);
    if (existsSync(d)) {
      try {
        rmSync(d, { recursive: true, force: true });
        removed.push(rel);
      } catch (e: any) {
        log(`[table] could not remove ${rel}: ${e?.message ?? e}`);
      }
    }
  }
  log(`[table] browser cache folders removed: ${removed.length ? pyRepr(removed) : "none present"}`);
}

/** The session's OPENING balance, the moment it can be read — once per session. */
export async function autoOpenBalance(sid: string | null, profile: string | null, where: string): Promise<void> {
  if (S.fakeMode || !sid || !profile) return;
  const rec = S.sessions.get(sid) || {};
  if ((rec.events || []).some((e: any) => e.kind === "balance" && e.phase === "open")) return;
  const fresh = BAL.latest(profile) === null;
  const snap: any = await BAL.snapshot(profile, C.CDP_PORT, sid, "open");
  if (snap.ok) {
    S.sessions.event(sid, "balance", { phase: "open", amountCents: snap.amountCents, how: snap.how ?? null, where, seed: fresh });
    log(`[balance] ${profile} opens at ${BAL.fmt(snap.amountCents)} (${where}${fresh ? "; first reading for this profile = its seed" : ""})`);
  } else {
    S.sessions.event(sid, "balance-missed", { phase: "open", reason: snap.reason ?? null, where });
    log(`[balance] no opening balance yet (${where}): ${pyStr(snap.reason ?? null)} - retried after sign-in / seating`);
  }
}

// ---- several tables --------------------------------------------------------------------------------------

async function slotUp(slotN: number, timeoutS = 1.5): Promise<boolean> {
  return (await TABLES.probe(slotN, timeoutS)) !== null;
}

/** Start table `slotN` of `n` (another wrapper process of this same app), unless it is already up. */
async function spawnSlot(slotN: number, n: number): Promise<Record<string, any>> {
  const port = TABLES.panelPort(slotN);
  if (await slotUp(slotN)) return { slot: slotN, panelPort: port, ok: true, already: true };
  const env: Record<string, string> = { ...(process.env as Record<string, string>),
    TABLE_SLOT: String(slotN), TABLE_COUNT: String(n), PANEL_PORT: String(port), CDP_PORT: String(C.CDP_PORT) };
  if (S.fakeMode) env.FAKE_TABLE = "1";
  try {
    // the ports go in ARGV as well as the environment: the takeover scan tells one instance from another by the
    // command line, and a slot started without them reads as :7700 — a relaunch of table 1 would then end it
    const args = ["run", join(import.meta.dir, "main.ts"), "--panel-port", String(port), "--cdp-port", String(C.CDP_PORT)];
    if (S.fakeMode) args.push("--fake");
    // W.spawnDetached: a slot must not inherit this leader's listening socket (it would hold :7700 open after us)
    W.startDetached(process.execPath, args, { env, cwd: C.ROOT, hide: true }, log);
  } catch (e: any) {
    return { slot: slotN, panelPort: port, ok: false, error: `could not start: ${e?.message ?? e}` };
  }
  for (let i = 0; i < 120; i++) {
    await sleep(0.5);
    if (await slotUp(slotN)) return { slot: slotN, panelPort: port, ok: true };
  }
  return { slot: slotN, panelPort: port, ok: false, error: "did not come up within 60 s" };
}

/** THIS WRAPPER'S PANEL WINDOW, OPENED IF IT IS NOT THERE (2026-09-25). Found by its own title ("Poker Wrapper 2"
 *  for table 2), so a table never mistakes the leader's window for its own. Placed where the launch would have put
 *  it: its tile of the panel grid when several tables run, else beside the table. Called when a table joins a
 *  session — a table wrapper left running from an earlier session is REUSED by the next one ("already running"),
 *  and its panel, closed in between, was never reopened: 4 tables playing, only the leader's panel on screen — and
 *  from the leader's Tables grid (POST /tables/panel). */
export function ensurePanelWindow(why: string): Record<string, any> {
  if (C.HEADLESS) return { ok: false, error: "headless: no panel window" };
  if (sessionSeams.panelWindow()) return { ok: true, already: true };
  const me = TABLES.slot(), n = TABLES.count();
  const area = targetArea();
  const url = `http://127.0.0.1:${C.PANEL_PORT}/panel`;
  let r: { x: number; y: number; w: number; h: number };
  if (me !== null && n > 1) r = TABLES.panelRect(me, n, area as TABLES.Area, otherArea() as TABLES.Area | null);
  else {
    const tw = Math.trunc(area.w * C.TABLE_FRAC);
    r = { x: area.x + tw, y: area.y, w: area.w - tw, h: area.h };
  }
  const pid = sessionSeams.openWindow(url, C.PROFILE_PANEL, r.x, r.y, r.w, r.h);
  log(`[panel] ${me !== null ? `slot ${me}/${n}: ` : ""}panel window was not open — opened at (${r.x},${r.y}) ${r.w}x${r.h} (${why})`);
  if (S.session.id) S.sessions.event(S.session.id, "panel-reopened", { slot: me, panelPort: C.PANEL_PORT, why, ok: pid !== null });
  return { ok: pid !== null, opened: true };
}

/** Hero has cards in front of him right now — money a Leave would forfeit (state.ts; the reader asks it too). */
export { inAHand };

/** This wrapper leaves its own table and stops answering for it — NEVER mid-hand (deferred to the boundary). */
export async function standDownTable(why: string): Promise<Record<string, any>> {
  if (inAHand()) {
    S.study.standDownPending = why;
    feedAdd("Table will be left as soon as this hand is over");
    return { deferred: true, why: "hero is in a hand" };
  }
  S.study.standDownPending = null;
  S.study.on = false;
  let res: Record<string, any>;
  try {
    markLeaving();
    res = (await cdp.available(C.CDP_PORT)) ? await sessionSeams.leave(C.CDP_PORT) : { ok: true, note: "no table window" };
  } catch (e: any) {
    res = { ok: false, error: String(e?.message ?? e) };
  }
  S.router.cancel = true;
  routerSet("left", `table closed — ${why}`);
  return res;
}

/**
 * A TABLE LOST THE POKER SERVER: END THE SESSION THERE, NEVER RECONNECT (Brady, 2026-09-25 — "if a table gets
 * disconnected, keep it disconnected, do not allow a reconnect, just end the session then and there"). The reader
 * latched it (ignition/reader.ts noteDisconnect: nothing pressed, auto off, router stopped); this, from the feed loop,
 * does the rest ONCE:
 *   1. closes the Ignition client — the one page every table lives in — so its own reconnect (on its own, 22-25 s
 *      later in session_20260925_180244, on new sockets, seats back as "Sit here") cannot happen;
 *   2. the leader ends the session (the other tables stand down; the closing balance cannot be read with the client
 *      closed and is recorded as missed); any other table tells the leader, and ends it itself if the leader does
 *      not answer. The wrapper stays up with the reason in its feed and in the session record.
 */
/** We are leaving a table on purpose: its game socket closing in the next seconds is not a failure
 *  (ignition/reader.ts noteSocketClosed). Called right before every leave. */
export function markLeaving(): void {
  S.tapLeavingAt = time();
}

export async function maybeEndForDisconnect(): Promise<void> {
  const x = S.disconnect;
  if (!x || x.handled) return;
  x.handled = true;
  const sid = x.sid;
  let closed = "";
  try {
    closed = await sessionSeams.closeClient();
  } catch (e: any) {
    closed = `could not close it: ${e?.message ?? e}`;
  }
  log(`[disconnect] Ignition client: ${closed}`);
  const detail = { slot: x.slot, text: x.text, attempt: x.attempt, of: x.of, reconnected: x.reconnected, client: closed };
  if (sid && S.session.id === sid) S.sessions.event(sid, "table-disconnected", detail);
  const note = `ended automatically: table ${x.slot ?? 1} lost the poker server (${x.reconnected ? "the client had reconnected by itself" : x.text}${x.attempt !== null ? `, attempt ${x.attempt} of ${x.of}` : ""}) — the client was closed so it could not reconnect`;
  if (!sid || S.session.id !== sid) return;
  if (!TABLES.isLeader()) {
    let told: Record<string, any> | null = null;
    try {
      told = await sessionSeams.tellLeader({ sid, ...detail });
    } catch (e: any) {
      told = { ok: false, error: String(e?.message ?? e) };
    }
    if (told && told.ok) {
      log(`[disconnect] told table ${TABLES.LEADER}, which ends the session`);
      return;
    }
    log(`[disconnect] table ${TABLES.LEADER} did not answer (${pyStr((told || {}).error ?? null)}) — ending the session from table ${pyStr(TABLES.slot())}`);
  }
  const res = await sessionEnd({ id: sid, note });
  feedAdd(res.ok ? "Session ended — the table disconnected from the poker server and was not allowed to reconnect"
                 : `Session could NOT be ended automatically: ${pyStr(res.error ?? null)} — end it yourself`);
}

/** POST /session/disconnected — another table saw its table lose the poker server: the leader ends the session. */
export async function sessionDisconnected(body: Record<string, any>): Promise<[number, Record<string, any>]> {
  const sid = String(body.sid || "");
  if (!S.session.id || (sid && sid !== S.session.id)) return [200, { ok: true, ended: null, note: "not this session (already ended?)" }];
  if (!S.disconnect) {
    const slot = body.slot === undefined || body.slot === null ? null : pyInt(body.slot);
    S.disconnect = { at: time(), slot, text: String(body.text || "disconnected"), attempt: body.attempt ?? null, of: body.of ?? null,
                     reconnected: !!body.reconnected, sid: S.session.id, handled: false, via: `table ${pyStr(slot)} told us` };
    Object.assign(S.study, { auto: false, autoDue: null, autoRealUntil: 0.0, autoRealHands: 0, autoRealFrom: null, autoRealReason: null,
                             standDownPending: null });
    S.router.cancel = true;
    feedAdd(`DISCONNECTED FROM THE POKER SERVER — table ${pyStr(slot)} lost it. Ending the session; the client is closed so it cannot reconnect`);
  }
  const was = S.session.id;
  await maybeEndForDisconnect();
  return [200, { ok: true, ended: S.session.id === null ? was : null }];
}

/**
 * THE SITE CLOSED OUR TABLE — KEEP THE SESSION, GET A NEW TABLE (Brady, 2026-10-01: "we keep playing until we get
 * kicked off the table, and if so, then we try join a new table at that stake"). The reader held the socket close
 * for its settle window and called it the site's (ignition/reader.ts maybeSettleSiteClose: hero alone, no hand on,
 * no other socket of the page closing, no disconnect overlay); this, from the feed loop, does the rest ONCE:
 *   1. the session record says which table the site closed, and what it showed;
 *   2. the leader notes it (noteSiteClosePending), so the seat count falling is a re-seat, not a close by hand
 *      (honourClosedTables → seatNextTable at the declared format), or — the only table — the router goes back to
 *      the format (routeSession); a follower tells the leader over /session/table-closed. The leader not answering
 *      leaves that table closed: the session goes on at the others, nothing ends.
 * Nothing is pressed meanwhile: there is no table. Our frame vanishing lets the pinned tag go (reader.ts
 * repinAfterSiteClose), so the new table's frame is read as ours and its socket binds from its own deal.
 */
export async function maybeReseatAfterSiteClose(): Promise<void> {
  const n = S.siteClosed.notice;
  if (!n || !n.settled) return;
  S.siteClosed.notice = null;
  const sid = n.sid;
  if (!sid || S.session.id !== sid) return;
  const me = TABLES.slot();
  const detail = { slot: me, hand: n.hand, seats: n.seats, hero: n.hero, rid: n.rid };
  S.sessions.event(sid, "table-closed-by-site", detail);
  if (TABLES.isLeader()) {
    noteSiteClosePending(me, "our own socket closed on the empty table");
    return;
  }
  let told: Record<string, any> | null = null;
  try {
    told = await sessionSeams.tellLeaderTableClosed({ sid, ...detail });
  } catch (e: any) {
    told = { ok: false, error: String(e?.message ?? e) };
  }
  if (told && told.ok) {
    log(`[tables] told table ${TABLES.LEADER}, which seats a new table`);
    feedAdd(`Table ${TABLES.LEADER} has been asked to seat a new table for this one`);
    return;
  }
  log(`[tables] table ${TABLES.LEADER} did not answer (${pyStr((told || {}).error ?? null)}) — this table stays closed; the session goes on at the others`);
  feedAdd(`Table ${TABLES.LEADER} could not be told — this table stays closed (re-seat it from table ${TABLES.LEADER}'s panel)`);
}

/** POST /session/table-closed — the site closed another table under its wrapper: the leader seats a new one. */
export function sessionTableClosed(body: Record<string, any>): [number, Record<string, any>] {
  const sid = String(body.sid || "");
  if (!S.session.id || (sid && sid !== S.session.id)) return [200, { ok: true, noted: false, note: "not this session (already ended?)" }];
  if (!TABLES.isLeader()) return [409, { ok: false, error: `table ${pyStr(TABLES.slot())} is not the leader — seating is table ${TABLES.LEADER}'s` }];
  const slot = body.slot === undefined || body.slot === null ? null : pyInt(body.slot);
  S.sessions.event(S.session.id, "table-closed-by-site", { slot, hand: body.hand ?? null, seats: body.seats ?? null, hero: body.hero ?? null,
                                                          rid: body.rid ?? null, told: true });
  feedAdd(`The site closed table ${pyStr(slot)} (its last other player had left) — seating a new table for it`);
  noteSiteClosePending(slot, `table ${pyStr(slot)} told us`);
  return [200, { ok: true, noted: true, pending: S.siteClosed.pending.length, want: tablesWanted((S.session.rec || {}).config || {}) }];
}

/** A connection drop waits this long for hero's hand to end before the session ends anyway. */
export const NET_DROP_HAND_WAIT_S = 120.0;

/**
 * THE CONNECTION DROPPED: END THE SESSION, NEVER SIT BACK IN (Brady, 2026-09-25 — "do not sit back after a connection
 * drop, just end the session"). netguard.ts noted the drop (S.net.drop) and ticked "Sit out next hand"; this, from
 * the feed loop, ends the session once hero's hand is over — the hand in play keeps its answers, and past
 * NET_DROP_HAND_WAIT_S it ends regardless. The client stays open (the table is still connected; hero sits out). A
 * table that is not the leader hands the drop to the leader, and ends it itself if the leader does not answer.
 */
export async function maybeEndForNetDrop(): Promise<void> {
  const d = S.net.drop;
  if (!d || d.handled) return;
  const sid = d.sid;
  if (S.session.id !== sid) {
    S.net.drop = null;   // that session is over already; a drop never carries into the next one
    return;
  }
  const waited = time() - d.at;
  const busy = inAHand();
  if (busy && waited < NET_DROP_HAND_WAIT_S) return;
  d.handled = true;
  const note = `ended automatically: the connection dropped (${d.why}; ${d.via}) — not sat back in` +
    (busy ? `; hero was still in a hand after ${Math.round(waited)} s` : "");
  if (!TABLES.isLeader()) {
    let told: Record<string, any> | null = null;
    try {
      told = await sessionSeams.tellLeaderNetDrop({ sid, slot: TABLES.slot(), why: d.why });
    } catch (e: any) {
      told = { ok: false, error: String(e?.message ?? e) };
    }
    if (told && told.ok) {
      log(`[net] told table ${TABLES.LEADER}, which ends the session`);
      return;
    }
    log(`[net] table ${TABLES.LEADER} did not answer (${pyStr((told || {}).error ?? null)}) — ending the session from table ${pyStr(TABLES.slot())}`);
  }
  const res = await sessionEnd({ id: sid, note });
  feedAdd(res.ok ? "Session ended — the connection dropped; hero was not sat back in"
                 : `Session could NOT be ended automatically: ${pyStr(res.error ?? null)} — end it yourself`);
}

/** POST /session/net-drop — another table's connection check failed: the leader ends the session at its hand's end. */
export async function sessionNetDrop(body: Record<string, any>): Promise<[number, Record<string, any>]> {
  const sid = String(body.sid || "");
  if (!S.session.id || (sid && sid !== S.session.id)) return [200, { ok: true, ended: null, note: "not this session (already ended?)" }];
  if (!S.net.drop || S.net.drop.sid !== S.session.id) {
    const slot = body.slot === undefined || body.slot === null ? null : pyInt(body.slot);
    S.net.drop = { sid: S.session.id, at: time(), why: String(body.why || "connection too slow"), via: `table ${pyStr(slot)} told us`, handled: false };
    feedAdd(`CONNECTION DROPPED at table ${pyStr(slot)} - the session ends when this hand is over`);
    S.sessions.event(S.session.id, "net-drop", { hand: S.handNo, slot, why: S.net.drop.why, via: S.net.drop.via });
  }
  const was = S.session.id;
  await maybeEndForNetDrop();
  return [200, { ok: true, ended: S.session.id === null ? was : null, pending: S.session.id !== null }];
}

/** The deferred half of a close: leave the table the moment the hand ends. */
export async function maybeStandDown(): Promise<void> {
  if (!S.study.standDownPending || inAHand()) return;
  const why = S.study.standDownPending;
  S.study.standDownPending = null;
  log(`[tables] hand over — leaving the table now (${why})`);
  await standDownTable(why);
}

/** Close table `slotN`: stop the session asking for it, and stand it down (idempotent). */
export async function closeTable(slotN: number, why = "closed from the panel"): Promise<Record<string, any>> {
  const me = TABLES.slot();
  const already = tablesClosed().has(slotN);
  S.closedTables.add(slotN);
  if (S.session.id && !already) S.sessions.event(S.session.id, "table-closed", { slot: slotN, why });
  const out: Record<string, any> = { ok: true, slot: slotN, already, wanted: tablesWanted((S.session.rec || {}).config || {}) };
  if (already) {
    out.note = "already closed — left alone";
    return out;
  }
  if (slotN === (me || TABLES.LEADER)) out.stood_down = await standDownTable(why);
  else out.stood_down = await postJson(`http://127.0.0.1:${TABLES.panelPort(slotN)}/table/stand-down`, { why, sid: S.session.id }, 30);
  feedAdd(`Table ${slotN} closed — the session now wants ${out.wanted}`);
  log(`[tables] table ${slotN} closed (${why}); wanted is now ${out.wanted}`);
  return out;
}

/** Become table 1 of `n` and bring the rest up. */
export async function openTables(n: number): Promise<any[]> {
  const before = TABLES.slot();
  TABLES.adopt(n);
  if (n <= 1) {
    if (before !== null) {
      log("[tables] back to one table");
      later(0.5, async () => log(`[layout] ${pyRepr(await layout())}`));
    }
    return [];
  }
  log(`[tables] this session wants ${n} tables; this is table ${TABLES.LEADER}`);
  log(`[layout] ${pyRepr(await layout())}`);
  const out: any[] = [];
  for (let k = 2; k <= n; k++) {
    const r = await spawnSlot(k, n);
    out.push(r);
    log(`[tables] table ${k}: ${r.ok ? "up" : "FAILED - " + pyStr(r.error ?? null)} on :${r.panelPort}` + (r.already ? " (already running)" : ""));
  }
  return out;
}

function tableCard(st: Record<string, any>, slotN: number, port: number, me: boolean): Record<string, any> {
  const h = st.hand || {};
  const node = h.currentNode || {};
  let a = st.panelAnswer ?? null;
  a = typeof a === "string" ? { text: a, pick: null } : a || null;
  const ended = !!h.ended;
  return {
    slot: slotN, panelPort: port, me,
    reachable: st.ok !== false,
    error: st.error ?? null,
    session: st.session && typeof st.session === "object" ? st.session.id ?? null : st.sessionId ?? null,
    answersOn: !!st.studyAnswers,
    connected: !!st.connected,
    street: h.street ?? null,
    heroCards: h.heroCards ?? null,
    handId: st.handId || h.handId || null,
    toActIsHero: !!node.toActIsHero && !ended,
    toCall: node.toCall ?? null,
    notToActWhy: h.notToActWhy ?? null,
    ended,
    answer: a && a.text,
    pick: a && a.pick,
    layout: st.layout ?? null,
    clientWindow: st.layout ?? null,
  };
}

/** Every table's answer in one payload — what the leader's panel renders (collected over loopback). */
export async function tablesOverview(stateLight: () => Promise<Record<string, any>>): Promise<Record<string, any>> {
  const me = TABLES.slot();
  const cards: Record<string, any>[] = [{ ...tableCard(await stateLight(), me || 1, C.PANEL_PORT, true), panelOpen: C.HEADLESS ? null : !!sessionSeams.panelWindow() }];
  const rows = seams.registry().filter((r: any) => r.slot !== me);
  if (rows.length) {
    const got = await Promise.all(rows.map(async (r: any) => {
      const st = r.live ? await getJson(`http://127.0.0.1:${r.panelPort}/state?light=1`, 4) : { ok: false, error: `table ${r.slot} is not running` };
      return { ...tableCard(st, r.slot, r.panelPort, false), panelOpen: r.live ? r.panelOpen ?? null : null };
    }));
    cards.push(...got);
  }
  cards.sort((a, b) => a.slot - b.slot);
  const closed = [...tablesClosed()].sort((a, b) => a - b);
  const cfg = (S.session.rec || {}).config || {};
  for (const c of cards) c.closed = closed.includes(c.slot);
  return { ok: true, at: time(), leader: TABLES.LEADER, slot: me, tables: cards, declared: TABLES.count(),
           closed, wanted: tablesWanted(cfg), waiting: cards.filter((c) => c.toActIsHero).length };
}

/** THE LEADER REOPENS TABLE PANELS: `slot` = one table, null = every table this session runs. This table's own
 *  window directly; every other through that table's POST /panel/open-window (its window, its title, its tile). */
export async function reopenPanels(slot: number | null): Promise<Record<string, any>> {
  const me = TABLES.slot() ?? TABLES.LEADER;
  // the registry lists every declared table, this one included (me: true); the single-table path has none
  const rows: any[] = TABLES.slot() === null ? [{ slot: me, panelPort: C.PANEL_PORT, live: true }] : seams.registry();
  const targets = rows.filter((r) => slot === null || r.slot === slot);
  if (!targets.length) return { ok: false, error: `table ${slot} is not part of this session` };
  const results = await Promise.all(targets.map(async (r: any) => {
    if (r.slot === me) return { slot: r.slot, ...ensurePanelWindow("reopened from the Tables grid") };
    if (r.live === false) return { slot: r.slot, ok: false, error: `table ${r.slot} is not running` };
    return { slot: r.slot, ...(await postJson(`http://127.0.0.1:${r.panelPort}/panel/open-window`, { why: "reopened from the Tables grid" }, 10)) };
  }));
  results.sort((a, b) => a.slot - b.slot);
  return { ok: results.every((x) => x.ok), results };
}

/** One instruction to every live peer, in parallel — PROBED, not remembered. */
export async function fanOut(path: string, body: unknown, timeoutS = 25.0): Promise<any[]> {
  const peers = await seams.livePeers();
  if (!peers.length) return [];
  const out = await Promise.all(peers.map(async (p: any) => ({ slot: p.slot, panelPort: p.panelPort,
                                                                ...(await postJson(`http://127.0.0.1:${p.panelPort}${path}`, body, timeoutS)) })));
  out.sort((a, b) => a.slot - b.slot);
  return out;
}
seams.registry = (now?: number) => TABLES.registry(now);
seams.livePeers = (timeoutS?: number) => TABLES.livePeers(timeoutS);

// ---- join / leave (followers) -----------------------------------------------------------------------------
export async function sessionJoin(body: Record<string, any>): Promise<[number, Record<string, any>]> {
  const sid = String(body.sid || "").trim();
  const cfg = body.config || {};
  if (!sid) return [400, { ok: false, error: "sid required" }];
  if (S.session.id === sid) return [200, { ok: true, session: S.session.rec, already: true }];
  if (S.session.id) return [409, { ok: false, error: `slot ${pyStr(TABLES.slot())} is already on session ${S.session.id}` }];
  const rec = S.sessions.get(sid);
  if (!rec) return [404, { ok: false, error: `no session ${sid}` }];
  if (rec.ended_at) return [409, { ok: false, error: `session ${sid} has already ended` }];
  S.disconnect = null;                 // a table that lost the server ended the LAST session; this one starts clean
  Object.assign(S.session, { id: sid, rec, started: time() });
  forgetFrame();                       // a new session's tables: pin our table's tag afresh on the first read
  await applySessionConfig(cfg);
  if (cfg.answers) void ensureAnswerChain(`slot ${pyStr(TABLES.slot())} joined`).catch(() => {});
  S.sessions.event(sid, "table-joined", { slot: TABLES.slot(), panelPort: C.PANEL_PORT });
  log(`[session] slot ${pyStr(TABLES.slot())} joined ${sid}`);
  try {
    await openTableWindow();
  } catch (e: any) {
    log(`[session] slot ${pyStr(TABLES.slot())} table window: ${e?.message ?? e}`);
  }
  if (TABLES.slot() !== null && !S.fakeMode && !C.PANEL_DEFER_WINDOW) {
    try {
      ensurePanelWindow(`joined ${sid}`);
    } catch (e: any) {
      log(`[session] slot ${pyStr(TABLES.slot())} panel window: ${e?.message ?? e}`);
    }
  }
  startRouter(cfg, sid);
  return [200, { ok: true, session: rec, slot: TABLES.slot() }];
}

export function sessionLeave(body: Record<string, any> | null): [number, Record<string, any>] {
  const sid = S.session.id;
  if (!sid) return [200, { ok: true, left: null }];
  const want = (body || {}).sid;
  if (want && want !== sid) return [200, { ok: true, left: null, on: sid, note: `slot ${pyStr(TABLES.slot())} is on ${sid}, not ${want}` }];
  const hands = sessionSeams.hands(sid);
  try {
    archiveHand();
  } catch {}
  S.router.cancel = true;
  S.study.on = false;
  S.study.text = null;
  S.study.auto = false;
  Object.assign(S.study, { autoRealUntil: 0.0, autoRealHands: 0, autoRealFrom: null, autoRealReason: null });
  setDebug(false);
  S.recPending.on = false;
  S.sessions.event(sid, "table-left", { slot: TABLES.slot(), hands });
  Object.assign(S.session, { id: null, rec: null, started: 0.0 });
  log(`[session] slot ${pyStr(TABLES.slot())} left ${sid} after ${hands} hand(s)`);
  return [200, { ok: true, left: sid, slot: TABLES.slot(), hands }];
}

// ---- followers watch the store themselves ------------------------------------------------------------------
const ORPHAN_POLL_S = 10.0;
const ADOPT_POLL_S = 4.0;

/** A FOLLOWER WHOSE SESSION HAS BEEN ENDED STANDS ITSELF DOWN. */
export async function maybeSessionOrphaned(): Promise<void> {
  const sid = S.session.id;
  if (!sid || TABLES.isLeader()) return;
  const now = time();
  if (now - S.orphanCheck.at < ORPHAN_POLL_S) return;
  S.orphanCheck.at = now;
  let rec: any;
  try {
    rec = S.sessions.get(sid);
  } catch {
    return;
  }
  if (!rec || !rec.ended_at) return;
  if (S.orphanCheck.said === sid) return;
  S.orphanCheck.said = sid;
  log(`[session] slot ${pyStr(TABLES.slot())}: ${sid} was ended by the leader — standing down`);
  feedAdd(`Session ${sid} ended elsewhere — this table stood down`);
  try {
    sessionLeave({ sid });
  } catch (e: any) {
    log(`[session] slot ${pyStr(TABLES.slot())}: could not stand down cleanly: ${e?.message ?? e}`);
  }
}

/** A FOLLOWER WITH NO SESSION TAKES UP ONE THAT DECLARED IT (the leader's push can miss). */
export async function maybeSessionAdopt(): Promise<void> {
  const me = TABLES.slot();
  if (S.session.id || me === null || TABLES.isLeader()) return;
  const now = time();
  if (now - S.adoptCheck.at < ADOPT_POLL_S) return;
  S.adoptCheck.at = now;
  let openRecs: any[];
  try {
    openRecs = S.sessions.openSessions();
  } catch {
    return;
  }
  for (const rec of openRecs) {
    const cfg = rec.config || {};
    let want = 1;
    try {
      want = pyInt(cfg.tables || 1);
    } catch {
      want = 1;
    }
    if (want < me) continue;
    const first = S.adoptCheck.said !== rec.id;
    S.adoptCheck.said = rec.id;
    if (first) {
      log(`[session] slot ${me}: ${rec.id} declared ${want} tables and never reached this one — joining it`);
      feedAdd(`Joined session ${rec.id} (the leader's invitation never arrived)`);
    }
    try {
      const [code, res] = await sessionSeams.join({ sid: rec.id, config: cfg });
      if (code !== 200) log(`[session] slot ${me}: could not join ${rec.id}: ${pyStr(res.error ?? null)}`);
    } catch (e: any) {
      log(`[session] slot ${me}: could not join ${rec.id}: ${e?.message ?? e}`);
    }
    return;
  }
}

// ---- updates for a PACKAGED install ------------------------------------------------------------------------
export function installedVersion(): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(join(REPO, "VERSION.json"), "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

function run(cmd: string, args: string[], timeoutS: number, cwd: string = REPO): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "";
    let c: ReturnType<typeof spawn>;
    try {
      c = spawn(cmd, args, { cwd, windowsHide: true });
    } catch (e: any) {
      resolve({ code: null, stdout: "", stderr: String(e?.message ?? e) });
      return;
    }
    const t = setTimeout(() => { try { c.kill(); } catch {} }, timeoutS * 1000);
    c.stdout?.on("data", (d) => (stdout += d.toString()));
    c.stderr?.on("data", (d) => (stderr += d.toString()));
    c.on("error", (e) => { clearTimeout(t); resolve({ code: null, stdout, stderr: stderr + String(e?.message ?? e) }); });
    c.on("close", (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
  });
}

async function ownerReleaseRefresh(): Promise<void> {
  try {
    // the packager is TypeScript (setup/buildPackage.ts, 2026-09-24): run it with the Bun running this wrapper
    const r = await run(process.execPath, [join(REPO, "setup", "buildPackage.ts"), "--status", "--json"], 180);
    const lines = r.stdout.trim().split(/\r?\n/);
    const line = lines[lines.length - 1] || "";
    S.ownerRelease.status = line.startsWith("{") ? JSON.parse(line) : { ok: false, error: (r.stderr || r.stdout).slice(-300) };
  } catch (e: any) {
    S.ownerRelease.status = { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  } finally {
    S.ownerRelease.at = time();
    S.ownerRelease.running = false;
  }
}

export async function updateStatus(force = false): Promise<Record<string, any>> {
  const inst = installedVersion();
  if (inst === null) {
    if (!existsSync(join(REPO, "setup", "buildPackage.ts"))) return { ok: true, packaged: false };
    if (!S.ownerRelease.running && (force || time() - S.ownerRelease.at > 90)) {
      S.ownerRelease.running = true;
      void ownerReleaseRefresh();
    }
    return { ok: true, packaged: false, owner: S.ownerRelease.status };
  }
  if (force || time() - S.updateCache.at > 1800) {
    S.updateCache.at = time();
    // an installed copy's own rclone first (bin, the installer's); its key comes as RCLONE_CONFIG from configenv.ps1
    const cands = [process.env.RCLONE, join(REPO, "bin", "rclone.exe"), join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "rclone.exe")];
    const rc = cands.find((c) => c && existsSync(c)) || "rclone";
    const ch = process.env.PW_CHANNEL || "r2:poker-solve-db/wrapper";
    const r = await run(rc, ["cat", `${ch}/latest.json`], 30);
    try {
      S.updateCache.latest = r.code === 0 ? JSON.parse(r.stdout) : null;
      S.updateCache.error = r.code === 0 ? null : r.stderr.trim().slice(-200) || "update channel unreadable";
    } catch (e: any) {
      S.updateCache.latest = null;
      S.updateCache.error = String(e?.message ?? e).slice(0, 200);
    }
  }
  const lat = S.updateCache.latest || {};
  let have: Record<string, any> = {};
  try {
    have = JSON.parse(readFileSync(join(REPO, "config", "installed-data.json"), "utf8").replace(/^﻿/, ""));
  } catch {}
  const dataBehind = Object.entries(lat.data || {}).filter(([k, v]: [string, any]) => have[k] !== (v || {}).version).map(([k]) => k);
  const codeBehind = !!lat.version && lat.version > String(inst.version || "");
  return { ok: true, packaged: true, installed: inst.version ?? null, latest: lat.version ?? null, notes: lat.notes || "",
           available: codeBehind || !!(dataBehind.length && Object.keys(lat).length), dataBehind, error: S.updateCache.error,
           sessionActive: !!S.session.rec };
}

/** Hand over to setup/update.ps1 in its own console, then stand down so it can replace our files. */
export function startUpdate(): [number, Record<string, any>] {
  if (S.session.rec) return [409, { ok: false, why: "a session is running — end it first" }];
  if (installedVersion() === null) return [409, { ok: false, why: "this is the source checkout — it updates from git" }];
  const ps1 = join(REPO, "setup", "update.ps1");
  const args = ["-Yes", "-Relaunch", "-PanelPort", String(C.PANEL_PORT)];
  if (C.PANEL_PORT !== livePort("panel")) args.push("-WrapperArgs", `--panel-port ${C.PANEL_PORT} --cdp-port ${C.CDP_PORT}` + (S.fakeMode ? " --fake" : ""));
  for (const [env, flag] of [["PW_API_PORT", "-ApiPort"], ["PW_CHART_PORT", "-ChartPort"]] as const) if (process.env[env]) args.push(flag, process.env[env]!);
  if (process.env.PW_SKIP_TASKS === "1") args.push("-SkipTasks");
  // W.spawnDetached: update.ps1 relaunches the wrapper while it is still running — holding our listening socket
  // it would keep this port open and the relaunch could not take it
  W.startDetached("cmd", ["/c", "start", "Poker Wrapper update", "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, ...args],
                  { cwd: REPO, hide: true }, log);
  standDown("updating");
  return [200, { ok: true, updating: true }];
}

// ---- start / end ------------------------------------------------------------------------------------------
export async function sessionStart(body: Record<string, any>): Promise<[number, Record<string, any>]> {
  if (!TABLES.isLeader() && !body.joining) {
    return [409, { ok: false, error: `table ${pyStr(TABLES.slot())} does not declare sessions — start it from table ${TABLES.LEADER} (http://127.0.0.1:${TABLES.leaderPort()}/setup)` }];
  }
  if (S.session.id) return [409, { ok: false, error: `session ${S.session.id} is already running — end it first` }];
  const presets = await SES.presets();
  const preset = body.preset in presets ? body.preset : null;
  if (!preset) return [400, { ok: false, error: "unknown preset" }];
  const cfg = await SES.mergedConfig(preset, body.config ?? null);
  cfg.panelPort = C.PANEL_PORT;
  const registry = await SES.fetchRegistry();
  const pf = await preflight(preset, cfg, registry);
  if (!pf.ok) return [409, { ok: false, error: "blocked by preflight: " + pf.blockers.join(" · "), preflight: pf }];
  const sid = SES.newSessionId();
  const rec = S.sessions.start(sid, preset, body.label ?? null, body.note ?? null, cfg, pf, SES.versionsSnapshot(registry));
  S.disconnect = null;                 // a table that lost the server ended the LAST session; this one starts clean
  Object.assign(S.session, { id: sid, rec, started: time() });
  await applySessionConfig(cfg);
  if (cfg.answers) void ensureAnswerChain("session start").catch(() => {});
  S.sessions.event(sid, "started", { hand: S.handNo });
  if (isCp()) {
    const cl = CP.ensureClient();
    S.sessions.event(sid, "coinpoker-client", cl);
    void openLeader();
    log(`[session] ${sid} started · ${preset} · CoinPoker · client ${cl.started ? "started" : cl.ok ? "already running" : pyStr(cl.error ?? null)}`);
    return [200, { ok: true, session: rec, tables: [], opened: [], site: CP_SITE, client: cl }];
  }
  if (isCgg()) {
    const cl = CGG.clientState();
    S.sessions.event(sid, "clubgg-client", cl);
    log(`[session] ${sid} started · ${preset} · ClubGG (reader only) · ${cl.running ? `${cl.tables} table window(s)` : "client not running"}`
        + ` · recording=${cfg.recording ? "on" : "off"}`);
    return [200, { ok: true, session: rec, tables: [], opened: [], site: CGG_SITE, client: cl }];
  }
  if (cfg.clearCache) {
    await clearTableCache();
    S.sessions.event(sid, "cache-cleared", {});
  }
  await autoOpenBalance(sid, cfg.profile ?? null, "session start");
  log(`[session] ${sid} started · ${preset} · answers=${cfg.answers ? "on" : "off"} recording=${cfg.recording ? "on" : "off"}`);
  const nTables = pyInt(cfg.tables || 1);
  if (nTables > 1) TABLES.adopt(nTables);
  forgetFrame();                       // a new session's tables: pin our table's tag afresh on the first read
  try {
    await openTableWindow();
  } catch (e: any) {
    log(`[session] table window: ${e?.message ?? e}`);
  }
  startRouter(cfg, sid);
  const opened = await openTables(nTables);
  if (opened.length) {
    S.sessions.event(sid, "tables-opened", { want: cfg.tables ?? null, up: opened.filter((r) => r.ok).map((r) => r.slot),
                                             failed: opened.filter((r) => !r.ok).map((r) => r.slot) });
  }
  const joined = TABLES.slot() !== null ? await fanOut("/session/join", { sid, config: cfg }) : [];
  if (joined.length) {
    const ok = joined.filter((r) => r.ok).map((r) => r.slot);
    const bad = joined.filter((r) => !r.ok).map((r) => `${r.slot}: ${pyStr(r.error ?? null)}`);
    log(`[session] ${sid} joined by table(s) ${ok.length ? pyRepr(ok) : "none"}` + (bad.length ? ` · FAILED ${pyRepr(bad)}` : ""));
    S.sessions.event(sid, "tables", { joined: ok, failed: bad });
  }
  return [200, { ok: true, session: rec, tables: joined, opened }];
}

/** A never-ended session another live panel is playing right now is not a leftover. */
async function ownedElsewhere(rec: Record<string, any>): Promise<boolean> {
  const port = (rec.config || {}).panelPort;
  if (!port || port === C.PANEL_PORT || !cdp.listening(port)) return false;
  const st = await getJson(`http://127.0.0.1:${port}/state?light=1`, 5);
  return st.sessionId === rec.id;
}

export async function leftovers(): Promise<any[]> {
  const out: any[] = [];
  for (const r of S.sessions.openSessions()) if (r.id !== S.session.id && !(await ownedElsewhere(r))) out.push(r);
  return out;
}

/** End every never-ended session except `keep` (and tell the tables). */
export async function endOtherOpen(keep: string | null, note: string): Promise<string[]> {
  const ended: string[] = [];
  for (const r of S.sessions.openSessions()) {
    if (r.id === keep || (await ownedElsewhere(r))) continue;
    S.sessions.end(r.id, { hands: sessionHands(r.id), durationMin: pyRound((nowMs() - r.started_at) / 60000, 1),
                           events: (r.events || []).length, recording: null, orphaned: true }, note);
    S.sessions.event(r.id, "ended", { orphaned: true });
    ended.push(r.id);
    try {
      for (const peer of await fanOut("/session/leave", { sid: r.id }, 8)) {
        if (peer.left) log(`[session] slot ${peer.slot} stood down from leftover ${r.id}`);
      }
    } catch (e: any) {
      log(`[session] could not stand tables down from ${r.id}: ${e?.message ?? e}`);
    }
  }
  if (ended.length) log(`[session] ended ${ended.length} leftover session(s): ${ended.join(", ")}`);
  return ended;
}

/** END SESSION = ALSO CLOSE OUT: leave the table, close the windows, then END THIS PROCESS (the next open from
 *  the icon is always the code on disk). The leave runs first; if it fails nothing is closed. */
export async function closeOutAfterEnd(sid: string): Promise<Record<string, any>> {
  if (S.fakeMode) return { left: null, windows: "kept", why: "test rig" };
  if (isClientSite()) {
    const cp = isCp();
    // THE MAIN COINPOKER PANEL IS A TABLE PANEL LIKE ANY OTHER (2026-10-01): ending its session closes its own window
    // only — the leader window (and every other panel) stays, and this process with it: it serves the leader page
    const keep = cp && !C.TAG && !!leaderHwnd();
    later(0.8, async () => {
      await killProfileWindows(C.PROFILE_PANEL);
      if (!keep) standDown("session ended");
    });
    return { left: null, windows: "closing", process: keep ? "kept (it serves the leader window)" : "exiting",
             why: `${cp ? "CoinPoker" : "ClubGG"} tables are left open in the client` };
  }
  if (!(await cdp.available(C.CDP_PORT))) {
    later(0.8, async () => {
      await killProfileWindows(C.PROFILE_PANEL);
      standDown("session ended");
    });
    return { left: null, windows: "closing", process: "exiting", why: "no table window was open" };
  }
  let res: Record<string, any>;
  try {
    markLeaving();
    res = await F.leave(C.CDP_PORT, (m) => log(m));
  } catch (e: any) {
    res = { ok: false, error: String(e?.message ?? e) };
  }
  const left = !!res.ok;
  S.sessions.event(sid, "close-out", { left, note: res.note ?? null, error: res.error ?? null });
  if (!left) {
    log(`[close-out] table NOT left (${res.error || "unknown"}) — windows kept open`);
    return { left: false, windows: "kept", why: res.error || "could not leave the table" };
  }
  later(0.8, async () => {
    if (!(await closeBrowser(C.CDP_PORT))) await killProfileWindows(C.PROFILE_TABLE);
    await killProfileWindows(C.PROFILE_PANEL);
    standDown("session ended");
  });
  return { left: true, windows: "closing", process: "exiting", why: null };
}

export async function sessionEnd(body: Record<string, any>): Promise<Record<string, any>> {
  if (body.all) {
    const ended = await endOtherOpen(S.session.id, body.note || "ended from setup (all leftovers)");
    return { ok: true, ended, kept: S.session.id };
  }
  const sid = body.id || S.session.id;
  if (!sid) return { ok: false, error: "no session to end" };
  const rec = S.sessions.get(sid);
  if (!rec) return { ok: false, error: `no session ${sid}` };
  const live = sid === S.session.id;
  if (live) {
    try {
      archiveHand();
    } catch {}
    // THE OTHER TABLES STOP FIRST (the closing balance brackets the session's hands)
    const left = await fanOut("/session/leave", { sid });
    if (left.length) {
      log(`[session] ${sid}: tables stood down ${pyRepr(left.map((r) => [r.slot, r.hands ?? null]))}`);
      await fanOut("/quit", {}, 8);
      await sleep(1.0);
      TABLES.adopt(1);
      log("[tables] extra tables closed; back to one");
    }
  }
  let closeCents: number | null = null;
  const prof = rec.config && typeof rec.config === "object" ? rec.config.profile ?? null : null;
  if (live && prof && !S.fakeMode) {
    const snap: any = await BAL.snapshot(prof, C.CDP_PORT, sid, "close");
    if (snap.ok) {
      closeCents = snap.amountCents;
      S.sessions.event(sid, "balance", { phase: "close", amountCents: closeCents, how: snap.how ?? null });
      log(`[balance] ${prof} closes at ${BAL.fmt(closeCents)}`);
    } else {
      S.sessions.event(sid, "balance-missed", { phase: "close", reason: snap.reason ?? null });
      log(`[balance] could not record a closing balance: ${pyStr(snap.reason ?? null)} — the session's money is unreconciled`);
    }
  }
  const summary = { hands: sessionHands(sid), durationMin: pyRound((nowMs() - rec.started_at) / 60000, 1),
                    events: (rec.events || []).length, balanceCloseCents: closeCents,
                    recording: live && S.dbg.on ? S.dbg.dir : null };
  if (live) {
    S.study.on = false;
    S.study.text = null;
    S.study.auto = false;
    Object.assign(S.study, { autoRealUntil: 0.0, autoRealHands: 0, autoRealFrom: null, autoRealReason: null });
    setDebug(false);
    S.recPending.on = false;
    S.router.cancel = true;
    S.sessions.event(sid, "ended", { hand: S.handNo });
    Object.assign(S.session, { id: null, rec: null, started: 0.0 });
    Object.assign(S.net, { bad: 0, good: 0, sitout: null, drop: null });   // the guard's stretch belonged to this session
    log(`[session] ${sid} ended · ${pyRepr(summary)}`);
  }
  const out = S.sessions.end(sid, summary, body.note ?? null);
  return { ok: true, session: out };
}

// ---- the table window ------------------------------------------------------------------------------------
/** Open (or retarget) the table window — the Ignition lobby, or the fake table on the test rig. */
export async function openTableWindow(): Promise<void> {
  const area = targetArea();
  const { w, h, x: ax, y: ay } = area;
  const tableUrl = S.fakeMode ? `http://127.0.0.1:${C.PANEL_PORT}/faketable` : C.IGNITION_URL;
  const me = TABLES.slot();
  if (me !== null && !TABLES.isLeader()) {
    if (await cdp.available(C.CDP_PORT)) log(`[table] slot ${me}: reading table ${me} in the client the leader opened`);
    else log(`[table] slot ${me}: waiting for table ${TABLES.LEADER} to open the client`);
    return;
  }
  if (await cdp.available(C.CDP_PORT)) {
    const wantFake = S.fakeMode;
    for (const t of (await cdp.pageTargets(C.CDP_PORT)) || []) {
      const url = t.url || "";
      if (url.startsWith("devtools")) continue;
      if (url.includes("/faketable") !== wantFake) {
        try {
          await cdp.evaluate(t.webSocketDebuggerUrl!, `location.href = ${JSON.stringify(tableUrl)}; true`, 5);
          log(`[table] window was showing the other rig's table — sent it to ${tableUrl}`);
        } catch (e: any) {
          log(`[table] could not retarget the window: ${e?.message ?? e}`);
        }
      }
      break;
    }
    log("[table] already open (CDP up) — not relaunching");
    later(1.0, async () => log(`[layout] ${pyRepr(await layout())}`));
    return;
  }
  const first = TABLES.clientRect(TABLES.count(), { x: ax, y: ay, w, h });
  chromeWindow(tableUrl, C.PROFILE_TABLE, first.x, first.y, first.w, first.h, C.CDP_PORT);
  log(`[table] ${S.fakeMode ? "fake" : "Ignition"} app window ${first.w}x${first.h} (CDP :${C.CDP_PORT})`);
  later(2.5, async () => log(`[layout] ${pyRepr(await layout())}`));
  for (let i = 0; i < 40; i++) {
    if (await cdp.available(C.CDP_PORT)) break;
    await sleep(0.5);
  }
  log(`[table] CDP ${(await cdp.available(C.CDP_PORT)) ? "up" : "NOT up (panel will keep retrying)"}`);
}

// ---- the fake table (test mode) -----------------------------------------------------------------------------
export function fakeSpecFor(slot: number | null): Record<string, any> {
  if (slot !== null && S.faketableSpecs.has(slot)) return S.faketableSpecs.get(slot)!;
  return S.faketableSpec || faketable.EXAMPLE_SPEC;
}

/** Enter test mode with an authored state: the spec, the WS-side hand state seeded from its `node`, and a
 *  CDP-visible browser showing the fake page. */
export async function faketableLoad(spec: Record<string, any>): Promise<Record<string, any>> {
  S.faketableSpec = spec;
  if (TABLES.slot() !== null && !TABLES.isLeader()) {
    await postJson(`http://127.0.0.1:${TABLES.leaderPort()}/faketable/slot`, { slot: TABLES.domSlot(), spec }, 10);
  }
  S.fakeMode = true;
  const node = spec.node || {};
  const bb = 100;
  const cents = (v: any) => (v === null || v === undefined ? null : pyRound(pyFloat(v) * bb));
  const seats = spec.seats || {};
  const dealt: number[] = truthy(node.dealt) ? node.dealt
    : Object.entries(seats).filter(([, s]: [string, any]) => !(s || {}).empty && (s || {}).cards).map(([k]) => pyInt(k)).sort((a, b) => a - b);
  const acts = (node.actions || []).map((a: any) => ({ seat: pyInt(a.seat), type: a.type, cents: cents(a.amount ?? null),
                                                       street: "street" in a ? a.street : "preflop" }));
  const committed = new Map<number, number>();
  for (const [k, v] of Object.entries(node.committed || {})) committed.set(pyInt(k), cents(v) || 0);
  const hero = pyInt(spec.heroSeat || 1);
  S.handNo += 1;
  S.handIds.set(S.handNo, pyStr(node.clientHandId || 9_000_000 + S.handNo));
  Object.assign(S.ws, {
    bb, bbSeen: true,
    dealt: dealt.map((x) => pyInt(x)),
    heroSeat: hero,
    dealer: pyInt(spec.dealerSeat || hero),
    board: (spec.board || []).map(faketable.displayCard),
    heroCards: (spec.heroCards || []).map(faketable.displayCard),
    actions: acts,
    committed,
    maxBet: cents(node.maxBet ?? null) || (committed.size ? Math.max(...committed.values()) : 0),
    actionOn: pyInt(node.toActSeat || hero),
    potCents: cents(spec.potBB ?? null),
    heroFolded: false, handOver: false, endedSince: null,
    actSeen: new TupleSet(), foldedSeats: new Set(), domFolds: new Set(), foldTicks: new Map(),
    // an authored state has no WebSocket money: nothing of the last real hand's may be exported with it
    wsAccount: new Map(), wsFront: new Map(), wsDead: new Map(), wsStale: new Set(),
    domGraceUntil: time() + 1e9,
  });
  S.actionGraceUntil = time() + 1e9;
  const url = `http://127.0.0.1:${C.PANEL_PORT}/faketable`;
  let opened = "reused";
  let existing = await seams.ignitionTarget();
  if (existing && !(existing.url || "").includes("/faketable")) existing = null;
  if (existing) {
    try {
      const me = TABLES.slot();
      const js = me === null ? "location.reload(); true"
        : slotted("(() => {__FRAME__ const f = __frame(__SLOT__); if (!f) return false; f.src = f.src; return true; })()", mySel());
      await cdp.evaluate(existing.webSocketDebuggerUrl, js, 4);
      await sleep(1.2);
      opened = "reloaded";
    } catch {}
  }
  if (!existing) {
    if (await cdp.available(C.CDP_PORT)) {
      for (const method of ["PUT", "GET"]) {
        try {
          const r = await fetchJson(`http://127.0.0.1:${C.CDP_PORT}/json/new?${url}`, { method, timeoutS: 4 });
          if (r.status >= 400) throw new Error(String(r.status));
          opened = "new tab";
          break;
        } catch {
          continue;
        }
      }
    } else {
      const area = targetArea();
      chromeWindow(url, ".profile-faketest", area.x, area.y, Math.trunc(area.w * C.TABLE_FRAC), area.h, C.CDP_PORT);
      opened = "launched";
    }
  }
  log(`[faketable] test mode ON — hand ${S.handNo}, browser ${opened}`);
  return { ok: true, hand: S.handNo, browser: opened };
}

export function faketableStop(): Record<string, any> {
  S.fakeMode = false;
  S.ws.domGraceUntil = 0;
  S.lastArchived.no = S.handNo;
  log("[faketable] test mode off");
  return { ok: true };
}

// ---- stand-down ------------------------------------------------------------------------------------------
/** Archive the hand in flight, give the window back, then go (after the reply is out). */
export function standDown(why = "a new instance"): void {
  setTimeout(() => {
    try {
      archiveHand();
    } catch {}
    try {
      const me = TABLES.slot();
      if (me !== null) TABLES.release(me);
    } catch {}
    log(`[panel] standing down (${why})`);
    process.exit(0);
  }, 200);
}

// ---- the big pieces, watched; a closed panel ends its session -------------------------------------------
export async function healthCheck(): Promise<any[]> {
  const issues: any[] = [];
  const lost = unpinnedTableIssue();
  if (lost) issues.push(lost);
  const api = SES.API().replace(/\/+$/, "");
  if ((await fetchBytes(`${api}/api/dashboard/config`, 5)) === null) {
    issues.push({ level: "down", piece: "study-api", text: `The study API (:${port("api")}) is DOWN — there are no answers at all`,
                  fix: "it restarts itself within a minute; if it stays down, restart the laptop" });
    return issues;
  }
  const charts = (process.env.HRC3MAX_URL || chartsUrl()).replace(/\/+$/, "");
  if ((await fetchBytes(`${charts}/`, 5)) === null) {
    issues.push({ level: "down", piece: "chart-server", text: `The chart server (:${port("charts")}) is DOWN — preflop chart answers (3-handed, heads-up) are OFF`,
                  fix: "it restarts itself within a minute" });
  }
  const raw = await fetchBytes(`${api}/api/dashboard/gtow-status`, 10);
  let g: any = {};
  try {
    g = raw ? JSON.parse(new TextDecoder().decode(raw)) : {};
  } catch {
    g = {};
  }
  const sess = (g.sessions || []).filter((x: any) => x.enabled ?? true);
  const liveS = sess.filter((x: any) => x.tokenLive);
  if (raw !== null && sess.length && !liveS.length) {
    issues.push({ level: "down", piece: "gtow", text: "GTO Wizard is NOT CONNECTED — postflop and multiway answers are OFF",
                  detail: sess.map((x: any) => `${pyStr(x.id ?? null)}: ${pyStr(x.text ?? null)}`).join(" · "),
                  fix: "is GTO Wizard up? Sign in again in its Chrome window if it shows the login page" });
  } else if (liveS.length && liveS.length < sess.length) {
    const off = sess.filter((x: any) => !x.tokenLive);
    issues.push({ level: "partial", piece: "gtow",
                  text: "GTO Wizard is PARTLY connected — " + off.map((x: any) => `the ${pyStr(x.id ?? null)} account${!x.multiway ? " (heads-up)" : ""} is down`).join(", "),
                  detail: off.map((x: any) => `${pyStr(x.id ?? null)}: ${pyStr(x.text ?? null)}`).join(" · ") });
  }
  return issues;
}

export async function healthLoop(): Promise<void> {
  for (;;) {
    try {
      const issues = await healthCheck();
      Object.assign(S.health, { issues, at: time() });
    } catch (e: any) {
      log(`[health] check failed: ${e?.message ?? e}`);
    }
    await sleep(15);
  }
}

const PANEL_GONE_S = 8;

/** Every 2 s while a session runs: is this wrapper's panel window still there? Gone for 8 s = closed. */
export async function panelWatchLoop(): Promise<void> {
  for (;;) {
    await sleep(2);
    try {
      const pw = S.panelWatch;
      const sid = S.session.id;
      if (!sid || S.fakeMode || TABLES.slot() !== null || C.HEADLESS) {
        Object.assign(pw, { sid, seen: false, missingSince: null });
        continue;
      }
      if (pw.sid !== sid) Object.assign(pw, { sid, seen: false, missingSince: null });
      if (panelHwnd()) {
        Object.assign(pw, { seen: true, missingSince: null });
        continue;
      }
      if (!pw.seen) continue;
      if (pw.missingSince === null) {
        pw.missingSince = time();
        continue;
      }
      if (time() - pw.missingSince < PANEL_GONE_S) continue;
      log(`[session] ${sid}: the panel window was closed — ending the session`);
      S.sessions.event(sid, "panel-closed", { goneS: pyRound(time() - pw.missingSince, 1) });
      Object.assign(pw, { seen: false, missingSince: null });
      // COINPOKER: a panel is its table (Brady, 2026-10-01) — closing it leaves the table too, once the hand is over
      if (isCp()) {
        cpCloseOut("the panel window was closed");
        continue;
      }
      const res = await sessionEnd({ note: "ended: the panel window was closed" });
      if (res.ok && isClientSite()) await closeOutAfterEnd(sid);
    } catch (e: any) {
      log(`[session] panel watch: ${e?.message ?? e}`);
    }
  }
}

// ---- CoinPoker: a panel and its table close together; the leader closes them all ----------------------------
/** How long a close-out waits for hero's hand to finish before it closes the table anyway (sat out by then). */
export const CP_CLOSE_HAND_WAIT_S = 180;
/** After the table window is asked to close: how long its process gets to go before the close-out says it did not. */
const CP_TABLE_GONE_S = 12;

/** What a test replaces: the table, the window and the process (the order and the decisions are the code's). */
export const cpCloseSeams = {
  room: (): string | null => CP.table()?.room ?? null,
  heroSeated: (): boolean => !!CP.table()?.heroSeated,
  sitOut: (): Promise<Record<string, any>> => CP.sitout(true, false),
  /** hero is dealt into a hand that has not ended for him */
  heroInHand: (): boolean => {
    const h = CP.hand();
    return !!(h && !h.ended && h.heroSeatId != null && (h.liveSeats || []).includes(h.heroSeatId));
  },
  /** ask the table window to close (its X button); true once the table's process is gone */
  closeTable: async (room: string): Promise<boolean> => {
    const { tableWindow } = await import("./sites/cpActions");
    const { Site } = await import("./sites/coinpoker");
    const h = tableWindow(room);
    if (h === null) return !Site.openRooms().has(room);
    W.closeWindow(h);
    const t0 = time();
    while (time() - t0 < CP_TABLE_GONE_S) {
      await sleep(0.5);
      if (!Site.openRooms().has(room)) return true;
    }
    return false;
  },
  endSession: (note: string): Promise<Record<string, any>> => sessionEnd({ note }),
  closePanel: (): Promise<number> => killProfileWindows(C.PROFILE_PANEL),
  leaderUp: (): boolean => !!leaderHwnd(),
  exit: (why: string): void => standDown(why),
};

/**
 * CLOSE A COINPOKER PANEL AND ITS TABLE (Brady, 2026-10-01: "a sub-panel … if closed, closes just itself + the coinpoker
 * table/session attached"; the leader closes them all). In order, never mid-hand:
 *   1. tick "sit out next hand", so no new hand is dealt to hero while this runs;
 *   2. let the hand hero is in finish (up to CP_CLOSE_HAND_WAIT_S; the table window stays up to act in by hand);
 *   3. end the session;
 *   4. close the table window in the client, as its X does — the client takes hero off the table;
 *   5. close the panel window, and end this process — unless it is the main panel's and the leader window is still
 *      up: that process serves the leader page (/admin), so it stays, with no session, until the leader closes.
 * Runs in the background (the caller returns at once); `S.cpClosing` says it is under way, on /state and to a second
 * caller, which it refuses. A step that fails is logged and the next one still runs.
 */
export function cpCloseOut(why: string, opts: { keepProcess?: boolean; closePanel?: boolean } = {}): Record<string, any> {
  if (S.cpClosing) return { ok: false, why: `already closing (${S.cpClosing.why})` };
  const room = cpCloseSeams.room();
  S.cpClosing = { why, room, at: nowMs(), step: "sitting out" };
  const sid = S.session.id;
  if (sid) S.sessions.event(sid, "cp-close-out", { why, room });
  log(`[close-out] CoinPoker: ${why} — ${room ? `leaving ${room} after this hand` : "no table attached"}`);
  const run = async () => {
    // each step on its own: one that throws is logged and the next still runs — a close-out never stops half way
    const step = async (name: string, f: () => unknown) => {
      if (S.cpClosing) S.cpClosing.step = name;
      try {
        await f();
      } catch (e: any) {
        log(`[close-out] ${name}: ${e?.message ?? e}`);
      }
    };
    await step("sitting out", async () => {
      if (!room || !cpCloseSeams.heroSeated()) return;
      log(`[close-out] sit out next hand: ${pyRepr(await cpCloseSeams.sitOut())}`);
    });
    await step("waiting for the hand to finish", async () => {
      const t0 = time();
      while (room && cpCloseSeams.heroInHand() && time() - t0 < CP_CLOSE_HAND_WAIT_S) await sleep(1);
      if (room && cpCloseSeams.heroInHand()) log(`[close-out] the hand is still running after ${CP_CLOSE_HAND_WAIT_S} s — closing the table anyway`);
    });
    await step("ending the session", async () => {
      if (S.session.id) await cpCloseSeams.endSession(`ended: ${why}`);
    });
    await step("closing the table", async () => {
      if (!room) return;
      const gone = await cpCloseSeams.closeTable(room);
      log(gone ? `[close-out] ${room} closed in the client` : `[close-out] ${room} did NOT close — the client kept the window (a confirmation?); close it by hand`);
      if (sid) S.sessions.event(sid, "cp-table-closed", { room, ok: gone });
    });
    const keep = opts.keepProcess ?? (!C.TAG && cpCloseSeams.leaderUp());
    await step("closing the panel", async () => {
      if (opts.closePanel !== false) await cpCloseSeams.closePanel();
    });
    S.cpClosing = null;
    if (!keep) cpCloseSeams.exit(why);
    else log("[close-out] this process serves the leader window — it stays, with no session");
  };
  void run();
  return { ok: true, closing: true, room };
}

/**
 * THE LEADER CLOSES THEM ALL (Brady, 2026-10-01): every CoinPoker panel this install is running — the tagged ones on
 * their own ports, and this one — closes itself and its table (cpCloseOut), each after its own hand; then the leader
 * window itself goes and this process ends. `others` is the panel ports to tell (the admin page's list).
 */
export async function cpCloseAll(why: string, others: number[]): Promise<Record<string, any>> {
  const told = await Promise.all(others.map(async (p) => {
    try {
      const r = await postJson(`http://127.0.0.1:${p}/panel/close-out`, { why }, 10);
      return { port: p, ok: !!(r && (r as any).ok) };
    } catch (e: any) {
      return { port: p, ok: false, why: String(e?.message ?? e) };
    }
  }));
  log(`[close-out] leader: closing every CoinPoker panel (${why}) — told ${told.map((t) => `:${t.port} ${t.ok ? "ok" : "failed"}`).join(", ") || "no other panel"}`);
  S.leaderWatch.closingAll = true;
  const mine = S.session.id || CP.table() ? cpCloseOut(why, { keepProcess: true }) : { ok: true, closing: false };
  // the leader window and this process go once this panel's own close-out is done
  void (async () => {
    while (S.cpClosing) await sleep(1);
    await killProfileWindows(C.PROFILE_LEADER);
    await killProfileWindows(C.PROFILE_PANEL);
    standDown(why);
  })();
  return { ok: true, told, mine };
}

/** Every 2 s on the main CoinPoker process: the leader window, once seen, gone for PANEL_GONE_S = close them all. */
export async function leaderWatchLoop(): Promise<void> {
  for (;;) {
    await sleep(2);
    try {
      const lw = S.leaderWatch;
      if (C.TAG || S.fakeMode || C.HEADLESS || lw.closingAll) continue;
      if (time() < lw.quietUntil) continue;                     // we are reopening it ourselves (openLeader)
      if (leaderHwnd()) {
        Object.assign(lw, { seen: true, missingSince: null });
        continue;
      }
      if (!lw.seen) continue;
      if (lw.missingSince === null) {
        lw.missingSince = time();
        continue;
      }
      if (time() - lw.missingSince < PANEL_GONE_S) continue;
      log("[close-out] the CoinPoker leader window was closed — closing every panel and its table");
      if (S.session.id) S.sessions.event(S.session.id, "leader-closed", { goneS: pyRound(time() - lw.missingSince, 1) });
      Object.assign(lw, { seen: false, missingSince: null });
      const { cpPanelPorts } = await import("./admin");
      await cpCloseAll("the leader window was closed", await cpPanelPorts());
    } catch (e: any) {
      log(`[close-out] leader watch: ${e?.message ?? e}`);
    }
  }
}

// ---- ClubGG: which table the reader reads ------------------------------------------------------------------

/** Attach the reader to one open ClubGG table (by window handle; the title re-finds it if the window is reopened). */
export function cggReattach(key: string | null, title: string | null = null): [number, Record<string, any>] {
  const t = key ? CggSite.tables().find((x) => String(x.hwnd) === key) ?? null : null;
  if (key && !t) return [409, { ok: false, why: "that table is not open in ClubGG" }];
  CGG.attach(key, t?.title ?? title);
  S.study.text = null;
  S.study.pick = null;
  if (S.session.rec) {
    const cfg = { ...(S.session.rec.config || {}), cggTable: key, cggTitle: t?.title ?? null };
    S.session.rec.config = cfg;
    S.sessions.setConfig(S.session.id!, cfg);
    S.sessions.event(S.session.id!, "clubgg-attach", { key, title: t?.title ?? null });
  }
  log(`[clubgg] attached to ${t ? cggLabel(t.title) : "no table"}`);
  return [200, { ok: true, key, title: t?.title ?? null, label: t ? cggLabel(t.title) : null }];
}

// ---- CoinPoker: the leader window and the admin page ------------------------------------------------------
export const ADMIN_PORTS = [livePort("panel"), ...Array.from({ length: 20 }, (_, i) => livePort("panel") + 20 + i)];

/** THE LEADER PANEL: while playing CoinPoker the main panel keeps the admin page up in a second window. */
export async function openLeader(): Promise<void> {
  if (C.TAG || S.fakeMode) return;
  // the leader watch must not read our own reopen as the leader being closed
  Object.assign(S.leaderWatch, { quietUntil: time() + 30, seen: false, missingSince: null, closingAll: false });
  if (leaderHwnd()) await killProfileWindows(C.PROFILE_LEADER);
  const area = otherArea() || targetArea();
  const w = Math.min(area.w, Math.max(520, Math.floor(area.w / 3))), ht = Math.trunc(area.h * 0.7);
  chromeWindow(`http://127.0.0.1:${C.PANEL_PORT}/admin`, C.PROFILE_LEADER, area.x, area.y, w, ht);
  log("[coinpoker] leader window opened");
}

