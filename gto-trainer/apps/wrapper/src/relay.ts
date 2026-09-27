/**
 * THE RELAY — an ASSISTIVE INPUT: it actuates only a control the user has just pressed on the panel (or, with
 * auto-execute armed on a PRACTICE table, the study pick), on the table they are already sitting at. It never
 * acts on anything the client is not currently offering. launch.py: act, raise_to, the pick → relay path, the
 * told-vs-did postcondition, the time bank.
 *
 * AUTO-EXECUTE IS PRACTICE-ONLY BY DEFAULT: it arms on a practice table (the client's playMode=fun / CoinPoker's
 * coinType 2) or the fake table with no further ask. A REAL-MONEY table — Ignition or CoinPoker — needs an
 * explicit, BOUNDED, TEMPORARY test allowance (`/study-auto {allowRealMoney: true, minutes, hands, reason}`) —
 * re-added 2026-09-24 at Brady's request to exercise the auto-execute path where practice tables have no
 * players/aren't available; same shape as the old Python allowance (clamped minutes/hands, cleared on disarm
 * or expiry, never inherited into a new session, never silently re-granted). Not a production mode.
 */
import * as cdp from "./cdp";
import { nowMs, sleep, time } from "./clock";
import { feedAdd, log } from "./feed";
import { fmtFixed, pyFloat, pyFloatStr, pyInt, pyRepr, pyReprStr, pyRound, pyStr } from "./py";
import { CP, S, isCp, pressBlocked, seams, type ActOpts } from "./state";
import * as TABLES from "./tables";
import { ACTION_RE, buyPanelUp, cardKey, findInputJs, framePin, heroCards, modalOf, mySel, pointProbeJs, sameHole, splitStrip, tableJs } from "./ignition/dom";
import { handState, toActSources } from "./ignition/hand";
import { callIsMaxCommit } from "./terminal";
import { closeBuyPanel } from "./topup";
import * as AUTO from "./autoLog";

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

/**
 * THE CHAIN LINE (2026-09-25): how the current answer was produced — its verdict (only while the answer is fresh) —
 * and the session's clean count (the share of hands that reached a postflop decision along the happy path).
 */
export function currentChain(): Record<string, any> | null {
  const st = S.study;
  if (!st.on) return null;
  const fresh = !!st.text && (time() - st.at) * 1000 < STUDY_ANSWER_TTL_MS;
  const answer = fresh && st.chain ? st.chain : null;
  if (!answer && !st.chainSession) return null;
  return { verdict: answer?.verdict ?? null, label: answer?.label ?? null, reason: answer?.reason ?? null, session: st.chainSession ?? null };
}

// ---- the press -------------------------------------------------------------------------------------------
/** None if that page point is inside THIS table, else why it is not (the client's own hit-testing decides). OUR
 *  table is the client's tag the reader pinned (dom.ts mySel) — the same identity every read used — never a
 *  position in the client's order: that is what let a press compute into a neighbour after a table closed. */
export async function pointIsMyTable(ws: string, x: number, y: number): Promise<string | null> {
  // every click site asks this last (the relay, sit back in, the connection guard's sit-out): a table that lost the
  // poker server this session blocks them all, one table or several
  const blocked = pressBlocked();
  if (blocked) return blocked;
  if (TABLES.domSlot() === null) return null;
  const pin = framePin();
  const mine = pin.tag;
  if (mine === null) return `table ${pyStr(TABLES.slot())} has not identified its own table in the client yet — refusing`;
  if (pin.lost !== null) return `table ${pyStr(TABLES.slot())}'s own table (the client's tag ${mine}) is gone — refusing`;
  let got: any;
  try {
    got = await cdp.evaluate(ws, pointProbeJs(x, y), 4);
  } catch (e: any) {
    return `could not check which table that point is on: ${e?.message ?? e}`;
  }
  if (got === mine) return null;
  // NOT INSIDE ANY TABLE (2026-09-25, found in a real browser: a re-tiled frame shorter than its table put the CALL
  // button below the frame, on the page's own grid): at several tables the client tags every table, so a point in
  // none of them is not ours — it used to be let through, as the single-table client's untagged frame is
  if (got === "unknown") return `that press would land outside every table (table ${pyStr(TABLES.slot())} is the client's ${mine}) — refusing`;
  const g = pyStr(got);
  return /^-*\d+$/.test(g) && /\d/.test(g)
    ? `that press would land on the client's table ${g}, not table ${pyStr(TABLES.slot())}'s (the client's ${mine}) — refusing`
    : `that press would not land on table ${pyStr(TABLES.slot())} (${g})`;
}

/**
 * THE HOLE-CARD GUARD (2026-09-25, session 20260925_180244). After a disconnect replaced the tables, table 1's capture
 * followed another table's socket while its own frame showed a different hand, and the relay pressed that hand's
 * answers on it — 4hQd's "Raise 3.5" became a 5bb 3-bet with 9♠9♣ (then a no-answer FOLD of the 99), A8o's "Call" an
 * open-limp with 5♣7♣. Every check before this compared the pick with the CAPTURE, which was the wrong hand
 * throughout, so every one passed. The cards are the one fact another table cannot share: a press made for hole
 * cards `cards` goes only to a table whose own frame shows those two cards. `strict` also refuses when the frame
 * shows none (or the decision carries none) — every automatic press at several tables; a lone table, or a human's
 * own press, is refused only on a definite mismatch. null = go ahead.
 */
export function holeCardsRefusal(cards: readonly unknown[] | null | undefined, frameCards: readonly unknown[] | null | undefined,
                                 strict = TABLES.slot() !== null): string | null {
  const want = (cards || []).map(cardKey).filter((c): c is string => !!c);
  const have = (frameCards || []).map(cardKey).filter((c): c is string => !!c);
  if (want.length < 2) return strict ? "the decision carries no hole cards to check this table against — not pressing" : null;
  if (have.length < 2) return strict ? `this table shows no hole cards for hero (the answer is for ${want.join(" ")}) — not pressing` : null;
  if (!sameHole(want, have)) {
    return `the answer is for ${want.join(" ")} but this table shows ${have.join(" ")} — the capture is on another hand; not pressing`;
  }
  return null;
}

