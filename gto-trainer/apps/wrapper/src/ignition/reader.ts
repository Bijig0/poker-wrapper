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
import { keepLast, pyRound, sortedNums, truthy } from "../py";
import { S, seams } from "../state";
import * as TABLES from "../tables";
import { archiveHand, noteAward } from "../archive";
import {
  awardName, bankStep, boardCards, domHeroSeat, heroCards, heroClockOf, heroHandOf, heroStatus, modalOf, parseSeats, potOf, potVal, RANK_RE,
  splitStrip, tableJs, toAct, watchJs, type Node,
} from "./dom";
import { actAdd, actSeen, boardCap, dumpMark, lastStanding, mkey, tapVerify, withoutRabbit } from "./ws";
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
    return (await cdp.evaluate(t.webSocketDebuggerUrl, watchJs(TABLES.domSlot()), 6)) || [];
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
    d = (await cdp.evaluate(t.webSocketDebuggerUrl, tableJs(TABLES.domSlot()), 6)) || {};
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

const STABLE_TICKS = 12;
const WINS_POT = /\bwins?\b.*pot/i;
const RESULT_FOR = /result for hand\s*(\d+)/i;

export async function feedTick(): Promise<void> {
  const t = await seams.ignitionTarget();
  if (!t) return;
  let d: Record<string, any>;
  try {
    d = (await cdp.evaluate(t.webSocketDebuggerUrl, tableJs(TABLES.domSlot()), 6)) || {};
  } catch {
    return;
  }
  const L = S.liveStatus;
  const w = S.ws;
  if (S.fakeMode) {
    // the authored state owns the hand's HISTORY; the per-tick SNAPSHOT is still read from the table
    try {
      const bc = boardCards(d);
      L.hero = heroStatus(d, d.nodes || []);
      L.heroSeatDom = domHeroSeat(d);
      L.board = [...bc];
      L.practice = true;
      L.toAct = toAct(d);
      const m = modalOf(d);
      L.modal = m ? { text: m.text, harmless: m.harmless } : null;
      S.feedPrev = { seated: true, seats: parseSeats(d), board: bc.length, heroCards: heroCards(d).join(" ") };
    } catch {}
    return;
  }
  try {
    L.hero = heroStatus(d, d.nodes || []);
  } catch {}
  try {
    L.heroSeatDom = domHeroSeat(d);
    tapVerify(heroCards(d));
  } catch {}
  try {
    L.buyPanel = (d.buttons || []).some((b: any) => String(b.qa || "") === "buyInButton");
  } catch {}
  const p = S.feedPrev;
  if (!d.seated) {
    if (p.seated) {
      feedAdd("table closed");
      archiveHand();
      S.feedPrev = {};
      S.seatMem.clear();
    }
    return;
  }
  const fr0 = d.frame || {};
  const mid = (fr0.y ?? 0) + (fr0.h ?? 0) * 0.7;
  const waiting = (d.nodes ?? []).some((n: Node) => /please wait|another table/i.test(n.text) && n.y < mid);
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
  await handleModal(d);
  L.timeBank = (d.buttons ?? []).find((b: any) => /^\+\d+s$/.test(String(b.text || "").trim())) ?? null;
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
      if (heroSeat !== null && !w.heroFolded && time() - toActAt <= 3.0 && actedAt < toActAt
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
    L.board = [...bc];
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
  if (S.site.id === "coinpoker") return;
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
