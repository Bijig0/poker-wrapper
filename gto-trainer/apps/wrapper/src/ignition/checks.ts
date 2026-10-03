/**
 * STATE HEALTH and the client's own notices (launch.py 2026-09-19): every tick the independent views of the table
 * are compared, and a disagreement that HOLDS (animations never last a second) is recorded once per decision — on
 * the feed, in the session, in /state — so a misread names itself the first time it happens.
 *
 * Modals: a notice the wrapper KNOWS to be harmless is dismissed the tick it appears; any other is reported and
 * left alone (a notice the wrapper has never seen may be the one that matters), and picks hold while it is up.
 */
import { nowMs, time } from "../clock";
import { feedAdd, log } from "../feed";
import { keepLast, pyFloat, pyInt, pyReprStr, pyRepr, pyRound, pyStr } from "../py";
import { S, seams } from "../state";
import { toActSources } from "./hand";
import { modalOf } from "./dom";
import { noteTopUpRefusal } from "../topup";

export function stateEvent(kind: string, detail: string, resolved: string): void {
  const key = [S.handNo, kind, (S.ws.actions || []).length];
  const h = S.stateHealth;
  if (h.seen.has(key)) return;
  h.seen.add(key);
  if (h.seen.size > 400) h.seen = h.seen.keepLast(200);
  const ev = { at: nowMs(), hand: S.handNo, clientHandId: S.handIds.get(S.handNo) ?? null,
               kind, detail, resolvedAs: resolved };
  h.events.push(ev);
  keepLast(h.events, 50);
  h.byKind.set(kind, (h.byKind.get(kind) || 0) + 1);
  feedAdd(`⚠ state check (${kind}): ${detail} — ${resolved}`);
  log(`[state-check] ${kind}: ${detail} — ${resolved}`);
  if (S.session.id) {
    // the session row is kind "state-check" with the sub-kind under `check`
    const { kind: _k, at: _a, ...rest } = ev;
    S.sessions.event(S.session.id, "state-check", { ...rest, check: kind });
  }
}

/** Compare the buttons, the client's own action request, action-on and hero's status; a disagreement held for
 *  4 ticks (~1 s) is an event. */
export function stateCheck(buttonsUp: boolean, seats: Map<any, any>): void {
  const h = S.stateHealth;
  h.ticks += 1;
  const hero = S.ws.heroSeat ?? null;
  const dealt: number[] = S.ws.dealt || [];
  if (hero === null || !dealt.includes(hero) || time() < (S.ws.domGraceUntil ?? 0)) {
    h.streak = new Map();
    return;
  }
  const src = toActSources(buttonsUp);
  const status = S.liveStatus.hero ?? null;
  const folded = !!S.ws.heroFolded;
  const myCards = (seats.get(hero) || {}).cards || 0;
  const checks: [string, boolean, string, string][] = [
    ["buttons-without-request", src.buttons && !src.ws && !folded,
     "your buttons are up but the client never asked you to act (CO_SELECT_REQ missed?)",
     "the buttons win: exported as your turn"],
    ["request-without-buttons", src.ws && !src.buttons && !folded,
     "the client asked you to act but no turn buttons are on screen",
     "exported as your turn on the client's word"],
    ["buttons-vs-action-on", src.buttons && !src.actionOn && !src.ws && !folded,
     `buttons up while action-on says seat ${pyStr(S.ws.actionOn ?? null)}`,
     "the buttons win: exported as your turn"],
    ["status-while-dealt", status === "sitting-out" || status === "waiting-for-bb",
     `status read as ${pyStr(status)} while you were dealt in`,
     "dealt wins: exported as in the hand"],
    ["dealt-without-cards", myCards === 0 && !folded && src.buttons,
     "your seat shows no cards while your buttons are up",
     "the buttons win"],
  ];
  const st = h.streak;
  for (const [kind, bad, detail, resolved] of checks) {
    st.set(kind, bad ? (st.get(kind) || 0) + 1 : 0);
    if (st.get(kind) === 4) stateEvent(kind, detail, resolved);
  }
}

export function stateHealthSummary(): Record<string, any> {
  const ev = S.stateHealth.events;
  return { ticks: S.stateHealth.ticks, events: ev.length, byKind: new Map(S.stateHealth.byKind),
           last: ev.length ? ev[ev.length - 1] : null, recent: ev.slice(-5) };
}

export async function handleModal(d: Record<string, any>): Promise<void> {
  const m = modalOf(d);
  S.liveStatus.modal = m ? { text: m.text, harmless: m.harmless } : null;
  if (!m) return;
  // THE DEEP-STACK RESET'S LEAVE (stackReset.ts) puts the client's own leave confirmation up: F.leave answers it —
  // the tick neither dismisses it nor files it as an unknown notice
  if (S.stackReset.state === "leaving") return;
  if (m.harmless) {
    if (time() - S.modalState.lastClickAt < 2.0) return;
    await dismissModal(m, "the table tick");
    return;
  }
  const key = [...m.text].slice(0, 80).join("");
  if (!S.modalState.reported.has(key)) {
    S.modalState.reported.add(key);
    stateEvent("unknown-modal", `the client shows a notice the wrapper does not know: ${pyReprStr([...m.text].slice(0, 120).join(""))} (buttons ${pyRepr(m.buttons)})`,
               "left on screen — picks are held until it is gone");
  }
}

/**
 * PRESS A KNOWN NOTICE AWAY — its OK, on the feed, in the session, and the top-up refusal it may be. `where` names
 * who saw it: the table tick (handleModal) or a press's own read (relay.ts actReal, 2026-09-30). Until then only the
 * tick could dismiss a notice while a press could only refuse on one — and the tick does not always get this far
 * (session_20260930_104219, table 2: a chat line read as "table broke" from 10:46:54 to the end, so the refused
 * top-up's notice — a KNOWN one — stayed up, eight Fold presses refused on it, hero timed out and was sat out).
 */
export async function dismissModal(m: Record<string, any>, where: string): Promise<Record<string, any>> {
  S.modalState.lastClickAt = time();
  const res = await seams.act(m.button.text, "button");
  feedAdd(`Dismissed the client's notice (${m.harmless}): ${[...m.text].slice(0, 80).join("")}`);
  if (S.session.id) {
    S.sessions.event(S.session.id, "modal-dismissed", { modalKind: m.harmless, text: [...m.text].slice(0, 200).join(""),
                                                       ok: !!res.ok, hand: S.handNo, where });
  }
  log(`[modal] dismissed (${m.harmless}, ${where}): ${pyRepr(res)}`);
  noteTopUpRefusal(m);
  return res;
}

/** The client's own receipt for a buy: settles the pending top-up record and files the receipt. */
export function topUpReceipt(amount: string): void {
  const now = time();
  S.toastsSeen.push([amount, now]);
  keepLast(S.toastsSeen, 20);
  feedAdd(`Top-up receipt — the client added $${amount} in chips`);
  const cents = pyRound(pyFloat(amount.replace(/,/g, "")) * 100);
  const rec = S.study.lastTopUp;
  if (rec && rec.pressed && !rec.receiptCents && now * 1000 - (rec.at || 0) < 180_000
      && Math.abs(cents - pyInt(rec.amountCents || 0)) <= 100) {
    const reason = rec.ok ? null : `confirmed by the client's receipt ($${amount} added)`;
    Object.assign(rec, { ok: true, reason, receiptCents: cents });
  }
  if (S.session.id) S.sessions.event(S.session.id, "top-up-receipt", { amount, hand: S.handNo, at: Math.trunc(now * 1000) });
}