/** The hole cards a decision key was made for (`[street, board, heroCards, toCall, n]`), or null. */
export function keyCards(key: string | null | undefined): string[] | null {
  if (!key) return null;
  try {
    const i = key.indexOf("|");
    const k = JSON.parse(i >= 0 && !key.trimStart().startsWith("[") ? key.slice(i + 1) : key);
    return Array.isArray(k) && Array.isArray(k[2]) ? k[2].map(String) : null;
  } catch {
    return null;
  }
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

/** A turn control's IDENTITY is the client's data-qa, not its label — the label is what the control will do at the
 *  size now in the field, and the client rewrites it: once that size is hero's whole stack the RAISE/BET button
 *  reads "ALL-IN 89.2 BB" (hand 4920545590, QJdd river, 2026-09-25: the ALL-IN preset was clicked, the confirm
 *  looked for a label starting "raise"/"bet", found "ALL-IN 89.2 BB", refused — and fold-on-no-answer folded).
 *  Every label ever recorded on the strip, by data-qa (112 MB of DOM frames, 2026-09-25): foldButton FOLD ·
 *  checkButton CHECK · callButton "CALL N BB" · betButton "BET N BB" · raiseButton "RAISE TO N BB" | "ALL-IN N BB";
 *  no allInButton ever — ALL-IN is a sizing preset (allInSelector). */
const QA_OF: Record<string, RegExp> = {
  fold: /^foldButton$/i, check: /^checkButton$/i, call: /^callButton$/i, raise: /^raiseButton$/i, bet: /^betButton$/i,
  "all-in": /^allInButton$/i,
  // the control a sized raise/bet (or a shove sized on a preset) is CONFIRMED on, whatever it reads
  confirm: /^(raise|bet)Button$/i,
};
/** The confirm control on a strip without data-qa: the action-row button that raises, bets, or (sized) shoves. */
const CONFIRM_LABEL = /^(raise|bet|all[ -]?in)\b/i;
export const isAllInLabel = (text: unknown) => /^all[ -]?in\b/i.test(String(text ?? "").trim());

/** The button `label` names within `pool`: exact label, then first word, then (turn actions) the client's data-qa
 *  identity — a CALL relabelled by the client is still the call. "confirm" = the RAISE/BET control, any label. */
export function findControl(pool: any[], label: string, kind: string): any | null {
  if (label === "confirm") {
    return pool.find((b) => QA_OF.confirm!.test(String(b.qa || "")))
      ?? pool.find((b) => !b.qa && CONFIRM_LABEL.test(String(b.text))) ?? null;
  }
  const want = label.trim().toLowerCase();
  let hit = pool.find((b) => String(b.text).toLowerCase() === want);
  if (!hit) {
    const m = ACTION_RE.exec(label);
    const parts = label.split(/\s+/).filter(Boolean);
    const word = (m ? m[0] : parts.length ? parts[0]! : label).toLowerCase();
    hit = pool.find((b) => String(b.text).toLowerCase().startsWith(word));
    const qa = kind === "action" ? QA_OF[word.replace(/^all[ ]?in$/, "all-in")] : undefined;
    if (!hit && qa) hit = pool.find((b) => qa.test(String(b.qa || "")));
  }
  return hit ?? null;
}

/** Relay ONE human-chosen press: re-read the strip, match the label within its OWN row, click its centre.
 *  `expect` sees the matched control on the SAME read as the click and may refuse it (return a reason) — a press
 *  that must only land on a control saying one thing (the shove's confirm must read ALL-IN) checks it here, with
 *  no second read for the strip to change in between. `cards` = the hole cards the decision was made for: checked
 *  against hero's cards on that SAME read (holeCardsRefusal), so nothing can land on a table showing another hand. */
async function actReal(label: string, kind = "action", opts: ActOpts = {}): Promise<Record<string, any>> {
  // a table lost the poker server this session: nothing is pressed — not a turn, not Buy chips, not Sit here
  const blocked = pressBlocked();
  if (blocked) return { ok: false, reason: blocked, blocked: true };
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
    d = (await cdp.evaluate(ws, tableJs(mySel()), 6)) || {};
  } catch (e: any) {
    return { ok: false, reason: `table read failed: ${e?.message ?? e}` };
  }
  if (!d.seated) return { ok: false, reason: "no table tab open" };
  if ((kind === "action" || kind === "preset") && modalOf(d)) {
    return { ok: false, reason: "a client notice is over the action strip (seen on the press's own read)" };
  }
  // THE BUY-CHIPS PANEL, on this press's own read (2026-09-25 audit): only our own flag was checked, and a close that
  // was refused (not rendering, another table's point, the press lock) left the panel over the strip — the strip's
  // coordinates then landed on the panel
  if ((kind === "action" || kind === "preset") && buyPanelUp(d)) {
    return { ok: false, reason: "the Buy-chips panel is over the action strip (seen on the press's own read)" };
  }
  if (opts.cards !== undefined) {
    const wrongHand = holeCardsRefusal(opts.cards, heroCards(d), opts.strict);
    if (wrongHand) return { ok: false, reason: wrongHand, wrongHand: true };
  }
  const [actions, presets] = splitStrip(d);
  const pool: any[] = kind === "preset" ? presets : kind === "action" ? actions : d.buttons ?? [];
  const hit = findControl(pool, label, kind);
  const offer = pool.map((b) => b.text);
  const offerQa = pool.map((b) => b.qa ?? null);
  if (!hit) {
    const what = label === "confirm" ? "a RAISE/BET control" : `'${label}'`;
    return { ok: false, reason: `${what} not on offer (${kind})`, offer, offerQa, missing: true };
  }
  const refusal = opts.expect ? opts.expect(hit) : null;
  if (refusal) return { ok: false, reason: refusal, offer, offerQa, seen: hit.text };
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
export const act = (label: string, kind = "action", opts: ActOpts = {}) => seams.act(label, kind, opts);

/** The hole-card guard on a read of its own, for a press that types before it clicks (raiseTo). */
async function holeCardsOnTable(ws: string, opts: ActOpts): Promise<string | null> {
  if (opts.cards === undefined) return null;
  let d: Record<string, any>;
  try {
    d = (await cdp.evaluate(ws, tableJs(mySel()), 6)) || {};
  } catch (e: any) {
    return `table read failed: ${e?.message ?? e}`;
  }
  return holeCardsRefusal(opts.cards, heroCards(d), opts.strict);
}

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

/** Did the bet field take the size? THE CLIENT ROUNDS TO WHOLE CENTS: at NL5 one cent is 0.2 bb, so a typed 2.5
 *  reads back 2.6 once the field reformats ($0.125 → $0.13) — the same raise the client makes when the field has
 *  not reformatted yet (session 20260925_044829, 04:58: refused on "client changed 2.5 to 2.6"). A read-back within
 *  one cent is the size asked for; the field still on its default (2.0 for a 2.5, hand 4920431586) is not. */
export function raiseReadBackOk(typedBb: number, gotBb: number, bbCents: number | null): boolean {
  const centBb = bbCents && bbCents > 0 ? 1 / bbCents : 0;
  return Math.abs(gotBb - typedBb) <= Math.max(0.011, centBb + 1e-6);
}

/** Custom raise: type an exact BB amount into the client's own bet field, then press its RAISE TO (or BET). */
async function raiseToReal(amount: string, strict = false, opts: ActOpts = {}): Promise<Record<string, any>> {
  amount = amount.trim().replaceAll(",", ".");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(amount)) return { ok: false, reason: `bad amount ${pyReprStr(amount)} — digits only, in BB` };
  const blocked = pressBlocked();
  if (blocked) return { ok: false, reason: blocked, blocked: true };
  const t = await seams.ignitionTarget();
  if (!t) return { ok: false, reason: "poker client not open" };
  const ws = t.webSocketDebuggerUrl;
  // not even a size typed into a table showing another hand (the confirm checks again, on its own read)
  const wrongHand = await holeCardsOnTable(ws, opts);
  if (wrongHand) return { ok: false, reason: wrongHand, wrongHand: true };
  const guard: ActOpts = opts.cards !== undefined ? { cards: opts.cards, strict: opts.strict } : {};
  let d: Record<string, any>;
  try {
    d = (await cdp.evaluate(ws, findInputJs(mySel()), 6)) || {};
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
      const d2 = (await cdp.evaluate(ws, findInputJs(mySel()), 6)) || {};
      const [back, why2] = pickBetInput(d2.inputs || [], d2.anchor ?? null, d2.frameW ?? null);
      if (back === null) return { ok: false, reason: `could not read the bet field back — ${why2}`, typed: amount };
      got = pyStr(back.value ?? "").replaceAll(",", ".");
      gv = pyFloat(got.replace(/[^\d.]/g, "") || "nan");
    } catch (e: any) {
      return { ok: false, reason: `could not read the bet field back: ${e?.message ?? e}`, typed: amount };
    }
    if (!raiseReadBackOk(pyFloat(amount), gv, S.ws.bb ?? null)) {
      const clamp = `client changed ${amount} to ${got} (min/max clamp) — not pressed`;
      // CAPPED AT HERO'S STACK: a size above everything hero has comes back lower with the confirm reading ALL-IN —
      // the client's own word that this raise IS the shove (it knows hero's stack; the answer's tree may not)
      if (gv < pyFloat(amount)) {
        const c = await act("confirm", "action", { ...guard, expect: (hit) => (isAllInLabel(hit.text) ? null : clamp) });
        if (c.ok) return { ok: true, typed: amount, field: got, confirm: c, as: "all-in" };
        if (c.seen === undefined) return { ok: false, reason: `${clamp}; ${pyStr(c.reason ?? null)}`, typed: amount, field: got };
      }
      return { ok: false, reason: clamp, typed: amount, field: got };
    }
  }
  // the RAISE/BET control by identity: a size that is hero's whole stack relabels it "ALL-IN N BB"
  const res = await act("confirm", "action", guard);
  if (res.wrongHand) return { ok: false, reason: res.reason, wrongHand: true, typed: amount, confirm: res };
  return { ok: res.ok ?? false, typed: amount, confirm: res };
}
seams.raiseTo = raiseToReal;
export const raiseTo = (amount: string, strict = false, opts: ActOpts = {}) => seams.raiseTo(amount, strict, opts);

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
  const blocked = isCp() ? null : pressBlocked();
  if (blocked) return no(blocked);
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
  if (S.handAbandoned !== null && S.handAbandoned === S.handNo) {
    return no("the hand in progress was dropped (it was being read off another table's socket) — nothing is pressed until the next hand");
  }
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
  // count the way the key was made (decisionActions: a post-in is not an action to the API)
  const nActs = decisionActions(h).length;
  if (kStreet !== h.street || kN !== nActs) {
    return no(`pick was for ${pyStr(kStreet)} after ${kN} actions; table is ${h.street} after ${nActs}`);
  }
  out.kN = kN;
  const plan = pickPlan(st.pick, (h.currentNode || {}).pot ?? null);
  if (!plan) return no(`cannot map pick ${pyReprStr(String(st.pick))} to a table action`);
  // the hand the pick was made for must be the hand OUR table shows (holeCardsRefusal) — checked here against the
  // last read, so auto waits (and says why) instead of firing, and again on the press's own read
  if (!isCp()) {
    const wrongHand = holeCardsRefusal(keyCards(key), S.tapDomCards);
    if (wrongHand) return no(wrongHand);
  }
  Object.assign(out, { ok: true, plan });
  return out;
}

