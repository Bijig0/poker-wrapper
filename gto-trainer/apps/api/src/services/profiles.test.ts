import { describe, expect, test } from "bun:test";
import { reconcile, rakeEstCents, rakeCapCents, toleranceCents, usd, type BalanceSnap, type PricedHand } from "./profiles";

const snap = (ts: number, cashier: number, opts: { inPlay?: number | null; session?: string | null } = {}): BalanceSnap => ({
  id: ts, ts, profile: "X", amountCents: cashier, inPlayCents: opts.inPlay ?? null,
  equityCents: cashier + (opts.inPlay ?? 0), currency: "USD", source: "scraped",
  sessionId: opts.session ?? null, phase: null, how: "hook",
});
const hand = (playedAt: number, netCents: number | null, extra: Partial<PricedHand> = {}): PricedHand =>
  ({ playedAt, netCents, rakeEstCents: 0, bbCents: 25, ...extra });

describe("rake estimate", () => {
  test("only an uncontested win that saw a flop is raked", () => {
    expect(rakeEstCents({ heroWonUncontested: true, sawFlop: true, potCents: 1000, playersDealt: 3 })).toBe(50);
    expect(rakeEstCents({ heroWonUncontested: true, sawFlop: false, potCents: 1000, playersDealt: 3 })).toBe(0); // no flop no drop
    expect(rakeEstCents({ heroWonUncontested: false, sawFlop: true, potCents: 1000, playersDealt: 3 })).toBe(0); // showdown: stack delta is post-rake
  });
  test("the cap follows players dealt", () => {
    expect(rakeCapCents(2)).toBe(100); expect(rakeCapCents(3)).toBe(200); expect(rakeCapCents(5)).toBe(300); expect(rakeCapCents(6)).toBe(400);
    expect(rakeEstCents({ heroWonUncontested: true, sawFlop: true, potCents: 100_000, playersDealt: 3 })).toBe(200);
  });
});

describe("reconcile", () => {
  test("equity moved by exactly what poker did is clean", () => {
    const [i] = reconcile([snap(100, 50_00, { session: "s1" }), snap(200, 47_50, { session: "s1" })],
      [hand(150, -1_50), hand(160, -1_00)]);
    expect(i!.unexplainedCents).toBe(0);
    expect(i!.tier).toBe("clean");
    expect(i!.sessionId).toBe("s1");
  });

  test("EQUITY: a closing snapshot taken from a seat must not report the stack as missing money", () => {
    // opened with $50 in the cashier, bought in for $25, won $2.50, ended still seated
    const [i] = reconcile([snap(100, 50_00), snap(200, 25_00, { inPlay: 27_50 })], [hand(150, 2_50)]);
    expect(i!.movedCents).toBe(2_50);
    expect(i!.tier).toBe("clean");
  });

  test("RAKE: an uncontested post-flop win overstates the net by the rake, which is explained not flagged", () => {
    // the displayed pot said +$10.00 but the site kept $0.50 of it
    const [i] = reconcile([snap(100, 100_00), snap(200, 109_50)], [hand(150, 10_00, { rakeEstCents: 50 })]);
    expect(i!.pokerCents).toBe(10_00);
    expect(i!.rakeEstCents).toBe(50);
    expect(i!.unexplainedCents).toBe(0);
    expect(i!.tier).toBe("clean");
  });

  test("TOLERANCE: cent-level residue is noise, not movement", () => {
    const [i] = reconcile([snap(100, 100_00), snap(200, 99_70)], [hand(150, -33)]);
    expect(i!.unexplainedCents).toBe(3);
    expect(i!.tier).toBe("noise");
  });

  test("a withdrawal is movement, not a loss", () => {
    const [i] = reconcile([snap(100, 150_00), snap(200, 52_50)], [hand(150, 2_50)]);
    expect(i!.unexplainedCents).toBe(-100_00);
    expect(i!.tier).toBe("movement");
  });

  test("a deposit is movement the other way", () => {
    const [i] = reconcile([snap(100, 20_00), snap(200, 120_00)], []);
    expect(i!.unexplainedCents).toBe(100_00);
    expect(i!.tier).toBe("movement");
  });

  test("an unpriced hand makes a large residue unverifiable rather than movement", () => {
    const [i] = reconcile([snap(100, 10_00), snap(200, 3_00)], [hand(150, null), hand(160, -1_00)]);
    expect(i!.unpricedHands).toBe(1);
    expect(i!.unexplainedCents).toBe(-6_00);
    expect(i!.tier).toBe("unverifiable");
  });

  test("hands outside the window are not attributed to it", () => {
    const [i] = reconcile([snap(100, 10_00), snap(200, 10_00)], [hand(50, 5_00), hand(250, -5_00)]);
    expect(i!.hands).toBe(0);
    expect(i!.tier).toBe("clean");
  });

  test("tolerance scales with the stake, never below half a dollar", () => {
    expect(toleranceCents(null, 0)).toBe(50);
    expect(toleranceCents(25, 0)).toBe(50);
    expect(toleranceCents(200, 0)).toBe(200);
    expect(toleranceCents(200, 100)).toBe(220);
  });

  test("a single snapshot cannot be reconciled", () => {
    expect(reconcile([snap(100, 10_00)], [hand(150, 1)])).toEqual([]);
  });

  test("money formats in whole cents", () => {
    expect(usd(-12_345)).toBe("-$123.45");
    expect(usd(null)).toBe("—");
  });
});

