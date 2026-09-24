/**
 * THE LEVEL RECONCILER, fed every tick (launch._shadow_tick) — reconcile.ts rebuilds each hand's line from the
 * table's LEVELS (chips in front, cards, pot, board, hero's buttons) beside the live logger. Since the 2026-09-19
 * cut-over its line can replace the event log's in /hand (ignition/hand.ts reconciledLine); at archive time the
 * two are diffed into shadow.jsonl (the recording folder when recording, else data/).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { nowMs, strftime } from "../clock";
import { DATA_DIR } from "../config";
import { log } from "../feed";
import { pyInt, pyJsonDumps } from "../py";
import { HandReconciler, bb as rcBb, makeTick } from "../reconcile";
import { S } from "../state";
import { eventLine } from "./hand";

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
    sh.rc.observe(makeTick({ seq: sh.seq, t: strftime("%H:%M:%S"), seats, pot: rcBb(state.pot ?? null),
                             board: (state.board || []).length, buttons: [...(state.actions || [])], hero }));
  } catch (e: any) {
    log(`[shadow] tick error: ${e?.message ?? e}`);
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