/** Press `plan` on our table. `guard.cards` = the hole cards the decision was made for: every click the plan takes
 *  is refused on a table whose own frame shows another hand (holeCardsRefusal). */
export async function actuate(plan: Record<string, any>, guard: ActOpts = {}): Promise<Record<string, any>> {
  if (isCp()) {
    const auto = S.study.execSource === "auto";
    // the actuator keeps its own practice-only check; it lets an auto press through on real money only when we
    // vouch for a LIVE bounded allowance (checked here, at press time — not when it was armed)
    return CP.actuate(plan, { auto, allowReal: auto && autoAllowance().live });
  }
  const g: ActOpts = guard.cards !== undefined ? { cards: guard.cards, strict: guard.strict } : {};
  if (plan.kind === "raise-to") return raiseTo(plan.amount, true, g);
  if (plan.label === "all-in") return actuateAllIn(g);
  return act(plan.label, "action", g);
}

/** How long the confirm may take to show the preset's size (the client re-renders the strip on the next frame). */
const SHOVE_CONFIRM_WAIT_S = 1.2;
const SHOVE_CONFIRM_POLL_S = 0.15;

/** A SHOVE, by whichever control the client offers it through — in this order, every step on the client's own
 *  word (never a size of ours):
 *   1. a turn control that already reads ALL-IN (the raise button when the smallest raise is hero's stack);
 *   2. a RAISE/BET control on the strip: size it on the ALL-IN (else MAX) preset, then press that control ONLY once
 *      it reads ALL-IN. The client relabels it — "RAISE TO 2 BB" → "ALL-IN 89.2 BB" (hand 4920545590); this used to
 *      look for a "raise"/"bet" label, so EVERY Ignition shove sized on the preset was refused (ALLIN 18, 94.2,
 *      89.2 in the 2026-09-25 sessions — none went through). A confirm still reading RAISE TO 2 BB is a min-raise,
 *      never pressed as a shove;
 *   3. no RAISE/BET control at all, only CALL: the call is the most hero can put in when it takes hero's last chip
 *      or every opponent still in is all-in (hand 4920544353: FOLD / CALL 21.6 BB against a jam, refused twice, then
 *      folded) — pressed only when the hand agrees (terminal.callIsMaxCommit). The result carries `as: "call"`. */
