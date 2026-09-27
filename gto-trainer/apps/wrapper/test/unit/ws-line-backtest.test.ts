/**
 * THE PROTOCOL LINE AGAINST IGNITION'S OWN HAND HISTORY (2026-09-26). The 77 hands of NL5 session_20260926_030543 — the
 * frames the tap recorded for each (debug/ws_dump-<slot>.jsonl) and Ignition's record of it (the handhistory API) —
 * rebuilt by ignition/wsLine.ts and compared action by action, board, hero's cards, every stack as dealt
 * (tools/wsLineBacktest.ts judge). The event-log reader it replaced had 15 of these hands wrong before hero's last
 * action; the reducer has none. The one hand not exact is the session's last: the tap closed with the session after
 * hero's fold, and what it caught is exact.
 *
 * Rebuild the fixture from a session's dumps + cached records: see the header of tools/wsLineBacktest.ts.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { judge, type HandFrames } from "../../src/tools/wsLineBacktest";
import { FRAME_TWIN_S, TwinFilter, potAgrees, wsHand } from "../../src/ignition/wsLine";

type FixtureHand = HandFrames & { ignition: unknown };
const fx: { hands: FixtureHand[] } = JSON.parse(
  new TextDecoder().decode(Bun.gunzipSync(readFileSync(join(import.meta.dir, "../fixtures/ws-line-backtest-20260926.json.gz")))));

test("every hand of session_20260926_030543 rebuilds from its frames exactly as Ignition recorded it", () => {
  const verdicts = fx.hands.map((h) => judge(h, h.ignition));
  const notExact = verdicts.filter((v) => v.verdict !== "exact").map((v) => `${v.id}: ${v.verdict}\n${v.lines.join("\n")}`);
  expect(fx.hands).toHaveLength(77);
  expect(notExact).toEqual([expect.stringMatching(/^4920639103: capture-ended/)]);
});

test("the hands the event-log reader got wrong are exact from the protocol", () => {
  // phantom BB checks (4920637909, 4920638312), phantom hero checks postflop (4920638173), lost first-to-act folds
  // (4920636746, 4920636732, 4920637397), lost start stacks (4920637006, 4920637454, 4920639015)
  for (const id of ["4920637909", "4920638312", "4920638173", "4920636746", "4920636732", "4920637397", "4920637006", "4920637454", "4920639015"]) {
    const h = fx.hands.find((x) => x.id === id)!;
    expect(`${id}: ${judge(h, h.ignition).verdict}`).toBe(`${id}: exact`);
  }
});

test("hand 4920638173: the SB leads every postflop street — no check of hero's before it", () => {
  const h = fx.hands.find((x) => x.id === "4920638173")!;
  const p = wsHand(h.frames, 5);
  const post = p.actions.filter((a) => a.street !== "preflop").map((a) => `${a.street} ${a.seatId} ${a.type}`);
  expect(post).toEqual(["flop 3 bet", "flop 5 call", "turn 3 bet", "turn 5 call", "river 3 bet", "river 5 call"]);
});

test("a post-in is filed as the post, then the poster's own action at its turn (hand 4920636325)", () => {
  const h = fx.hands.find((x) => x.id === "4920636325")!;
  const pre = wsHand(h.frames, 5).actions.filter((a) => a.street === "preflop").map((a) => `${a.seatId} ${a.type}${a.amount !== undefined ? " " + a.amount : ""}`);
  expect(pre.slice(0, 4)).toEqual(["6 post-sb 0.4", "1 post-bb 1", "2 post 1", "2 raise 2"]);
});

test("the protocol's own pot agrees with the line at every hand's last pot frame", () => {
  const off = fx.hands.map((h) => ({ id: h.id, p: wsHand(h.frames, 5) })).filter(({ p }) => potAgrees(p) === false)
    .map(({ id, p }) => `${id}: pot ${p.potCheck!.potCents} line ${p.potCheck!.lineCents}`);
  expect(off).toEqual([]);
});

test("the reducer reads no clock: the same frames give the same hand", () => {
  const h = fx.hands.find((x) => x.id === "4920637334")!;
  expect(JSON.stringify(wsHand(h.frames, 5))).toBe(JSON.stringify(wsHand([...h.frames], 5)));
});

test("a frame delivered twice is one frame; the same check again after a board card is a real one (TwinFilter)", () => {
  const check = { pid: "CO_SELECT_INFO", seat: 4, btn: 64, bet: 0, raise: 0, account: 1128 };
  const flop = { pid: "CO_BCARD3_INFO", bcard: [50, 5, 3] };
  // hand 4920544810: the BB checks preflop, the flop 46 ms later, the BB checks the flop 1 ms after that
  let f = new TwinFilter();
  expect([f.keep(check, 36.06), f.keep(flop, 36.106), f.keep(check, 36.107)]).toEqual([true, true, true]);
  // recording 20260921_143046: the same frame twice within milliseconds, a timer frame between — one frame
  f = new TwinFilter();
  expect([f.keep(check, 10), f.keep({ pid: "PLAY_TIME_INFO", time: 15 }, 10.001), f.keep(check, 10.002)]).toEqual([true, true, false]);
  // and a repeat after FRAME_TWIN_S is not a double
  f = new TwinFilter();
  expect([f.keep(check, 10), f.keep(check, 10 + FRAME_TWIN_S + 0.01)]).toEqual([true, true]);
});
