/**
 * CoinPoker's sizing presets are buttons of their own: a bet made with the Pot button logs caption "Raise",
 * newCaption "Pot". The reader typed actions by newCaption alone, so every Pot-button bet vanished from the line
 * (hand 140706500001, 2026-09-24: the villain's flop and turn bets were dropped, the solve saw hero first to act,
 * and answered "Check" facing a 21bb bet). test/fixtures/cp-hand-140706500001.log.gz is that hand's own log lines.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { actionType, exportHand, Feed, learnHero } from "../../src/sites/cpFeed";

test("actionType: a preset label falls back to the caption; a first bet on a street is a bet", () => {
  expect(actionType({ action: "Pot", caption: "Raise", street: "FLOP" }, 0)).toBe("bet");
  expect(actionType({ action: "Pot", caption: "Raise", street: "FLOP" }, 5.36)).toBe("raise");
  expect(actionType({ action: "Pot", caption: "Raise", street: "PREFLOP" }, 0.25)).toBe("raise");
  expect(actionType({ action: "Bet", caption: "Raise", street: "TURN" }, 0)).toBe("bet");
  expect(actionType({ action: "Raise", caption: "Raise", street: "TURN" }, 5)).toBe("raise");
  expect(actionType({ action: "Call", caption: "Call", street: "TURN" }, 5)).toBe("call");
  expect(actionType({ action: "Muck", caption: "Muck", street: "RIVER" }, 0)).toBeNull();
});

test("hand 140706500001: the villain's Pot-button bets are in the line and price hero's decisions", () => {
  learnHero("megturism0");
  const f = new Feed("NUL", true);
  const text = new TextDecoder().decode(Bun.gunzipSync(readFileSync(join(import.meta.dir, "..", "fixtures", "cp-hand-140706500001.log.gz"))));
  const seen = new Map<string, any>();
  for (const line of text.split("\n")) {
    for (const [name] of f.processLine(line)) {
      const e = exportHand(f.rooms.get(name)!);
      if (e && e.handId === 140706500001 && e.currentNode.toActIsHero && !seen.has(e.currentNode.street)) seen.set(e.currentNode.street, e);
    }
  }
  const tail = (e: any) => e.actions.filter((a: any) => a.street !== "preflop").map((a: any) => `${a.hero ? "H" : "V"}:${a.street}:${a.type} ${a.amount ?? ""}`.trim());
  const flop = seen.get("flop");
  expect(flop.currentNode.toCall).toBe(21.44);
  expect(tail(flop)).toEqual(["V:flop:bet 21.44"]);
  const turn = seen.get("turn");
  expect(turn.currentNode.toCall).toBe(64.32);
  expect(tail(turn)).toEqual(["V:flop:bet 21.44", "H:flop:call 21.44", "V:turn:bet 64.32"]);
  expect(flop.lineUncertain).toBeNull();
});