export async function actuateAllIn(guard: ActOpts = {}): Promise<Record<string, any>> {
  const res = await act("all-in", "action", guard);
  if (res.ok || res.wrongHand) return res;
  // the control WAS there and the press itself was refused (another table's point, a window not rendering): that
  // reason is the answer — the fallbacks below are for a strip that does not show the shove as one control
  if (res.offer && !res.missing) return res;
  const qa: string[] = (res.offerQa ?? []).map((q: any) => String(q ?? ""));
  const labels: string[] = (res.offer ?? []).map((t: any) => String(t));
  const tagged = qa.some((q) => q);
  const hasConfirm = tagged ? qa.some((q) => QA_OF.confirm!.test(q)) : labels.some((t) => CONFIRM_LABEL.test(t));
  const hasCall = tagged ? qa.some((q) => QA_OF.call!.test(q)) : labels.some((t) => /^call\b/i.test(t));
  if (hasConfirm || !res.offer) {
    for (const label of ["all-in", "max"]) {
      const preset = await act(label, "preset", guard);
      if (!preset.ok) {
        if (preset.offer && !preset.missing) return { ok: false, reason: `could not press the ${label.toUpperCase()} preset — ${pyStr(preset.reason ?? null)}` };
        continue;
      }
      const deadline = time() + SHOVE_CONFIRM_WAIT_S;
      let confirm: Record<string, any>;
      for (;;) {
        await sleep(SHOVE_CONFIRM_POLL_S);
        confirm = await act("confirm", "action", {
          ...guard,
          expect: (hit) => (isAllInLabel(hit.text) ? null
            : `the RAISE/BET button still reads '${pyStr(hit.text)}' after ${pyStr(preset.clicked ?? null)} — the shove size has not taken`),
        });
        if (confirm.ok || confirm.seen === undefined || time() >= deadline) break;
      }
      if (confirm.ok) return { ok: true, clicked: `${pyStr(preset.clicked ?? null)} + ${pyStr(confirm.clicked ?? null)}`, kind: "preset+confirm" };
      return { ok: false, reason: `sized the shove on ${pyStr(preset.clicked ?? null)} but did not confirm it — ${pyStr(confirm.reason ?? null)}` };
    }
    if (hasConfirm) return { ok: false, reason: `no ALL-IN or MAX sizing preset to size the shove on (strip: ${pyRepr(labels)})`, offer: res.offer };
  }
  if (hasCall) {
    const why = callIsMaxCommit(handState());
    if (!why.yes) {
      return { ok: false, reason: `only FOLD / CALL on offer and the call is not hero's whole stack (${why.why}) — not calling it a shove`, offer: res.offer };
    }
    const c = await act("call", "action", guard);
    return c.ok ? { ...c, kind: "call-as-all-in", as: "call", why: why.why } : c;
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
    // the shove the table only offered as a CALL (actuateAllIn step 3)
    if (plan.realized === "call") return t === "call";
    if ((t === "raise" || t === "bet") && amt !== null && heroStack) return amt >= 0.9 * heroStack;
    return t === "raise" || t === "bet" ? null : false;
  }
  return null;
}

/**
 * THE ACTIONS A DECISION IS COUNTED IN — the hand's line without its post-ins. A POST-IN is not an action to the API
 * (utils/foldPostIns folds it into the poster's own action), so the decision key's action count (element 4) leaves
 * them out. EVERY count here must be this one: pickReady and the no-answer fold used it, but spotUnchanged and the
 * press verifier counted the raw line (2026-09-25 audit) — in any hand with a post-in a press that did not register
 * read as "another action landed first" and was never retried, and acts[kN] could be hero's OWN earlier action,
 * judging the new press "confirmed" or "MIS-EXECUTED" against the wrong one.
 */
export function decisionActions(h: Record<string, any>): any[] {
  return (h.actions || []).filter((a: any) => a.type !== "post");
}

