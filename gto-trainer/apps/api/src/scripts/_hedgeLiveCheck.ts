/**
 * LIVE CHECK OF THE HEDGE (2026-10-14, hand 4924409679 — gtowApi header "WHAT A HUNG POLL IS"): a heads-up flop tree is
 * solved through the real chain against GTO Wizard with the hang cap set so low (GTOW_POLL_HANG_MS, default here 1500 ms)
 * that a cold solve's first read "hangs", so the walk hedges: the hung solve keeps being polled while the same tree is
 * posted on another account, and the first node to answer wins. Prints each street's account, route, treeWhy and leak,
 * and the trace's GTO Wizard requests. One fresh board per run (a board already in the solve cache would not solve).
 *
 *   . config/env.ps1; $env:GTOW_POLL_HANG_MS='1500'; & $env:BUN run src/scripts/_hedgeLiveCheck.ts [boards=2]
 *   (GTOW_POLL_HANG_MS unset = the live 8 s cap: a control run — no hedge expected on a quiet account)
 *
 * NOT while a session is live. ~8-16 requests per board across two accounts; stops on any 429.
 *
 * RESULTS (2026-10-14 03:40 +07 = 2026-10-13 20:40 UTC, cap 1500 ms, origin hedgeLiveCheck, no 429):
 *   7dJhAs  primary solve e2c5d4ee not served after 1.5 s → hedged on ultra-2 (48ffa70d); the hedge answered first and was
 *           adopted (tree:hung-hedge); 19.4 s in all (ultra-2 was carrying 367 requests/h from elsewhere at the time).
 *   9d4c8c  primary solve ece0b9b7 not served after 1.5 s → hedge routed "least-loaded (no solve of ours running on it);
 *           solves in flight: primary 1" to ultra-2; the FIRST solve answered first (4.7 s), kept, the hedge recorded as
 *           extra requests; the losing read ended on its own clock (ultra-2 in flight 1 at the end, as designed).
 *   First run (before the trigger keyed on the solve's age): the hang landed on the prefetch's readiness probe, the walk
 *   only joined it, and no hedge fired — the reason fetchOnSolve now triggers on the solve's age.
 */
import { solveAiChain, type AiChainSpec } from "../services/aiChain";
import { withRequestScope } from "../services/requestScope";
import { gtowSessions } from "../services/gtowSessions";

const N = 1326;
const boards = Number(process.argv[2] ?? 2);
const ranks = "23456789TJQKA", suits = "cdhs";
const rnd = <T,>(a: string): string => a[Math.floor(Math.random() * a.length)]!;
function freshBoard(): string {
  const seen = new Set<string>(); const out: string[] = [];
  while (out.length < 3) { const c = rnd(ranks) + rnd(suits); if (!seen.has(c)) { seen.add(c); out.push(c); } }
  return out.join("");
}
const flat = (v: number) => new Array(N).fill(v);

async function one(i: number): Promise<void> {
  const board = freshBoard();
  // BB (villain, OOP) vs BTN (hero): a single-raised pot, villain checks, hero to act
  const spec: AiChainSpec = {
    oopPos: "BB", ipPos: "BTN", oopRange: flat(1), ipRange: flat(1),
    flopPot: 6.5, flopStack: 97, board, heroSeat: "ip", heroComboIdx: null,
    streets: [["X"]],
  };
  const t0 = Date.now();
  const { value: r } = await withRequestScope({ origin: "hedgeLiveCheck", handKey: `hedge-check-${i}`, street: "flop" }, () => solveAiChain(spec));
  const ms = Date.now() - t0;
  console.log(`\n=== board ${board}: ${r.ok ? "answered" : `NO ANSWER (${r.why})`} in ${ms} ms`);
  for (const s of r.trace?.streets ?? []) {
    console.log(`  ${s.street}: solve ${String(s.solId).slice(0, 8)} on ${s.account ?? "?"} · route: ${s.route ?? "-"}`);
    console.log(`    treeWhy: ${s.treeWhy ?? "-"}`);
    console.log(`    leak: ${s.leak ? `${s.leak.code} — ${s.leak.why}` : "-"}`);
  }
  for (const id of ["primary", "ultra-2", "secondary"]) console.log(`  in flight now: ${id} ${gtowSessions.inFlight(id)}`);
}

console.log(`hang cap GTOW_POLL_HANG_MS=${process.env.GTOW_POLL_HANG_MS ?? "(unset: 8000)"} · GTOW_HUNG_HEDGE=${process.env.GTOW_HUNG_HEDGE ?? "(unset: on)"}`);
for (let i = 0; i < boards; i++) await one(i);
process.exit(0);
