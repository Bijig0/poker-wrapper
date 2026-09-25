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
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { nowMs, time } from "./clock";
import { DATA_DIR } from "./config";
import { feedAdd, log } from "./feed";
import { fmtFixed, pyFloat, pyJsonDumps, pyRound, pyStr, truthy } from "./py";
import { CP, S, isCp } from "./state";
import { handState } from "./ignition/hand";
import { awardName, type Node } from "./ignition/dom";
import { shadowArchive } from "./ignition/shadow";
import { SITE as CP_SITE } from "./sites/coinpoker";
import * as feed from "./sites/cpFeed";

const DDL = `CREATE TABLE IF NOT EXISTS hands (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  hand_id INTEGER,
  played_at INTEGER,
  stakes TEXT,
  street TEXT,
  result_text TEXT,
  result_amount REAL,
  hero_cards TEXT,
  action_count INTEGER,
  data TEXT NOT NULL
)`;

export function db(): Database {
  mkdirSync(DATA_DIR(), { recursive: true });
  const c = new Database(join(DATA_DIR(), "hands.db"));
  c.run("PRAGMA busy_timeout = 5000");
  c.run("PRAGMA journal_mode=WAL");
  c.run(DDL);
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
  if (S.fakeMode || isCp()) return;       // authored test states are not hand history; CoinPoker archives via archiveCp
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
    const c = db();
    try {
      // ONE ROW PER CLIENT HAND, ACROSS PROCESSES
      const cid = h.clientHandId;
      if (cid && c.query("SELECT 1 FROM hands WHERE data LIKE ? LIMIT 1").get(`%"clientHandId": "${cid}"%`)) {
        S.lastArchived.no = h.handId;
        S.lastArchived.fp = fp;
        log(`[history] skipped hand #${h.handId}: client hand ${cid} is already archived (another wrapper on this table?)`);
        return;
      }
      const cur = c.query("INSERT INTO hands (hand_id, played_at, stakes, street, result_text,"
                          + " result_amount, hero_cards, action_count, data) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(h.handId, h.playedAt, h.stakes, h.street, result, null, h.heroCards.join(","), h.actions.length, pyJsonDumps(h));
      h.dbId = Number(cur.lastInsertRowid);
      c.query("UPDATE hands SET data = ? WHERE rowid = ?").run(pyJsonDumps(h), h.dbId);
    } finally {
      c.close();
    }
    S.lastArchived.no = h.handId;
    S.lastArchived.fp = fp;
    S.lastArchived.body = body;
    log(`[history] archived hand #${h.handId} (${h.actions.length} actions)`);
  } catch (e: any) {
    log(`[history] archive failed: ${e?.message ?? e}`);
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
        const r: any = c.query("SELECT rowid, data FROM hands WHERE data LIKE ? ORDER BY rowid DESC LIMIT 1").get(`%"${hid}"%`);
        if (r) {
          const h = JSON.parse(r.data);
          if (h.clientHandId === hid && (h.result || {}).wonCents !== cents) {
            h.result = { ...(h.result || {}), ...rec, heroWon: seat === (h.heroSeatId ?? null) };
            c.query("UPDATE hands SET data = ?, result_text = ? WHERE rowid = ?").run(pyJsonDumps(h), rec.text, r.rowid);
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
    if (c.query("SELECT 1 FROM hands WHERE data LIKE ? LIMIT 1").get(`%"clientHandId": "${hid}"%`)) return;
    c.query("INSERT INTO hands (hand_id, played_at, stakes, street, result_text,"
            + " result_amount, hero_cards, action_count, data) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(/^\d+$/.test(hid) ? Number(hid) : null, h.playedAt, h.stakes, h.street, winners || null, null,
           (h.heroCards || []).join(" ") || null, h.actions.length, pyJsonDumps(h));
  } finally {
    c.close();
  }
  log(`[history] coinpoker hand ${hid} archived (${h.stakes}, hero net ${pyStr(net)})`);
}

export function history(limit = 20): Record<string, any> {
  try {
    const c = db();
    try {
      const n = (c.query("SELECT COUNT(*) AS n FROM hands").get() as any).n;
      const rows: any[] = c.query("SELECT rowid, hand_id, played_at, stakes, street, result_text,"
                                  + " hero_cards, action_count FROM hands ORDER BY rowid DESC LIMIT ?").all(limit);
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
      n = (c.query("SELECT COUNT(*) AS n FROM hands WHERE json_extract(data, '$.sessionId') = ?").get(sid) as any).n;
    } finally {
      c.close();
    }
  } catch {}
  S.handsCache = { id: sid, at: now, n };
  return n;
}
