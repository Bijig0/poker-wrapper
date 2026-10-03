/**
 * OUR TABLE'S SOCKET WENT SILENT MID-HAND (2026-10-03, session_20261003_111447 table 2, hand 4922280690). The river
 * came at 14:12:03.3 and then nothing — not one frame, not the 14:12:20 PONG — until 14:12:44.4, when it all came at
 * once: seat 2's bet, hero's turn, hero's clock already at 0, hero folded and sat out. Table 1's socket in the same
 * page kept its PONGs on time (14:12:22), so it was neither the Wi-Fi nor the capture: Ignition's stream to that one
 * table held back ~41 s while hero's clock ran on the server. The wrapper never saw hero's turn, so it never asked
 * for an answer and never pressed; hero sat out, missed 3 big blinds, was removed (14:17:21), and the table's socket
 * closed at 14:27:20 — which then looked like the site closing an empty table.
 *
 * Brady: "watch for a silent table socket … mark the hand as a connection stall rather than a missed answer. It
 * should also count as a kick, not a natural close, when deciding whether to re-seat."
 *
 * THE SIGN: the socket this table is bound to has sent nothing for STALL_SILENT_S while hero is in a hand, AND its
 * keep-alive reply is overdue (no PONG for KEEPALIVE_S + KEEPALIVE_GRACE_S). Both, because a hand can be quiet for
 * 10 s on its own (a villain thinking), and a PONG can be late without the hand missing anything; together they are
 * the stream itself stopping. Nothing is pressed or held for it — the lost time cannot be won back. What it does:
 *  - says it (log, feed, the ws dump's `<socket-stall>` / `<socket-stall-end>`, session events `socket-stall` /
 *    `socket-stall-end`), with whether the page's other sockets were still talking (`pageAlive`: one table's stream,
 *    or everything the capture sees);
 *  - stamps the hand (`connStalls` on its row, archive.ts) so the API's reconciler files a decision that never
 *    reached us as `socket-stall`, not `no-probe`;
 *  - makes this table's later socket close a KICK, not the site closing an empty table (reader.ts
 *    siteClosedEvidence): hero sat out by a stalled turn is removed from the seat and then the table, and that
 *    close must take the failure path, never the re-seat. Until hero is dealt into a hand again, which proves the
 *    seat survived the stall.
 */
import { time } from "../clock";
import { feedAdd, log } from "../feed";
import { pyStr } from "../py";
import { S, inAHand } from "../state";
import * as TABLES from "../tables";
import { dumpEvent, streetNow } from "./ws";

/** Silence on the bound socket, mid-hand, before it can be a stall. */
export const STALL_SILENT_S = 10;
/** The client's keep-alive: one PONG per socket every 30 s (every ws dump, both tables, 2026-09-25 .. 2026-10-03). */
export const KEEPALIVE_S = 30;
/** How late a PONG may be before it is overdue. */
export const KEEPALIVE_GRACE_S = 5;

export type Stall = {
  rid: string; from: number; at: number; to: number | null; silentS: number | null;
  hand: number; clientHandId: string | null; street: string; pageAlive: boolean;
};

const r1 = (s: number) => Math.round(s * 10) / 10;

/** Every frame of every socket, from the tap (ws.ts tapFrame), before anything else reads it. A frame on the socket
 *  whose stall is open ends that stall. */
export function noteTapFrame(rid: string | null | undefined, pid: unknown): void {
  if (!rid) return;
  const now = time();
  const L = S.tapLast.get(rid);
  if (L) {
    L.at = now;
    if (pid === "PONG") L.pongAt = now;
  } else {
    S.tapLast.set(rid, { at: now, pongAt: pid === "PONG" ? now : null });
  }
  const cur = S.socketStall.cur;
  if (cur && cur.rid === rid) endStall(cur, now, "its frames came back");
}

