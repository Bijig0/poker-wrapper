/**
 * THE WRAPPER'S STATE — everything launch.py kept in module globals, in one object.
 *
 * One process reads one table and presses real buttons, so the state is still one set per process (four tables
 * are four processes, exactly as before). What changed is only that it is NAMED: every field below is the Python
 * global of the same name (camelCased, leading underscore dropped), and `resetState()` puts a fresh copy in place —
 * which is what lets the golden replays run scenario after scenario in one test process.
 *
 * Python dicts whose iteration order matters, or whose keys are ints, are Maps (a JS object sorts integer keys).
 * Python sets of TUPLES are TupleSets: the tuple is compared by content, and it iterates as the list of tuples the
 * golden normaliser sorts, exactly as Python's norm() does.
 *
 * SEAMS: the few functions the golden harness replaces (Python monkeypatched the module: ignition_target, act,
 * raise_to, _cdp_seq, TABLES.registry, TABLES.live_peers). Every internal call goes through `seams`, so replacing
 * one here replaces it everywhere, as it did in Python.
 */
import { time } from "./clock";
import { C } from "./config";
import { truthy } from "./py";
import { SessionStore } from "./sessions";
import { Site } from "./sites/coinpoker";
import { Site as CggSite } from "./sites/clubgg";
import type { Stall } from "./ignition/stall";

export class TupleSet extends Set<unknown[]> {
  private index = new Map<string, unknown[]>();
  static key(t: unknown[]): string {
    return JSON.stringify(t);
  }
  override add(t: unknown[]): this {
    const k = TupleSet.key(t);
    if (this.index === undefined || this.index.has(k)) return this;
    this.index.set(k, t);
    return super.add(t);
  }
  override has(t: unknown[]): boolean {
    return this.index.has(TupleSet.key(t));
  }
  override delete(t: unknown[]): boolean {
    const k = TupleSet.key(t);
    const v = this.index.get(k);
    if (v === undefined) return false;
    this.index.delete(k);
    return super.delete(v);
  }
  override clear(): void {
    this.index.clear();
    super.clear();
  }
  /** set(list(s)[-n:]) — keep the last n (insertion order; Python's is hash order, which no caller relies on). */
  keepLast(n: number): TupleSet {
    const out = new TupleSet();
    for (const t of [...this].slice(-n)) out.add(t);
    return out;
  }
}

export function freshStudy(): Record<string, any> {
  return {
    on: false, text: null, pick: null, roll: null, note: null,
    at: 0.0,
    // THE CHAIN LINE (2026-09-25, the API's services/chainPath): this answer's verdict — clean / rebuilt / extra
    // requests / no answer — and the session's clean count, which outlives any one answer
    chain: null, chainSession: null,
    decisionKey: null, handId: null, solveId: null as number | null, clientHandId: null as string | null,
    auto: false, executed: null, autoTried: null, lastExec: null,
    autoHeld: null,
    pendingExec: null,
    autoDelay: "instant", autoDue: null, autoRetry: null,
    foldNoAnswer: false, noAnswerTurn: null, lastNoAnswerFold: null,
    sitBackIn: false, sitBackTurn: null, lastSitBackIn: null,
    timeBank: true, timeBankAt: 0.0, lastTimeBank: null, timeBankDecision: null,
    topUp: true, topUpAt: 0.0, topUpHand: null, lastTopUp: null,
    topUpDue: null, topUpTrigger: null,
    // THE REAL-MONEY AUTO-EXECUTE ALLOWANCE (relay.ts, restored 2026-09-24 after the TS port first left it out): a
    // time/hand budget granted per session; these fields hold it. Practice and the fake table need no grant.
    autoRealUntil: 0.0, autoRealHands: 0, autoRealFrom: null, autoRealReason: null,
    autoDeclared: false, autoDeclaredReal: false, autoDeclaredBudget: null,
    // ON DEMAND (2026-09-30, the CoinPoker ring strategy): the session's strategy answers only when the panel's Solve
    // asks (relay.requestSolve), and auto-execute cannot arm. `solveRequest` is that press: the decision it was made
    // on (hand, street, the line's length) and when.
    onDemand: false, solveRequest: null,
  };
}

/** The deep-stack reset's steps (stackReset.ts). */
export type StackResetState = "idle" | "armed" | "sat-out" | "leaving" | "waiting" | "reseating";
/** How long a sibling's word that its socket is about to close on purpose holds (stackReset.ts peerLeaving). */
export const PEER_LEAVING_S = 600;

