/**
 * THE RELAY — an ASSISTIVE INPUT: it actuates only a control the user has just pressed on the panel (or, with
 * auto-execute armed on a PRACTICE table, the study pick), on the table they are already sitting at. It never
 * acts on anything the client is not currently offering. launch.py: act, raise_to, the pick → relay path, the
 * told-vs-did postcondition, the time bank.
 *
 * AUTO-EXECUTE IS PRACTICE-ONLY. The Python wrapper had a temporary real-money testing allowance
 * (/study-auto allowRealMoney); it is deliberately NOT ported (2026-09-24): auto arms on a practice table
 * (the client's playMode=fun) or the fake table, and nowhere else.
 */
import * as cdp from "./cdp";
import { nowMs, sleep, time } from "./clock";
import { feedAdd, log } from "./feed";
import { fmtFixed, pyFloat, pyFloatStr, pyInt, pyRepr, pyReprStr, pyRound, pyStr } from "./py";
import { CP, S, isCp, seams } from "./state";
import * as TABLES from "./tables";
import { ACTION_RE, findInputJs, modalOf, pointProbeJs, splitStrip, tableJs } from "./ignition/dom";
import { handState, toActSources } from "./ignition/hand";
import { closeBuyPanel } from "./topup";

export const STUDY_ANSWER_TTL_MS = 3000;
const PICK_TTL_S = STUDY_ANSWER_TTL_MS / 1000;
export const AUTO_DELAY_S: [number, number] = [1.5, 2.0];
const VERIFY_DEADLINE_S = 2.5;
const VERIFY_ATTEMPTS = 2;
const RAISE_TOL = 0.12;
const PICK_NOT_FIRED_S = 1.5;
const TIME_BANK_COOLDOWN_S = 5.0;
const BET_INPUT_MAX_DX = 0.5;
const BET_INPUT_MAX_DY_ROWS = 3.0;

/** A Python dict lookup on a value that is a Map here (int keys) or a plain object (from JSON). */
export function dget(o: any, k: unknown): any {
  if (o === null || o === undefined) return undefined;
  if (o instanceof Map) return o.get(k);
  return o[String(k)];
}

/** The displayable answer {text, pick, roll, note} — only while the toggle is on and the push is fresh. */
export function currentAnswer(): Record<string, any> | null {
  const st = S.study;
  if (!st.on || !st.text) return null;
  if ((time() - st.at) * 1000 >= STUDY_ANSWER_TTL_MS) return null;
  return { text: st.text, pick: st.pick, roll: st.roll, note: st.note };
}

/** WHY there is no answer, when there is none (the same freshness gate, a separate channel). */
export function currentNote(): string | null {
  const st = S.study;
  if (!st.on || st.text || !st.note) return null;
  if ((time() - st.at) * 1000 >= STUDY_ANSWER_TTL_MS) return null;
  return st.note;
}

// ---- the press -------------------------------------------------------------------------------------------
/** None if that page point is inside THIS table, else why it is not (the client's own hit-testing decides). */
export async function pointIsMyTable(ws: string, x: number, y: number): Promise<string | null> {
  const me = TABLES.domSlot();
  if (me === null) return null;
  let got: any;
  try {
    got = await cdp.evaluate(ws, pointProbeJs(x, y), 4);
  } catch (e: any) {
    return `could not check which table that point is on: ${e?.message ?? e}`;
  }
  if (got === String(me)) return null;
  if (got === "unknown") return null;
  const g = pyStr(got);
  return /^-*\d+$/.test(g) && /\d/.test(g)
    ? `that press would land on table ${pyInt(g) + 1}, not table ${pyStr(TABLES.slot())} — refusing`
    : `that press would not land on table ${pyStr(TABLES.slot())} (${g})`;
}

/** Make the page render, or say why it cannot (a sleeping monitor cannot be woken by bringToFront). */
export async function ensureVisible(ws: string): Promise<string | null> {
  try {
    if ((await cdp.evaluate(ws, "document.visibilityState", 3)) === "visible") return null;
    await seams.cdpSeq(ws, [["Page.bringToFront", {}]]);
    if ((await cdp.evaluate(ws, "document.visibilityState", 3)) === "visible") return null;
    return "the table window is not rendering (its screen is off or asleep, or the window is minimized) — Chrome parks clicks on a page producing no frames";
  } catch (e: any) {
    return `could not check the table window: ${e?.message ?? e}`;
  }
}

