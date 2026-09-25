/**
 * DECLARED SESSIONS — launch.py's session layer: start / join / leave / end, the table ROUTER (auth gate → the
 * declared format → watch), the answer chain keeper, several tables in one session, the fake-table test mode,
 * stand-down, and packaged-install updates.
 *
 * A session is declared ONCE, on the leader's setup page; every other live table joins it. A follower never
 * writes a session record, never takes a balance reading and never ends anything.
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
import { CP, S, TupleSet, isCp, seams } from "./state";
import * as TABLES from "./tables";
import * as faketable from "./faketable";
import { SITE as CP_SITE, FORMATS as CP_FORMATS } from "./sites/coinpoker";
import { archiveHand, sessionHands } from "./archive";
import { setDebug } from "./ignition/recorder";
import { slotted } from "./ignition/dom";
import { setAuto } from "./relay";
import { applyLayout, chromeWindow, closeBrowser, killProfileWindows, leaderHwnd, otherArea, panelHwnd, targetArea } from "./windows";

const layout = () => applyLayout(seams.ignitionTarget);

/** The lobby call a test replaces (Python's tests stubbed formats.leave). */
export const sessionSeams = {
  leave: (port: number) => F.leave(port),
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
  const r = await apiPost("/api/study-poller/start", { assistiveUrl: pub });
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

/** A table that went away AFTER we had them all was closed on purpose: honour it. */
export function honourClosedTables(cfg: Record<string, any>, seatedNow: number): number {
  let want = tablesWanted(cfg);
  const reached = S.seating.reached || 0;
  if (!reached || seatedNow >= reached) return want;
  const gone = reached - seatedNow;
  S.seating.reached = seatedNow;
  for (let i = 0; i < gone; i++) S.closedTables.add(nextUnclosedSlot(cfg));
  want = tablesWanted(cfg);
  feedAdd(`A table was closed — not re-seating it (the session now wants ${want})`);
  log(`[tables] seated count fell to ${seatedNow}; honouring it, wanted is now ${want}`);
  if (S.session.id) S.sessions.event(S.session.id, "table-closed", { slot: null, why: "closed by hand" });
  return want;
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
    if (st.state === "seated") {
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
    if (S.router.state === "done" || S.router.state === "off-format") {
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

export function startRouter(cfg: Record<string, any>, sid: string): void {
  S.router.cancel = true;
  later(0.1, () => routeSession(cfg, sid));
}

export function resumeRecordingIfPending(): void {
  if (S.recPending.on) {
    S.recPending.on = false;
    setDebug(true);
  }
}

// ---- preflight, the checklist, the brief ------------------------------------------------------------------
export async function preflight(preset: string, cfg: Record<string, any>, registry: any = undefined): Promise<Record<string, any>> {
  const pf: any = await SES.runPreflight(preset, cfg, S.fakeMode, registry !== undefined ? registry : await SES.fetchRegistry(), C.CDP_PORT);
  if (cfg.site === CP_SITE) {
    pf.checks = [...pf.checks, ...CP.preflight(cfg.cpTable ?? null)];
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
  if (cfg.site === CP_SITE) {
    const pf = await preflight(preset, cfg, registry);
    const t = CP.table();
    if (t && rec) for (const c of pf.checks) if (c.id === "cp-table") c.required = !!cfg.answers;
    S.chain.lastCheck = time();
    return { ok: pf.ok, checks: pf.checks, blockers: pf.blockers, checkedAt: nowMs(), preset: rec ? rec.preset ?? null : null,
             session: await sessionBrief(), chain: { attempting: S.chain.attempting, lastResult: S.chain.lastResult } };
  }
  const pf: any = await SES.runPreflight(preset, cfg, S.fakeMode, registry, C.CDP_PORT);
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
  S.site.id = cfg.site === CP_SITE ? CP_SITE : "ignition";
  CP.attach(cfg.site === CP_SITE ? cfg.cpTable ?? null : null);
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
  st.autoDeclared = !!cfg.autoExecute;
  st.autoDeclaredReal = !!cfg.autoRealMoney;
  st.autoDeclaredBudget = { ...(cfg.autoBudget || { minutes: 30, hands: 50 }) };
  if (st.autoDeclared) {
    const res = setAuto(true, {
      allowReal: st.autoDeclaredReal, minutes: st.autoDeclaredBudget?.minutes ?? null, hands: st.autoDeclaredBudget?.hands ?? null,
      reason: "declared at session setup",
    });
    if (!res.ok) log(`[pick] declared auto not armed yet: ${pyStr(res.error ?? null)}`);
  }
  if (isCp()) {
    S.recPending.on = false;
    setDebug(false);
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

/** Hero has cards in front of him right now — money a Leave would forfeit. */
export function inAHand(): boolean {
  if (S.ws.handOver || S.ws.heroFolded) return false;
  return truthy(S.ws.heroCards) || S.liveStatus.hero === "in-hand";
}

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
    res = (await cdp.available(C.CDP_PORT)) ? await sessionSeams.leave(C.CDP_PORT) : { ok: true, note: "no table window" };
  } catch (e: any) {
    res = { ok: false, error: String(e?.message ?? e) };
  }
  S.router.cancel = true;
  routerSet("left", `table closed — ${why}`);
  return res;
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
  Object.assign(S.session, { id: sid, rec, started: time() });
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
    const cands = [process.env.RCLONE, join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "rclone.exe")];
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
  if (C.PANEL_PORT !== 7700) args.push("-WrapperArgs", `--panel-port ${C.PANEL_PORT} --cdp-port ${C.CDP_PORT}` + (S.fakeMode ? " --fake" : ""));
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
  if (cfg.clearCache) {
    await clearTableCache();
    S.sessions.event(sid, "cache-cleared", {});
  }
  await autoOpenBalance(sid, cfg.profile ?? null, "session start");
  log(`[session] ${sid} started · ${preset} · answers=${cfg.answers ? "on" : "off"} recording=${cfg.recording ? "on" : "off"}`);
  const nTables = pyInt(cfg.tables || 1);
  if (nTables > 1) TABLES.adopt(nTables);
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
  if (isCp()) {
    later(0.8, async () => {
      await killProfileWindows(C.PROFILE_PANEL);
      if (!C.TAG) await killProfileWindows(C.PROFILE_LEADER);
      standDown("session ended");
    });
    return { left: null, windows: "closing", process: "exiting", why: "CoinPoker tables are left open in the client" };
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
        : slotted("(() => {__FRAME__ const f = __frame(__SLOT__); if (!f) return false; f.src = f.src; return true; })()", TABLES.domSlot());
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
  const api = SES.API().replace(/\/+$/, "");
  if ((await fetchBytes(`${api}/api/dashboard/config`, 5)) === null) {
    issues.push({ level: "down", piece: "study-api", text: "The study API (:2000) is DOWN — there are no answers at all",
                  fix: "it restarts itself within a minute; if it stays down, restart the laptop" });
    return issues;
  }
  const charts = (process.env.HRC3MAX_URL || "http://127.0.0.1:8777").replace(/\/+$/, "");
  if ((await fetchBytes(`${charts}/`, 5)) === null) {
    issues.push({ level: "down", piece: "chart-server", text: "The chart server (:8777) is DOWN — preflop chart answers (3-handed, heads-up) are OFF",
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
      const res = await sessionEnd({ note: "ended: the panel window was closed" });
      if (res.ok && isCp()) await closeOutAfterEnd(sid);
    } catch (e: any) {
      log(`[session] panel watch: ${e?.message ?? e}`);
    }
  }
}

// ---- CoinPoker: the leader window and the admin page ------------------------------------------------------
export const ADMIN_PORTS = [7700, ...Array.from({ length: 20 }, (_, i) => 7720 + i)];

/** THE LEADER PANEL: while playing CoinPoker the main panel keeps the admin page up in a second window. */
export async function openLeader(): Promise<void> {
  if (C.TAG || S.fakeMode) return;
  if (leaderHwnd()) await killProfileWindows(C.PROFILE_LEADER);
  const area = otherArea() || targetArea();
  const w = Math.min(area.w, Math.max(520, Math.floor(area.w / 3))), ht = Math.trunc(area.h * 0.7);
  chromeWindow(`http://127.0.0.1:${C.PANEL_PORT}/admin`, C.PROFILE_LEADER, area.x, area.y, w, ht);
  log("[coinpoker] leader window opened");
}