/** THE DEEP-STACK RESET (stackReset.ts), one table's state plus — at the leader — the notes of the tables resetting.
 *  Its own top-level key: never on liveStatus or the light /state, which the reader golden compares key by key. */
export function freshStackReset() {
  return {
    /** the session's setting (session.ts applySessionConfig): hero's stack in bb that starts a reset, 0 = off; the
     *  wait between leaving one table and the next seat */
    bb: 0, waitS: 60,
    state: "idle" as StackResetState,
    since: 0.0,
    /** a slow step (the press, the leader, the leave) is running in the background: the machine waits for it */
    busy: false,
    armedHand: 0, stackBb: null as number | null,
    ticks: 0, clicked: false, needTick: false, lastTick: null as Record<string, any> | null, bbHands: [] as number[],
    leftAt: 0.0, notBefore: 0.0, oldRid: null as string | null, oldTag: null as string | null,
    abortedAt: null as number | null, aborts: 0,
    /** sockets the sibling tables said are about to close on purpose (rid → when told) */
    peerLeaving: new Map<string, number>(),
    /** THE LEADER'S NOTES (session.ts noteStackReset): one per table resetting — `matched` once the seat count fell for
     *  it (honourClosedTables), `notBefore` when its new seat is due */
    notes: [] as { slot: number | null; at: number; notBefore: number; left: boolean; matched: boolean }[],
  };
}

