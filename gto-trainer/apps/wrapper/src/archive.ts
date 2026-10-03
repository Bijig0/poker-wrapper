/**
 * HAND HISTORY — every finished hand into data/hands.db with the same DDL and column semantics as
 * assistive-play's HandStore, so its History / replay tooling (and the study dashboard) read these hands
 * unchanged. The `data` blob is the /hand export plus the hand's feed lines, written as Python's json.dumps
 * writes it: rows are matched with LIKE '%"clientHandId": "X"%', which depends on the ", " / ": " separators.
 *
 * Python held a lock around the archive (the WS tap and the feed loop are threads there); here everything that
 * archives runs on the one event loop and archiving never awaits, so two triggers cannot interleave.
 */
import { Database } from "bun:sqlite";
import { nowMs, time } from "./clock";
import { paths } from "./env";
import { openStore } from "../../../packages/data-root/centralDb";
import { ensureHandsSchema, FINISHED, HANDS_DDL } from "../../../packages/data-root/handsSchema";
import { feedAdd, log } from "./feed";
import { fmtFixed, pyFloat, pyJsonDumps, pyRound, pyStr, truthy } from "./py";
import { CGG, CP, S, isCgg, isCp } from "./state";
import { handState } from "./ignition/hand";
import { awardName, type Node } from "./ignition/dom";
import { shadowArchive } from "./ignition/shadow";
import { autoLogFor } from "./autoLog";
import { stallsFor } from "./ignition/stall";
import { SITE as CP_SITE } from "./sites/coinpoker";
import * as feed from "./sites/cpFeed";
import * as cgg from "./sites/cggFeed";

export { HANDS_DDL };

/**
 * The hands table (the central poker.sqlite the API reads the same rows from, or a sandbox's hands.db). The API
 * writes the same file, so a write can meet its lock: `busyMs` is how long this call may wait — the live row's
 * write passes a few ms and skips a busy tick; the archive waits longer and, if it still loses, is retried from
 * `flushPendingArchives` instead of being dropped.
 */
export function db(busyMs = 2000): Database {
  const c = openStore(paths().handsDb, { busyMs });
  ensureHandsSchema(c);
  return c;
}

export function stakesStr(): string | null {
  const bb = S.ws.bb || 0;
  if (!(bb && S.ws.bbSeen)) return null;
  return `$${fmtFixed(bb / 200, 2)}/$${fmtFixed(bb / 100, 2)}`;
}

