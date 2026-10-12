/**
 * THE WRAPPER'S HTTP CONTRACT, as zod schemas — one definition shared by the wrapper (it parses every POST body
 * through these) and its callers (the study API's poller can import the reply schemas and validate what it reads
 * from /state and /hand instead of trusting the shape).
 *
 * Request schemas are deliberately PERMISSIVE: the Python wrapper accepted loose bodies (a missing field meant its
 * default, an extra field was ignored, a number where a string was expected was str()-ed), and the panel pages and
 * tools depend on that. They type the fields and reject only what the Python handler could not have used at all
 * (a body that is not a JSON object).
 */
import { z } from "zod";

const anyVal = z.unknown();
const obj = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);

export const Body = {
  act: obj({ label: anyVal.optional(), kind: anyVal.optional(), amount: anyVal.optional() }),
  faketableSlot: obj({ slot: anyVal.optional(), spec: anyVal.optional() }),
  faketableFixture: obj({ name: anyVal.optional(), fixture: anyVal.optional() }),
  gtowConnect: obj({ source: anyVal.optional() }),
  tablesClose: obj({ slot: anyVal.optional(), why: anyVal.optional() }),
  tablesPanel: obj({ slot: anyVal.optional() }),
  panelOpen: obj({ why: anyVal.optional() }),
  standDown: obj({ why: anyVal.optional(), sid: anyVal.optional() }),
  profile: obj({ name: anyVal.optional(), site: anyVal.optional(), email: anyVal.optional(), password: anyVal.optional(),
                 rememberMe: anyVal.optional(), trustDevice: anyVal.optional() }),
  login: obj({ profile: anyVal.optional() }),
  code: obj({ profile: anyVal.optional(), code: anyVal.optional(), trustDevice: anyVal.optional() }),
  preflight: obj({ preset: anyVal.optional(), config: anyVal.optional() }),
  sessionStart: obj({ preset: anyVal.optional(), config: anyVal.optional(), label: anyVal.optional(), note: anyVal.optional(),
                      joining: anyVal.optional() }),
  sessionJoin: obj({ sid: anyVal.optional(), config: anyVal.optional() }),
  sessionLeave: obj({ sid: anyVal.optional() }),
  sessionDisconnected: obj({ sid: anyVal.optional(), slot: anyVal.optional(), text: anyVal.optional(), attempt: anyVal.optional(),
                             of: anyVal.optional(), reconnected: anyVal.optional(), client: anyVal.optional() }),
  sessionNetDrop: obj({ sid: anyVal.optional(), slot: anyVal.optional(), why: anyVal.optional() }),
  sessionTableClosed: obj({ sid: anyVal.optional(), slot: anyVal.optional(), hand: anyVal.optional(), seats: anyVal.optional(),
                            hero: anyVal.optional(), rid: anyVal.optional() }),
  sessionStackReset: obj({ sid: anyVal.optional(), slot: anyVal.optional(), phase: anyVal.optional(), waitS: anyVal.optional(),
                            notBefore: anyVal.optional() }),
  peerLeaving: obj({ sid: anyVal.optional(), slot: anyVal.optional(), rid: anyVal.optional() }),
  sessionEnd: obj({ id: anyVal.optional(), note: anyVal.optional(), all: anyVal.optional(), closeOut: anyVal.optional() }),
  balance: obj({ profile: anyVal.optional() }),
  topupSecond: obj({ cents: anyVal.optional() }),
  studyAnswers: obj({ on: anyVal.optional(), mode: anyVal.optional() }),
  panelAnswer: obj({
    text: anyVal.optional(), pick: anyVal.optional(), roll: anyVal.optional(), note: anyVal.optional(),
    uncertain: anyVal.optional(), decisionKey: anyVal.optional(), handId: anyVal.optional(),
    solveId: anyVal.optional(), clientHandId: anyVal.optional(),
    band: anyVal.optional(), strategy: anyVal.optional(), source: anyVal.optional(), tier: anyVal.optional(),
    chart: anyVal.optional(), exploitPick: anyVal.optional(), chartPick: anyVal.optional(),
    // THE SHORT ALL-IN PRESS (2026-10-07, the API's services/allInPress): [{action, kind: "raise-to", amount, verb, why, …}]
    press: anyVal.optional(),
  }),
  // LIVE STEPS (2026-10-12): the API's solve steps for one decision, pushed while the solve runs (steps.noteSolveSteps)
  panelSteps: obj({ decisionKey: anyVal.optional(), handId: anyVal.optional(), steps: anyVal.optional(), run: anyVal.optional() }),
  room: obj({ room: anyVal.optional(), preset: anyVal.optional() }),
  adminPanel: obj({ port: anyVal.optional(), action: anyVal.optional(), room: anyVal.optional() }),
  sitout: obj({ on: anyVal.optional(), all: anyVal.optional() }),
  cggAttach: obj({ key: anyVal.optional(), title: anyVal.optional() }),
  studyAuto: obj({ auto: anyVal.optional(), allowRealMoney: anyVal.optional(), minutes: anyVal.optional(), hands: anyVal.optional(),
                   reason: anyVal.optional(), delay: anyVal.optional(), timeBank: anyVal.optional(), topUp: anyVal.optional(),
                   via: anyVal.optional(), page: anyVal.optional() }),
  studyAutoBudget: obj({ minutes: anyVal.optional(), hands: anyVal.optional(), via: anyVal.optional(), page: anyVal.optional() }),
  debug: obj({ on: anyVal.optional() }),
  recnote: obj({ session: anyVal.optional(), note: anyVal.optional() }),
  any: z.record(z.string(), z.unknown()),
};