/** From the feed loop: open a stall on our bound socket when the sign is there. */
export function checkSocketStall(): void {
  const rid = S.tapBound;
  if (!rid || !S.session.id || S.socketStall.cur) return;
  const L = S.tapLast.get(rid);
  if (!L || L.pongAt === null || !inAHand()) return;
  const now = time();
  if (now - L.at < STALL_SILENT_S) return;
  if (now - L.pongAt < KEEPALIVE_S + KEEPALIVE_GRACE_S) return;
  // another socket of the page heard from inside our silence: the stream to this table, not the capture or the link
  let pageAlive = false;
  for (const [other, o] of S.tapLast) if (other !== rid && o.at > L.at) pageAlive = true;
  const st: Stall = { rid, from: L.at, at: now, to: null, silentS: null, hand: S.handNo,
                      clientHandId: S.handIds.get(S.handNo) ?? null, street: streetNow(), pageAlive };
  S.socketStall.cur = st;
  S.socketStall.last = st;
  S.socketStall.dealtSince = false;
  const list = S.socketStall.byHand.get(st.hand) ?? [];
  list.push(st);
  S.socketStall.byHand.set(st.hand, list);
  const silent = r1(now - L.at), pong = r1(now - L.pongAt);
  const whose = pageAlive ? "the page's other tables are still talking" : "nothing else on the page is talking either";
  dumpEvent("<socket-stall>", { rid, silentS: silent, sincePongS: pong, street: st.street, pageAlive });
  feedAdd(`⚠ CONNECTION STALL — this table's connection has sent nothing for ${silent} s mid-hand (keep-alive ${r1(pong - KEEPALIVE_S)} s overdue; ${whose}). `
          + "Hero's turn may be lost to it; the hand is marked as a connection stall");
  log(`[ws] table ${pyStr(TABLES.slot() ?? 1)}: socket ${rid} silent ${silent} s in hand #${st.hand} (${st.street}), last PONG ${pong} s ago — a connection stall (${whose})`);
  try {
    S.sessions.event(S.session.id, "socket-stall", { slot: TABLES.slot(), rid, hand: st.hand, clientHandId: st.clientHandId,
                                                     street: st.street, silentS: silent, sincePongS: pong, pageAlive });
  } catch {}
}

function endStall(st: Stall, now: number, why: string): void {
  st.to = now;
  st.silentS = r1(now - st.from);
  S.socketStall.cur = null;
  dumpEvent("<socket-stall-end>", { rid: st.rid, silentS: st.silentS, why });
  feedAdd(`Connection stall over — this table's connection was silent ${st.silentS} s`);
  log(`[ws] table ${pyStr(TABLES.slot() ?? 1)}: socket ${st.rid} stall over after ${st.silentS} s (${why})`);
  if (S.session.id) {
    try {
      S.sessions.event(S.session.id, "socket-stall-end", { slot: TABLES.slot(), rid: st.rid, hand: st.hand, silentS: st.silentS, why });
    } catch {}
  }
}

/** Our socket closed while its stall was open: the stall ends with it. */
export function stallSocketClosed(rid: string): void {
  const cur = S.socketStall.cur;
  if (cur && cur.rid === rid) endStall(cur, time(), "the socket closed");
}

/** The hand's stalls, for its row (archive.ts) — null when it had none. */
export function stallsFor(hand: number): Record<string, unknown>[] | null {
  const list = S.socketStall.byHand.get(hand);
  if (!list || !list.length) return null;
  return list.map((s) => ({ from: s.from, to: s.to, silentS: s.silentS ?? r1(time() - s.from), street: s.street, rid: s.rid,
                            pageAlive: s.pageAlive }));
}

/** Why a close of this table must be a kick, not the site's close of an empty table: a stall on its socket that hero
 *  has not been dealt into a hand since (a stalled turn sits hero out; a sat-out hero is removed, then the table).
 *  Only a stall on the socket that is closing: a stall on a table we have since left proves nothing about this one.
 *  null = no such stall. */
export function stallMakesKick(rid: string): string | null {
  const st = S.socketStall.last;
  if (!st || st.rid !== rid) return null;
  if (S.socketStall.dealtSince) return null;
  return `this table's connection stalled ${st.silentS ?? r1(time() - st.from)} s in hand #${st.hand} and hero has not been dealt in since`;
}

/** Hero was dealt into a hand (ws.ts): the seat survived any stall before it. */
export function noteHeroDealt(hand: number): void {
  const st = S.socketStall.last;
  if (st && hand > st.hand) S.socketStall.dealtSince = true;
}
