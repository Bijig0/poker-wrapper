/**
 * THE TABLE READER — launch.py's _feed_tick: one DOM read of OUR table per tick (0.25 s), turned into hero's live
 * status, the panel's feed, and the DOM-side BACKFILL of actions the WebSocket tap missed (deduped against the
 * tap through the shared actSeen keys — whichever source reports first wins).
 *
 * Actions are derived from PERSISTENT STATE DELTAS (a seat's cards gone, its chips in front up), never from a
 * transient badge alone, so a missed tick delays a line but never loses it and an animation cannot invent one.
 * HERO'S seat is never read this way: the WS owns hero's actions.
 */
import * as cdp from "../cdp";
import { time } from "../clock";
import { C } from "../config";
import { feedAdd, log } from "../feed";
import { keepLast, pyRepr, pyRound, pyStr, sortedNums, truthy } from "../py";
import { S, inAHand, seams } from "../state";
import * as TABLES from "../tables";
import { archiveHand, noteAward } from "../archive";
import {
  awardName, bankStep, boardCards, buyPanelUp, disconnectOf, domHeroSeat, forgetFrame, heroCards, heroClockOf, heroHandOf, heroStatus, modalOf, parseSeats, potOf, potVal, RANK_RE,
  mySel, pinFrame, sameHole, splitStrip, tableJs, toAct, watchJs, type Node,
} from "./dom";
import { actAdd, actSeen, boardCap, dumpEvent, dumpMark, lastStanding, mkey, noteDomBoard, tapForget, tapVerify, withoutRabbit } from "./ws";
import { handState, heroPosition, toActSources } from "./hand";
import { handleModal, stateCheck, topUpReceipt } from "./checks";
import { shadowTick } from "./shadow";
import { dbgRecord, writeHandIds } from "./recorder";

/** The poker client's page target — the one that isn't our own panel. ONE page is shared by every table, so it
 *  is never claimed per slot; tables are told apart inside it (the `data-multitableslot` frames). */
export async function ignitionTargetReal(): Promise<Record<string, any> | null> {
  const pages = await cdp.pageTargets(C.CDP_PORT);
  const rank = (u: string): number | null => {
    if (S.fakeMode && u.includes("/faketable")) return 0;
    const low = u.toLowerCase();
    if (low.includes("poker-game")) return 1;
    if (low.includes("ignition")) return 2;
    if (u.includes(`localhost:${C.PANEL_PORT}`) || u.startsWith("devtools")) return null;
    return 3;
  };
  return TABLES.pin(pages, rank, null);
}
seams.ignitionTarget = ignitionTargetReal;

/** Install (once) and drain the in-page action watcher. */
async function drainActions(): Promise<any[]> {
  const t = await seams.ignitionTarget();
  if (!t) return [];
  try {
    return (await cdp.evaluate(t.webSocketDebuggerUrl, watchJs(mySel()), 6)) || [];
  } catch {
    return [];
  }
}