function fresh() {
  return {
    site: { id: "ignition" as string },
    session: { id: null as string | null, rec: null as any, started: 0.0 },
    sessions: new SessionStore(),
    faketableSpec: null as Record<string, any> | null,
    faketableSpecs: new Map<number, Record<string, any>>(),
    fakeMode: C.FAKE_RIG,
    layoutLast: {} as Record<string, any>,
    cpSnap: { room: null } as Record<string, any>,
    cpFollow: { room: null, hwnd: null, rect: null, stable: 0, snapped: null } as Record<string, any>,
    study: freshStudy(),
    liveStatus: { hero: "unknown" } as Record<string, any>,
    /** Seconds on hero's action clock as the table shows it (Ignition), null when not on the clock / unreadable. Kept
     *  out of liveStatus, which the reader golden compares key by key against the Python recordings. */
    heroClock: null as number | null,
    /** When the reader last READ the strip and set liveStatus.toAct (reader.ts feedTick). A tick that stands down
     *  before that point (table read failed, "table broke", not seated) leaves toAct as it was; hand.ts treats a
     *  reading older than BUTTONS_STALE_S as no buttons. Not in liveStatus (the golden). */
    screenReadAt: null as number | null,
    /** Hero's time bank over the current turn (dom.bankStep → relay.heroTimeLeft). Not in liveStatus (the golden). */
    bankSeen: null as { secs: number; at: number; started: boolean } | null,
    /** What the screen's board is worth to /hand's DOM-board override (ws.ts domBoardRefusal), per hand number: the hole
     *  cards the SAME capture showed at hero's seat, the flops it showed before anyone had acted this hand, and the
     *  refusals already logged. Kept out of S.ws / liveStatus, which the reader golden compares key by key. */
    domBoard: { hand: 0, hole: [] as string[], stale: new Set<string>(), said: new Set<string>() },
    health: { at: 0.0, issues: [] as any[] },
    panelWatch: { sid: null, seen: false, missingSince: null } as Record<string, any>,
    /** the CoinPoker leader window's watch (session.leaderWatchLoop): gone for 8 s once seen = close every panel */
    leaderWatch: { seen: false, missingSince: null as number | null, quietUntil: 0, closingAll: false },
    /** a CoinPoker close-out under way (session.cpCloseOut): why, the table, the step it is on */
    cpClosing: null as { why: string; room: string | null; at: number; step: string } | null,
    feed: [] as Record<string, any>[],
    feedPrev: {} as Record<string, any>,
    /** When our frame last stopped showing a table it had shown (reader.ts "table closed"): a socket closing right
     *  after is the site taking the table down, not a drop (reader.ts siteClosedEvidence). */
    tableGoneAt: 0.0,
    handNo: 0,
    seatMem: new Map<number, Record<string, any>>(),
    handBlinds: { no: 0, sb: false, bb: false, ticks: 0, strength: false, cards: "" } as Record<string, any>,
    handBoard: { no: 0, max: 0, armed: false } as Record<string, any>,
    roundSeen: new Set<unknown>(),
    actionGraceUntil: 0.0,
    winsSeen: [] as string[],
    handIds: new Map<number, string>(),
    resultSeen: [] as string[],
    dbg: { on: false, dir: null as string | null, seq: 0 },
    ws: { bb: 0, board: [], pot: null } as Record<string, any>,
    wsDump: [] as Record<string, any>[],
    wsDumpCur: null as Record<string, any> | null,
    tapBound: null as string | null,
    // when we last left a table on purpose (session.ts markLeaving): its socket closing then is not a failure
    tapLeavingAt: 0,
    /** When a socket of the page that is NOT ours last closed (reader.ts noteSocketClosed): the network taking every
     *  socket closes ours within seconds of the others — the site closing our empty table closes ours alone. */
    tapOtherClosedAt: 0,
    /** THE SITE CLOSED OUR TABLE (2026-10-01, session_20261001_021221: table 2 emptied to hero alone and Ignition shut it
     *  15 s later; the socket-closed rule took the whole client down mid-hand on table 1). Our game socket closing with
     *  hero alone and no hand on is the site's close, not a connection failure: the session goes on and a table of the
     *  same format is asked for again (reader.ts noteSocketClosed → maybeSettleSiteClose; session.ts
     *  maybeReseatAfterSiteClose, honourClosedTables). `notice` = the close awaiting its settle / the feed loop;
     *  `pending` = closes the LEADER has still to match to a seat-count drop, each when it was noted; `lastHonour` = the
     *  leader's last close-by-hand verdicts, undone when the site's notice arrives just after; `repinUntil` = our frame
     *  is about to vanish: pin the next table the client opens (dom.ts forgetFrame) instead of standing down for good. */
    siteClosed: {
      notice: null as null | { at: number; decideAt: number; settled: boolean; rid: string; sid: string; slot: number | null;
                               seats: number[]; hero: string | null; hand: number },
      pending: [] as number[],
      lastHonour: { at: 0.0, slots: [] as number[] },
      repinUntil: 0.0,
    },
    tapForeign: 0,
    tapHeld: 0,
    tapSeen: new Map<string, number[]>(),
    /** Every socket's face-up deal in ITS current hand, whether or not it is the one we are reading (2026-09-25):
     *  cleared when that socket starts a hand, so an old hand's deal can never bind us. */
    tapDeals: new Map<string, { up: Map<number, string[]>; at: number }>(),
    tapClaims: new Map<string, number>(),
    tapRejected: new Set<string>(),
    tapHold: new Map<string, Record<string, any>[]>(),
    /** Every socket's frames since ITS last PLAY_STAGE_INFO, always (tapHold only fills while unbound): what a
     *  re-bind replays, so the hand is rebuilt from its start after a hand in progress was dropped. */
    tapHist: new Map<string, Record<string, any>[]>(),
    tapReplay: [] as Record<string, any>[],
    tapDomCards: [] as string[],
    tapAmbiguousSaid: new TupleSet(),
    tapMismatch: 0,
    tapStall: { since: null as number | null, said: false },
    /** Every socket's last frame and last PONG (ignition/stall.ts noteTapFrame): what a silent socket is told by. */
    tapLast: new Map<string, { at: number; pongAt: number | null }>(),
    /** OUR SOCKET WENT SILENT MID-HAND (ignition/stall.ts): `cur` = the stall open now, `last` = the latest one,
     *  `byHand` = each hand's stalls for its row, `dealtSince` = hero has been dealt a hand after `last` (the seat
     *  survived it, so a later close of this table may be the site's again). */
    socketStall: { cur: null as Stall | null, last: null as Stall | null, byHand: new Map<number, Stall[]>(), dealtSince: false },
    /** Hero's cards in the hand before this one, and when the bound socket dealt the current one: our frame still
     *  showing those a few seconds after a new deal is the DOM catching up, not another table (tapVerify). */
    tapPrevHero: [] as string[],
    tapDealtAt: 0.0,
    /** Our frame has shown the cards the bound socket dealt hero in THIS hand (tapVerify): until it has, a DOM reading
     *  is not known to be this hand's — nothing is backfilled from it, and a deal it never draws is another table's. */
    tapDealDrawn: false,
    /** The handNo of a hand dropped because its socket turned out to be another table's — never archived. */
    handAbandoned: null as number | null,
    /** A table showed the client's "disconnected from our poker server" overlay (dom.ts disconnectOf) during this
     *  session: nothing is pressed from then on, the client is closed so it cannot reconnect, and the session ends
     *  (session.ts maybeEndForDisconnect). Cleared only by a new session. */
    disconnect: null as null | { at: number; slot: number | null; text: string; attempt: number | null; of: number | null;
                                 reconnected: boolean; sid: string | null; handled: boolean; via: string },
    /** OUR TABLE'S OWN TAG (data-multitableslot), pinned on the first read (dom.ts mySel): a closed table never
     *  moves the others. `lost` = when the pinned frame went away (we stand down; we never take a neighbour's). */
    frame: { tag: null as string | null, at: 0.0, lost: null as number | null, for: null as string | null },
    /** OUR FRAME'S HEALTH as the last capture found it (reader.ts noteFrame): every table tag open on the page, how many
     *  frames carry our pinned tag, and whether the browser is still drawing ours; `said` is the condition last
     *  reported and `since` when it began. /state `tableFrame`, with the pinned tag. */
    frameHealth: {
      tags: null as number[] | null, dup: 0, drawn: null as boolean | null, why: null as string | null,
      idleMs: null as number | null, since: null as number | null, said: "",
    },
    stateHealth: { ticks: 0, events: [] as any[], byKind: new Map<string, number>(), streak: new Map<string, number>(), seen: new TupleSet() },
    modalState: { lastClickAt: 0.0, reported: new Set<string>() },
    toastsSeen: [] as [string, number][],
    /** the client's buy receipts in its message history, counted by text (reader.ts receiptRises) */
    receiptCounts: null as Map<string, number> | null,
    lastArchived: { no: 0, fp: null } as Record<string, any>,
    awards: new Map<string, Record<string, any>>(),
    /** The connection guard (netguard.ts). `drop` = the link went bad during session `sid`: the session ends at the hand's
     *  end (session.ts maybeEndForNetDrop) and hero is never sat back in; `handled` once it has been ended (or passed on). */
    net: { last: null as any, bad: 0, good: 0, sitout: null as any, history: [] as any[],
           drop: null as null | { sid: string; at: number; why: string; via: string; handled: boolean } },
    stackReset: freshStackReset(),
    shadow: { hand: null as number | null, rc: null as any, seq: 0, done: new Map<number, any>(), agree: 0, differ: 0, last: null as any },
    // the screen checking the protocol's line (ignition/shadow.ts screenPotCheck): consecutive disagreeing ticks, and why
    screenCheck: { hand: null as number | null, bad: 0, since: null as number | null, why: null as string | null },
    topupLocked: false,
    topupPanel: { open: false, lastCloseAt: 0.0, domTicks: 0 } as Record<string, any>,
    topupAbort: false,
    topupKpi: { hand: null as string | null, hands: 0, short: 0, worstBb: 0.0 },
    topupPrefold: { active: false, key: null, hand: null, deadline: 0.0, startedAt: 0.0, banked: false } as Record<string, any>,
    /** HERO'S MONEY AS THE TABLE'S SOCKET REPORTS IT (topup.ts noteTopUpFrame, 2026-10-04): each note carries the socket
     *  (`rid`) and the wrapper's hand counter (`handNo`) it came in. `end` = hero's stack at a hand's end (CO_RESULT_INFO,
     *  before any buy is added), `cash` = his NEW stack after a buy went through (PLAY_ACCOUNT_CASH_RES type 2), `account`
     *  = his stack as he folded (PLAY_ACCOUNT_INFO), `buyin` = what the opened Buy-chips panel offers (PLAY_BUYIN_INFO),
     *  `ends` = when hands ended (ms, the last 20). */
    topupSock: { end: null as null | Record<string, any>, cash: null as null | Record<string, any>,
                 account: null as null | Record<string, any>, buyin: null as null | Record<string, any>,
                 ends: [] as number[], endHand: null as number | null },
    /** The need at each deal and the stall alarm (topup.ts topUpDealNeed): the last deal's verdict, when a run last
     *  started, the hand whose final verdict was already said, the alarms raised. */
    topupNeed: { prev: null as null | { hid: string; need: boolean; at: number; shortBb: number | null },
                 lastAttemptAt: 0.0, finalSaid: null as string | null, stalls: 0, last: null as any },
    orphanCheck: { at: 0.0, said: null as string | null },
    adoptCheck: { at: 0.0, said: null as string | null },
    chain: { attempting: false, lastAt: 0.0, lastResult: null as any, lastCheck: null as number | null },
    router: { state: "idle", text: "", steps: [] as string[], at: 0.0, format: null as string | null, cancel: false,
              loginAt: 0.0, seats: null as any, generation: 0 } as Record<string, any>,
    seating: { reached: 0 },
    recPending: { on: false },
    handsCache: { id: null as string | null, at: 0.0, n: 0 },
    closedTables: new Set<number>(),
    updateCache: { at: 0.0, latest: null as any, error: null as string | null },
    ownerRelease: { at: 0.0, running: false, status: null as any },
  };
}

