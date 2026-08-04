/**
 * Critical-path benchmark for the custom-solve line walk.
 *
 * Runs the REAL code — services/gtowApi's polling loop and caches, and
 * services/exploitLine's street walk — against a stubbed `fetch` that imitates
 * GTO Wizard's cloud: each POST costs a round trip, and `spot-solution` answers
 * 204 until that solution's simulated solve time has elapsed. So the numbers
 * below measure our own scheduling (poll quantization, how many solves sit on
 * hero's clock), not GTOW's solver, which is what we can actually change.
 *
 * Two knobs are ASSUMPTIONS, not measurements — both are swept so you can see
 * the sensitivity rather than trust a single figure:
 *   --solve  simulated cloud solve time per fresh tree (default 2000ms, the
 *            "~2s" the code comments and GTOW's own docs quote)
 *   --rtt    per-request network round trip (default 120ms)
 *
 *   bun run src/scripts/benchAiSolve.ts
 *   bun run src/scripts/benchAiSolve.ts --solve 4000 --rtt 200
 */

import { gtowApi } from "../services/gtowApi";
import { solveExploitLine, warmExploitLine, type ExploitLineInput } from "../services/exploitLine";

const arg = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const SOLVE_MS = arg("solve", 2000);
const RTT_MS = arg("rtt", 120);

const N = 1326;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── the fake cloud ─────────────────────────────────────────────────────────
/** Simulated solve start time per solution id — 204 until SOLVE_MS has passed. */
const solveStartedAt = new Map<string, number>();
let treeSeq = 0;
let requests = 0;
let treePosts = 0;
let polls = 0;

/** A node payload shaped like GTOW's: both seats' ranges + a Call strategy. */
const nodeJson = () => {
  const w = new Array(N).fill(0.5);
  return {
    action_solutions: [
      { action: { display_name: "FOLD", code: "F" }, strategy: new Array(N).fill(0.2) },
      { action: { display_name: "CALL", code: "C" }, strategy: new Array(N).fill(0.6) },
      { action: { display_name: "RAISE", code: "R" }, strategy: new Array(N).fill(0.2) },
    ],
    players_info: [
      { player: { relative_postflop_position: "OOP" }, range: w },
      { player: { relative_postflop_position: "IP" }, range: w },
    ],
  };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function installFakeCloud(): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    requests++;
    await sleep(RTT_MS);

    if (url.includes("/custom-trees/")) {
      treePosts++;
      return json({ id: `tree-${++treeSeq}` });
    }
    if (url.includes("/v4/custom-solutions/")) {
      const solId = `sol-${treeSeq}`;
      // the cloud starts solving the moment the solution is created
      if (!solveStartedAt.has(solId)) solveStartedAt.set(solId, Date.now());
      return json({ id: solId });
    }
    if (url.includes("/spot-solution/")) {
      polls++;
      const solId = new URL(url).searchParams.get("custom_solution_id") ?? "";
      const started = solveStartedAt.get(solId) ?? Date.now();
      if (Date.now() - started < SOLVE_MS) return new Response(null, { status: 204 });
      return json(nodeJson());
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

/** Skip the CDP token sniff — it's not what this benchmark measures. */
function stubToken(): void {
  const g = gtowApi as unknown as { token: string; tokenExpMs: number };
  g.token = "bench-token";
  g.tokenExpMs = Date.now() + 3_600_000;
}

/** Drop every cache so each scenario starts genuinely cold. */
function resetCaches(): void {
  const g = gtowApi as unknown as { treeSolCache: Map<string, string>; nodeCache: Map<string, unknown> };
  g.treeSolCache.clear();
  g.nodeCache.clear();
  solveStartedAt.clear();
  requests = 0; treePosts = 0; polls = 0;
}

// ── the spot: hero faces a river bet after flop bet-call and turn bet-call ──
const range = () => {
  const a = new Array(N).fill(0);
  for (let i = 0; i < N; i += 3) a[i] = 1;
  return a;
};

const deepRiver: ExploitLineInput = {
  boardFull: "Ts7h2dKc4s",
  streets: { flop: ["X", "R3", "C"], turn: ["X", "R8", "C"], river: ["R20"] },
  current: "river",
  oopRange: range(), ipRange: range(), oopPos: "BB", ipPos: "SB",
  flopPot: 5, effStack: 97.5,
};

const flopOnly: ExploitLineInput = { ...deepRiver, current: "flop", streets: { flop: ["X", "R3"], turn: [], river: [] } };

interface Row { label: string; ms: number; solves: number; treePosts: number; polls: number }
const rows: Row[] = [];

async function timed(label: string, fn: () => Promise<number>): Promise<void> {
  const t0 = Date.now();
  const solves = await fn();
  rows.push({ label, ms: Date.now() - t0, solves, treePosts, polls });
}

async function main(): Promise<void> {
  installFakeCloud();
  stubToken();

  // baseline: a single-street spot, nothing to walk
  resetCaches();
  await timed("flop decision (1 solve, floor)", async () => {
    const r = await solveExploitLine(flopOnly);
    if (!r.ok) throw new Error(r.error);
    return r.solves;
  });

  // the case that hurts: cold deep river, whole chain on hero's clock
  resetCaches();
  await timed("river, COLD (walk on hero's clock)", async () => {
    const r = await solveExploitLine(deepRiver);
    if (!r.ok) throw new Error(r.error);
    return r.solves;
  });

  // same spot, prior streets already warmed during dead time
  resetCaches();
  const w = await warmExploitLine(deepRiver);
  if (!w.ok) throw new Error(w.error);
  const warmReqs = requests;
  requests = 0; treePosts = 0; polls = 0;
  await timed("river, WARMED (hero's node only)", async () => {
    const r = await solveExploitLine(deepRiver);
    if (!r.ok) throw new Error(r.error);
    return r.solves;
  });

  const pad = (s: string, n: number) => s.padEnd(n);
  const num = (n: number, u = "") => String(n) + u;
  console.log(`\nassumptions: cloud solve ${SOLVE_MS}ms/tree, network ${RTT_MS}ms/request, poll ${process.env.GTOW_POLL_MS ?? 400}ms\n`);
  // "streets" is how many the walk traversed; "fresh trees" is what actually
  // cost a cloud solve — a warmed run still walks 3 streets but pays for 1.
  console.log(`${pad("scenario", 38)} ${pad("hero waits", 12)} ${pad("streets", 9)} ${pad("fresh trees", 13)} polls`);
  console.log("-".repeat(86));
  for (const r of rows) {
    console.log(`${pad(r.label, 38)} ${pad(num(r.ms, "ms"), 12)} ${pad(num(r.solves), 9)} ${pad(num(r.treePosts), 13)} ${r.polls}`);
  }
  const cold = rows.find((r) => r.label.includes("COLD"))!;
  const warm = rows.find((r) => r.label.includes("WARMED"))!;
  console.log(`\nwarm moved ${warmReqs} requests off hero's clock: ${cold.ms}ms → ${warm.ms}ms (${Math.round((1 - warm.ms / cold.ms) * 100)}% faster)\n`);
}

await main();