/** Is the table still showing the EXACT decision this press was sent for? (the whole safety case for a retry) */
export function spotUnchanged(p: Record<string, any>, h: Record<string, any>): [boolean, string | null] {
  if (!S.liveStatus.toAct) return [false, "hero is no longer on the clock"];
  if (S.liveStatus.modal) return [false, "a client notice is over the action strip"];
  if (h.handId !== p.handId) return [false, "the table moved to the next hand"];
  if (h.heroFolded || h.ended) return [false, "the hand is over for hero"];
  if (decisionActions(h).length !== p.kN) return [false, "another action landed first — the spot moved on"];
  try {
    const i = p.key.indexOf("|");
    if (i >= 0 && JSON.parse(p.key.slice(i + 1))[0] !== h.street) return [false, "the street moved on"];
  } catch {}
  return [true, null];
}

export function verifyDone(outcome: string, why: string | null, observed: Record<string, any> | null = null): void {
  const p = S.study.pendingExec || {};
  S.study.pendingExec = null;
  const rec = S.study.lastExec;
  if (rec && typeof rec === "object" && rec.key === p.key) Object.assign(rec, { outcome, outcomeWhy: why, observed, attempts: p.attempts ?? null });
  AUTO.noteOutcome(p.key, outcome, why, observed?.did ?? null);
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
  const acts: any[] = decisionActions(h);   // kN counts THIS list (the key's own count)
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
      const res = await actuate(p.plan, { cards: keyCards(p.key) });
      AUTO.notePress(p.key, { ok: !!res.ok, reason: res.reason ?? null });
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
    const res = await actuate(plan, { cards: keyCards(key) });
    const ok = !!res.ok;
    const rec: Record<string, any> = { at: nowMs(), source, pick, plan, ok, result: res, hand: S.handNo, waitedS, key,
                                       outcome: ok ? "pending" : "refused" };
    S.study.lastExec = rec;
    AUTO.notePress(key, { pick, source, ok, reason: ok ? null : res.reason ?? null });
    if (ok) {
      S.study.executed = key;
      const waited = waitedS !== null ? `, after ${fmtFixed(waitedS, 1)} s` : "";
      const how = res.as === "call" ? ` — as a CALL: ${pyStr(res.why ?? "the call is hero's whole stack")}`
        : res.as === "all-in" && plan.kind === "raise-to" ? ` — the client capped ${pyStr(res.typed ?? plan.amount)} at hero's stack: ALL-IN ${pyStr(res.field ?? "")}` : "";
      feedAdd(`Study pick executed — ${pyStr(pick)} (${source}${waited})${how}`);
      if (kN !== null) {
        const h0 = handState() || {};
        const hero0 = h0.heroSeatId ?? null;
        const behind0 = dget(h0.stacks, hero0) ?? null;
        const committed0 = dget(h0.committed, hero0) || 0;
        // judge the press by what the client was actually asked to do (a shove it only offered as a call, a raise
        // it capped into a shove) — the retry re-sends this plan, which re-derives the same control
        const vplan = res.as === "call" ? { kind: "action", label: "all-in", realized: "call", ...(plan.kind === "raise-to" ? { from: plan } : {}) }
          : res.as === "all-in" && plan.kind === "raise-to" ? { kind: "action", label: "all-in", from: plan } : plan;
        S.study.pendingExec = { key, pick, plan: vplan, kN, handId: S.study.handId ?? null, sentAt: time(),
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

/** The executor a test replaces (Python's tests stubbed launch._execute_pick). */
export const relaySeams = { executePick: (source: string, waitedS: number | null = null) => executePick(source, waitedS) };

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

/** May auto-execute run against the table in front of us right now? Practice, the fake table, or a live real-money test allowance
 *  (Ignition and CoinPoker both — a site's own practice check decides `practice` above). */
export function autoTableOk(): [boolean, string | null] {
  const practice = S.fakeMode || (isCp() ? CP.practice() : S.liveStatus.practice);
  if (practice) return [true, null];
  const allow = autoAllowance();
  if (allow.granted) {
    if (allow.live) return [true, null];
    // the grant just ran out — disarm here so the caller isn't left re-testing an expired allowance forever
    if (S.study.auto) {
      S.study.auto = false;
      Object.assign(S.study, { autoRealUntil: 0.0, autoRealHands: 0, autoRealFrom: null, autoRealReason: null });
      feedAdd("Auto-execute disarmed — real-money TEST allowance expired");
      if (S.session.id) S.sessions.event(S.session.id, "study-auto", { on: false, hand: S.handNo, reason: "allowance-expired" });
      log("[pick] auto off (real-money test allowance expired)");
    }
    return [false, "real-money auto-execute test allowance has expired"];
  }
  return [false, PRACTICE_ONLY];
}

/** Arm/disarm the auto mode. Arms on a practice / fake table with no ask; a real-money table needs `allowReal`
 *  plus a bounded `minutes`/`hands` (clamped 1-2880 / 1-10000 — raised 2026-09-24 to match the research team's
 *  ~2-day check-in cadence; either running out still disarms it — see autoTableOk). */
export function setAuto(on: boolean, opts: { allowReal?: boolean; minutes?: number | null; hands?: number | null; reason?: string | null; delay?: string | null; timeBank?: boolean | null; topUp?: boolean | null } = {}): Record<string, any> {
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
  if (!practice) {
    if (!opts.allowReal) {
      st.auto = false;
      const site = isCp() ? "CoinPoker" : "this";
      return { ok: false, auto: false,
               error: `${site} is a REAL-MONEY table: auto-execute is practice-only (it arms on a practice table or the fake table) ` +
                      "unless a bounded test allowance is granted (allowRealMoney: true)",
               allowance: autoAllowance() };
    }
    // TEMPORARY, BOUNDED real-money TEST allowance (Brady, 2026-09-24: exercising auto-execute where practice
    // tables have no players/are otherwise unavailable — not a production mode; same shape on Ignition and
    // CoinPoker). Clamped like the old Python allowance; whichever of minutes/hands runs out first disarms
    // (autoTableOk); off/disarm/session-end always clears it, never inherited.
    const minutes = Math.min(2880, Math.max(1, pyInt(opts.minutes ?? 10)));
    const hands = opts.hands === null || opts.hands === undefined ? null : Math.min(10000, Math.max(1, pyInt(opts.hands)));
    const reason = opts.reason ?? "manual test allowance";
    Object.assign(st, { autoRealUntil: time() + minutes * 60, autoRealHands: hands ?? 0, autoRealFrom: S.handNo, autoRealReason: reason });
    st.auto = true;
    if (S.session.id) {
      S.sessions.event(S.session.id, "study-auto", {
        on: true, hand: S.handNo, practice: false, delay: st.autoDelay ?? null,
        realMoneyAllowance: { minutes, hands, reason, site: isCp() ? "coinpoker" : "ignition" },
      });
    }
    feedAdd(`Auto-execute armed on REAL MONEY — TEMPORARY TEST allowance (${minutes} min / ${hands ?? "no"} hand cap): ${reason}`);
    log(`[pick] auto ON (REAL-MONEY test allowance, ${minutes}min / ${hands ?? "no cap"} hands: ${reason})`);
    return { ok: true, auto: true, practice: false, delay: st.autoDelay ?? null, allowance: autoAllowance() };
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
export function notePickNotFired(r: Record<string, any>): void {
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
  if (r.reason !== "already executed for this decision") AUTO.noteNotFired(key, r.reason ?? null, st.pick ?? null);
  feedAdd(`Auto-execute has an answer (${pyStr(st.pick ?? null)}) it cannot fire — ${pyStr(r.reason ?? null)}`);
  log(`[pick] auto not fired for ${pyFloatStr(pyRound(time() - cur.since, 1))}s: ${pyStr(r.reason ?? null)}`);
  if (S.session.id) {
    S.sessions.event(S.session.id, "pick-not-fired", {
      hand: S.handNo, clientHandId: S.handIds.get(S.handNo) ?? null, pick: st.pick ?? null, reason: r.reason ?? null,
      heldS: pyRound(time() - cur.since, 1), toActSources: toActSources(!!S.liveStatus.toAct),
    });
  }
}

/** A REFUSED PRESS IS RETRIED (2026-09-25, hand 4920431586, a 99 open from the CO): the chart's Raise 2.5 was typed the
 *  instant the strip appeared, the client's bet field still read its default 2.0 a quarter-second later, the press
 *  was refused — and auto-execute never tried again, so the clock ran (Brady raised by hand at 16.5 s). A refusal
 *  like that is transient; the decision is pressed again up to AUTO_RETRIES times, AUTO_RETRY_S apart. */
export const AUTO_RETRIES = 2;
const AUTO_RETRY_S = 1.0;

function autoRetryDue(key: string): boolean {
  const st = S.study;
  const ex = st.lastExec;
  if (!(ex && ex.key === key && ex.outcome === "refused")) return false;
  const prev = st.autoRetry && st.autoRetry.key === key ? st.autoRetry : null;
  if (prev && prev.n >= AUTO_RETRIES) return false;
  const last = Math.max((ex.at ?? 0) / 1000, prev ? prev.at : 0);
  return time() - last >= AUTO_RETRY_S;
}

/** The auto mode, from the feed loop. A refused attempt is retried (autoRetryDue), then left alone. */
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
  let retry = false;
  if (r.key === st.autoTried) {
    if (!autoRetryDue(r.key)) return;
    retry = true;
  }
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
      AUTO.noteHeld(r.key, holdWhy, r.pick ?? null);
      if (S.session.id) S.sessions.event(S.session.id, "study-auto-held", { why: holdWhy, hand: S.handNo, pick: r.pick });
    }
    st.autoDue = null;
    return;
  }
  let heldS = 0;
  if ((st.autoHeld || {}).key === r.key) {
    const was = st.autoHeld;
    st.autoHeld = null;
    heldS = time() - was.at;
    AUTO.noteResumed(r.key, heldS);
    feedAdd(`Auto-execute resumed — ${String(was.why).replaceAll("line uncertain — ", "")} cleared after ${fmtFixed(time() - was.at, 1)} s`);
    if (S.session.id) {
      S.sessions.event(S.session.id, "study-auto-resumed", { why: was.why, heldS: pyRound(time() - was.at, 1), hand: S.handNo, pick: r.pick });
    }
  }
  if (retry) {
    const n = (st.autoRetry && st.autoRetry.key === r.key ? st.autoRetry.n : 0) + 1;
    st.autoRetry = { key: r.key, n, at: time() };
    feedAdd(`Auto-execute: ${pyStr(r.pick)} again (retry ${n} of ${AUTO_RETRIES}) — the last press was refused`);
    await relaySeams.executePick("auto");
    return;
  }
  if (st.autoDelay === "random") {
    const due = st.autoDue;
    if (!due || due.key !== r.key) {
      const wait = AUTO_DELAY_S[0] + Math.random() * (AUTO_DELAY_S[1] - AUTO_DELAY_S[0]);
      // A HOLD IS PART OF THE WAIT (hand 4920545590: a 6.3 s top-up hold, THEN 1.9 s more, and the shove went at
      // clock 4): the delay keeps a press from landing the instant the answer shows; a decision held longer has waited
      if (heldS >= wait) {
        st.autoTried = r.key;
        await relaySeams.executePick("auto", pyRound(heldS, 1));
        return;
      }
      st.autoDue = { key: r.key, at: time() + wait - heldS, wait };
      feedAdd(`Auto-execute: ${pyStr(r.pick)} in ${fmtFixed(wait - heldS, 1)} s (randomized)`);
      return;
    }
    if (time() < due.at) return;
    st.autoDue = null;
    st.autoTried = r.key;
    await relaySeams.executePick("auto", due.wait);
    return;
  }
  st.autoTried = r.key;
  await relaySeams.executePick("auto");
}

// ---- fold on no-answer: auto-execute's companion -------------------------------------------------------------
/** How long hero's turn waits on an answer before fold-on-no-answer gives up on it: long enough to sit through a
 *  cold postflop chain solve (the poller allows one 45 s) once the +45s time bank has been taken. */
export const NO_ANSWER_DEADLINE_S = 30;
/** A refusal note must be this far into the turn to count: a note left over from the previous decision is
 *  replaced by the poller's next push, well inside this. */
const NO_ANSWER_NOTE_MIN_S = 1.5;
const NO_ANSWER_RETRY_S = 2.5;
const NO_ANSWER_TRIES = 2;
/** Seconds left on hero's own clock (Ignition's countdown in the seat box) at which the decision is given up.
 *  THE CLOCK, NOT A FIXED DEADLINE (2026-09-25, hand 4920431665): the turn's real length depends on how much of the
 *  time bank is left and whether the +45s press landed, so the 30 s deadline fired at 30.5 s — half a second after
 *  the client had already timed hero out (the check went to a strip with no buttons). The base clock is 15 s. */
export const NO_ANSWER_CLOCK_S = 4;

/** Why hero's turn should be given up as a no-answer right now, or null. `age` = seconds hero has been on this
 *  decision. The ways a decision is known to have no answer coming in time:
 *    - the poller has stopped asking (it pushes a note and no answer after its repeat-fail limit);
 *    - hero's clock is down to NO_ANSWER_CLOCK_S (whatever the time bank did or did not add);
 *    - the +45s time bank is on offer (clock at ~9 s) and the session is set to leave it;
 *    - NO_ANSWER_DEADLINE_S has passed (the backstop when the clock cannot be read). */
export function noAnswerFoldWhy(age: number): string | null {
  const note = currentNote();
  if (note && age >= NO_ANSWER_NOTE_MIN_S) return `refused — ${note}`;
  const left = heroTimeLeft();
  if (left !== null && left.total <= NO_ANSWER_CLOCK_S) return `clock nearly out (${left.total} s left)`;
  if (!isCp() && S.liveStatus.timeBank && !S.study.timeBank) return "clock nearly out (time bank on offer, set to leave it)";
  // the backstop is for a clock that cannot be read — a readable one (the bank running) is the better judge
  if (left === null && age >= NO_ANSWER_DEADLINE_S) return `no answer after ${fmtFixed(age, 0)} s`;
  return null;
}

/** Hero's countdown as the table shows it (Ignition only), or null. */
function heroClockLeft(): number | null {
  if (isCp()) return null;
  const c = S.heroClock;
  return typeof c === "number" && Number.isFinite(c) ? c : null;
}

/** The seconds on the "+Ns" time-bank button, while the client offers it. */
export function bankOfferS(): number | null {
  if (isCp()) return null;
  const b = S.liveStatus.timeBank;
  const m = b ? /(\d+)/.exec(String(b.text ?? "")) : null;
  return m ? Number(m[1]) : null;
}

/** HERO'S REAL TIME LEFT = the clock PLUS the time bank still to come. THE CLIENT STARTS THE BANK ITSELF when the
 *  base clock reaches 0 with the "+Ns" button on offer — measured 2026-09-25 over every recorded session: hero's
 *  clock jumped 0 → 45 (or to what was left of the bank) at clock 0 in 8 of 8 activations, 3-9 s AFTER the +45s
 *  press, which itself never changed anything on screen (the button stayed up, the clock kept counting); villains'
 *  banks start the same way, at 0 ("Player N has activated their time bank"). Hand 4920545590 was folded "with 4 s
 *  left" while 45 s of bank was still to come. The handover frame — button gone, clock still 0 — counts the bank
 *  too (dom.bankStep remembers the offer for the turn until the clock jumps). null = the clock cannot be read
 *  (CoinPoker, or no number in the box). */
export function heroTimeLeft(): { total: number; clock: number; bank: number } | null {
  const clock = heroClockLeft();
  const bank = bankOfferS();
  if (bank !== null && !(S.bankSeen && S.bankSeen.secs === bank && !S.bankSeen.started)) S.bankSeen = { secs: bank, at: time(), started: false };
  if (clock === null) return null;
  if (bank !== null) return { total: clock + bank, clock, bank };
  const seen = S.bankSeen;
  if (seen && !seen.started && clock <= 1) return { total: clock + seen.secs, clock, bank: seen.secs };
  return { total: clock, clock, bank: 0 };
}

const fmtLeft = (l: { total: number; clock: number; bank: number }) =>
  l.bank ? `${l.clock} s + ${l.bank} s time bank left` : `${l.clock} s left`;

/** When hero HAS an answer for this decision but it is not going to be played in time, the reason — else null.
 *  A refused press (the client's field did not take the size, the press would land on another table, ...) is
 *  retried by auto-execute (autoRetryDue), and a held pick (line uncertain) waits for its hold to clear; either
 *  one used to run the clock out, because fold-on-no-answer stood aside for any answer. They are given up only
 *  when the clock is nearly out (or at the deadline when it cannot be read) — NOT on the first refusal, which is
 *  what 2fdcb0ba did: that folded hand 4920431586's 99 the moment the open's field read 2.0. */
export function unplayedAnswerWhy(key: string | null, age: number): string | null {
  const st = S.study;
  const ex = st.lastExec;
  const refused = !!(key && ex && ex.key === key && ex.outcome === "refused");
  const state = st.autoHeld && st.autoHeld.key === key ? `held — ${st.autoHeld.why}`
    : refused ? `refused — ${pyStr((ex.result || {}).reason ?? null)}`
    : "not played yet";
  const left = heroTimeLeft();
  if (left !== null && left.total <= NO_ANSWER_CLOCK_S) return `clock nearly out (${fmtLeft(left)}) with the answer ${state}`;
  // A REFUSAL WITH NO RETRY LEFT will not play itself: it gets the base clock, not the bank — the bank is a
  // per-seat budget the next hands need, and nothing is coming that it could wait for
  const spent = refused && (st.autoRetry && st.autoRetry.key === key ? st.autoRetry.n : 0) >= AUTO_RETRIES;
  if (left !== null && spent && left.clock <= NO_ANSWER_CLOCK_S) {
    return `clock nearly out (${left.clock} s left) with the answer ${state} — no retry left, so the time bank is not spent on it`;
  }
  // no readable clock: the deadline backstop, for an answer that is stuck (refused / held) — one merely not yet
  // pressed is auto-execute's
  if (left === null && state !== "not played yet" && age >= NO_ANSWER_DEADLINE_S) return `answer ${state} after ${fmtFixed(age, 0)} s`;
  return null;
}

/** FOLD ON NO-ANSWER (session setup `autoFoldNoAnswer`): with auto-execute armed, a decision that gets no answer
 *  is checked if checking is free, else folded — instead of running the clock out, which sits the seat out after
 *  a few timeouts. Every one is a `no-answer-fold` session event with its reason, so the no-answers of an
 *  unattended run can be collected afterwards. TEMPORARILY enabled on ALL tables, including real-money, for
 *  product development — the practice/fake-table-only guard has been removed; see relay.ts history to restore it. */
export async function maybeFoldNoAnswer(): Promise<void> {
  const st = S.study;
  if (!(st.on && st.auto && st.foldNoAnswer)) {
    st.noAnswerTurn = null;
    return;
  }
  const h = handState();
  const onClock = isCp() ? !!(h && (h.currentNode || {}).toActIsHero) : !!S.liveStatus.toAct;
  if (!onClock || !h || h.heroFolded || h.ended) {
    st.noAnswerTurn = null;
    return;
  }
  const key = `${pyStr(h.handId)}|${pyStr(h.street)}|${decisionActions(h).length}`;
  if ((st.noAnswerTurn || {}).key !== key) st.noAnswerTurn = { key, since: time(), tries: 0, lastTry: 0.0 };
  const turn = st.noAnswerTurn;
  if (turn.tries >= NO_ANSWER_TRIES || time() - turn.lastTry < NO_ANSWER_RETRY_S) return;
  // a pressed pick being verified is the verify loop's (a press that did not land is re-sent there)
  if (st.pendingExec) return;
  // nothing may be pressed through these; the next tick looks again
  if (!isCp() && (S.liveStatus.modal || S.liveStatus.buyPanel)) return;
  if (S.topupPrefold.active && time() < S.topupPrefold.deadline) return;
  const age = time() - turn.since;
  // an answer for THIS decision is auto-execute's to play (or to hold) — unless it is not going to be played in time
  const ready = currentAnswer() ? pickReady() : null;
  // the answer for this decision was pressed: the strip just has not gone yet — never press over it
  if (ready && !ready.ok && ready.key && st.executed === ready.key) return;
  const why = ready && ready.ok ? unplayedAnswerWhy(ready.key ?? null, age) : noAnswerFoldWhy(age);
  if (!why) return;
  turn.tries += 1;
  turn.lastTry = time();
  // actuate() on CoinPoker keeps its own practice check only for an auto press — so this goes as one
  st.execSource = "auto";
  // THE CAPTURE'S HAND MUST BE THE ONE ON OUR TABLE (holeCardsRefusal): a no-answer fold that followed another
  // table's hand folded 9♠9♣ on this one (2026-09-25)
  const guard: ActOpts = { cards: h.heroCards ?? null };
  let did = "check";
  let res = await actuate({ kind: "action", label: "check" }, guard);
  if (!res.ok && !res.wrongHand) {
    did = "fold";
    res = await actuate({ kind: "action", label: "fold" }, guard);
  }
  const ok = !!res.ok;
  const rec = { at: nowMs(), hand: S.handNo, clientHandId: S.handIds.get(S.handNo) ?? null, street: h.street ?? null,
                decision: key, did, ok, why, ageS: pyRound(age, 1), attempt: turn.tries, note: currentNote(),
                reason: ok ? null : res.reason ?? null };
  st.lastNoAnswerFold = rec;
  AUTO.noteNoAnswer(ready && ready.ok && ready.key ? ready.key : key, did, ok, why);
  feedAdd(ok ? `No answer — ${did.toUpperCase()} (fold on no-answer): ${why}`
             : `No answer — fold on no-answer could not act (${pyStr(res.reason ?? null)}): ${why}`);
  if (S.session.id) S.sessions.event(S.session.id, "no-answer-fold", rec);
  log(`[pick] no-answer ${did}: ${why} -> ${pyRepr(res)}`);
}

/** Press the client's +45s time bank when it is offered (answers on, the session allows it) — ONCE per decision.
 *  The press has never been seen to do anything on screen: the button stays up and the clock keeps counting, and
 *  the client starts the bank itself when the clock reaches 0 (heroTimeLeft). It used to be pressed every 5 s and
 *  reported "taken" each time; it is pressed once, as a harmless belt-and-braces, and reported as a press. */
export async function maybeTakeTime(): Promise<Record<string, any> | null> {
  const st = S.study;
  if (!(st.on && st.timeBank)) return null;
  const b = S.liveStatus.timeBank;
  if (!b || time() - (st.timeBankAt ?? 0.0) < TIME_BANK_COOLDOWN_S) return null;
  if (S.liveStatus.modal) return null;
  const h = handState();
  const decision = h ? `${pyStr(h.handId)}|${pyStr(h.street)}|${decisionActions(h).length}` : `#${S.handNo}`;
  if (st.timeBankDecision === decision) return null;
  st.timeBankAt = time();
  const label = String(b.text || "+45s").trim();
  // our frame's own clock, but not spent on a decision the capture is not reading (another table's hand)
  const res = await act(label, "button", { cards: h ? h.heroCards ?? null : null, strict: false });
  const ok = !!res.ok;
  if (ok) st.timeBankDecision = decision;
  st.lastTimeBank = { at: nowMs(), label, ok, hand: S.handNo, reason: ok ? null : res.reason ?? null };
  feedAdd(ok ? `Time bank ${label} pressed (the client starts it when the clock reaches 0)`
             : `Time bank ${label} NOT pressed — ${"reason" in res ? pyStr(res.reason) : "refused"}`);
  if (S.session.id) S.sessions.event(S.session.id, "time-bank", { label, ok, hand: S.handNo, reason: ok ? null : res.reason ?? null });
  log(`[time-bank] ${label}: ${pyRepr(res)}`);
  return st.lastTimeBank;
}