import { rakePaidBb } from "./profiles";
describe("rakePaidBb — rake on the pots hero won", () => {
  const base = { heroFolded: false, sawFlop: true, potBb: 20, tableSeats: 3 };
  test("an uncontested post-flop win pays 5%, and the recorded net has not seen it", () => {
    expect(rakePaidBb({ ...base, heroWonUncontested: true }, 0.25, 12)).toEqual({ bb: 1, unseen: true });
  });
  test("a showdown win pays rake too, but the stack delta already had it out", () => {
    expect(rakePaidBb({ ...base, heroWonUncontested: false }, 0.25, 12)).toEqual({ bb: 1, unseen: false });
  });
  test("a lost showdown and a fold pay nothing", () => {
    expect(rakePaidBb({ ...base, heroWonUncontested: false }, 0.25, -8).bb).toBe(0);
    expect(rakePaidBb({ ...base, heroWonUncontested: false, heroFolded: true }, 0.25, -2).bb).toBe(0);
  });
  test("no flop, no drop", () => {
    expect(rakePaidBb({ ...base, sawFlop: false, heroWonUncontested: true }, 0.25, 1.5).bb).toBe(0);
  });
  test("the dollar cap binds at big pots, in the stake's own bb", () => {
    // 3 players -> $2 cap; at $0.25/bb that is 8 bb, so a 400 bb pot pays 8 bb not 20
    expect(rakePaidBb({ ...base, potBb: 400, heroWonUncontested: true }, 0.25, 300).bb).toBe(8);
    // at NL200 ($2/bb) the same $2 cap is 1 bb
    expect(rakePaidBb({ ...base, potBb: 400, heroWonUncontested: true }, 2, 300).bb).toBe(1);
  });
});

describe("rakePaidBb — the archive's own won signal", () => {
  const base = { heroWonUncontested: false, heroFolded: false, sawFlop: false, potBb: 30, tableSeats: 6 };
  test("a July-era showdown win with no board and no priced net still counts as a raked pot", () => {
    // sawFlop=false and netBb=null, but the client said "★ wins main pot … with (Two pair)"
    expect(rakePaidBb({ ...base, wentToShowdown: true, won: true }, 0.05, null)).toEqual({ bb: 1.5, unseen: false });
  });
  test("without either signal it is still unraked, as before", () => {
    expect(rakePaidBb({ ...base }, 0.05, null).bb).toBe(0);
  });
});

describe("reconcile — a reading marked correct", () => {
  test("keeps the residue on record but takes the interval out of the verdict; the next interval is untouched", () => {
    const snaps = [snap(100, 150_00), snap(200, 52_50), snap(300, 52_50)];
    const acked = { "200": { profile: "X", at: 1, note: "stack was not read", unexplainedCents: -100_00, flaggedTier: "movement" } };
    const [a, b] = reconcile(snaps, [hand(150, 2_50)], acked);
    expect(a!.tier).toBe("accepted");
    expect(a!.flaggedTier).toBe("movement");
    expect(a!.unexplainedCents).toBe(-100_00);
    expect(a!.accepted?.note).toBe("stack was not read");
    expect(b!.tier).toBe("clean");
    expect(b!.accepted).toBeNull();
  });
  test("without the acknowledgement the same interval is movement", () => {
    const [a] = reconcile([snap(100, 150_00), snap(200, 52_50)], [hand(150, 2_50)]);
    expect(a!.tier).toBe("movement");
    expect(a!.flaggedTier).toBeNull();
  });
});
