/**
 * LIVE VERIFICATION OF HARNESS CASES (2026-09-25, round 2, part B). A harness case (seed + operators) is dealt exactly
 * as the offline sweep deals it, its preflop decisions are asked in order (offline by default — the pins are the
 * sweep's; --live-preflop lets the AI preflop piece call GTO Wizard), and at its FIRST postflop hero decision the
 * solver input is built twice: once as a dry run, once for real against GTO Wizard. Checked:
 *   - an answer arrives, and hero's mix is not all-zero (notInRange false, frequencies sum > 0);
 *   - what GTO Wizard was sent (the stored trace's spec in this worktree's data/solves.sqlite: every seat's 1326-combo
 *     range, pot, stack, street tokens) equals the dry-run input for the same decision. A mismatch is a finding.
 *
 * BUDGET (Brady's rules): GTO Wizard's per-account cap is counted in the main checkout's ledger, which this script
 * only READS; before every live decision it counts the Ultra account's solutions since 00:00 UTC there plus this
 * process's own, and stops once fewer than --reserve (default 450) would be left of the 1,275 cap. Run with
 * GTOW_SECONDARY=0 (never the Elite account), GTOW_RESERVE=450 and GTOW_REQUEST_ORIGIN=harness; paced (--pace-ms,
 * default 3000 between live decisions); a 429 stops the run (never retried).
 *
 *   GTOW_SECONDARY=0 GTOW_RESERVE=450 GTOW_REQUEST_ORIGIN=harness HRC6MAX_DB=… ANSWERS_DB_PATH=:memory: \
 *     bun src/scripts/mutation/liveVerify.ts --cases=2:late-fold,111:limps [--live-preflop] [--max-solutions=60]
 */
import { readFileSync, existsSync } from "node:fs";
process.env.ANSWERS_DB_PATH ??= ":memory:";
import { harnessEnv, runCase, exportAt, mutateExport, liveHand, Rng, type Op } from "../mutationHarness";
import { fastSolve, forgetPreflopPin, forgetPostflopPin } from "../../services/fastSolve";
import { forgetCheckpoints } from "../../services/aiChain";
import { solveStore } from "../../services/solveStore";
import { gtowRequests } from "../../services/gtowRequestLog";

const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const cases = arg("cases", "").split(",").filter(Boolean).map((c) => { const [s, o] = c.split(":"); return { seed: Number(s), ops: (o && o !== "-" ? o.split("+") : []) as Op[] }; });
const livePreflop = process.argv.includes("--live-preflop");
const reserve = Number(arg("reserve", "450"));
const paceMs = Number(arg("pace-ms", "3000"));
const maxOwn = Number(arg("max-solutions", "60"));
const CAP = 1275;
const MAIN_LEDGER = "C:/Users/Brady/poker/gto-trainer/apps/api/data/gtow_requests.jsonl";
const STRATEGY = "ign200-ring-6max-equilibrium";

if (process.env.GTOW_SECONDARY !== "0") { console.error("refusing to run: set GTOW_SECONDARY=0 (the Elite account is never used)"); process.exit(2); }
if (!cases.length) { console.error("usage: liveVerify.ts --cases=<seed:op+op,...>"); process.exit(2); }

/** Ultra solutions since 00:00 UTC: the main ledger (the live API and every script) + this process's own ledger. */
function solutionsToday(): { main: number; own: number } {
  const mid = new Date(); mid.setUTCHours(0, 0, 0, 0);
  const count = (file: string) => {
    if (!existsSync(file)) return 0;
    let n = 0;
    for (const l of readFileSync(file, "utf8").split("\n")) {
      if (!l) continue;
      try { const r = JSON.parse(l); if (r.ts >= mid.getTime() && r.s === "primary" && r.k === "solution") n++; } catch { /* torn line */ }
    }
    return n;
  };
  return { main: count(MAIN_LEDGER), own: gtowRequests.path.replace(/\\/g, "/") === MAIN_LEDGER ? 0 : count(gtowRequests.path) };
}
const t0Run = Date.now();
/** 429s THIS run received (an earlier run's stay in the ledger) */
const own429 = () => gtowRequests.rows().filter((r) => r.st === 429 && r.ts >= t0Run).length;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const maxDiff = (a: number[], b: number[]) => { let m = 0; for (let i = 0; i < 1326; i++) m = Math.max(m, Math.abs((a[i] ?? 0) - (b[i] ?? 0))); return m; };

const results: string[] = [];
const start = solutionsToday();
console.log(`budget: Ultra solutions since 00:00 UTC — main ledger ${start.main}, this worktree ${start.own}; cap ${CAP}, reserve ${reserve}; own max ${maxOwn}`);