// ---- replies the study API reads (CONTRACT.md §1) --------------------------------------------------------
export const ActionRec = obj({
  seatId: z.number(), hero: z.boolean(), type: z.string(), street: z.string(), amount: z.number().optional(),
});

export const CurrentNode = obj({
  street: z.string(), toActSeatId: z.number().nullable(), toActIsHero: z.boolean(), pot: z.number(), toCall: z.number(),
  legalActions: z.array(z.unknown()), complete: z.boolean(),
});

/** GET /hand's `hand` (and /state's): a ParsedHand. */
export const Hand = obj({
  handId: z.number(), tableSlot: z.number().nullable(), panelPort: z.number().optional(), clientHandId: z.string().nullable(),
  bbCents: z.number().nullable().optional(), heroSeatId: z.number(), heroCards: z.array(z.string()), board: z.array(z.string()),
  street: z.string(), actions: z.array(ActionRec), liveSeats: z.array(z.number()),
  committed: z.record(z.string(), z.number().nullable()), positions: z.record(z.string(), z.string()),
  stacks: z.record(z.string(), z.number().nullable()).nullable(), currentNode: CurrentNode,
  /** each dealt seat's stack as dealt (bb), from the table's own account — present once the seat has acted */
  startStacks: z.record(z.string(), z.number()).optional(),
  /** each dealt seat's chips behind NOW (bb, 4 dp), from the WebSocket's own account — once the WS has reported the
   *  hand; a seat whose money the DOM filed ahead of any frame is left out until its next frame (round 3) */
  wsStack: z.record(z.string(), z.number()).optional(),
  /** each dealt seat's chips in front THIS STREET (bb, 4 dp), from the WebSocket frames — same coverage as wsStack */
  wsInFront: z.record(z.string(), z.number()).optional(),
  /** a dead blind a seat posted (bb): out of its stack, in no bet */
  wsDead: z.record(z.string(), z.number()).optional(),
  heroFolded: z.boolean(), heroWon: z.boolean(), ended: z.boolean(),
});

export const HandReply = obj({ ok: z.boolean(), hand: Hand.nullable() });

/** /state `stackReset` (2026-10-09): the deep-stack reset's step, its ticks and aborts, the last tick's outcome. */
export const StackResetBrief = obj({
  state: z.enum(["idle", "armed", "sat-out", "leaving", "waiting", "reseating"]), bb: z.number(), waitS: z.number(),
  since: z.number().nullable(), forS: z.number().nullable(), armedHand: z.number().nullable(), stackBb: z.number().nullable(),
  ticks: z.number(), maxTicks: z.number(), misses: z.number(), aborts: z.number(), maxAborts: z.number(), off: z.boolean(),
  lastTick: obj({ at: z.number().nullable(), ok: z.boolean(), why: z.string().nullable(), method: z.string().nullable() }).nullable(),
  /** the panel's banner (stackReset.ts stackResetBanner): the step in plain words while the reset is under way, then
   *  how it ended for a while; null when there is nothing to say */
  banner: obj({
    phase: z.enum(["armed", "sat-out", "leaving", "waiting", "reseating", "done", "aborted", "off"]),
    level: z.enum(["reset", "ok", "bad"]), text: z.string(), detail: z.string().nullable(), short: z.string(),
  }).nullable().optional(),
});

/** GET /state (light or full): the fields the poller and the panel act on. */
export const StateReply = obj({
  cdp: z.boolean(), connected: z.boolean(), hand: Hand.nullable(), studyAnswers: z.boolean(),
  sessionId: z.string().nullable(), site: z.string(), practice: z.boolean(), fakeTable: z.boolean(),
  panelPort: z.number(), cdpPort: z.number(), tableSlot: z.number().nullable(),
  pickReady: obj({ ok: z.boolean(), reason: z.string().nullable() }),
  snapshot: obj({ status: z.string().nullable(), seats: z.array(obj({ hero: z.boolean(), sittingOut: z.boolean() })) }),
  /** the deep-stack reset's machine (stackReset.ts stackResetBrief) — present only while the session has the reset on */
  stackReset: StackResetBrief.optional(),
});