async function cdpSeqReal(ws: string, cmds: [string, Record<string, unknown>][]): Promise<void> {
  await cdp.commands(ws, cmds, 5);
}
seams.cdpSeq = cdpSeqReal;

/** Relay ONE human-chosen press: re-read the strip, match the label within its OWN row, click its centre. */
async function actReal(label: string, kind = "action"): Promise<Record<string, any>> {
  if ((kind === "action" || kind === "preset") && S.topupPanel.open) {
    // OUR OWN MODAL FIRST: the Buy-chips panel renders over the action strip
    S.topupAbort = true;
    await closeBuyPanel();
    await sleep(0.4);
  }
  const t = await seams.ignitionTarget();
  if (!t) return { ok: false, reason: "poker client not open" };
  const ws = t.webSocketDebuggerUrl;
  let d: Record<string, any>;
  try {
    d = (await cdp.evaluate(ws, tableJs(TABLES.domSlot()), 6)) || {};
  } catch (e: any) {
    return { ok: false, reason: `table read failed: ${e?.message ?? e}` };
  }
  if (!d.seated) return { ok: false, reason: "no table tab open" };
  if ((kind === "action" || kind === "preset") && modalOf(d)) {
    return { ok: false, reason: "a client notice is over the action strip (seen on the press's own read)" };
  }
  const [actions, presets] = splitStrip(d);
  const pool: any[] = kind === "preset" ? presets : kind === "action" ? actions : d.buttons ?? [];
  const want = label.trim().toLowerCase();
  let hit = pool.find((b) => String(b.text).toLowerCase() === want);
  if (!hit) {
    const m = ACTION_RE.exec(label);
    const parts = label.split(/\s+/).filter(Boolean);
    const word = (m ? m[0] : parts.length ? parts[0]! : label).toLowerCase();
    hit = pool.find((b) => String(b.text).toLowerCase().startsWith(word));
  }
  const offer = pool.map((b) => b.text);
  if (!hit) return { ok: false, reason: `'${label}' not on offer (${kind})`, offer };
  const lk = await TABLES.pressLock();
  try {
    const blind = await ensureVisible(ws);
    if (blind) return { ok: false, reason: blind, offer };
    const px = hit.x + hit.w / 2, py = hit.y + hit.h / 2;
    const wrong = await pointIsMyTable(ws, px, py);
    if (wrong) return { ok: false, reason: wrong, offer };
    try {
      await cdp.dispatchClick(ws, px, py);
    } catch (e: any) {
      return { ok: false, reason: `click did not go through: ${e?.message ?? e}`, offer };
    }
  } finally {
    lk.release();
  }
  const out: Record<string, any> = { ok: true, clicked: hit.text, kind, at: [hit.x + Math.floor(hit.w / 2), hit.y + Math.floor(hit.h / 2)] };
  if (lk.waited) out.pressWaitedS = lk.waited;
  if (lk.forced) out.pressLockForced = true;
  return out;
}
seams.act = actReal;
export const act = (label: string, kind = "action") => seams.act(label, kind);

/** The client's BET field among everything else on screen: [input, refusal]. */
export function pickBetInput(inputs: any[], anchor: any, frameW: number | null = null): [any, string | null] {
  if (!inputs.length) return [null, "no bet input on screen — not a raise spot?"];
  if (anchor === null || anchor === undefined) {
    return inputs.length === 1 ? [inputs[0], null] : [null, `${inputs.length} inputs on screen and no RAISE/BET button to tell them apart`];
  }
  const ay = anchor.y ?? null;
  const sameRow = (i: any) => (ay === null || !i.h ? true : Math.abs(i.y - ay) <= i.h * BET_INPUT_MAX_DY_ROWS);
  const rowInputs = inputs.filter(sameRow);
  if (!rowInputs.length) {
    const off = Math.min(...inputs.map((i) => Math.abs(i.y - ay)));
    return [null, `the nearest input is ${pyStr(off)}px above/below the RAISE/BET button — a different row, not the bet field`];
  }
  let near = rowInputs[0];
  for (const i of rowInputs) if (Math.abs(i.x - anchor.x) < Math.abs(near.x - anchor.x)) near = i;
  const dx = Math.abs(near.x - anchor.x);
  if (frameW && dx > frameW * BET_INPUT_MAX_DX) return [null, `the nearest input is ${pyStr(dx)}px from the RAISE/BET button — not the bet field`];
  return [near, null];
}

