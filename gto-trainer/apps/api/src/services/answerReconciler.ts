import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { answerLog, type FailKind } from "./answerLog";
import { sessionsStore } from "./sessionsStore";
import { HANDS_DB, enrichSync, coverageOf, answersByHand, decisionIndexOf } from "../routes/dashboard";

/**
 * Why a decision got no answer, settled AFTER the hand is over.
 *
 * Two gaps the live poller cannot close on its own:
 *
 *  1. A decision nobody ever asked about. The poller only solves when the
 *     wrapper's export says hero is on the clock; when that export is wrong
 *     (the WS/DOM to-act desync of 2026-09-12, hand 4917810973) there is no
 *     probe, no solve, and so no row of any kind — the node is simply absent.
 *     Only the archive knows hero acted there, and only once the hand is done.
 *
 *  2. A failure the poller logged with no hand to hang it on. A probe carries
 *     no client hand id (services/studyPoller.ts IngestLikeResponse), so a
 *     timeout or a down client is written with client_hand_id NULL. Here it is
 *     matched to the hand it belongs to and attached.
 *
 * Both are idempotent: a decision that already has a row is never given a
 * second one, so the pass can run as often as it likes.
 *
 * A no-probe row is only written where an answer was actually OWED: the hand
 * belongs to a declared session that was started with study answers ON. The
 * first backfill without that gate wrote 354 of them against the pre-session
 * archive — hands from before any of this existed, where nothing was supposed
 * to answer and "unanswered" means nothing.
 */

/** Hands are archived complete, so anything in hands.db is safe to judge. */
interface HandRowLite { rowid: number; hand_id: number | null; played_at: number | null; stakes: string | null; street: string | null; result_text: string | null; hero_cards: string | null; action_count: number | null; data: string }

let db: Database | null = null;
function open(): Database | null {
  if (db) return db;
  if (!existsSync(HANDS_DB)) return null;
  db = new Database(HANDS_DB, { readonly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

export interface ReconcileResult { hands: number; attached: number; noProbe: number; skippedNoSession: number; sinceMs: number }

/**
 * @param sinceMs only hands played at or after this instant (0 = the whole archive)
 */
export function reconcileAnswers(sinceMs: number): ReconcileResult {
  const d = open();
  const out: ReconcileResult = { hands: 0, attached: 0, noProbe: 0, skippedNoSession: 0, sinceMs };
  if (!d) return out;
  let rows: HandRowLite[];
  try {
    rows = d.query<HandRowLite, [number]>(
      "SELECT rowid, hand_id, played_at, stakes, street, result_text, hero_cards, action_count, data FROM hands WHERE COALESCE(played_at, 0) >= ? ORDER BY played_at"
    ).all(sinceMs);
  } catch { return out; }
  if (!rows.length) return out;

  // one read of the answer log for the whole pass
  const days = Math.max(1, Math.ceil((Date.now() - (sinceMs || rows[0]!.played_at || Date.now())) / 86_400_000) + 1);
  const all = answerLog.rows(days);
  const byCid = answersByHand(all);
  // failures the poller could not attribute: matched on hero's cards and the
  // time the hand was live, which is unambiguous inside one session
  const orphans = all.filter((a) => !a.client_hand_id && a.text == null);
  // sessions that were declared WITH study answers on — the only hands where a
  // missing answer is a fault rather than the expected state
  const answering = new Map<string, boolean>();
  for (const sess of sessionsStore.list(500)) answering.set(sess.id, sess.config?.answers === true);

  for (const row of rows) {
    const e = enrichSync(row as never);
    if (!e?.clientHandId) continue;
    out.hands++;
    const mine = byCid.get(e.clientHandId) ?? [];
    const cov = coverageOf(e, mine);
    if (!cov.uncovered.length) continue;
    const sid = (e.raw as { sessionId?: string })?.sessionId ?? null;
    const owed = !!sid && answering.get(sid) === true;

    // the window this hand was live: from its first answer (or its own played_at
    // less a minute) to played_at, which the wrapper stamps when it archives
    const end = e.playedAt ?? 0;
    const start = Math.min(...[...mine.map((a) => a.ts), end].filter((x) => x > 0)) - 60_000;
    const covered = new Set(mine.map((a) => decisionIndexOf(a)).filter((i): i is number => i != null));

    for (const dec of cov.uncovered) {
      if (covered.has(dec.index)) continue; // a failed row already explains this node
      const hit = orphans.find(
        (a) => a.ts >= start && a.ts <= end + 60_000 &&
          (a.hero_cards ?? "") === (e.heroCards ?? []).join("") &&
          decisionIndexOf(a) === dec.index
      );
      if (hit) {
        answerLog.attach(hit.id, e.clientHandId, sid, e.handId ?? null);
        orphans.splice(orphans.indexOf(hit), 1);
        out.attached++;
        continue;
      }
      // nothing anywhere: hero acted and nobody ever asked. Only a fault when
      // this session was actually answering.
      if (!owed) { out.skippedNoSession++; continue; }
      answerLog.add({
        ts: e.playedAt ?? Date.now(),
        wrapperHandId: e.handId ?? null,
        clientHandId: e.clientHandId,
        street: dec.street,
        board: (e.hand.board ?? []).join("") || null,
        heroCards: (e.heroCards ?? []).join("") || null,
        // the shape services/studyPoller.ts decisionKey() writes: the last
        // element is hero's action index, which is what the coverage join reads
        decisionKey: JSON.stringify([dec.street, e.hand.board ?? [], e.heroCards ?? [], null, dec.index]),
        text: null, pick: null, roll: null, tier: null, warning: null, latencyMs: null,
        failReason: "hero acted here but the decision was never asked about — no probe, no solve, no failure",
        failKind: "no-probe" as FailKind,
        sessionId: sid,
      });
      out.noProbe++;
    }
  }
  return out;
}

/** Rolling pass over the last day's hands, a minute after the hand is done. */
class AnswerReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  start(everyMs = 120_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try { reconcileAnswers(Date.now() - 86_400_000); } catch { /* a reconcile pass never takes the process down */ }
    }, everyMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
export const answerReconciler = new AnswerReconciler();