export type WrapperState = ReturnType<typeof fresh>;

export const S: WrapperState = fresh();

/** Put a fresh state in place (tests / a replay scenario). */
export function resetState(): void {
  const f = fresh();
  for (const k of Object.keys(S)) delete (S as any)[k];
  Object.assign(S, f);
}

/** Why no press may be made at all right now, or null: a table lost the poker server this session (S.disconnect). */
export function pressBlocked(): string | null {
  const x = S.disconnect;
  if (!x) return null;
  return `table ${x.slot ?? 1} lost the poker server (${x.reconnected ? "the client reconnected on its own" : x.text}) — `
    + "the session is ended there and nothing is pressed";
}

/** Hero has cards in front of him right now — money a Leave would forfeit (session.ts standDownTable), and the one
 *  state in which a table's socket closing can never be the site closing an empty table (ignition/reader.ts). */
export function inAHand(): boolean {
  if (S.ws.handOver || S.ws.heroFolded) return false;
  return truthy(S.ws.heroCards) || S.liveStatus.hero === "in-hand";
}

/** Our own socket `rid` closing is the deep-stack reset's leave, not a failure (ignition/reader.ts noteSocketClosed):
 *  the leave can outlast LEAVE_GRACE_S. Only the socket we left; before a new table binds when none was bound. */