/** Custom raise: type an exact BB amount into the client's own bet field, then press its RAISE TO (or BET). */
async function raiseToReal(amount: string, strict = false): Promise<Record<string, any>> {
  amount = amount.trim().replaceAll(",", ".");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(amount)) return { ok: false, reason: `bad amount ${pyReprStr(amount)} — digits only, in BB` };
  const t = await seams.ignitionTarget();
  if (!t) return { ok: false, reason: "poker client not open" };
  const ws = t.webSocketDebuggerUrl;
  let d: Record<string, any>;
  try {
    d = (await cdp.evaluate(ws, findInputJs(TABLES.domSlot()), 6)) || {};
  } catch (e: any) {
    return { ok: false, reason: `input lookup failed: ${e?.message ?? e}` };
  }
  let [inp, refusal] = pickBetInput(d.inputs || [], d.anchor ?? null, d.frameW ?? null);
  if (refusal) {
    if (d.buyPanel) refusal += " — the Buy-chips panel is open over the strip";
    return { ok: false, reason: refusal };
  }
  const wrong = await pointIsMyTable(ws, inp.x, inp.y);
  if (wrong) return { ok: false, reason: wrong };
  const base = { x: inp.x, y: inp.y, button: "left" };
  const lk = await TABLES.pressLock();
  try {
    const blind = await ensureVisible(ws);
    if (blind) return { ok: false, reason: blind };
    await seams.cdpSeq(ws, [
      ["Input.dispatchMouseEvent", { type: "mouseMoved", x: inp.x, y: inp.y }],
      ["Input.dispatchMouseEvent", { ...base, type: "mousePressed", clickCount: 1 }],
      ["Input.dispatchMouseEvent", { ...base, type: "mouseReleased", clickCount: 1 }],
      ["Input.dispatchMouseEvent", { ...base, type: "mousePressed", clickCount: 3 }],
      ["Input.dispatchMouseEvent", { ...base, type: "mouseReleased", clickCount: 3 }],
      ["Input.insertText", { text: amount }],
    ]);
  } finally {
    lk.release();
  }
  await sleep(0.25);
  if (strict) {
    let got: string, gv: number;
    try {
      const d2 = (await cdp.evaluate(ws, findInputJs(TABLES.domSlot()), 6)) || {};
      const [back, why2] = pickBetInput(d2.inputs || [], d2.anchor ?? null, d2.frameW ?? null);
      if (back === null) return { ok: false, reason: `could not read the bet field back — ${why2}`, typed: amount };
      got = pyStr(back.value ?? "").replaceAll(",", ".");
      gv = pyFloat(got.replace(/[^\d.]/g, "") || "nan");
    } catch (e: any) {
      return { ok: false, reason: `could not read the bet field back: ${e?.message ?? e}`, typed: amount };
    }
    if (!(Math.abs(gv - pyFloat(amount)) <= 0.011)) {
      return { ok: false, reason: `client changed ${amount} to ${got} (min/max clamp) — not pressed`, typed: amount, field: got };
    }
  }
  let res = await act("raise", "action");
  if (!res.ok) {
    const alt = await act("bet", "action");
    if (alt.ok) res = alt;
  }
  return { ok: res.ok ?? false, typed: amount, confirm: res };
}
seams.raiseTo = raiseToReal;
export const raiseTo = (amount: string, strict = false) => seams.raiseTo(amount, strict);

// ---- the study pick → the relay ----------------------------------------------------------------------------
/** What relay call a pick label means (HRC "Raise 2.5", GTO Wizard "RAISE 12", MES "Bet 4.5bb", "Bet 33%"). */
export function pickPlan(pick: string | null | undefined, potBb: number | null = null): Record<string, any> | null {
  if (!pick) return null;
  const s = pick.trim().toLowerCase();
  if (s.startsWith("fold")) return { kind: "action", label: "fold" };
  if (s.startsWith("check")) return { kind: "action", label: "check" };
  if (s.startsWith("call") || s.startsWith("limp")) return { kind: "action", label: "call" };
  if (/^(all[ -]?in|jam|shove|rai\b)/.test(s)) return { kind: "action", label: "all-in" };
  if (s.startsWith("raise") || s.startsWith("bet") || /^r\d/.test(s)) {
    const verb = s.startsWith("bet") ? "bet" : "raise";
    const m = /(\d+(?:\.\d+)?)\s*(%|bb)?/.exec(s);
    if (!m) return { kind: "action", label: verb };
    let size = pyFloat(m[1]);
    if (m[2] === "%") {
      if (potBb === null || potBb === undefined || potBb <= 0) return null;
      size = pyRound(size / 100 * potBb, 2);
    }
    if (size <= 0) return null;
    return { kind: "raise-to", amount: fmtFixed(size, 2).replace(/0+$/, "").replace(/\.$/, ""), verb };
  }
  return null;
}

