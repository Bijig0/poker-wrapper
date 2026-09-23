/**
 * The poller's read of the wrapper's /state is checked against the SHARED contract (apps/wrapper/src/contract.ts).
 * The wrapper's contract suite proves those schemas against both wrapper implementations; this proves the API side
 * uses them: a reply on the contract passes, a reply off it names the field.
 */
import { describe, expect, it } from "bun:test";
import { wrapperContractIssues } from "./resolveHand";

const HAND = {
  handId: 7, tableSlot: null, panelPort: 7700, clientHandId: "4919080696", bbCents: 200, heroSeatId: 4,
  heroCards: ["Ah", "Kd"], board: [], street: "preflop",
  actions: [{ seatId: 1, hero: false, type: "post-sb", street: "preflop", amount: 1 }],
  liveSeats: [1, 2, 4], committed: { "1": 1, "2": 2 }, positions: { "1": "SB", "2": "BB", "4": "BTN" },
  stacks: { "1": 100, "2": 100, "4": 100 },
  currentNode: { street: "preflop", toActSeatId: 4, toActIsHero: true, pot: 3, toCall: 2, legalActions: [], complete: false },
  heroFolded: false, heroWon: false, ended: false,
};
const STATE = {
  cdp: true, connected: true, hand: HAND, studyAnswers: true, sessionId: "s1", site: "ignition", practice: false,
  fakeTable: false, panelPort: 7700, cdpPort: 9333, tableSlot: null,
  pickReady: { ok: false, reason: "no answer yet" },
  snapshot: { status: "in-hand", seats: [{ hero: true, sittingOut: false }] },
  // fields the contract does not name ride along untouched (the schemas are loose objects)
  panelAnswer: null, extraField: 1,
};

describe("wrapper /state against the shared contract", () => {
  it("a reply on the contract passes", () => {
    expect(wrapperContractIssues(STATE)).toBeNull();
    expect(wrapperContractIssues({ ...STATE, hand: null })).toBeNull();
  });

  it("a reply off the contract names the field", () => {
    const { connected: _drop, ...noConnected } = STATE;
    expect(wrapperContractIssues(noConnected)).toContain("connected");
    expect(wrapperContractIssues({ ...STATE, hand: { ...HAND, heroCards: "AhKd" } })).toContain("hand.heroCards");
    expect(wrapperContractIssues({ ...STATE, hand: { ...HAND, currentNode: { ...HAND.currentNode, toCall: "2" } } }))
      .toContain("hand.currentNode.toCall");
  });
});
