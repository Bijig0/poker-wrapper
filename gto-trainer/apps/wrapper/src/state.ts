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
import { C } from "./config";
import { SessionStore } from "./sessions";
import { Site } from "./sites/coinpoker";

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
    decisionKey: null, handId: null,
    auto: false, executed: null, autoTried: null, lastExec: null,
    autoHeld: null,
    pendingExec: null,
    autoDelay: "instant", autoDue: null, autoRetry: null,
    foldNoAnswer: false, noAnswerTurn: null, lastNoAnswerFold: null,
    sitBackIn: false, sitBackTurn: null, lastSitBackIn: null,
    timeBank: true, timeBankAt: 0.0, lastTimeBank: null, timeBankDecision: null,
    topUp: true, topUpAt: 0.0, topUpHand: null, lastTopUp: null,
    topUpDue: null, topUpTrigger: null,
    // The Python wrapper had a REAL-MONEY auto-execute allowance here. It is NOT ported: auto-execute arms on a
    // practice table or the fake table only (2026-09-24). The fields stay, permanently "not granted", so the
    // panel's view of them is unchanged.
    autoRealUntil: 0.0, autoRealHands: 0, autoRealFrom: null, autoRealReason: null,
    autoDeclared: false, autoDeclaredReal: false, autoDeclaredBudget: null,
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
    /** Hero's time bank over the current turn (dom.bankStep → relay.heroTimeLeft). Not in liveStatus (the golden). */
    bankSeen: null as { secs: number; at: number; started: boolean } | null,
    /** What the screen's board is worth to /hand's DOM-board override (ws.ts domBoardRefusal), per hand number: the hole
     *  cards the SAME capture showed at hero's seat, the flops it showed before anyone had acted this hand, and the
     *  refusals already logged. Kept out of S.ws / liveStatus, which the reader golden compares key by key. */
    domBoard: { hand: 0, hole: [] as string[], stale: new Set<string>(), said: new Set<string>() },
    health: { at: 0.0, issues: [] as any[] },
    panelWatch: { sid: null, seen: false, missingSince: null } as Record<string, any>,
    feed: [] as Record<string, any>[],
    feedPrev: {} as Record<string, any>,
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
    stateHealth: { ticks: 0, events: [] as any[], byKind: new Map<string, number>(), streak: new Map<string, number>(), seen: new TupleSet() },
    modalState: { lastClickAt: 0.0, reported: new Set<string>() },
    toastsSeen: [] as [string, number][],
    lastArchived: { no: 0, fp: null } as Record<string, any>,
    awards: new Map<string, Record<string, any>>(),
    net: { last: null as any, bad: 0, good: 0, sitout: null as any, history: [] as any[] },
    shadow: { hand: null as number | null, rc: null as any, seq: 0, done: new Map<number, any>(), agree: 0, differ: 0, last: null as any },
    topupLocked: false,
    topupPanel: { open: false, lastCloseAt: 0.0, domTicks: 0 } as Record<string, any>,
    topupAbort: false,
    topupKpi: { hand: null as string | null, hands: 0, short: 0, worstBb: 0.0 },
    topupPrefold: { active: false, key: null, hand: null, deadline: 0.0, startedAt: 0.0, banked: false } as Record<string, any>,
    orphanCheck: { at: 0.0, said: null as string | null },
    adoptCheck: { at: 0.0, said: null as string | null },
    execBusy: false,
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

/** What a relayed press may be told beyond its label. `cards` = the hole cards the decision was made for: the press
 *  is refused unless OUR table shows them (relay.ts holeCardsRefusal); `strict` = refuse when they cannot be seen. */
export type ActOpts = { expect?: (hit: any) => string | null; cards?: readonly unknown[] | null; strict?: boolean };

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
export const site = () => S.site.id;
