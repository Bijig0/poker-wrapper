/**
 * THE TREE LEDGER AFTER A HUNG-POLL RE-ROUTE (2026-10-14, the answer-path audit's finding 7). A hung poll re-posts the
 * street's tree on another account (GTOW_HUNG_HEDGE=off: the 2026-10-08 re-route; on: the hedge, adopted when it answers
 * first) and records it `reroute` in the hand's tree ledger (handFacts). The NEXT decision finds that tree in the cache and
 * recorded it plain, so check #9 read "the flop's default tree was created 2 times … ranges, pot or stack changed" over
 * byte-identical requests, and #11 "the warm-up solved tree X, the live walk Y — with no size pinned": 54 false #9 and 2
 * false #11 in 14 days (4924409838 solves 9162→9164, 4923395963 7506/7507, 4923405062 7615/7616). handFacts.recordTree now
 * carries the mark onto the same tree, and #11 takes the re-route's tree as the warm-up's.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { gtowApi } from "./gtowApi";
import { forgetChainMemo, forgetCheckpoints, solveAiChain, type AiChainSpec } from "./aiChain";
import { handFacts } from "./handFacts";
import { withRequestScope } from "./requestScope";

const N = 1326;
const even = (n: number) => new Array(N).fill(1 / n);
const flat = (v: number) => new Array(N).fill(v);
type Act = { code: string; name: string; betsize?: number };
const checkOrBet: Act[] = [{ code: "X", name: "Check" }, { code: "R7", name: "Bet", betsize: 7 }];
const node = (toAct: string, acts: Act[]) => ({
  game: { players: [{ position: toAct, is_hero: true }] },
  action_solutions: acts.map((a) => ({ action: { code: a.code, display_name: a.name, betsize: a.betsize ?? "", position: toAct },
    total_frequency: 0.5, total_ev: 0, strategy: even(acts.length), evs: flat(1) })),
});

/** GTO Wizard scripted: one solve per (street, pot) — sol-FLOP on primary first, sol2-FLOP on ultra-2 once re-posted or
 *  hedged, sol3-FLOP for a tree whose pot changed; `hangs` hangs a node read that many times */
function script(hangs: Record<string, number>) {
  const api = gtowApi as any;
  const saved = { ensure: api.ensureCustomSolution, node: api.customNode, peek: api.peekSolution, forget: api.forgetSolution, owner: api.ownerOf,
    hedge: api.hedgeSolution, sibling: api.hedgeSibling, adopt: api.adoptSolution };
  const ids = ["sol-FLOP", "sol2-FLOP", "sol3-FLOP"];
  const made = new Map<string, string>();        // `${street}|${pot}` → the solve the cache holds
  const forgotten = new Set<string>();
  const issued = new Set<string>();              // a solve id is minted once
  const ensures: string[] = [];
  const keyOf = (input: any) => `${input.startingStreet}|${input.pot}`;
  const session = (solId: string) => (solId === "sol2-FLOP" ? "ultra-2" : "primary");
  api.ensureCustomSolution = async (input: any, opts: any = {}) => {
    const key = keyOf(input);
    const cur = made.get(key);
    if (cur && !forgotten.has(cur)) { ensures.push(`cached ${cur}`); return { ok: true, solId: cur, created: false, session: session(cur) }; }
    const next = input.startingStreet === "FLOP" ? ids.find((x) => !issued.has(x))! : `sol-${input.startingStreet}`;
    made.set(key, next); issued.add(next);
    ensures.push(`created ${next}${opts.avoid ? ` avoiding ${opts.avoid.join(",")}` : ""}`);
    return { ok: true, solId: next, created: true, session: session(next) };
  };
  api.peekSolution = (input: any) => { const cur = made.get(keyOf(input)); return cur && !forgotten.has(cur) ? cur : null; };
  api.forgetSolution = (solId: string) => { forgotten.add(solId); };
  api.ownerOf = (solId: string) => session(solId);
  api.hedgeSolution = async (input: any, opts: any) => { ensures.push(`hedge sol2-FLOP avoiding ${(opts?.avoid ?? []).join(",")}`); issued.add("sol2-FLOP"); return { ok: true, solId: "sol2-FLOP", created: true, session: "ultra-2", route: "least-loaded" }; };
  api.hedgeSibling = () => null;
  api.adoptSolution = (input: any, solId: string) => { made.set(keyOf(input), solId); };
  api.customNode = async (solId: string, q: any) => {
    const line = String(q.flopActions ?? q.turnActions ?? q.riverActions ?? "");
    const key = `${solId}|${line}`;
    if ((hangs[key] ?? 0) > 0) { hangs[key]!--; return { ok: false, status: 0, hung: true, error: `GTO Wizard poll hung on ${session(solId)} (no reply in 8.0 s)` }; }
    return { ok: true, data: node(line === "" ? "BB" : "BTN", checkOrBet), solveSecs: 0, cached: false, src: "fetched" };
  };
  return { ensures, restore: () => Object.assign(api, { ensureCustomSolution: saved.ensure, customNode: saved.node, peekSolution: saved.peek, forgetSolution: saved.forget,
    ownerOf: saved.owner, hedgeSolution: saved.hedge, hedgeSibling: saved.sibling, adoptSolution: saved.adopt }) };
}