/** What makes two archive attempts the SAME hand: the site's hand id, else the hand's content. */
export function archiveFp(h: Record<string, any>): unknown[] {
  if (h.clientHandId) return ["id", h.clientHandId];
  return ["body", h.stakes ?? null, [...h.heroCards], h.actions.map((a: any) => [a.seatId, a.type, a.amount ?? null])];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Persist the finishing hand (next hand's PLAY_STAGE_INFO, table close, ended-hand grace, stand-down — the
 *  dedupe guards make the triggers safe together). */
export function archiveHand(): void {
  if (S.fakeMode || isCp() || isCgg()) return;   // authored test states are not hand history; CoinPoker / ClubGG archive their own
  archiveHandLocked();
}

function archiveHandLocked(): void {
  try {
    // a hand dropped because its socket was another table's (ws.ts abandonHand) is nobody's history here
    if (S.handAbandoned !== null && S.handAbandoned === S.handNo) return;
    const h = handState();
    if (!h || !h.actions.length) return;
    if (h.handId === S.lastArchived.no) return;
    // THE WEBSOCKET CHIP COUNTS ARE A DECISION'S, NOT A ROW'S (round 3): at the end of the hand they say what every
    // seat had left, and a replay that cut the row back to one of its decisions would read them against a shorter
    // line — every seat "short" (the end-of-hand-money trap, API utils/archivedHand). The row keeps startStacks.
    delete h.wsStack;
    delete h.wsInFront;
    delete h.wsDead;
    // YOUR HANDS ONLY: a hand hero was not dealt into is not hand history
    const live: number[] = h.liveSeats && h.liveSeats.length ? h.liveSeats : [h.heroSeatId];
    if (S.ws.heroDealt === false || !live.includes(h.heroSeatId)) {
      S.lastArchived.no = h.handId;
      log(`[history] skipped hand #${h.handId}: hero was not dealt in (not hand history)`);
      return;
    }
    const lines = S.feed.filter((f) => f.hand === S.handNo).map((f) => f.line as string);
    const result = [...lines].reverse().find((x) => /\bwins?\b|Result for hand/.test(x)) ?? null;
    h.playedAt = nowMs();
    h.stakes = stakesStr();
    h.clientHandId = S.handIds.get(S.handNo) ?? null;
    shadowArchive(h);
    h.sessionId = S.session.id;
    h.feedLines = lines;
    // what the relay did with each decision (autoLog.ts) — the hand page's "Auto-execute: worked, 1 try"
    const autoExec = autoLogFor(S.handNo);
    if (autoExec) h.autoExec = autoExec;
    // the hand's connection stalls (ignition/stall.ts): a decision lost to one is filed as socket-stall, not no-probe
    const stalls = stallsFor(S.handNo);
    if (stalls) h.connStalls = stalls;
    if (result) h.result = { text: result };
    const aw = S.awards.get(h.clientHandId || "");
    if (aw) h.result = { ...(h.result || { text: aw.text }), ...aw, heroWon: aw.winnerSeat === h.heroSeatId };
    const fp = archiveFp(h);
    const body = ["body", h.stakes ?? null, h.actions.map((a: any) => [a.seatId, a.type, a.amount ?? null])];
    if (same(fp, S.lastArchived.fp) || (!h.clientHandId && same(body, S.lastArchived.body ?? null))) {
      S.lastArchived.no = h.handId;
      log(`[history] skipped hand #${h.handId}: same hand as the last archive (table reopen replayed the previous hand's state)`);
      return;
    }
    S.lastArchived.no = h.handId;
    S.lastArchived.fp = fp;
    S.lastArchived.body = body;
    const w = { h, result };
    if (!writeArchive(w)) {
      pendingArchives.push(w);
      log(`[history] hand #${h.handId} archive deferred: the database is busy — retried next pass`);
    }
  } catch (e: any) {
    log(`[history] archive failed: ${e?.message ?? e}`);
  }
}

type PendingArchive = { h: Record<string, any>; result: string | null };
/** finished hands whose write met a busy database: the loop retries them, oldest first (never dropped) */
const pendingArchives: PendingArchive[] = [];

/** ONE ROW PER CLIENT HAND, ACROSS PROCESSES: finish the hand's live row in place, else insert it. False = busy. */
function writeArchive({ h, result }: PendingArchive): boolean {
  let c: Database;
  try { c = db(); } catch { return false; }
  try {
    const cid: string | null = h.clientHandId ?? null;
    const row = cid ? c.query("SELECT rowid, status FROM hands WHERE client_hand_id = ? ORDER BY rowid DESC LIMIT 1").get(cid) as { rowid: number; status: string } | null : null;
    if (row?.status === "done") {
      log(`[history] skipped hand #${h.handId}: client hand ${cid} is already archived (another wrapper on this table?)`);
      return true;
    }
    const now = nowMs();
    if (row) {
      h.dbId = row.rowid;
      c.query("UPDATE hands SET hand_id = ?, played_at = ?, stakes = ?, street = ?, result_text = ?, hero_cards = ?, action_count = ?,"
              + " data = ?, status = 'done', updated_at = ? WHERE rowid = ?")
        .run(h.handId, h.playedAt, h.stakes, h.street, result, h.heroCards.join(","), h.actions.length, pyJsonDumps(h), now, row.rowid);
    } else {
      const cur = c.query("INSERT INTO hands (hand_id, played_at, stakes, street, result_text,"
                          + " result_amount, hero_cards, action_count, data, client_hand_id, status, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'done',?)")
        .run(h.handId, h.playedAt, h.stakes, h.street, result, null, h.heroCards.join(","), h.actions.length, pyJsonDumps(h), cid, now);
      h.dbId = Number(cur.lastInsertRowid);
      c.query("UPDATE hands SET data = ? WHERE rowid = ?").run(pyJsonDumps(h), h.dbId);
    }
    log(`[history] archived hand #${h.handId} (${h.actions.length} actions)`);
    return true;
  } catch (e: any) {
    if (/busy|locked/i.test(String(e?.message ?? e))) return false;
    log(`[history] archive failed: ${e?.message ?? e}`);
    return true;
  } finally {
    c.close();
  }
}

/** Retry archives a busy database deferred (the loop calls this every pass; a no-op when nothing waits). */
export function flushPendingArchives(): void {
  while (pendingArchives.length && writeArchive(pendingArchives[0]!)) pendingArchives.shift();
}

/**
 * THE LIVE ROW (2026-09-25): while hero is in a hand, its row in the hands table carries the hand as it stands now
 * (status 'live'), and the archive finishes that same row. Written only when the hand changes (street, board, an
 * action, hero's cards), AFTER the loop's press chain, with a few-ms lock wait: a busy database skips one write,
 * never a press. Ignition only (CoinPoker archives from its log at the hand's end); never in fake mode.
 */
let liveFp = "";
export function liveHandTick(): void {
  flushPendingArchives();
  if (S.fakeMode || isCp() || isCgg() || S.ws.heroDealt === false) return;
  const cid = S.handIds.get(S.handNo) ?? null;
  if (!cid || S.handNo === S.lastArchived.no) return;
  const h = handState();
  if (!h || !h.actions.length) return;
  const fp = JSON.stringify([cid, h.street, h.board ?? [], h.actions.length, h.heroCards]);
  if (fp === liveFp) return;
  let c: Database;
  try { c = db(25); } catch { return; }
  try {
    delete h.wsStack;
    delete h.wsInFront;
    delete h.wsDead;
    h.clientHandId = cid;
    h.stakes = stakesStr();
    h.sessionId = S.session.id;
    const autoExec = autoLogFor(S.handNo);
    if (autoExec) h.autoExec = autoExec;
    const stalls = stallsFor(S.handNo);
    if (stalls) h.connStalls = stalls;
    const now = nowMs();
    const row = c.query("SELECT rowid, status FROM hands WHERE client_hand_id = ? ORDER BY rowid DESC LIMIT 1").get(cid) as { rowid: number; status: string } | null;
    if (row?.status === "done") { liveFp = fp; return; }
    if (row) {
      c.query("UPDATE hands SET stakes = ?, street = ?, hero_cards = ?, action_count = ?, data = ?, updated_at = ? WHERE rowid = ?")
        .run(h.stakes, h.street, h.heroCards.join(","), h.actions.length, pyJsonDumps({ ...h, dbId: row.rowid }), now, row.rowid);
    } else {
      c.query("INSERT INTO hands (hand_id, played_at, stakes, street, result_text, result_amount, hero_cards, action_count, data,"
              + " client_hand_id, status, updated_at) VALUES (?,?,?,?,NULL,NULL,?,?,?,?,'live',?)")
        .run(h.handId, now, h.stakes, h.street, h.heroCards.join(","), h.actions.length, pyJsonDumps(h), cid, now);
    }
    liveFp = fp;
  } catch {
    /* busy: the next change (or pass) writes it */
  } finally {
    c.close();
  }
}

// ---- the client's award: "Player S wins ($X)" under "Result for hand N" ----------------------------------
const AWARD_WIN = /^wins\b.*?\(\$([\d,]+(?:\.\d+)?)\)/i;

export function noteAward(hid: string, idNode: Node, nodes: Node[]): void {
  const row = nodes.filter((x) => x.y - idNode.y >= 12 && x.y - idNode.y <= 40 && Math.abs(x.x - idNode.x) < 120);
  const win = row.find((x) => AWARD_WIN.test(x.text));
  if (!win) return;
  const cents = pyRound(pyFloat(AWARD_WIN.exec(win.text)![1]!.replace(/,/g, "")) * 100);
  const name = awardName(win, row);
  const m = /Player (\d+)/.exec(name);
  const seat = m ? Number(m[1]) : null;
  const rec = { winnerSeat: seat, winnerLabel: name || null, wonCents: cents,
                text: ("★ " + (name ? name + " " : "") + win.text).trim() };
  if (same(S.awards.get(hid), rec)) return;
  S.awards.set(hid, rec);
  const keys = [...S.awards.keys()];
  for (const k of keys.slice(0, Math.max(0, keys.length - 60))) S.awards.delete(k);
  // already archived (the box came late)? patch the row in place
  if (S.handIds.get(S.lastArchived.no) === hid) {
    try {
      const c = db();
      try {
        const r: any = c.query("SELECT rowid, data FROM hands WHERE client_hand_id = ? ORDER BY rowid DESC LIMIT 1").get(hid);
        if (r) {
          const h = JSON.parse(r.data);
          if (h.clientHandId === hid && (h.result || {}).wonCents !== cents) {
            h.result = { ...(h.result || {}), ...rec, heroWon: seat === (h.heroSeatId ?? null) };
            // updated_at moves: the dashboard re-reads a row it cached once the award lands (it used to keep the award-less one)
            c.query("UPDATE hands SET data = ?, result_text = ?, updated_at = ? WHERE rowid = ?").run(pyJsonDumps(h), rec.text, nowMs(), r.rowid);
            log(`[history] award attached to hand ${hid}: seat ${pyStr(seat)} $${fmtFixed(cents / 100, 2)}`);
          }
        }
      } finally {
        c.close();
      }
    } catch (e: any) {
      log(`[history] award patch failed: ${e?.message ?? e}`);
    }
  }
}

// ---- CoinPoker: its log says when a hand is over ---------------------------------------------------------

/** A CoinPoker feed line onto the panel feed (attached: that table's lines only). */
export function cpLine(room: string, line: string): void {
  if (isCp() && (!CP.pinned || room === CP.pinned)) {
    const parts = room.split(/\s+/).filter(Boolean);
    feedAdd(`[${parts[parts.length - 1] ?? room}] ${line.trim()}`);
  }
}

export function cpFinished(room: feed.Room, raw: feed.Hand): void {
  if (!isCp()) return;
  if (CP.pinned && room.name !== CP.pinned) return;
  try {
    archiveCp(room, raw);
  } catch (e: any) {
    log(`[history] coinpoker archive failed: ${e?.message ?? e}`);
  }
}

export function archiveCp(room: feed.Room, raw: feed.Hand): void {
  if (!truthy(raw.bb) || !truthy(raw.actions)) return;
  // YOUR hands only
  if (raw.hero === null || raw.hero === undefined || !(raw.dealt || []).includes(raw.hero)) return;
  const h = CP.exportFinished(room, raw);
  if (!h) return;
  const hid = String(raw.id);
  const hero = (raw.seats instanceof Map ? raw.seats.get(raw.hero) : undefined)?.name ?? null;
  let net: number | null = null;
  if (hero) {
    const put = raw.actions.filter((a: any) => a.name === hero).reduce((s: number, a: any) => s + a.added, 0);
    const won = (raw.winners || []).filter((w: any) => w.name === hero).reduce((s: number, w: any) => s + (w.won || 0), 0);
    const back = (raw.returned instanceof Map ? raw.returned.get(raw.hero) : undefined) ?? 0;
    net = pyRound(won + back - put, 4);
  }
  const winners = (raw.winners || []).map((w: any) => `${w.name} ${feed.money(w.won)}`).join(", ");
  const bb = pyFloat(raw.bb);
  h.playedAt = raw.serverT0 || nowMs();
  h.stakes = `${feed.money(raw.sb ?? null)}/${feed.money(raw.bb ?? null)}` + (truthy(raw.ante) ? ` ante ${feed.money(raw.ante)}` : "");
  h.sessionId = S.session.id;
  h.site = CP_SITE;
  h.feedLines = [];
  h.shown = raw.shown ?? null;
  h.result = { text: winners || null, winners: raw.winners ?? null, heroNet: net,
               heroNetBb: net !== null && bb ? pyRound(net / bb, 2) : null, heroWon: !!(net && net > 0) };
  h.rake = (CP.table() || {}).rake ?? null;
  const c = db();
  try {
    if (c.query("SELECT 1 FROM hands WHERE client_hand_id = ? LIMIT 1").get(hid)) return;
    c.query("INSERT INTO hands (hand_id, played_at, stakes, street, result_text,"
            + " result_amount, hero_cards, action_count, data, client_hand_id, status, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'done',?)")
      .run(/^\d+$/.test(hid) ? Number(hid) : null, h.playedAt, h.stakes, h.street, winners || null, null,
           (h.heroCards || []).join(" ") || null, h.actions.length, pyJsonDumps(h), hid, nowMs());
  } finally {
    c.close();
  }
  log(`[history] coinpoker hand ${hid} archived (${h.stakes}, hero net ${pyStr(net)})`);
}

// ---- ClubGG: the screen reader says when a hand is over ------------------------------------------------------

/** A ClubGG reader line onto the panel feed (attached: that table's lines only). */
export function cggLine(room: string, line: string): void {
  if (isCgg() && (!CGG.pinned || room === CGG.pinned)) feedAdd(`[ClubGG] ${line.trim()}`);
}

export function cggFinished(room: cgg.Room, raw: cgg.Hand): void {
  if (!isCgg()) return;
  if (CGG.pinned && room.key !== CGG.pinned) return;
  try {
    archiveCgg(room, raw);
  } catch (e: any) {
    log(`[history] clubgg archive failed: ${e?.message ?? e}`);
  }
}

/** A finished ClubGG hand into the hands table — YOUR hands only (observed hands go to <data>/clubgg/hands-*.jsonl).
 *  Hero's net is the stack the reader last saw (after the award) less the stack as dealt. */
export function archiveCgg(room: cgg.Room, raw: cgg.Hand): void {
  if (!raw.bb || !raw.actions.length) return;
  if (raw.hero === null || !raw.dealt.includes(raw.hero)) return;
  const h = CGG.exportFinished(room, raw);
  if (!h) return;
  const hid = `cgg-${raw.id}`;
  const start = raw.startStacks.get(raw.hero), end = raw.seen.get(raw.hero);
  const net = start !== undefined && end !== undefined ? pyRound(end - start, 2) : null;
  const winners = raw.winners.map((w) => `${w.name}${w.won !== null ? " +" + w.won : ""}`).join(", ");
  h.playedAt = Math.round(raw.t0 * 1000);
  h.stakes = `${raw.sb ?? "None"}/${raw.bb}` + (raw.bomb ? " bomb pot" : "");
  h.sessionId = S.session.id;
  h.site = cgg.SITE;
  h.feedLines = [];
  h.result = { text: winners || null, winners: raw.winners, heroNet: net, heroNetBb: net !== null ? pyRound(net / raw.bb, 2) : null, heroWon: !!(net && net > 0) };
  const c = db();
  try {
    if (c.query("SELECT 1 FROM hands WHERE client_hand_id = ? LIMIT 1").get(hid)) return;
    c.query("INSERT INTO hands (hand_id, played_at, stakes, street, result_text,"
            + " result_amount, hero_cards, action_count, data, client_hand_id, status, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'done',?)")
      .run(null, h.playedAt, h.stakes, h.street, winners || null, null,
           (h.heroCards || []).filter(Boolean).join(" ") || null, h.actions.length, pyJsonDumps(h), hid, nowMs());
  } finally {
    c.close();
  }
  log(`[history] clubgg hand ${hid} archived (${h.stakes}, hero net ${pyStr(net)})`);
}

export function history(limit = 20): Record<string, any> {
  try {
    const c = db();
    try {
      const n = (c.query(`SELECT COUNT(*) AS n FROM hands WHERE ${FINISHED}`).get() as any).n;
      const rows: any[] = c.query("SELECT rowid, hand_id, played_at, stakes, street, result_text,"
                                  + ` hero_cards, action_count FROM hands WHERE ${FINISHED} ORDER BY rowid DESC LIMIT ?`).all(limit);
      return { count: n, hands: rows.map((r) => ({ dbId: r.rowid, handId: r.hand_id, playedAt: r.played_at, stakes: r.stakes,
                                                    street: r.street, result: r.result_text, heroCards: r.hero_cards, actions: r.action_count })) };
    } finally {
      c.close();
    }
  } catch (e: any) {
    return { count: 0, hands: [], error: String(e?.message ?? e) };
  }
}

/** Archived hands stamped with this session (cached 5 s — /state is polled at 1 Hz). */
export function sessionHands(sid: string): number {
  const now = time();
  if (S.handsCache.id === sid && now - S.handsCache.at < 5) return S.handsCache.n;
  let n = 0;
  try {
    const c = db();
    try {
      n = (c.query(`SELECT COUNT(*) AS n FROM hands WHERE ${FINISHED} AND json_extract(data, '$.sessionId') = ?`).get(sid) as any).n;
    } finally {
      c.close();
    }
  } catch {}
  S.handsCache = { id: sid, at: now, n };
  return n;
}