/** Can the current pick be executed right now? Every guard names its reason. */
export function pickReady(): Record<string, any> {
  const st = S.study;
  const out: Record<string, any> = { ok: false, reason: null, pick: st.pick ?? null, plan: null, key: st.decisionKey ?? null };
  const no = (reason: string) => {
    out.reason = reason;
    return out;
  };
  if (!st.on) return no("answers are off");
  if (!st.text || !st.pick) return no("no pick yet");
  if (time() - st.at > PICK_TTL_S) return no("pick is stale (poller not refreshing it)");
  const key = st.decisionKey ?? null;
  if (!key || st.handId === null || st.handId === undefined) return no("pick carries no decision key (poller predates this)");
  out.key = `${pyStr(st.handId)}|${key}`;
  if (st.executed === out.key) return no("already executed for this decision");
  if (isCp()) {
    const hh = handState();
    if (!(hh && (hh.currentNode || {}).toActIsHero)) return no("not your turn (CoinPoker has not asked you to act)");
  } else if (!S.liveStatus.toAct) {
    return no("not your turn (no turn buttons on the table)");
  }
  if (!isCp() && S.liveStatus.modal) {
    return no(`a client notice is on screen — ${S.liveStatus.modal.harmless ? "dismissing it" : "close it first"}`);
  }
  if (!isCp() && S.liveStatus.buyPanel) return no("Buy-chips panel is over the action strip");
  const h = handState();
  if (!h) return no("no hand exported");
  if (h.heroFolded || h.ended) return no("hand is over for you");
  if (st.handId !== h.handId) return no(`pick was for hand #${pyStr(st.handId)}, table is on #${h.handId}`);
  let kStreet: any, kN: number;
  try {
    const k = JSON.parse(key);
    if (!Array.isArray(k) && typeof k !== "string") throw new Error("not subscriptable");
    kStreet = k[0];
    if (kStreet === undefined) throw new Error("index");
    kN = pyInt(k[4]);
  } catch {
    return no("decision key unreadable");
  }
  if (kStreet !== h.street || kN !== h.actions.length) {
    return no(`pick was for ${pyStr(kStreet)} after ${kN} actions; table is ${h.street} after ${h.actions.length}`);
  }
  out.kN = kN;
  const plan = pickPlan(st.pick, (h.currentNode || {}).pot ?? null);
  if (!plan) return no(`cannot map pick ${pyReprStr(String(st.pick))} to a table action`);
  Object.assign(out, { ok: true, plan });
  return out;
}

async function actuate(plan: Record<string, any>): Promise<Record<string, any>> {
  if (isCp()) return CP.actuate(plan, { auto: S.study.execSource === "auto" });
  if (plan.kind === "raise-to") return raiseTo(plan.amount, true);
  if (plan.label === "all-in") return actuateAllIn();
  return act(plan.label, "action");
}

/** A shove, by whichever control the client offers it through (the action ALL-IN, else size + confirm). */
async function actuateAllIn(): Promise<Record<string, any>> {
  const res = await act("all-in", "action");
  if (res.ok) return res;
  for (const label of ["all-in", "max"]) {
    const preset = await act(label, "preset");
    if (!preset.ok) continue;
    await sleep(0.25);
    let confirm = await act("raise", "action");
    if (!confirm.ok) confirm = await act("bet", "action");
    if (confirm.ok) return { ok: true, clicked: `${pyStr(preset.clicked ?? null)} + ${pyStr(confirm.clicked ?? null)}`, kind: "preset+confirm" };
    return { ok: false, reason: `sized the shove on ${pyStr(preset.clicked ?? null)} but no RAISE/BET to confirm it — ${pyStr(confirm.reason ?? null)}` };
  }
  return res;
}