const HAND = "4920000777";
const spec = (flopPot = 10): AiChainSpec => ({
  oopPos: "BB", ipPos: "BTN", oopRange: flat(1), ipRange: flat(1), flopPot, flopStack: 95, board: "2s3sQd", heroSeat: "ip", heroComboIdx: null,
  streets: [["X"]], handKey: HAND,
});
const check = (r: Awaited<ReturnType<typeof solveAiChain>>, id: number) => {
  if (!r.ok) throw new Error(r.why);
  return (r.trace!.streets[0] as any).checks.find((c: any) => c.id === id) as { status: string; text: string };
};
const decide = (origin: "warm" | "live", flopPot?: number) => withRequestScope({ handKey: HAND, origin, street: "flop" }, () => solveAiChain(spec(flopPot))).then((x) => x.value);

const envBefore = process.env.GTOW_HUNG_HEDGE;
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.(); restore = null;
  forgetCheckpoints(HAND); handFacts.forget(HAND);
  if (envBefore == null) delete process.env.GTOW_HUNG_HEDGE; else process.env.GTOW_HUNG_HEDGE = envBefore;
});

for (const mode of ["off", "on"] as const) {
  describe(`after a hung poll (GTOW_HUNG_HEDGE=${mode}: ${mode === "off" ? "the tree re-posted elsewhere" : "a hedge solve adopted"})`, () => {
    it("the re-created tree, found in the cache by the next decision, passes #9 and #11; a tree whose pot changed still fails #9", async () => {
      process.env.GTOW_HUNG_HEDGE = mode;
      const hangs: Record<string, number> = {};
      const s = script(hangs); restore = s.restore;
      // the warm-up: sol-FLOP, no hang
      const warm = await decide("warm");
      expect(check(warm, 11).status).toBe("na");
      forgetChainMemo(HAND);                                   // the memo only: the tree ledger (a fact) stays
      // the hedge keeps polling the hung solve while the second runs: both reads of the first hang, so the hedge wins
      hangs["sol-FLOP|"] = mode === "off" ? 1 : 2;
      // the live decision: the root read on sol-FLOP hangs → sol2-FLOP on ultra-2 (4924409838's 9164: warm 2a920ee3, live 515950a2)
      const first = await decide("live");
      expect(first.ok && first.trace!.streets[0]!.solId).toBe("sol2-FLOP");
      expect(first.ok && first.trace!.streets[0]!.leak?.code).toBe(mode === "off" ? "tree:hung-reroute" : "tree:hung-hedge");
      expect(check(first, 9).status).toBe("pass");
      expect(check(first, 11)).toMatchObject({ status: "pass" });
      expect(check(first, 11).text).toContain("re-created on another account");
      forgetChainMemo(HAND);                                   // the memo only: the tree ledger (a fact) stays
      // the next decision finds sol2-FLOP in the cache: not a second default tree (#9), the warm-up's tree re-created (#11)
      const next = await decide("live");
      expect(next.ok && next.trace!.streets[0]!.solId).toBe("sol2-FLOP");
      expect(next.ok && next.trace!.streets[0]!.created).toBe(false);
      expect(check(next, 9).status).toBe("pass");
      expect(check(next, 9).text).toContain("1 default tree + 1 re-created on another account after a 429 or a hung poll (allowed)");
      expect(check(next, 11).status).toBe("pass");
      expect(handFacts.trees(HAND).filter((t) => t.solId === "sol2-FLOP").every((t) => t.reroute)).toBe(true);
      forgetChainMemo(HAND);                                   // the memo only: the tree ledger (a fact) stays
      // the pot changed: a real second default tree — #9 fails as before
      const changed = await decide("live", 12);
      expect(changed.ok && changed.trace!.streets[0]!.solId).toBe("sol3-FLOP");
      expect(check(changed, 9).status).toBe("fail");
      expect(check(changed, 9).text).toContain("created 2 times");
    });
  });
}
