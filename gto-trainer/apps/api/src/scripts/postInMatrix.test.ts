/**
 * THE POST-IN GATE (2026-09-25, Brady: "create hands that have someone posting a big blind … check, as hero, if given
 * all the possibilities preflop … we have a fallback option set in already"). The matrix of scripts/postInMatrix.ts,
 * trimmed for the regression run: every poster seat (UTG/HJ/CO/BTN), the preflop tree walked from the charts up to the
 * 3-bet, every seat's decision on it — the post-in table must answer as the ordinary table does (the poster's check a
 * limp, his call a call, his raise a raise, his unacted post ignored), say it is an approximation, and every pick the
 * poller can roll must be a press Ignition's strip offers. Hero's own free option is swept over all 169 classes.
 * Offline, charts only; its own process in setup/regress.ts (MUTATION_GATE=1). The full tree is the script itself.
 */
import { expect, test } from "bun:test";
import { harnessEnv } from "./mutationHarness";
import { walk, summarize, renderHand, autoPresses, pressProblem, type Row, type Step } from "./postInMatrix";
import { exportAt, liveHand } from "./mutationHarness";
import { fastSolve, forgetPreflopPin } from "../services/fastSolve";

const GATE = process.env.MUTATION_GATE !== "1";

test.skipIf(GATE)("post-ins: every poster seat × every hero seat, the tree to the 3-bet — answered as the ordinary table, pressable", async () => {
  const restore = harnessEnv();
  const rows: Row[] = [];
  try {
    for (const p of ["UTG", "HJ", "CO", "BTN"] as const) await walk({ posters: [p], postBb: 1, bbCents: 200 }, { max: 100_000, maxRaises: 2, onRow: (r) => rows.push(r) });
  } finally { restore(); }
  const bad = rows.filter((r) => r.verdict === "finding");
  if (bad.length) console.log(summarize(rows));
  // every poster state is exercised
  const states = new Set(rows.map((r) => r.posterState.split(":")[1]));
  for (const s of ["to-act-after", "hero-posted", "checked(limp)", "called", "raised", "folded"]) expect(states.has(s)).toBe(true);
  expect(rows.filter((r) => r.verdict === "ok").length).toBeGreaterThan(1000);
  expect(bad.map((r) => `hero ${r.hero} · ${r.posters.join("+")} posted · ${r.line} · ${r.kind}: ${String(r.detail).slice(0, 200)}`)).toEqual([]);
}, 900_000);

// Brady's own examples, spelled out
const BTN_POSTS: Step[] = [{ pos: "UTG", kind: "F" }, { pos: "HJ", kind: "C" }, { pos: "CO", kind: "F" }];
async function answer(line: Step[], hero: "UTG" | "HJ" | "CO" | "BTN" | "SB" | "BB", posters: ("UTG" | "HJ" | "CO" | "BTN")[], cards: [string, string]) {
  const h = renderHand(line, hero, { posters, postBb: 1, bbCents: 200 });
  h.heroCards = cards;
  const key = `postin-gate-${hero}-${posters.join("")}-${cards.join("")}-${line.length}`;
  forgetPreflopPin(key);
  const raw = exportAt(h, h.actions.length, key, 0, 0);
  const hand = liveHand(raw);
  return { res: await fastSolve(hand, hero, { strategyId: "ign200-ring-6max-equilibrium", origin: "harness" }) as any, toCall: Number(raw.currentNode.toCall) };
}

test.skipIf(GATE)("hero posted in on the BTN over an HJ limp: no roll presses FOLD or CALL — the chart's Fold and Limp are a free CHECK", async () => {
  const restore = harnessEnv();
  try {
    for (const cards of [["9s", "8s"], ["Ah", "Kd"], ["7c", "2d"], ["Qs", "Js"]] as [string, string][]) {
      const { res, toCall } = await answer(BTN_POSTS, "BTN", ["BTN"], cards);
      expect(res.ok).toBe(true);
      expect(toCall).toBe(0);
      expect(res.actions.some((a: any) => /^(fold|limp|call)\b/i.test(a.action))).toBe(false);
      for (const p of autoPresses(res)) expect(pressProblem(p.plan, toCall)).toBeNull();
      expect(String(res.warning)).toContain("you posted 1bb and are yet to act");
    }
  } finally { restore(); }
}, 120_000);

test.skipIf(GATE)("the HJ poster: yet to act when hero opens UTG (ignored), a limp when he checks to the BTN, a raiser when he raises", async () => {
  const restore = harnessEnv();
  try {
    const utg = await answer([], "UTG", ["HJ"], ["Ah", "Kh"]);
    expect(utg.res.line).toMatch(/root/);
    const limp = await answer(BTN_POSTS, "BTN", ["HJ"], ["Ah", "Kh"]);
    expect(limp.res.gametype).toMatch(/olimp/);
    expect(limp.res.line).toBe("F-C-F");
    expect(String(limp.res.warning)).toContain("HJ posted 1bb and checked his option — read as a LIMP");
    const raise = await answer([{ pos: "UTG", kind: "F" }, { pos: "HJ", kind: "R", to: 2.5 }, { pos: "CO", kind: "F" }], "BTN", ["HJ"], ["Ah", "Kh"]);
    expect(raise.res.line).toBe("F-R2.5-F");
    expect(String(raise.res.warning)).toContain("HJ posted 1bb and raises (post included)");
  } finally { restore(); }
}, 120_000);