/** Is hero's recorded action the one `plan` asked for? null = cannot tell. */
export function didAsTold(plan: Record<string, any>, a: Record<string, any>, heroStack: number | null): boolean | null {
  const t = String(a.type || "").toLowerCase();
  const amt = a.amount ?? null;
  if (plan.kind === "raise-to") {
    if (!["raise", "bet", "all-in"].includes(t)) return false;
    if (amt === null) return null;
    const want = pyFloat(plan.amount);
    return Math.abs(amt - want) <= Math.max(RAISE_TOL * want, 0.05);
  }
  const label = plan.label ?? null;
  if (label === "fold") return t === "fold";
  if (label === "check") return t === "check";
  if (label === "call") return t === "call" || t === "all-in";
  if (label === "raise" || label === "bet") return t === label || t === "all-in";
  if (label === "all-in") {
    if (t === "all-in") return true;
    if ((t === "raise" || t === "bet") && amt !== null && heroStack) return amt >= 0.9 * heroStack;
    return t === "raise" || t === "bet" ? null : false;
  }
  return null;
}

/** Is the table still showing the EXACT decision this press was sent for? (the whole safety case for a retry) */
function spotUnchanged(p: Record<string, any>, h: Record<string, any>): [boolean, string | null] {
  if (!S.liveStatus.toAct) return [false, "hero is no longer on the clock"];
  if (S.liveStatus.modal) return [false, "a client notice is over the action strip"];
  if (h.handId !== p.handId) return [false, "the table moved to the next hand"];
  if (h.heroFolded || h.ended) return [false, "the hand is over for hero"];
  if ((h.actions || []).length !== p.kN) return [false, "another action landed first — the spot moved on"];
  try {
    const i = p.key.indexOf("|");
    if (i >= 0 && JSON.parse(p.key.slice(i + 1))[0] !== h.street) return [false, "the street moved on"];
  } catch {}
  return [true, null];
}

function verifyDone(outcome: string, why: string | null, observed: Record<string, any> | null = null): void {
  const p = S.study.pendingExec || {};
  S.study.pendingExec = null;
  const rec = S.study.lastExec;
  if (rec && typeof rec === "object" && rec.key === p.key) Object.assign(rec, { outcome, outcomeWhy: why, observed, attempts: p.attempts ?? null });
  if (outcome === "diverged") feedAdd(`Study pick MIS-EXECUTED — told ${pyStr(p.pick ?? null)}, the table took ${pyStr(why)}`);
  else if (outcome === "unknown") feedAdd(`Study pick UNCONFIRMED — ${pyStr(p.pick ?? null)} was sent, the table never showed it (${pyStr(why)})`);
  else if (outcome === "abandoned") feedAdd(`Study pick unverified — ${pyStr(p.pick ?? null)}: ${pyStr(why)}`);
  if (S.session.id) {
    S.sessions.event(S.session.id, "pick-outcome", { outcome, why, pick: p.pick ?? null, plan: p.plan ?? null,
                                                    hand: p.handId ?? null, attempts: p.attempts ?? null, observed });
  }
  if (outcome !== "confirmed") log(`[pick] outcome ${outcome}: ${pyStr(why)}`);
}

