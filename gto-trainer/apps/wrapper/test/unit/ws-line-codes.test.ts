/**
 * TWO PROTOCOL CODES THE REDUCER DID NOT KNOW (2026-10-03, the reader audit: 1,434 hands against Ignition's own hand
 * histories — these four hands were the only ones where the line built from a complete capture differed).
 *
 *  · CO_SELECT_INFO btn 1048576 = "Folds & shows": a fold with no chips. Unknown, it fell to the amount rule ("no
 *    chips = a check"), so the seat stayed in the hand.
 *  · CO_BLIND_INFO btn 16 = a returning player's post WITH a dead small blind (bet = the live blind, dead = the dead
 *    one; Ignition's history: "Posts dead chip $0.07"). The chips were counted, the post row was not written, so the
 *    poster's option-check at its turn read as a check from a seat with nothing in front of it.
 *
 * test/fixtures/ign-ws-codes.json = the line frames of three of those hands, as the tap dumped them (NL5, bb = 5c).
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { potAgrees, wsHand } from "../../src/ignition/wsLine";

const fx: Record<string, Record<string, any>[]> = JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "ign-ws-codes.json"), "utf8"));
const line = (id: string, street?: string) =>
  wsHand(fx[id]!, 5).actions.filter((a) => !street || a.street === street).map((a) => `${a.street} ${a.seatId} ${a.type}${a.amount !== undefined ? " " + a.amount : ""}`);

test("a post with a dead small blind is a post: the poster's option at its turn is a check behind it (hand 4921653890)", () => {
  const p = wsHand(fx["4921653890"]!, 5);
  expect(line("4921653890", "preflop")).toEqual(["preflop 1 post-bb 1", "preflop 3 post 1", "preflop 2 fold", "preflop 3 check", "preflop 4 call 1", "preflop 1 check"]);
  expect(p.deadCents).toBe(2);                    // the dead small blind: in the pot, in no seat's line
  expect(p.startCents.get(3)).toBe(150);          // 30bb as dealt: the stack after the post + the 7c it put in
  expect(potAgrees(p)).toBe(true);
  expect(p.faults).toEqual([]);
});

test("the poster raises over its own post: the level counts the live blind, not the dead one (hand 4921673957)", () => {
  const p = wsHand(fx["4921673957"]!, 5);
  expect(line("4921673957", "preflop")).toEqual([
    "preflop 2 post-sb 0.4", "preflop 3 post-bb 1", "preflop 5 post 1", "preflop 4 raise 2", "preflop 5 raise 3",
    "preflop 6 fold", "preflop 1 fold", "preflop 2 fold", "preflop 3 fold", "preflop 4 call 1",
  ]);
  expect(p.deadCents).toBe(2);
  expect(potAgrees(p)).toBe(true);
});

test("'folds & shows' is a fold (hand 4921654555)", () => {
  const p = wsHand(fx["4921654555"]!, 5);
  expect(line("4921654555", "river")).toEqual(["river 5 bet 25.4", "river 4 fold"]);
  expect([...p.folded].sort()).toEqual([1, 2, 3, 4, 6]);
  expect(potAgrees(p)).toBe(true);
});