for (const c of cases) {
  const label = `seed ${c.seed} [${c.ops.join("+") || "baseline"}]`;
  // 1. the case as the offline sweep deals it (its hand and its verdicts)
  const restore = harnessEnv();
  const offline = await runCase(c.seed, c.ops);
  restore();
  const hand = offline.hand!;
  const key = `mh-${c.seed}-${c.ops.join("+") || "base"}`;
  const drift = c.ops.includes("stack-drift") ? 0.3 : 0;
  const heroIdx = hand.actions.map((a, i) => [a, i] as const).filter(([a]) => a.seat === hand.hero && !/^post/.test(a.type)).map(([, i]) => i);
  forgetPreflopPin(key); forgetPostflopPin(key); forgetCheckpoints(key);
  let line = `${label}: `;
  let done = false;
  for (const k of heroIdx) {
    const raw = mutateExport(exportAt(hand, k, key, drift), c.ops, new Rng(1));
    const h = liveHand(raw);
    const pos = h.positions[h.heroSeatId] ?? null;
    if (raw.street === "preflop") {
      // preflop: offline unless --live-preflop (then the AI preflop piece may call GTO Wizard)
      process.env.POSTFLOP_DRY_RUN = "0";
      if (livePreflop) {
        const b = solutionsToday();
        if (CAP - (b.main + b.own) < reserve || b.own - start.own >= maxOwn) { line += "STOPPED (budget) before a live preflop decision"; done = true; break; }
        delete process.env.GTOW_BLOCK;
      } else process.env.GTOW_BLOCK = "1";
      const r: any = await fastSolve(h, pos, { strategyId: STRATEGY, origin: "harness" });
      line += `pre k=${k} ${r.ok ? `${r.source}${r.decision ? ` ${r.decision.action}` : ""}` : `refused (${String(r.reason).slice(0, 90)})`} · `;
      if (livePreflop) await sleep(paceMs);
      continue;
    }
    // 2. the first postflop decision: the dry-run input, then the live solve
    // the dry run may read the AI preflop tree (a hand whose preflop the AI piece answered takes its flop ranges from
    // it): GTO Wizard is allowed, and the dry run stops before any postflop solve
    const b = solutionsToday();
    if (CAP - (b.main + b.own) < reserve || b.own - start.own >= maxOwn) { line += "STOPPED (budget) before the postflop decision"; done = true; break; }
    delete process.env.GTOW_BLOCK; process.env.POSTFLOP_DRY_RUN = "1";
    const dry: any = await fastSolve(h, pos, { strategyId: STRATEGY, origin: "harness" });
    process.env.POSTFLOP_DRY_RUN = "0";
    if (!dry.ok || !dry.dryRun) { line += `${raw.street}: dry run refused (${String(dry.reason ?? "").slice(0, 160)}) — nothing to verify live`; done = true; break; }
    const t0 = Date.now();
    const live: any = await fastSolve(h, pos, { strategyId: STRATEGY, origin: "harness" });
    const ms = Date.now() - t0;
    process.env.GTOW_BLOCK = "1";
    if (!live.ok) { line += `${raw.street}: LIVE REFUSED in ${ms} ms — ${String(live.reason).slice(0, 200)}`; done = true; break; }
    const mix = (live.actions ?? []) as { action: string; frequency: number }[];
    const total = mix.reduce((s, a) => s + (a.frequency || 0), 0);
    const degenerate = live.notInRange || !(total > 0);
    const stored = live.solveId != null ? solveStore.get(live.solveId) : null;
    const spec = stored?.trace?.spec;
    const diffs: string[] = [];
    let note2 = "";
    if (!spec) diffs.push("no stored trace");
    else {
      const tree = dry.dryRun.trees?.[0];
      const sent: Record<string, number[]> = { [String(spec.oopPos).toUpperCase()]: spec.oopRange, [String(spec.ipPos).toUpperCase()]: spec.ipRange, ...(spec.midPos ? { [String(spec.midPos).toUpperCase()]: spec.midRange } : {}) };
      for (const s of tree?.seats ?? []) {
        const got = sent[String(s.pos).toUpperCase()];
        if (!got) { diffs.push(`${s.pos} not sent`); continue; }
        const d = maxDiff(s.range, got);
        if (d > 1e-9) diffs.push(`${s.pos} range differs by ${r4(d)}`);
      }
      const potDry = dry.dryRun.flopPot, potLive = spec.firstStreet ? null : spec.flopPot;
      if (potLive != null && Math.abs(potDry - potLive) > 1e-6) diffs.push(`pot dry ${potDry} live ${potLive}`);
      if (!spec.firstStreet && Math.abs(dry.dryRun.flopStack - spec.flopStack) > 1e-6) diffs.push(`stack dry ${dry.dryRun.flopStack} live ${spec.flopStack}`);
      if (JSON.stringify(tree?.streets) !== JSON.stringify(spec.streets)) diffs.push(`streets dry ${JSON.stringify(tree?.streets)} live ${JSON.stringify(spec.streets)}`);
      if (diffs.length) diffs.push(`range source dry ${dry.rangeSource} live ${spec.rangeSource}`);
      // a collapsed 4+ way spot: the stored trace is the first plan's; only that one is compared (said, not a mismatch)
      if ((dry.dryRun.trees?.length ?? 0) !== 1) note2 = ` (${dry.dryRun.trees.length} collapse plans; the first compared)`;
    }
    const top = mix.slice().sort((x, y) => y.frequency - x.frequency).slice(0, 3).map((x) => `${x.action} ${x.frequency.toFixed(1)}%`).join(", ");
    line += `${raw.street} k=${k}: answered in ${ms} ms (${live.tier}, solve #${live.solveId}) · mix ${top}${degenerate ? " · DEGENERATE (all-zero / not in range)" : ""} · ` +
      (diffs.length ? `INPUT MISMATCH: ${diffs.join("; ")}` : `sent == dry run (ranges, pot, stack, tokens)${note2}`) + ` · ${String(live.warning ?? "").slice(0, 160)}`;
    done = true;
    await sleep(paceMs);
    break;
  }
  if (!done) line += "no postflop decision";
  if (own429()) { line += " · 429 SEEN — stopping"; results.push(line); console.log(line); break; }
  results.push(line);
  console.log(line);
}
const end = solutionsToday();
console.log(`\nspent: ${end.own - start.own} Ultra solution(s) in this run (own ledger ${gtowRequests.path}: ${gtowRequests.stats().last24h.total} request(s) in 24 h, ${own429()} x 429); main ledger now ${end.main}`);
process.exit(0);
