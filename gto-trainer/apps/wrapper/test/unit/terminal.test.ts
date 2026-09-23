/**
 * Port of tests/test_terminal.py — the terminal-action family over every plan shape the relay can send, against
 * exported hands; anything unreadable is NOT terminal, except a fold. Plus hero_done (the showdown-pending window).
 */
import { expect, test } from "bun:test";
import { heroDone, isTerminal, seatsToAct, stillToActAfterHero, tableView, TERMINAL_ACTIONS, WRAPPER_TERMINALS } from "../../src/terminal";
import { pickPlan } from "../../src/relay";
import { checker, J } from "./helpers";

type A = [number, string, (number | null)?, string?];

export function hand(o: { street?: string; hero?: number; dealt?: number[]; actions?: A[]; stacks?: Record<string, number> | null;
                          toCall?: number; committed?: Record<string, number> | null } = {}): Record<string, any> {
  const { street = "river", hero = 4, dealt = [1, 3, 4, 5], actions = [], stacks = null, toCall = 0.0, committed = null } = o;
  const acts = actions.map((a) => {
    const rec: any = { seatId: a[0], hero: a[0] === hero, type: a[1], street: a.length > 3 ? a[3] : street };
    if (a.length > 2 && a[2] !== null && a[2] !== undefined) rec.amount = a[2];
    return rec;
  });
  const n = ({ preflop: 0, flop: 3, turn: 4, river: 5 } as Record<string, number>)[street]!;
  return {
    handId: 1, heroSeatId: hero, heroCards: ["A♠", "K♠"], board: ["2♣", "7♦", "9♥", "T♠", "3♣"].slice(0, n),
    street, actions: acts, liveSeats: [...dealt].sort((a, b) => a - b),
    committed: committed || {}, positions: Object.fromEntries(dealt.map((s) => [String(s), "X"])),
    stacks: stacks !== null ? stacks : Object.fromEntries(dealt.map((s) => [String(s), 100.0])),
    currentNode: { street, toActSeatId: hero, toActIsHero: true, pot: 20.0, toCall }, heroFolded: false, ended: false,
  };
}