/** From the feed loop: resolve the pending press against the table's own chips. */
export async function maybeVerifyExec(): Promise<void> {
  const p = S.study.pendingExec;
  if (!p) return;
  const h = handState();
  if (!h) {
    if (time() > p.deadline) verifyDone("unknown", "no hand state to check against");
    return;
  }
  if (h.handId !== p.handId) {
    verifyDone("unknown", "the table moved to the next hand before the press showed");
    return;
  }
  const acts: any[] = h.actions || [];
  const k = p.kN;
  let mine = acts.length > k && acts[k].hero ? acts[k] : null;
  if (mine === null && acts.length > k) mine = acts.slice(k).find((a) => a.hero) ?? null;
  if (mine !== null) {
    // LET THE AMOUNT SETTLE BEFORE JUDGING IT (the client shows the chips ADDED for a tick)
    const didNow = [mine.type ?? null, mine.amount ?? null];
    if (p.plan.kind === "raise-to" && time() <= p.deadline && JSON.stringify(p.seen ?? null) !== JSON.stringify(didNow)) {
      p.seen = didNow;
      return;
    }
    let stack = p.stackAtSend ?? null;
    if (stack === null) stack = dget(h.stacks, h.heroSeatId) ?? null;
    const verdict = didAsTold(p.plan, mine, stack);
    const did = String(mine.type) + (mine.amount !== null && mine.amount !== undefined ? ` ${pyFloatStr(mine.amount)}` : "");
    if (verdict === true) verifyDone("confirmed", null, { did });
    else if (verdict === false) verifyDone("diverged", did, { did });
    else verifyDone("unknown", `hero acted (${did}) but it cannot be matched to the pick`, { did });
    return;
  }
  if (time() <= p.deadline) return;
  // NOTHING LANDED. Retry only on proof of that, never on a timeout alone.
  if (p.attempts < VERIFY_ATTEMPTS) {
    const [same, whyNot] = spotUnchanged(p, h);
    if (same) {
      p.attempts += 1;
      p.deadline = time() + VERIFY_DEADLINE_S;
      const res = await actuate(p.plan);
      feedAdd(`Study pick ${pyStr(p.pick)} did not register — retried (${p.attempts}/${VERIFY_ATTEMPTS})`
              + (res.ok ? "" : `, refused: ${pyStr(res.reason ?? null)}`));
      if (S.session.id) {
        S.sessions.event(S.session.id, "pick-retried", { pick: p.pick, plan: p.plan, hand: p.handId, attempt: p.attempts,
                                                        ok: !!res.ok, reason: res.reason ?? null });
      }
      if (!res.ok) verifyDone("unknown", `retry refused — ${pyStr(res.reason ?? null)}`);
      return;
    }
    verifyDone("abandoned", whyNot || "the spot is no longer hero's to act on");
    return;
  }
  verifyDone("unknown", `no action from hero after ${VERIFY_ATTEMPTS} presses`);
}

// one execution at a time (Python's _exec_lock)
let execChain: Promise<unknown> = Promise.resolve();

/** Run the current pick through the relay, if pickReady agrees. One execution per decision. */
export function executePick(source: string, waitedS: number | null = null): Promise<Record<string, any>> {
  const run = async (): Promise<Record<string, any>> => {
    const r = pickReady();
    if (!r.ok) return { ok: false, reason: r.reason, source };
    const plan = r.plan, key = r.key, pick = r.pick;
    const kN = r.kN ?? null;
    S.study.execSource = source;
    const res = await actuate(plan);
    const ok = !!res.ok;
    const rec: Record<string, any> = { at: nowMs(), source, pick, plan, ok, result: res, hand: S.handNo, waitedS, key,
                                       outcome: ok ? "pending" : "refused" };
    S.study.lastExec = rec;
    if (ok) {
      S.study.executed = key;
      const waited = waitedS !== null ? `, after ${fmtFixed(waitedS, 1)} s` : "";
      feedAdd(`Study pick executed — ${pyStr(pick)} (${source}${waited})`);
      if (kN !== null) {
        const h0 = handState() || {};
        const hero0 = h0.heroSeatId ?? null;
        const behind0 = dget(h0.stacks, hero0) ?? null;
        const committed0 = dget(h0.committed, hero0) || 0;
        S.study.pendingExec = { key, pick, plan, kN, handId: S.study.handId ?? null, sentAt: time(),
                                deadline: time() + VERIFY_DEADLINE_S, attempts: 1,
                                stackAtSend: behind0 !== null ? behind0 + committed0 : null };
      }
    } else {
      feedAdd(`Study pick NOT executed — ${pyStr(pick)}: ${"reason" in res ? pyStr(res.reason) : "refused"}`);
    }
    if (S.session.id) {
      S.sessions.event(S.session.id, ok ? "pick-executed" : "pick-refused", { source, pick, plan, hand: S.handNo,
                                                                             waitedS, reason: ok ? null : res.reason ?? null });
    }
    log(`[pick] ${source}: ${pyRepr(pick)} -> ${pyRepr(res)}`);
    return { ok, ...rec };
  };
  const p = execChain.then(run, run);
  execChain = p.catch(() => {});
  return p;
}

// ---- auto-execute: practice / fake table only --------------------------------------------------------------
/** The real-money allowance's state — never granted in this build (see the header); kept for the panel. */
export function autoAllowance(): Record<string, any> {
  const st = S.study;
  const until = st.autoRealUntil, cap = st.autoRealHands, frm = st.autoRealFrom;
  if (!until) return { granted: false, live: false, minutesLeft: null, handsLeft: null };
  const minsLeft = Math.max(0.0, pyRound((until - time()) / 60, 1));
  const handsUsed = Math.max(0, S.handNo - (frm !== null && frm !== undefined ? frm : S.handNo));
  const handsLeft = cap ? Math.max(0, cap - handsUsed) : null;
  const live = minsLeft > 0 && (handsLeft === null || handsLeft > 0);
  return { granted: true, live, minutesLeft: minsLeft, handsLeft, handsUsed, reason: st.autoRealReason };
}