/** GET /table: what the client offers right now. */
export async function tableState(): Promise<Record<string, any>> {
  const t = await seams.ignitionTarget();
  if (!t) return { seated: false, reason: "poker client not open" };
  let d: Record<string, any>;
  try {
    d = (await cdp.evaluate(t.webSocketDebuggerUrl, tableJs(mySel()), 6)) || {};
  } catch (e: any) {
    return { seated: false, reason: `read failed: ${e?.message ?? e}` };
  }
  if (!d.seated) return { seated: false, reason: "no table tab open" };
  const nodes: Node[] = d.nodes ?? [];
  let [actions, presets] = splitStrip(d);
  const pot = potOf(nodes);
  const title = nodes.find((n) => /hold'?em|omaha/i.test(n.text) && n.text.includes("/"))?.text ?? null;
  const heroHand = heroHandOf(d);
  const toActNow = actions.length > 0 && actions.some((a) => /\d/.test(a.text));
  if (!toActNow) actions = [];
  const board = boardCards(d);
  return {
    seated: true, practice: d.practice ?? false, title, pot, toAct: toActNow, board: board.length,
    boardCards: board, heroCards: heroCards(d), heroHand,
    actionOn: S.ws.actionOn ?? null, heroSeat: S.ws.heroSeat ?? null, heroFolded: !!S.ws.heroFolded,
    position: heroPosition(), heroStatus: heroStatus(d, nodes),
    actions: actions.map((a) => ({ text: a.text })), presets: presets.map((p) => ({ text: p.text })),
  };
}

/** Say what pinning our table's tag just did (dom.ts pinFrame). A LOST table is not replaced: the wrapper reads
 *  nothing until the client shows that tag again — reading the wrong table is worse than reading none. */
function notePin(what: ReturnType<typeof pinFrame>): void {
  const tag = S.frame.tag;
  if (what === "pinned") {
    log(`[tables] table ${TABLES.slot()} is the client's table tagged ${tag} — reading that one only`);
  } else if (what === "lost") {
    feedAdd(`This table (the client's tag ${tag}) is gone — reading nothing rather than another table`);
    log(`[tables] table ${TABLES.slot()}: the client's table tagged ${tag} is gone — standing down, not reading a neighbour's`);
  } else if (what === "back") {
    feedAdd(`This table (the client's tag ${tag}) is back`);
    log(`[tables] table ${TABLES.slot()}: the client's table tagged ${tag} is back`);
  }
}

/**
 * A TABLE LOST THE POKER SERVER — Brady, 2026-09-25: "if a table gets disconnected, keep it disconnected, do not allow
 * a reconnect, just end the session then and there". The client reconnects by itself 20-odd seconds later on new
 * sockets, and that recovery is what went wrong (session_20260925_180244). Latched ONCE per session, on the first
 * sighting: nothing is pressed from here on (state.ts pressBlocked), auto-execute is disarmed and the router stops
 * (it would sign back in); session.ts maybeEndForDisconnect, next in this loop, closes the client and ends the session.
 */
export function noteDisconnect(what: NonNullable<ReturnType<typeof disconnectOf>>, via: string): void {
  if (S.disconnect || !S.session.id) return;
  S.disconnect = { at: time(), slot: TABLES.slot(), ...what, sid: S.session.id, handled: false, via };
  Object.assign(S.study, { auto: false, autoDue: null, autoRealUntil: 0.0, autoRealHands: 0, autoRealFrom: null, autoRealReason: null,
                           standDownPending: null });
  S.router.cancel = true;
  const said = what.reconnected ? "the client has reconnected by itself" : `${what.text}${what.attempt !== null ? ` (attempt ${what.attempt} of ${what.of})` : ""}`;
  feedAdd(`DISCONNECTED FROM THE POKER SERVER — ${said}. Ending the session; the client is closed so it cannot reconnect`);
  log(`[disconnect] table ${pyStr(TABLES.slot() ?? 1)}: ${said} (${via}) — nothing more is pressed; ending the session`);
}

/** How long after we leave a table on purpose its socket closing is ours, not a failure. */
export const LEAVE_GRACE_S = 30;
/** Another socket of the page closing within this many seconds of ours is one drop taking them all, not the site
 *  closing our table alone (2026-09-25 18:10: every table's socket went within 4 minutes; the site's close of an empty
 *  table, 2026-10-01 04:06:59, took one socket and left the other table's PONGs on schedule). */
export const SITE_CLOSE_OTHERS_S = 15;
/** How long a socket close that looks like the site's is held before it counts as one: the window in which the page's
 *  other sockets would follow ours in a drop, or the client's disconnect overlay would show (dom.ts disconnectOf). */
export const SITE_CLOSE_SETTLE_S = 3;
/** How long after the site's close our frame is expected to vanish — the next table the client opens is then ours. */
export const SITE_CLOSE_REPIN_S = 120;

/**
 * THE TABLE'S GAME SOCKET CLOSED (2026-09-26, Brady: "table open -> connect socket. If it disconnects for any reason,
 * end the session … a socket end is a failure state"). Chrome reports every WebSocket of the page closing
 * (Network.webSocketClosed); only the one this table is bound to matters. Closed because WE left the table (a
 * stand-down, a closed table, the router's re-seat — session.ts markLeaving) it releases the bind, so the next table
 * binds fresh. Closed any other way — the server dropped us, the network, the client reconnecting (2026-09-25 18:10: every
 * table's socket replaced over 4 minutes, and the capture hunted for the new ones by the cards on screen for 2 minutes,
 * mid-hand) — the session ends exactly as for the disconnect overlay: nothing more is pressed, the client is closed.
 *
 * ONE EXCEPTION (Brady, 2026-10-01, after session_20261001_021221 — "we keep playing until we get kicked off the table,
 * and if so, then we try join a new table at that stake"): THE SITE CLOSING OUR EMPTY TABLE. Table 2 had thinned to hero
 * alone at 04:06:44; Ignition shut it at 04:06:59 with the connection healthy (PONGs on time, table 1's socket
 * untouched), and the rule above closed the one client both tables live in — table 1 was in a hand. That close is told
 * from a drop by what the table was when the socket went: hero alone (or the table already gone from our frame), no
 * hand on, and no other socket of the page closing around it — a drop takes them all, and would also draw the client's
 * overlay. Such a close is held for SITE_CLOSE_SETTLE_S (maybeSettleSiteClose) and then handed to the session, which
 * asks for a table of the same format again (session.ts maybeReseatAfterSiteClose); nothing ends, nothing is pressed
 * meanwhile (there is no hand to press in). Anything else is the failure it always was.
 */
export function noteSocketClosed(rid: string): void {
  const ours = rid === S.tapBound;
  dumpEvent("<socket-closed>", { rid, ours });
  if (!ours) {
    S.tapOtherClosedAt = time();
    const n = S.siteClosed.notice;
    if (n && !n.settled) settleSiteClose(n, `another socket of the page (${rid}) closed ${fmtS(time() - n.at)} s after ours`);
    return;
  }
  S.tapBound = null;
  S.tapMismatch = 0;
  if (time() - (S.tapLeavingAt || 0) <= LEAVE_GRACE_S) {
    log(`[ws] table socket ${rid} closed — we left the table; the next table binds fresh`);
    return;
  }
  const site = siteClosedEvidence();
  if (site && S.session.id && !S.disconnect) {
    const now = time();
    S.siteClosed.notice = { at: now, decideAt: now + SITE_CLOSE_SETTLE_S, settled: false, rid, sid: S.session.id, slot: TABLES.slot(),
                            seats: site.seats, hero: site.hero, hand: S.handNo };
    tapForget(rid);
    dumpEvent("<socket-closed-by-site?>", { rid, ...site });
    feedAdd(`The table's connection closed with the table over (${site.why}) and no hand on — `
            + `the site closing the table, unless the connection follows in ${SITE_CLOSE_SETTLE_S} s`);
    log(`[ws] table socket ${rid} closed on an empty table (${site.why}; seats ${pyRepr(site.seats)}, hero ${pyStr(site.hero)}) — holding ${SITE_CLOSE_SETTLE_S} s before calling it the site's close`);
    return;
  }
  feedAdd("The table's connection to the poker server closed");
  noteDisconnect({ text: "the table's game socket closed", attempt: null, of: null, reconnected: false }, "the capture saw its table's socket close");
}

const fmtS = (s: number) => (Math.round(s * 10) / 10).toFixed(1);

/** How long after our frame stopped showing the table (S.tableGoneAt) its socket closing is still that close. */
export const TABLE_GONE_S = 60;

/** What made the socket close look like the site's, or null when it cannot be. It takes a POSITIVE sign that the
 *  table was over — our frame's last full read showing no seat but hero's, the felt saying the table is breaking
 *  ("waiting"), our pinned frame lost, or the frame having just stopped showing a table — and none against: hero in
 *  a hand, or another socket of the page closed in the last SITE_CLOSE_OTHERS_S. A socket that closes before the
 *  frame was ever read in full is the failure it always was. `seats` = the seats occupied on that last full read. */
export function siteClosedEvidence(): { seats: number[]; hero: string | null; why: string } | null {
  if (inAHand()) return null;
  if (S.tapOtherClosedAt && time() - S.tapOtherClosedAt <= SITE_CLOSE_OTHERS_S) return null;
  const p = S.feedPrev;
  const hero = S.liveStatus.hero ?? null;
  if (p.seated && p.seats instanceof Map) {
    const seats = sortedNums(p.seats.keys());
    const mine = S.liveStatus.heroSeatDom ?? null;
    const others = seats.filter((n) => n !== mine);
    return others.length ? null : { seats, hero, why: seats.length ? "hero was the only player seated" : "no seat was occupied" };
  }
  if (p.seated && p.waiting) return { seats: [], hero, why: "the felt said the table is breaking" };
  if (S.frame.lost !== null) return { seats: [], hero, why: "our table's frame is gone from the client" };
  if (S.tableGoneAt && time() - S.tableGoneAt <= TABLE_GONE_S) return { seats: [], hero, why: "our frame had just stopped showing the table" };
  return null;
}

/** The held close is decided: the site's (settled, the session acts on it) or a drop after all (the failure path). */
function settleSiteClose(n: NonNullable<typeof S.siteClosed.notice>, drop: string | null): void {
  if (drop) {
    S.siteClosed.notice = null;
    log(`[ws] the socket close on table ${pyStr(n.slot ?? 1)} was a drop after all — ${drop}`);
    feedAdd("The table's connection to the poker server closed");
    noteDisconnect({ text: "the table's game socket closed", attempt: null, of: null, reconnected: false }, `the capture saw its table's socket close (${drop})`);
    return;
  }
  n.settled = true;
  S.siteClosed.repinUntil = time() + SITE_CLOSE_REPIN_S;
  if (TABLES.slot() !== null && S.frame.lost !== null) repinAfterSiteClose("it was already gone");
  feedAdd("The site closed this table (the last other player had left). Not a connection failure — the session goes on and a table of the same format is asked for");
  log(`[ws] table ${pyStr(n.slot ?? 1)}: the site closed the table (socket ${n.rid}, hero ${pyStr(n.hero)}, seats ${pyRepr(n.seats)}) — the session goes on`);
}

/** From the feed loop: a held close whose settle window has passed with no other socket closing and no disconnect
 *  overlay is the site's. */
export function maybeSettleSiteClose(): void {
  const n = S.siteClosed.notice;
  if (!n || n.settled) return;
  if (S.disconnect) {
    S.siteClosed.notice = null;      // the overlay (or another table) already called it a failure
    return;
  }
  if (S.tapOtherClosedAt && S.tapOtherClosedAt >= n.at - SITE_CLOSE_OTHERS_S) {
    settleSiteClose(n, `another socket of the page closed ${fmtS(Math.abs(n.at - S.tapOtherClosedAt))} s from ours`);
    return;
  }
  if (time() < n.decideAt) return;
  settleSiteClose(n, null);
}

/** Our frame is gone after the site's close: let the pinned tag go, so the next table the client opens is read as
 *  ours (dom.ts pinFrame) — a lost tag is otherwise never replaced. */
function repinAfterSiteClose(why: string): void {
  S.siteClosed.repinUntil = 0.0;
  forgetFrame();
  feedAdd("This table is gone — the next table the client opens is read as this one");
  log(`[tables] table ${pyStr(TABLES.slot())}: its frame is gone after the site's close (${why}) — pinning the next table the client opens`);
}

/** At several tables: is our frame showing the hand the capture is reading? Its hole cards against the capture's —
 *  another hand's (a frame that moved to another table, the hand before still drawn) is not; no cards on the frame
 *  now (hero folded) counts as it did last time the frame showed them — a socket bound on a claim whose deal the
 *  frame has never drawn is not proven ours. Hero not dealt in: nothing to tell hands apart by. One table: always. */
function frameShowsCaptureHand(hc: string[]): boolean {
  if (TABLES.slot() === null) return true;
  const cap: string[] = S.ws.heroCards || [];
  if (!cap.length) return true;
  if (hc.length >= 2) return sameHole(hc, cap);
  return S.tapDealDrawn;
}

/** A frame that has not drawn for this long is not being drawn (a live one draws every ~16 ms). */
export const FRAME_IDLE_MS = 1500;

/**
 * IS OUR FRAME BEING DRAWN? (2026-09-25) TABLE_JS reports a requestAnimationFrame heartbeat of our own frame (`draw`)
 * and every table tag the page has open (`tags`). A frame the browser is not drawing keeps its DOM — hero's hole cards
 * still changed on slot 4's stuck frame (sessions 20260925_044829 / _134058) — but its animations are frozen where they
 * were, so a board being cleared stays on screen for hands and cards being dealt stay hidden. Returns false when this
 * capture is no evidence of the table's board or of a seat's action: not being drawn, or only just drawn again (the jump
 * from the frozen picture to the live one is not a round of actions). The socket is the table's only word then. Each
 * change is said once (log + feed); /state `tableFrame` carries it with the pinned tag (S.frame). A capture from before
 * these fields (every recording up to 2026-09-25) is unknown, never "not drawn".
 */
export function noteFrame(d: Record<string, any>): boolean {
  const F = S.frameHealth;
  const tags: number[] | null = Array.isArray(d.tags) ? d.tags : null;
  F.tags = tags;
  F.dup = S.frame.tag !== null && tags ? tags.filter((t) => String(t) === S.frame.tag).length : 0;
  const dr = d.seated ? d.draw : null;
  const known = !!dr && typeof dr.idleMs === "number" && typeof dr.ageMs === "number";
  const drawn: boolean | null = known ? !(dr.idleMs > FRAME_IDLE_MS && dr.ageMs > FRAME_IDLE_MS) : null;
  const resumed = F.drawn === false && drawn === true;
  F.drawn = drawn;
  F.idleMs = known ? dr.idleMs : null;
  F.why = drawn !== false ? null
    : dr.pageHidden ? "the client window is not being drawn (minimized, covered, or its screen is off)"
    : dr.offscreen ? "the client has moved this table off screen (its lobby is in front)"
    : "the browser has stopped drawing this table's frame";
  const said = drawn === false ? `undrawn:${F.why}` : F.dup > 1 ? `dup:${F.dup}` : "";
  if (said !== F.said) {
    const was = F.said;
    F.said = said;
    F.since = time();                                  // /state tableFrame.forS: how long the frame has been as it is
    const table = `table ${pyStr(TABLES.slot() ?? 1)}`;
    const line = drawn === false ? `${table}'s frame is not being drawn: ${F.why} — its board and badges are frozen, reading the table from its socket only`
      : F.dup > 1 ? `${F.dup} frames carry ${table}'s tag in the client — reading the one on screen`
      : was.startsWith("undrawn") ? `${table}'s frame is being drawn again`
      : null;
    if (line) {
      log(`[frame] ${line}`);
      feedAdd(line);
    }
  }
  return drawn !== false && !resumed;
}

const STABLE_TICKS = 12;
/** How much of the frame's width is the felt: the client's message panel starts at 0.83 (measured in both layouts). */
export const FELT_W = 0.78;
const WINS_POT = /\bwins?\b.*pot/i;
const RESULT_FOR = /result for hand\s*(\d+)/i;

/**
 * A TABLE READ THAT DID NOT HAPPEN IS A FAILED TICK, NEVER AN IDLE ONE (audit 2026-09-25). It is thrown so the feed
 * loop counts it (loops.ts: FEED_STALL_TICKS in a row → "table reader failing", a feed-stalled session event, toAct
 * off) instead of the panel freezing on the last good read with nothing said. And a read that came back with
 * nothing — cdp.evaluate gives null when the page's reply never came or the page threw — is not "not seated": that
 * used to call "table closed", archive the hand in play and wipe the seat memory on one lost reply.
 */
export class TableReadError extends Error {
  override name = "TableReadError";
}

export async function feedTick(): Promise<void> {
  if (S.site.id === "clubgg") return;              // ClubGG is read off the screen (sites/clubgg.ts), not through CDP
  const t = await seams.ignitionTarget();
  if (!t) {
    // no client page: a failure only while a session expects a table (a disconnect closes the client on purpose)
    if (S.session.id && !S.disconnect) throw new TableReadError("the poker client is not open");
    return;
  }
  let d: Record<string, any>;
  try {
    d = await cdp.evaluate(t.webSocketDebuggerUrl, tableJs(mySel()), 6);
  } catch (e: any) {
    throw new TableReadError(`table read failed: ${e?.message ?? e}`);
  }
  if (!d || typeof d !== "object" || !("seated" in d)) {
    throw new TableReadError(d === null || d === undefined ? "table read came back empty (no reply in time, or the page threw)"
                                                           : `table read came back without a table: ${pyStr(JSON.stringify(d).slice(0, 80))}`);
  }
  const pin = pinFrame(d.frameTag ?? null, !!d.seated);
  notePin(pin);
  if (pin === "lost" && S.siteClosed.repinUntil && time() <= S.siteClosed.repinUntil) repinAfterSiteClose("the client took it down");
  const lost = disconnectOf(d);
  if (lost) noteDisconnect(lost, "our own table showed it");
  const L = S.liveStatus;
  const w = S.ws;
  if (S.fakeMode) {
    // the authored state owns the hand's HISTORY; the per-tick SNAPSHOT is still read from the table
    try {
      const bc = boardCards(d);
      L.hero = heroStatus(d, d.nodes || []);
      L.heroSeatDom = domHeroSeat(d);
      // hero's cards as the frame shows them: the hole-card guard's reference (relay.ts), fake tables included
      S.tapDomCards = heroCards(d);
      L.board = [...bc];
      L.practice = true;
      L.toAct = toAct(d);
      S.screenReadAt = time();
      const m = modalOf(d);
      L.modal = m ? { text: m.text, harmless: m.harmless } : null;
      S.feedPrev = { seated: true, seats: parseSeats(d), board: bc.length, heroCards: heroCards(d).join(" ") };
    } catch {}
    return;
  }
  let drawn = true;
  try {
    drawn = noteFrame(d);
  } catch {}
  try {
    L.hero = heroStatus(d, d.nodes || []);
  } catch {}
  try {
    L.heroSeatDom = domHeroSeat(d);
    tapVerify(heroCards(d), drawn);
  } catch {}
  // THE CLIENT'S NOTICES BEFORE ANY EARLY RETURN (2026-09-30): a known notice is pressed away on every read that shows
  // one, whatever else the read says. handleModal used to run only once the tick had passed "not seated" and "table
  // broke" — session_20260930_104219, table 2: a chat line tripped the table-broke rule every tick from 10:46:54 to
  // the end, so the refused top-up's notice was never pressed, every press refused on it, hero timed out and was sat
  // out, and /state's `modal` froze on the last read that got this far.
  await handleModal(d);
  try {
    L.buyPanel = buyPanelUp(d);
  } catch {}
  const p = S.feedPrev;
  if (!d.seated) {
    if (p.seated) {
      feedAdd("table closed");
      archiveHand();
      S.feedPrev = {};
      S.seatMem.clear();
      S.tableGoneAt = time();
    }
    return;
  }
  const fr0 = d.frame || {};
  const mid = (fr0.y ?? 0) + (fr0.h ?? 0) * 0.7;
  // ON THE FELT, NOT IN THE CHAT PANEL (2026-09-30): the client's message panel fills the frame's right sixth (its
  // lines start at 0.83 of the frame's width in both the one-table and the side-by-side layouts, every recording), and
  // "Player 3 has joined you from another table with $6.08" is an ordinary line there — read as the table breaking, it
  // returned here every tick for the rest of session_20260930_104219 (no recording, no notices, no state checks). The
  // client draws a table-broke notice on the felt: left of the panel, upper 70% of the frame.
  const feltRight = (fr0.x ?? 0) + (fr0.w ?? 0) * FELT_W;
  const waiting = (d.nodes ?? []).some((n: Node) => /please wait|another table/i.test(n.text) && n.y < mid && n.x < feltRight);
  if (waiting) {
    if (!p.waiting) feedAdd("table broke — waiting for a new table…");
    S.feedPrev = { seated: true, waiting: true };
    S.seatMem.clear();
    return;
  }

  // Drain the in-page watcher FIRST so nothing is lost while we parse.
  let events = await drainActions();
  const seats = parseSeats(d);
  const bc = boardCards(d);
  const board = bc.length;
  const hc = heroCards(d);
  const [actions] = splitStrip(d);
  const nodes: Node[] = d.nodes ?? [];
  const pot = potOf(nodes);
  const fr = d.frame;
  if (fr === undefined) throw new Error("KeyError: 'frame'");
  const heroHand = heroHandOf(d);
  const toActNow = actions.length > 0 && actions.some((a) => /\d/.test(a.text));
  L.toAct = toActNow;
  S.screenReadAt = time();                           // the strip was read THIS tick (hand.ts toActSources)
  L.toActSince = toActNow ? L.toActSince || time() : null;
  if (time() >= (w.domGraceUntil ?? 0)) {
    const held: Set<number> = (w.heldCards ??= new Set<number>());
    for (const [num, cs] of seats) if ((cs.cards || 0) >= 1) held.add(num);
  }
  // the client's own top-up receipt — counted on its RISING EDGE (the line stays in the message history)
  const nowReceipts = new Set<string>();
  for (const n of nodes) {
    if (/successfully added \$?([\d,]+(?:\.\d+)?) in chips/i.test(n.text)) nowReceipts.add(n.text.trim());
  }
  const before: Set<string> = L.receipts ?? new Set();
  for (const txt of nowReceipts) {
    if (!before.has(txt)) topUpReceipt(/\$?([\d,]+(?:\.\d+)?) in chips/i.exec(txt)![1]!);
  }
  L.receipts = nowReceipts;
  stateCheck(toActNow, seats);
  L.timeBank =(d.buttons ?? []).find((b: any) => /^\+\d+s$/.test(String(b.text || "").trim())) ?? null;
  const prevClock = S.heroClock;
  try {
    S.heroClock = toActNow ? heroClockOf(d, nodes) : null;
  } catch {
    S.heroClock = null;
  }
  S.bankSeen = bankStep(S.bankSeen, toActNow, L.timeBank ? String(L.timeBank.text) : null, prevClock, S.heroClock, time());
  L.practice = !!d.practice;
  const cur: Record<string, any> = { seated: true, seats, board, pot, heroHand, toAct: toActNow, heroCards: hc.join(" ") };

  // Python: `first = not p.get("seated") or p.get("waiting")` — True, or p's "waiting" value (None when absent),
  // which is what a new seat's `on` starts as below
  const first: boolean | null = !p.seated ? true : "waiting" in p ? p.waiting : null;
  if (first) {
    // THE HAND KEEPS ITS ID ACROSS A DOM "TABLE OPENED" TICK (hand 4919910444)
    const carried = truthy(w.dealt) && !w.handOver ? S.handIds.get(S.handNo) ?? null : null;
    S.handNo += 1;
    if (carried) {
      S.handIds.set(S.handNo, carried);
      feedAdd(`(table re-read mid-hand — hand id ${carried} kept)`);
    }
    const title = nodes.find((n) => /hold'?em|omaha/i.test(n.text))?.text ?? "table";
    feedAdd(`Table opened — ${title}`);
    for (const n of nodes) {
      if (WINS_POT.test(n.text) && !S.winsSeen.includes(n.text)) S.winsSeen.push(n.text);
      const m = RESULT_FOR.exec(n.text);
      if (m && !S.resultSeen.includes(m[1]!)) S.resultSeen.push(m[1]!);
    }
    keepLast(S.winsSeen, 80);
    keepLast(S.resultSeen, 80);
  }

  // Presence debounce (tracked, never announced: seat chips flicker during deal/win animations).
  for (const num of new Set([...seats.keys(), ...S.seatMem.keys()])) {
    let m = S.seatMem.get(num);
    if (!m) {
      m = { present: 0, absent: 0, on: first ? seats.has(num) : first, badge: null, badge_gone: 0, emitted: new Set() };
      S.seatMem.set(num, m);
    }
    if (seats.has(num)) {
      m.present += 1;
      m.absent = 0;
      if (!m.on && m.present >= STABLE_TICKS) m.on = true;
    } else {
      m.absent += 1;
      m.present = 0;
      if (m.on && m.absent >= STABLE_TICKS) {
        m.on = false;
        m.badge = null;
        m.badge_gone = 0;
      }
    }
  }

  if (!first) {
    const idBoundary = false;
    for (const n of nodes) {
      const m = RESULT_FOR.exec(n.text);
      if (m) {
        const hid = m[1]!;
        noteAward(hid, n, nodes);
        if (!S.resultSeen.includes(hid)) {
          S.resultSeen.push(hid);
          keepLast(S.resultSeen, 80);
          writeHandIds();
        }
      }
    }
    const young = S.handBlinds.no === S.handNo && S.handBlinds.ticks <= 12;
    const newHand = idBoundary || (!young && (p.board ?? 0) >= 3 && board === 0);
    if (newHand) {
      S.roundSeen.clear();
      events = [];
      S.actionGraceUntil = time() + 2.0;
      for (const [num, m] of S.seatMem) {
        const b = (seats.get(num) || {}).badge ?? null;
        m.badge = b;
        m.badge_gone = 0;
        m.emitted = b ? new Set([b]) : new Set();
      }
    }
    if (S.handBoard.no !== S.handNo) Object.assign(S.handBoard, { no: S.handNo, max: 0, armed: board < 3 });
    if (board < 3) S.handBoard.armed = true;
    if (!newHand && S.handBoard.armed && [3, 4, 5].includes(board) && board > S.handBoard.max) {
      S.handBoard.max = board;
      S.roundSeen.clear();
    }
    if (S.handBlinds.no !== S.handNo) Object.assign(S.handBlinds, { no: S.handNo, sb: false, bb: false, ticks: 0, strength: false, cards: "" });
    S.handBlinds.ticks += 1;
    // Winner lines — the name node TOUCHES the win text
    for (const n of nodes) {
      const txt = n.text;
      if (WINS_POT.test(txt) && !S.winsSeen.includes(txt)) {
        S.winsSeen.push(txt);
        keepLast(S.winsSeen, 60);
        const name = awardName(n, nodes.filter((m) => Math.abs(m.y - n.y) <= 8));
        feedAdd(("★ " + (name ? name + " " : "") + txt).trim());
      }
    }
    let prevSeats: Map<any, any> = p.seats instanceof Map ? p.seats : new Map();
    if (time() < (w.domGraceUntil ?? 0)) prevSeats = new Map();   // deal animation — the previous hand's pixels lie
    // ANOTHER HAND ON OUR FRAME (2026-09-25, A8o 4920571422: "seat 6 acted on the preflop but has no position label"):
    // table 3's frame moved to another table and, in the ticks before the verify let the socket go, that table's
    // seats were backfilled into A8o. Nothing is filed from a frame not showing the capture's own hand — no action,
    // no fold, not hero's hand-end fold (the per-seat tick bookkeeping below still runs).
    const ours = frameShowsCaptureHand(hc);
    const bbc = w.bb || 0;
    const bbKnown = !!(bbc && w.bbSeen);
    const heroSeat = w.heroSeat ?? null;
    if (toActNow) {
      w.heroToActAt = time();
      w.heroToActPot = potVal(pot);
    }
    // THE HAND-END WIPE: pot and every seat's cards cleared in one tick is not a round of folds — but a hand that
    // ends within seconds of hero being on the clock, with no hero action since and no showdown, ended on hero's fold.
    const wipe = pot === null && seats.size > 0
      && [...seats.values()].every((cs) => (cs.cards || 0) === 0)
      && [...prevSeats.values()].some((old) => (old.cards || 0) >= 1);
    if (wipe) {
      const toActAt = w.heroToActAt || 0.0;
      const actedAt = w.heroLastActAt || 0.0;
      const handLines = S.feed.filter((f) => f.hand === S.handNo).map((f) => f.line as string);
      const showdown = handLines.some((ln) => /\bshows\b|\bwins?\b.*pot/.test(ln));
      const potAtPrompt = w.heroToActPot ?? null;
      const potBeforeWipe = potVal(p.pot ?? null);
      const potGrew = potAtPrompt !== null && potBeforeWipe !== null && potBeforeWipe > potAtPrompt + 0.05;
      if (ours && drawn && heroSeat !== null && !w.heroFolded && time() - toActAt <= 3.0 && actedAt < toActAt
          && !showdown && !potGrew && !actSeen(["fold", heroSeat])) {
        const nb = Math.min(p.board || 0, boardCap());    // a rabbit-hunt card on screen is no street (ws.ts)
        const streetPrev = nb >= 5 ? "river" : nb === 4 ? "turn" : nb === 3 ? "flop" : "preflop";
        w.heroFolded = true;
        (w.foldedSeats ??= new Set<number>()).add(heroSeat);
        actAdd(heroSeat, "fold", null, streetPrev);
        feedAdd(`Seat ${heroSeat} folds (you — hand ended on your turn)`);
      }
      prevSeats = new Map();
    }
    const domCents = (v: number | null) => (bbKnown && v !== null ? pyRound(v * bbc) : null);
    const nd = withoutRabbit(bc).length;               // the backfill's street stamp: never the rabbit card's street
    const streetDom = nd >= 5 ? "river" : nd === 4 ? "turn" : nd === 3 ? "flop" : "preflop";
    L.board = drawn ? [...bc] : [];                    // a frame not being drawn shows no board of THIS hand (noteFrame)
    noteDomBoard(bc, hc);                              // what /hand's DOM-board override may make of it (ws.ts)
    const foldedSeats: Set<number> = (w.foldedSeats ??= new Set<number>());
    let prevMax = 0.0;
    for (const s of prevSeats.values()) prevMax = Math.max(prevMax, potVal(s.bet ?? null) || 0);
    for (const num of sortedNums(seats.keys())) {
      const cs = seats.get(num)!, old = prevSeats.get(num);
      if (!old || !Object.keys(old).length || foldedSeats.has(num)) continue;
      if (num === (w.heroSeat ?? null)) continue;
      const badge = String(cs.badge || "").toUpperCase();
      const obBadge = String(old.badge || "").toUpperCase();
      const oc = old.cards ?? 0, cc = cs.cards ?? 0;
      const ticks: Map<number, number> = (w.foldTicks ??= new Map());
      ticks.set(num, badge === "FOLD" ? (ticks.get(num) || 0) + 1 : 0);
      if (!(w.heldCards ?? new Set()).has(num)) continue;
      if (!ours || !drawn) continue;                   // nor any seat's action from a frame not being drawn
      // THE POT WINNER NEVER FOLDS (2026-09-25): once every other seat has folded, this seat's cards going and the
      // pot landing in its slot are the award, not a fold or a bet. Checked BEFORE actSeen, which would record the
      // fold key and swallow a real WS fold as a duplicate should our fold set ever be wrong.
      if (lastStanding(num)) {
        if (oc >= 1 && cc === 0) log(`[reader] seat ${num}'s cards left at the pot award — the last seat standing, not a fold`);
        continue;
      }
      if (((badge === "FOLD" && ticks.get(num) === 2) || (oc >= 1 && cc === 0)) && !actSeen(["fold", num])) {
        foldedSeats.add(num);
        (w.domFolds ??= new Set<number>()).add(num);
        if (num === w.heroSeat) w.heroFolded = true;
        actAdd(num, "fold", null, streetDom);
        feedAdd(`Seat ${num} folds`);
        continue;
      }
      if (badge === "CHECK" && obBadge !== "CHECK" && !actSeen(["check", num])) {
        // PREFLOP, A SEAT WITH LESS THAN A BIG BLIND IN CANNOT CHECK (2026-09-25, hand 4920414607: "Seat 2 checks"
        // facing UTG's limp, then its real raise — the WS only ever sent the raise). Only the big blind and a poster
        // (a full blind in) ever check preflop, whenever the badge is seen. NOT generalised to "owes chips": postflop
        // the DOM files a check the WS missed AFTER a later seat's bet has landed (golden corpus), and it was legal then.
        const inFront = (w.committed as Map<number | null, number> | undefined)?.get(num) ?? 0;
        if (streetDom === "preflop" && !(w.board || []).length && bbKnown && inFront < bbc) {
          dumpMark(`dropped: DOM CHECK badge on seat ${num} preflop with ${inFront} cents in (under the big blind)`);
          continue;
        }
        actAdd(num, "check", null, streetDom);
        feedAdd(`Seat ${num} checks`);
        continue;
      }
      // A missing bet reading means UNKNOWN, never zero
      const ob = potVal(old.bet ?? null), cb = potVal(cs.bet ?? null);
      if (ob === null || cb === null || cb <= ob + 1e-9) continue;
      const totalC = domCents(cb);
      if (totalC === null || actSeen(mkey(num, totalC))) continue;
      // READ-ONLY with respect to the WS bookkeeping: the backfill contributes actions, never math
      const com: Map<any, number> = w.committed || new Map();
      const topC = w.maxBet ?? 0;
      if (totalC <= (com.get(num) || 0)) continue;
      // money no WebSocket frame has reported yet: the seat's WS chips (ws.ts wsChips) predate this action until its
      // next frame, so the export leaves them out rather than contradict the line (round 3, exact per-seat chips)
      (w.wsStale ??= new Set<number>()).add(num);
      if ((potVal(cs.stack ?? null) || 0) === 0) {
        actAdd(num, "all-in", totalC, streetDom);
        feedAdd(`Seat ${num} is ALL-IN (${cs.bet})`);
      } else if (totalC > Math.max(topC, domCents(prevMax) || 0)) {
        const kind = prevMax > 0 || topC > (domCents(1.0) || 0) ? "raise" : "bet";
        actAdd(num, kind, totalC, streetDom);
        feedAdd(`Seat ${num} ${kind === "raise" ? "raises to" : "bets"} ${cs.bet}`);
      } else {
        actAdd(num, "call", totalC - (com.get(num) || 0), streetDom);
        feedAdd(`Seat ${num} calls ${cs.bet}`);
      }
    }
    if (cur.toAct && !p.toAct) {
      feedAdd("YOUR TURN: " + actions.filter((a) => !a.text.includes("%")).map((a) => a.text).join(" / "));
    }
    if (heroHand && heroHand !== (p.heroHand ?? null) && !S.handBlinds.strength) {
      S.handBlinds.strength = true;
      feedAdd(`Your hand: ${heroHand}`);
    }
  }
  shadowTick({ hand: S.handNo, pot, board: bc, seats, actions: actions.map((a) => a.text) });
  await dbgRecord(t.webSocketDebuggerUrl, {
    hand: S.handNo, pot, board: bc, heroCards: hc, toAct: toActNow, seats,
    actions: actions.map((a) => a.text), events,
    toActSrc: toActSources(toActNow),
    heroStatus: L.hero ?? null,
    feedTail: S.feed.slice(-40).map((l) => l.line),
    liveAnswer: S.study.text ? { text: S.study.text, pick: S.study.pick, roll: S.study.roll, ...(S.study.prov || {}) } : null,
  }, d);
  S.feedPrev = cur;
}

/** Archive a FINISHED hand after a short grace even when no next hand ever arrives. */
export function maybeFlushEnded(): void {
  if (S.site.id === "coinpoker" || S.site.id === "clubgg") return;
  const h = handState();
  const over = !!S.ws.handOver || !!(h && h.ended);
  if (!h || !over || !h.actions.length || h.handId === S.lastArchived.no) {
    S.ws.endedSince = null;
    return;
  }
  const since = S.ws.endedSince ?? null;
  if (since === null) S.ws.endedSince = time();
  else if (time() - since > 8) archiveHand();
}

export { RANK_RE };
