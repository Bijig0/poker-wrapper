/**
 * Replay ONE input-mutation case verbosely (2026-09-25): the dealt hand, every verdict, and — with --ask — the full
 * answer at chosen decisions. Cases replay exactly (runCase seeds the pick rolls), so a finding's seed and ops from
 * findings.jsonl reproduce it. Offline like the sweep (GTOW_BLOCK, POSTFLOP_DRY_RUN, the baked charts).
 *
 *   HRC6MAX_DB=<main checkout>/gto-trainer/apps/api/data/hrc6max-preflop.sqlite ANSWERS_DB_PATH=:memory: \
 *     bun src/scripts/mutationRepro.ts <seed> <op,op|-> [--ask] [--quiet]
 *
 * --ask re-asks every hero decision in order after the case (pins rebuilt as the hand goes) and prints the answer:
 * the decision, the chart and line it was read at, the notes, and a postflop dry run's solver-input numbers. The
 * re-ask rolls with Math.random, so a mixed pick may differ from the one the case played.
 */
import { harnessEnv, runCase, exportAt, mutateExport, liveHand, Rng, type Op } from "./mutationHarness";
import { fastSolve, forgetPreflopPin, forgetPostflopPin } from "../services/fastSolve";

const seed = Number(process.argv[2]);
const ops = (process.argv[3] && process.argv[3] !== "-" ? process.argv[3].split(",").filter(Boolean) : []) as Op[];
const quiet = process.argv.includes("--quiet");
const ask = process.argv.includes("--ask");
if (!Number.isFinite(seed)) { console.error("usage: mutationRepro.ts <seed> <op,op|-> [--ask] [--quiet]"); process.exit(2); }

const restore = harnessEnv();
const saved = { log: console.log, error: console.error, warn: console.warn };
const mute = () => { if (quiet) { console.log = () => {}; console.error = () => {}; console.warn = () => {}; } };
const unmute = () => Object.assign(console, saved);

mute();
const r = await runCase(seed, ops);
unmute();
const h = r.hand!;
const P = Object.fromEntries(h.seats.map((s) => [s.id, s.pos]));
console.log(`seats: ${h.seats.map((s) => `${s.id}:${s.pos}:${s.stack}`).join(" ")}  hero=${h.hero}(${P[h.hero]}) cards=${h.heroCards.join("")} board=${h.board.join("")} bb=${h.bbCents}c`);
for (const [i, a] of h.actions.entries()) console.log(`  ${i} st${a.street} ${P[a.seat]}${a.seat === h.hero ? "*" : ""} ${a.type} ${a.amount ?? ""}`);
for (const v of r.verdicts) console.log(`k=${v.k} ${v.street} ${v.verdict} ${v.kind ?? ""} ${v.reason ?? ""}${v.note ? `\n     note: ${v.note}` : ""}`);

if (ask) {
  const key = `mh-${seed}-${ops.join("+") || "base"}`;
  forgetPreflopPin(key); forgetPostflopPin(key);
  const drift = ops.includes("stack-drift") ? 0.3 : 0;
  for (const v of r.verdicts) {
    const raw = mutateExport(exportAt(h, v.k, key, drift), ops, new Rng(1));
    const hand = liveHand(raw);
    mute();
    const res: any = await fastSolve(hand, hand.positions[hand.heroSeatId] ?? null, { strategyId: "ign200-ring-6max-equilibrium", origin: "harness" });
    unmute();
    console.log(`\n=== k=${v.k} ${raw.street}: ${res.ok
      ? `decision=${JSON.stringify(res.decision)} gametype=${res.gametype} line=${res.line} pos=${res.pos} class=${res.heroClass}${res.notInRange ? " NOT-IN-RANGE" : ""}`
      : `REFUSED (${res.kind ?? "miss"}): ${res.reason}`}`);
    if (res.ok) console.log(`  mix: ${JSON.stringify(res.actions)?.slice(0, 400)}\n  notes: ${res.warning ?? ""}${res.dryRun ? `\n  solver input: ${JSON.stringify(res.dryRun)}` : ""}`);
  }
}
restore();
