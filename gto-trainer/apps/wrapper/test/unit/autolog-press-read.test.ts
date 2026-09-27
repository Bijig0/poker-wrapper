import { afterEach, describe, expect, it } from "bun:test";
import { autoLogFor, notePress, resetAutoLog } from "../../src/autoLog";

// the pick key: `<handNo>|<decisionKey JSON>` — decisionKey = [street, board, hero cards, to call, actions so far]
const KEY = `7|${JSON.stringify(["flop", ["Td", "6h", "7s"], ["As", "Ts"], 2.6, 9])}`;
afterEach(() => resetAutoLog());

describe("the press's own read, for the API's checks #14 / #16 (2026-09-27)", () => {
  it("records the strip's buttons and the spot at the click; the same spot is not stale", () => {
    notePress(KEY, { pick: "CALL 2.6", source: "auto", ok: true, buttons: ["FOLD", "CALL 2.6", "RAISE TO 6.8"], atPress: "flop|9" });
    const [d] = autoLogFor(7)!;
    expect([d!.keyActs, d!.buttons, d!.atPress, d!.stale]).toEqual([9, ["FOLD", "CALL 2.6", "RAISE TO 6.8"], "flop|9", false]);
  });
  it("a spot that moved on before the click is stale; a press with no read leaves it unknown", () => {
    notePress(KEY, { ok: true, buttons: ["CHECK", "BET"], atPress: "flop|10" });
    expect(autoLogFor(7)![0]!.stale).toBe(true);
    resetAutoLog();
    notePress(KEY, { ok: false, reason: "poker client not open", buttons: null, atPress: null });
    expect(autoLogFor(7)![0]!.stale).toBeNull();
  });
  it("a press noted without the read (older callers) keeps whatever was recorded", () => {
    notePress(KEY, { ok: true, buttons: ["FOLD", "CALL 2.6"], atPress: "flop|9" });
    notePress(KEY, { ok: true });
    expect(autoLogFor(7)![0]!.buttons).toEqual(["FOLD", "CALL 2.6"]);
  });
});