export function stackResetLeaving(rid: string): boolean {
  const R = S.stackReset;
  if (R.state !== "leaving" && R.state !== "waiting" && R.state !== "reseating") return false;
  return R.oldRid !== null ? R.oldRid === rid : R.state !== "reseating";
}

/** A sibling table said this socket of the page is about to close on purpose (stackReset.ts peerLeaving). */
export function peerIsLeaving(rid: string): boolean {
  const at = S.stackReset.peerLeaving.get(rid);
  return at !== undefined && time() - at <= PEER_LEAVING_S;
}

/** What a relayed press may be told beyond its label. `cards` = the hole cards the decision was made for: the press
 *  is refused unless OUR table shows them (relay.ts holeCardsRefusal); `strict` = refuse when they cannot be seen. */
/** `expect` sees the matched control and, beside it, every control of its row on the SAME read (`pool`). */
export type ActOpts = { expect?: (hit: any, pool?: any[]) => string | null; cards?: readonly unknown[] | null; strict?: boolean };

/** The functions a test may replace (see the header). Filled in by the modules that own them. */
export const seams: {
  ignitionTarget: () => Promise<Record<string, any> | null>;
  act: (label: string, kind?: string, opts?: ActOpts) => Promise<Record<string, any>>;
  raiseTo: (amount: string, strict?: boolean, opts?: ActOpts) => Promise<Record<string, any>>;
  cdpSeq: (ws: string, cmds: [string, Record<string, unknown>][]) => Promise<void>;
  registry: (now?: number) => any[];
  livePeers: (timeoutS?: number) => Promise<any[]>;
} = {} as any;

/** The CoinPoker site (launch.CP): its log reader runs for the life of the process. */
export const CP = new Site();

export const isCp = () => S.site.id === "coinpoker";
/** The ClubGG site (the screen reader): its loop reads only while a ClubGG session is live. */
export const CGG = new CggSite();
export const isCgg = () => S.site.id === "clubgg";
/** A desktop-client site the wrapper does not drive through a browser (CoinPoker, ClubGG): no CDP table, no router. */
export const isClientSite = () => isCp() || isCgg();
export const site = () => S.site.id;
