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
  standDown: obj({ why: anyVal.optional(), sid: anyVal.optional() }),
  profile: obj({ name: anyVal.optional(), site: anyVal.optional(), email: anyVal.optional(), password: anyVal.optional(),
                 rememberMe: anyVal.optional(), trustDevice: anyVal.optional() }),
  login: obj({ profile: anyVal.optional() }),
  code: obj({ profile: anyVal.optional(), code: anyVal.optional(), trustDevice: anyVal.optional() }),
  formatGoto: obj({ format: anyVal.optional(), buyinBb: anyVal.optional(), waitForBb: anyVal.optional() }),
  preflight: obj({ preset: anyVal.optional(), config: anyVal.optional() }),
  sessionStart: obj({ preset: anyVal.optional(), config: anyVal.optional(), label: anyVal.optional(), note: anyVal.optional(),
                      joining: anyVal.optional() }),
  sessionJoin: obj({ sid: anyVal.optional(), config: anyVal.optional() }),
  sessionLeave: obj({ sid: anyVal.optional() }),
  sessionEnd: obj({ id: anyVal.optional(), note: anyVal.optional(), all: anyVal.optional(), closeOut: anyVal.optional() }),
  balance: obj({ profile: anyVal.optional() }),
  topupSecond: obj({ cents: anyVal.optional() }),
  studyAnswers: obj({ on: anyVal.optional(), mode: anyVal.optional() }),
  panelAnswer: obj({
    text: anyVal.optional(), pick: anyVal.optional(), roll: anyVal.optional(), note: anyVal.optional(),
    uncertain: anyVal.optional(), decisionKey: anyVal.optional(), handId: anyVal.optional(),
    band: anyVal.optional(), strategy: anyVal.optional(), source: anyVal.optional(), tier: anyVal.optional(),
    chart: anyVal.optional(), exploitPick: anyVal.optional(), chartPick: anyVal.optional(),
  }),
  room: obj({ room: anyVal.optional(), preset: anyVal.optional() }),
  adminPanel: obj({ port: anyVal.optional(), action: anyVal.optional(), room: anyVal.optional() }),
  sitout: obj({ on: anyVal.optional(), all: anyVal.optional() }),
  studyAuto: obj({ auto: anyVal.optional(), allowRealMoney: anyVal.optional(), minutes: anyVal.optional(), hands: anyVal.optional(),
                   reason: anyVal.optional(), delay: anyVal.optional(), timeBank: anyVal.optional(), topUp: anyVal.optional() }),
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
  heroFolded: z.boolean(), heroWon: z.boolean(), ended: z.boolean(),
});

export const HandReply = obj({ ok: z.boolean(), hand: Hand.nullable() });

/** GET /state (light or full): the fields the poller and the panel act on. */
export const StateReply = obj({
  cdp: z.boolean(), connected: z.boolean(), hand: Hand.nullable(), studyAnswers: z.boolean(),
  sessionId: z.string().nullable(), site: z.string(), practice: z.boolean(), fakeTable: z.boolean(),
  panelPort: z.number(), cdpPort: z.number(), tableSlot: z.number().nullable(),
  pickReady: obj({ ok: z.boolean(), reason: z.string().nullable() }),
  snapshot: obj({ status: z.string().nullable(), seats: z.array(obj({ hero: z.boolean(), sittingOut: z.boolean() })) }),
});

/** POST /panel/answer — what the poller pushes. */
export const PanelAnswer = Body.panelAnswer;

export type HandT = z.infer<typeof Hand>;
export type StateReplyT = z.infer<typeof StateReply>;