const PRACTICE_ONLY = "auto-execute arms only on a practice table or the fake table (real-money auto-execute is not available)";

/** May auto-execute run against the table in front of us right now? Practice and the fake table only. */
export function autoTableOk(): [boolean, string | null] {
  if (isCp()) {
    return CP.practice() ? [true, null] : [false, "CoinPoker auto-execute arms only on a practice table (the server's coinType 2)"];
  }
  if (S.fakeMode || S.liveStatus.practice) return [true, null];
  return [false, PRACTICE_ONLY];
}

/** Arm/disarm the auto mode. Arms on a practice / fake table only; `allowReal` is refused. */
export function setAuto(on: boolean, opts: { allowReal?: boolean; delay?: string | null; timeBank?: boolean | null; topUp?: boolean | null } = {}): Record<string, any> {
  const st = S.study;
  if (opts.delay === "instant" || opts.delay === "random") {
    st.autoDelay = opts.delay;
    st.autoDue = null;
  }
  if (opts.timeBank !== null && opts.timeBank !== undefined) st.timeBank = !!opts.timeBank;
  if (opts.topUp !== null && opts.topUp !== undefined) st.topUp = !!opts.topUp;
  if (!on) {
    st.auto = false;
    st.autoDue = null;
    Object.assign(st, { autoRealUntil: 0.0, autoRealHands: 0, autoRealFrom: null, autoRealReason: null });
    // the LIVE toggle wins over the declaration
    st.autoDeclared = false;
    if (S.session.id) S.sessions.event(S.session.id, "study-auto", { on: false, hand: S.handNo });
    log("[pick] auto off");
    return { ok: true, auto: false, allowance: autoAllowance() };
  }
  const practice = !!(S.fakeMode || (isCp() ? CP.practice() : S.liveStatus.practice));
  if (isCp() && !practice) {
    st.auto = false;
    return { ok: false, auto: false, error: "CoinPoker auto-execute is practice-only — this table is real money (or its type is unknown)",
             allowance: autoAllowance() };
  }
  if (!practice) {
    st.auto = false;
    return { ok: false, auto: false,
             error: "this is a REAL-MONEY table: auto-execute is practice-only (it arms on a practice table or the fake table)",
             allowance: autoAllowance() };
  }
  st.auto = true;
  if (S.session.id) {
    S.sessions.event(S.session.id, "study-auto", { on: true, hand: S.handNo, practice, delay: st.autoDelay ?? null,
                                                  realMoneyAllowance: null });
  }
  log(`[pick] auto ON (practice, ${pyStr(st.autoDelay ?? null)})`);
  return { ok: true, auto: true, practice, delay: st.autoDelay ?? null, allowance: autoAllowance() };
}

/** A session that DECLARED auto-execute arms itself the moment a table it is allowed on appears. */
export function maybeAutoArm(): void {
  const st = S.study;
  if (!(st.on && st.autoDeclared && !st.auto)) return;
  const [ok] = autoTableOk();
  if (!ok) return;
  const res = setAuto(true);
  if (res.ok) feedAdd("Auto-execute armed (declared at session setup)");
}

/** An answer on the panel that auto never fired leaves a record, once per decision. */
function notePickNotFired(r: Record<string, any>): void {
  const st = S.study;
  if (!(st.text && st.pick) || time() - (st.at ?? 0) > PICK_TTL_S) {
    st.autoNotFired = null;
    return;
  }
  const key = `${pyStr(st.handId ?? null)}|${pyStr(st.decisionKey ?? null)}`;
  const cur = st.autoNotFired;
  if (!cur || cur.key !== key || cur.reason !== (r.reason ?? null)) {
    st.autoNotFired = { key, reason: r.reason ?? null, since: time(), said: false };
    return;
  }
  if (cur.said || time() - cur.since < PICK_NOT_FIRED_S) return;
  cur.said = true;
  feedAdd(`Auto-execute has an answer (${pyStr(st.pick ?? null)}) it cannot fire — ${pyStr(r.reason ?? null)}`);
  log(`[pick] auto not fired for ${pyFloatStr(pyRound(time() - cur.since, 1))}s: ${pyStr(r.reason ?? null)}`);
  if (S.session.id) {
    S.sessions.event(S.session.id, "pick-not-fired", {
      hand: S.handNo, clientHandId: S.handIds.get(S.handNo) ?? null, pick: st.pick ?? null, reason: r.reason ?? null,
      heldS: pyRound(time() - cur.since, 1), toActSources: toActSources(!!S.liveStatus.toAct),
    });
  }
}

