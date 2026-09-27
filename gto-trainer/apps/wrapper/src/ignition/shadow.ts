/**
 * THE LEVEL RECONCILER, fed every tick (launch._shadow_tick) — reconcile.ts rebuilds each hand's line from the
 * table's LEVELS (chips in front, cards, pot, board, hero's buttons) beside the live logger. Since the 2026-09-19
 * cut-over its line can replace the event log's in /hand (ignition/hand.ts reconciledLine); at archive time the
 * two are diffed into shadow.jsonl (the recording folder when recording, else data/).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { nowMs, strftime, time } from "../clock";
import { DATA_DIR } from "../config";
import { log } from "../feed";
import { pyInt, pyJsonDumps } from "../py";
import { HandReconciler, bb as rcBb, makeTick } from "../reconcile";
import { S } from "../state";
import { eventLine, potFaultAnswered, protocolHand } from "./hand";
import { withoutRabbit } from "./ws";
import { cardKey, sameHole } from "./dom";

export function shadowTick(state: Record<string, any>): void {
  try {
    const sh = S.shadow;
    const hand = state.hand ?? null;
    if (hand !== sh.hand) {
      const rc = sh.rc;
      if (rc !== null) {
        rc.finish(rc.prev ? rc.prev.seq : sh.seq);
        sh.done.set(sh.hand as number, rc);
        for (const k of [...sh.done.keys()]) if (hand !== null && k < hand - 5) sh.done.delete(k);
      }
      sh.hand = hand;
      sh.rc = new HandReconciler(hand || 0);
    }
    sh.seq += 1;
    const hero = S.ws.heroSeat ?? null;
    const seats = new Map<number, any>();
    const src = state.seats instanceof Map ? state.seats : new Map(Object.entries(state.seats || {}));
    for (const [num, sd] of src) {
      const n = pyInt(num);
      seats.set(n, { stack: sd.stack ?? null, bet: sd.bet ?? null, cards: sd.cards || 0,
                     hero: n === hero || !!sd.hero, badge: sd.badge ?? null });
    }
    // the hand's board: a rabbit-hunt card drawn after the award is no street — the reconciler revived an ended hand on
    // it ("the board grew to 5 cards", hand 4920544353: hero's fold retracted, turn and river checks filed)
    sh.rc.observe(makeTick({ seq: sh.seq, t: strftime("%H:%M:%S"), seats, pot: rcBb(state.pot ?? null),
                             board: withoutRabbit(state.board || []).length, buttons: [...(state.actions || [])], hero }));
    screenPotCheck(hand, rcBb(state.pot ?? null), withoutRabbit(state.board || []));
  } catch (e: any) {
    log(`[shadow] tick error: ${e?.message ?? e}`);
  }
}

/** How long the screen's pot may disagree with the protocol's line before the decision is held — ticks AND seconds.
 *  The screen redraws after the socket delivers: over the golden recordings every disagreement on a line Ignition
 *  confirms cleared within 1.4 s (4 ticks alone came in under 0.5 s and held 31 of hero's decisions in recording
 *  20260922_194132); a line that is really wrong, or a socket that is another table's, disagrees for good. */
export const SCREEN_POT_HOLD = 4;
export const SCREEN_POT_HOLD_S = 3.0;

/** THE SCREEN CHECKS THE PROTOCOL'S LINE (2026-09-26): the pot the table draws must be the chips the line put in, less
 *  rake (the same rule as reconcile.ts's own pot check — hand.potFaultAnswered). Only while the screen shows THIS hand
 *  on THIS street — hero's hole cards and every board card the protocol dealt — so a screen still drawing the last
 *  hand's pot (it lags a new deal by seconds: recording 20260922_194132, "Total pot 2.5 BB" over a hand of blinds) or
 *  another street is never read as a disagreement. A tick it cannot compare leaves the count where it was. */
export function screenPotCheck(hand: number | null, pot: number | null, board: string[]): void {
  const sc = S.screenCheck;
  if (sc.hand !== hand) Object.assign(sc, { hand, bad: 0, since: null, why: null });
  const p = protocolHand();
  if (!p || pot === null || !(pot > 0)) return;
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((c, i) => cardKey(c) === cardKey(b[i]));
  if (!same(board, p.board) || !sameHole(S.tapDomCards || [], p.heroCards)) return;
  const boardLen = board.length;
  const street = boardLen >= 5 ? "river" : boardLen === 4 ? "turn" : boardLen === 3 ? "flop" : "preflop";
  const bb = S.ws.bb || 0;
  const dead = bb && S.ws.bbSeen ? p.deadCents / bb : 0;   // a dead blind is in the pot and in no seat's line
  if (potFaultAnswered(p.actions, pot - dead, street)) {
    Object.assign(sc, { bad: 0, since: null, why: null });
    return;
  }
  sc.since ??= time();
  if (++sc.bad >= SCREEN_POT_HOLD && time() - sc.since >= SCREEN_POT_HOLD_S) {
    sc.why = `the pot on screen (${pot} BB) disagrees with the protocol's line`;
  }
}

/** At archive time: the reconciler's line for this hand against the archived one. */
export function shadowArchive(h: Record<string, any>): void {
  try {
    const sh = S.shadow;
    const hid = h.handId ?? null;
    const rc = sh.done.get(hid) || (sh.hand === hid ? sh.rc : null);
    if (rc === null || rc === undefined) return;
    if (!rc.ended) rc.finish(rc.prev ? rc.prev.seq : sh.seq);
    // Against the EVENT line: once the cut-over has put the reconciler's line in the archive, diffing against the
    // archive compares the reconciler with itself and always "agrees" (hand 4920374906: SB-first heads-up checks,
    // logged agree:true). `archive_only` / `archive` keep their names and now mean the event line in that case.
    const against = h.lineSource === "reconciled" ? "event" : "archive";
    const d = rc.diff(against === "event" ? eventLine() : h.actions || []);
    const rec = {
      at: nowMs(), session: S.session.id, hand: hid, clientHandId: h.clientHandId ?? null, lineSource: h.lineSource ?? null, against,
      agree: d.agree, archive_only: d.archive_only, reconciled_only: d.reconciled_only, changed: d.changed,
      violations: rc.violations, retractions: rc.journal.filter((a: any) => a.retracted),
      line: d.reconciled, archive: d.archive,
    };
    if (d.agree) sh.agree += 1;
    else sh.differ += 1;
    sh.last = { hand: hid, clientHandId: h.clientHandId ?? null, agree: d.agree,
                diffs: d.archive_only.length + d.reconciled_only.length + d.changed.length,
                violations: rc.violations.length };
    const dir = S.dbg.on && S.dbg.dir ? S.dbg.dir : DATA_DIR();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "shadow.jsonl"), pyJsonDumps(rec, { ensureAscii: false }) + "\n", "utf8");
    log(`[shadow] hand ${hid}: ${d.agree ? "agree" : "DIFF"} · ${rc.violations.length} violation(s) · `
        + `${d.archive_only.length} archive-only · ${d.reconciled_only.length} derived-only · ${d.changed.length} changed`);
  } catch (e: any) {
    log(`[shadow] archive error: ${e?.message ?? e}`);
  }
}