test("the terminal-action family, over every plan shape the relay can send", () => {
  const { fails, check } = checker();
  const plans: Record<string, any> = {};
  for (const p of ["Fold", "FOLD 100%", "Check", "CHECK", "Call", "Call 2.5", "limp", "All-in", "ALL-IN 98.2 BB", "jam", "shove",
                   "Raise 2.5", "RAISE 12", "Bet 3.35", "Bet 33%", "R2.5", "Raise", "Bet"]) plans[p] = pickPlan(p, 10.0);
  for (const [p, plan] of Object.entries(plans)) check(`plan for '${p}' maps`, plan !== null, J(plan));
  const kinds = new Set(Object.values(plans).filter(Boolean).map((pl: any) => (pl.kind !== "action" ? pl.kind : pl.label)));
  check("every plan kind/label the relay emits is in TERMINAL_ACTIONS", [...kinds].every((k) => k in TERMINAL_ACTIONS), J([...kinds]));
  check("wrapper-initiated terminals never buy first", Object.values(WRAPPER_TERMINALS).every((v) => !v.topUpBefore));

  for (const p of ["Fold", "FOLD 100%"]) {
    const v = isTerminal(plans[p], null);
    check(`${p}: terminal with no hand state`, v.terminal && v.kind === "fold" && v.finalStackKnown, v.why);
  }
  let v = isTerminal(plans.Fold, hand({ street: "preflop", stacks: {} }));
  check("fold: terminal even with unreadable stacks", v.terminal && v.finalStackKnown);
  for (const p of ["All-in", "ALL-IN 98.2 BB", "jam", "shove"]) {
    v = isTerminal(plans[p], hand());
    check(`${p}: shove is terminal`, v.terminal && v.kind === "shove" && !v.finalStackKnown, v.why);
  }
  let h = hand({ street: "flop", stacks: { 1: 50.0, 3: 80.0, 4: 9.5, 5: 100.0 }, committed: { 4: 2.5 } });
  check("raise-to 12 with 9.5 behind + 2.5 committed = shove", isTerminal(plans["RAISE 12"], h).kind === "shove");
  h = hand({ street: "flop", stacks: { 1: 50.0, 3: 80.0, 4: 60.0, 5: 100.0 }, committed: { 4: 2.5 } });
  check("raise-to 12 with 60 behind = not terminal", !isTerminal(plans["RAISE 12"], h).terminal);
  h = hand({ street: "flop", stacks: {} });
  check("raise-to with unknown stack = not terminal (conservative)", !isTerminal(plans["RAISE 12"], h).terminal);
  check("unsized 'Raise' = not terminal", !isTerminal(plans.Raise, hand()).terminal);
  check("unsized 'Bet' = not terminal", !isTerminal(plans.Bet, hand()).terminal);
  check("Bet 33% (priced) = not terminal", !isTerminal(plans["Bet 33%"], hand()).terminal);

  h = hand({ street: "river", dealt: [3, 4], actions: [[3, "bet", 6.0]], toCall: 6.0 });
  v = isTerminal(plans.Call, h);
  check("river call heads-up closes the action", v.terminal && v.kind === "closing-river-call", v.why);
  h = hand({ street: "river", dealt: [1, 4, 5], actions: [[1, "bet", 6.0]], toCall: 6.0 });
  v = isTerminal(plans.Call, h);
  check("river call with a seat still to act is not terminal", !v.terminal && J((v.details as any).pending) === J([5]), v.why);
  h = hand({ street: "river", dealt: [1, 4, 5], actions: [[5, "bet", 6.0], [1, "call", 6.0]], toCall: 6.0 });
  check("river call as the last to act closes", isTerminal(plans.Call, h).kind === "closing-river-call");
  h = hand({ street: "river", dealt: [3, 4], actions: [[4, "check", null], [3, "bet", 6.0]], toCall: 6.0 });
  check("river check-call heads-up closes", isTerminal(plans.Call, h).kind === "closing-river-call");
  h = hand({ street: "river", dealt: [1, 4, 5], actions: [[1, "check", null], [5, "bet", 6.0]], toCall: 6.0 });
  check("river call when an earlier checker still owes is not terminal", !isTerminal(plans.Call, h).terminal);
  h = hand({ street: "flop", dealt: [3, 4], actions: [[3, "bet", 6.0]], toCall: 6.0 });
  check("flop call is not terminal", !isTerminal(plans.Call, h).terminal);
  h = hand({ street: "flop", dealt: [3, 4], actions: [[3, "bet", 60.0]], toCall: 60.0, stacks: { 3: 40.0, 4: 55.0 } });
  v = isTerminal(plans.Call, h);
  check("flop call for hero's whole stack is terminal (all-in call)", v.terminal && v.kind === "all-in-call", v.why);
  h = hand({ street: "turn", dealt: [3, 4], actions: [[3, "all-in", 30.0]], toCall: 30.0, stacks: { 3: 0.0, 4: 90.0 } });
  v = isTerminal(plans.Call, h);
  check("call when the only opponent is all-in = run-out", v.terminal && v.kind === "run-out", v.why);
  h = hand({ street: "turn", dealt: [1, 3, 4], actions: [[3, "all-in", 30.0]], toCall: 30.0, stacks: { 1: 80.0, 3: 0.0, 4: 90.0 } });
  check("call of an all-in with another live seat behind is not terminal", !isTerminal(plans.Call, h).terminal);
  h = hand({ street: "river", dealt: [3, 4], actions: [[3, "all-in", null]], toCall: 6.0, stacks: { 3: 0.0, 4: 90.0 } });
  v = isTerminal(plans.Call, h);
  check("unsized all-in: run-out still recognised (opponent has no chips)", v.terminal && v.kind === "run-out", v.why);
  h = hand({ street: "river", dealt: [1, 3, 4], actions: [[3, "all-in", null]], toCall: 6.0, stacks: { 1: 50.0, 3: 0.0, 4: 90.0 } });
  check("unsized all-in with a live seat behind: not terminal (conservative)", !isTerminal(plans.Call, h).terminal);
  check("'limp' preflop maps to call and is not terminal", !isTerminal(plans.limp, hand({ street: "preflop", dealt: [1, 3, 4, 5], toCall: 1.0 })).terminal);
  check("call with unknown hero stack on the river still closes heads-up",
        isTerminal(plans.Call, hand({ street: "river", dealt: [3, 4], actions: [[3, "bet", 6.0]], toCall: 6.0, stacks: {} })).terminal);

  h = hand({ street: "river", dealt: [3, 4], actions: [[3, "check", null]], toCall: 0.0 });
  v = isTerminal(plans.Check, h);
  check("river check behind a check closes", v.terminal && v.kind === "closing-river-check", v.why);
  check("river check first to act is not terminal", !isTerminal(plans.Check, hand({ street: "river", dealt: [3, 4], toCall: 0.0 })).terminal);
  check("river check with a seat still to act is not terminal",
        !isTerminal(plans.Check, hand({ street: "river", dealt: [1, 4, 5], actions: [[1, "check", null]], toCall: 0.0 })).terminal);
  check("river check as last of three closes",
        isTerminal(plans.Check, hand({ street: "river", dealt: [1, 4, 5], actions: [[1, "check", null], [5, "check", null]], toCall: 0.0 })).kind === "closing-river-check");
  check("turn check is not terminal", !isTerminal(plans.Check, hand({ street: "turn", dealt: [3, 4], actions: [[3, "check", null]], toCall: 0.0 })).terminal);
  check("check when owing chips is not terminal (not on offer)",
        !isTerminal(plans.Check, hand({ street: "river", dealt: [3, 4], actions: [[3, "bet", 5.0]], toCall: 5.0 })).terminal);

  check("no plan -> not terminal", !isTerminal(null, hand()).terminal);
  check("no hand -> call not terminal", !isTerminal(plans.Call, null).terminal);
  check("no opponents in hand -> not terminal", !isTerminal(plans.Call, hand({ dealt: [4] })).terminal);
  check("hero seat unknown -> not terminal", !isTerminal(plans.Check, { ...hand(), heroSeatId: null }).terminal);
  check("unknown plan kind -> not terminal", !isTerminal({ kind: "mystery" }, hand()).terminal);

  const tv = tableView(hand({ street: "flop", dealt: [1, 3, 4, 5], actions: [[1, "fold", null], [5, "all-in", 30.0]], stacks: { 1: 50, 3: 80, 4: 90, 5: 0 } }));
  check("table_view: folded/all-in/with-chips", J([...tv.folded]) === J([1]) && J([...tv.allin]) === J([5]) && J([...tv.withChips]) === J([3]));
  const hh = hand({ street: "river", dealt: [1, 3, 4, 5], actions: [[1, "check", null], [3, "bet", 4.0], [5, "fold", null]], toCall: 4.0 });
  const pending = stillToActAfterHero(hh, tableView(hh));
  check("still_to_act: the earlier checker owes, the folder and the bettor do not", J(pending && [...pending]) === J([1]), J(pending && [...pending]));

  h = hand({ street: "river", dealt: [3, 4], actions: [[4, "bet", 6.0], [3, "call", 6.0]], toCall: 0.0 });
  v = heroDone(h);
  check("river bet called: hero is done (showdown pending)", v.terminal && v.kind === "showdown-pending" && !v.finalStackKnown, v.why);
  check("river bet not yet answered: not done", !heroDone(hand({ street: "river", dealt: [3, 4], actions: [[4, "bet", 6.0]], toCall: 0.0 })).terminal);
  check("river checked through: done",
        heroDone(hand({ street: "river", dealt: [3, 4], actions: [[3, "check", null], [4, "check", null]], toCall: 0.0 })).kind === "showdown-pending");
  h = hand({ street: "river", dealt: [1, 3, 4], actions: [[1, "check", null], [3, "bet", 5.0], [4, "call", 5.0]], toCall: 0.0 });
  check("river 3-way, one seat still to answer the bet: not done", !heroDone(h).terminal && J((heroDone(h).details as any).pending) === J([1]));
  check("turn call: not done (river to come)", !heroDone(hand({ street: "turn", dealt: [3, 4], actions: [[3, "bet", 6.0], [4, "call", 6.0]], toCall: 0.0 })).terminal);
  check("opponent all-in and called: run-out, done",
        heroDone(hand({ street: "turn", dealt: [3, 4], actions: [[3, "all-in", 30.0], [4, "call", 30.0]], toCall: 0.0, stacks: { 3: 0.0, 4: 90.0 } })).kind === "run-out");
  check("hero all-in: done", heroDone(hand({ street: "flop", dealt: [3, 4], actions: [[4, "all-in", 50.0]], toCall: 0.0, stacks: { 3: 90.0, 4: 0.0 } })).kind === "hero-all-in");
  check("hero folded: not this window's business", !heroDone(hand({ street: "river", dealt: [3, 4], actions: [[4, "fold", null]], toCall: 0.0 })).terminal);
  check("no hand: not done", !heroDone(null).terminal);
  const s1 = seatsToAct(hand({ street: "river", dealt: [3, 4], actions: [[4, "bet", 6.0], [3, "call", 6.0]] }));
  check("seats_to_act after a bet answered by everyone is empty", s1 !== null && s1.size === 0);
  check("seats_to_act with an unsized all-in is None", seatsToAct(hand({ street: "river", dealt: [3, 4], actions: [[3, "all-in", null]] })) === null);
  expect(fails).toEqual([]);
});