/** The auto mode, from the feed loop. A refused attempt is not retried for the same decision. */
export async function maybeAutoAct(): Promise<void> {
  const st = S.study;
  if (!(st.on && st.auto)) return;
  const [ok] = autoTableOk();
  if (!ok) return;
  const r = pickReady();
  if (!r.ok) {
    if (st.autoDue) st.autoDue = null;
    notePickNotFired(r);
    return;
  }
  st.autoNotFired = null;
  if (r.key === st.autoTried) return;
  // THE STRIP IS COVERED, the line is disputed, or a pre-action top-up is buying: hold (re-tested every tick)
  let holdWhy: string | null = st.uncertain || null;
  if (!holdWhy && S.liveStatus.buyPanel) holdWhy = "Buy-chips panel is over the action strip";
  if (!holdWhy && S.topupPrefold.active && time() < S.topupPrefold.deadline) {
    holdWhy = `pre-action top-up in progress (${S.topupPrefold.kind || "terminal"})`;
  }
  if (holdWhy) {
    const held = st.autoHeld || {};
    if (held.key !== r.key || held.why !== holdWhy) {
      st.autoHeld = { key: r.key, why: holdWhy, at: time() };
      feedAdd(`Auto-execute held — ${holdWhy}`);
      if (S.session.id) S.sessions.event(S.session.id, "study-auto-held", { why: holdWhy, hand: S.handNo, pick: r.pick });
    }
    st.autoDue = null;
    return;
  }
  if ((st.autoHeld || {}).key === r.key) {
    const was = st.autoHeld;
    st.autoHeld = null;
    feedAdd(`Auto-execute resumed — ${String(was.why).replaceAll("line uncertain — ", "")} cleared after ${fmtFixed(time() - was.at, 1)} s`);
    if (S.session.id) {
      S.sessions.event(S.session.id, "study-auto-resumed", { why: was.why, heldS: pyRound(time() - was.at, 1), hand: S.handNo, pick: r.pick });
    }
  }
  if (st.autoDelay === "random") {
    const due = st.autoDue;
    if (!due || due.key !== r.key) {
      const wait = AUTO_DELAY_S[0] + Math.random() * (AUTO_DELAY_S[1] - AUTO_DELAY_S[0]);
      st.autoDue = { key: r.key, at: time() + wait, wait };
      feedAdd(`Auto-execute: ${pyStr(r.pick)} in ${fmtFixed(wait, 1)} s (randomized)`);
      return;
    }
    if (time() < due.at) return;
    st.autoDue = null;
    st.autoTried = r.key;
    await executePick("auto", due.wait);
    return;
  }
  st.autoTried = r.key;
  await executePick("auto");
}

/** Press the client's +45s time bank whenever it is offered (answers on, the session allows it). */
export async function maybeTakeTime(): Promise<Record<string, any> | null> {
  const st = S.study;
  if (!(st.on && st.timeBank)) return null;
  const b = S.liveStatus.timeBank;
  if (!b || time() - (st.timeBankAt ?? 0.0) < TIME_BANK_COOLDOWN_S) return null;
  if (S.liveStatus.modal) return null;
  st.timeBankAt = time();
  const label = String(b.text || "+45s").trim();
  const res = await act(label, "button");
  const ok = !!res.ok;
  st.lastTimeBank = { at: nowMs(), label, ok, hand: S.handNo, reason: ok ? null : res.reason ?? null };
  feedAdd(ok ? `Time bank ${label} taken` : `Time bank ${label} NOT taken — ${"reason" in res ? pyStr(res.reason) : "refused"}`);
  if (S.session.id) S.sessions.event(S.session.id, "time-bank", { label, ok, hand: S.handNo, reason: ok ? null : res.reason ?? null });
  log(`[time-bank] ${label}: ${pyRepr(res)}`);
  return st.lastTimeBank;
}
