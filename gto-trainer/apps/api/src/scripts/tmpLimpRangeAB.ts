/** TEMP: A/B the limped-pot flop — chart limp ranges vs the measured NL200 pool limp range, identical spec. */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMBOS, comboIndex } from "../utils/comboIndex/comboIndex";
import { gtowApi } from "../services/gtowApi";
import { gtowSessions } from "../services/gtowSessions";

const db = new Database(join(import.meta.dir, "..", "..", "data", "solves.sqlite"), { readonly: true });
const row = db.query<any, [string]>("SELECT trace FROM solves WHERE client_hand_id = ? ORDER BY ts DESC LIMIT 1").get("stress-cmp-01");
const trace = JSON.parse(Buffer.from(Bun.gunzipSync(row.trace)).toString("utf-8"));
const spec = trace.spec;
const s0 = trace.streets[0];

// pool limp range: per-class frequency from 756 shown limps, divided by the class's combo count, scaled so the
// most-limped class is 1 — a relative weight, which is all a solver range is
const counts = JSON.parse(readFileSync(join(process.env.TMP!, "pool_limp_classes.json"), "utf-8")) as Record<string, number>;
const combosIn: Record<string, number> = {};
for (const c of COMBOS as any[]) combosIn[c.cls] = (combosIn[c.cls] ?? 0) + 1;
const per: Record<string, number> = {};
for (const [k, n] of Object.entries(counts)) per[k] = n / (combosIn[k] ?? 1);
const top = Math.max(...Object.values(per));
const pool = (COMBOS as any[]).map((c) => (per[c.cls] ?? 0) / top);
// the board's cards are dead in every range
const dead = new Set((spec.board.match(/../g) ?? []).map((x: string) => x.toLowerCase()));
const live = (w: number[]) => w.map((x, i) => {
  const c = COMBOS[i] as any; const cards: string[] = c.cards ?? [c.c1, c.c2];
  return cards?.some?.((k: string) => dead.has(String(k).toLowerCase())) ? 0 : x;
});

const hero = comboIndex("Kh", "9h");
const report = (label: string, res: any) => {
  if (!res?.ok) { console.log(`${label}: FAILED — ${res?.error}`); return; }
  const sols = res.data?.action_solutions ?? [];
  console.log(`\n${label}  (solved on ${res.session})`);
  for (const a of sols) {
    const code = a.action?.code ?? a.action?.display_name;
    console.log(`   ${String(code).padEnd(6)} whole range ${(100 * (a.total_frequency ?? 0)).toFixed(1).padStart(5)}%   K9 two pair ${(100 * (a.strategy?.[hero] ?? 0)).toFixed(1).padStart(5)}%`);
  }
};

await gtowSessions.forceRefresh();
// the exact request the live chain sent for this spot's flop, rebuilt from its stored trace
const base: any = {
  board: spec.board, pot: spec.flopPot, stack: spec.flopStack, startingStreet: "FLOP",
  oopPos: spec.oopPos, ipPos: spec.ipPos, oopRange: spec.oopRange, ipRange: spec.ipRange,
  rake: spec.rake, ...(s0.fixedLevels ? { fixedLevels: s0.fixedLevels } : {}), flopActions: "",
};
console.log(`spot: board ${spec.board} · pot ${spec.flopPot}bb · stack ${spec.flopStack}bb · OOP ${spec.oopPos} (hero) · mid ${spec.midPos} · IP ${spec.ipPos}`);
const midPos = spec.midPos;
const midChart = spec.midRange;
// 1) the same tree, walked on: BB checks, UTG checks, CO bets 33% — what does K9 do NOW?
report("A2 · CHART ranges, BB checked, UTG checked, CO bets 33%: K9's response",
  await gtowApi.customSolve({ ...base, mid: { pos: midPos, range: midChart }, flopActions: "X-X-R1.2" } as any));
// 2) the same spot with the BB's range UNCAPPED: its preflop raising hands put back in (AA/KK/QQ/JJ/AK/AQ)
const uncap = spec.oopRange.map((w: number, i: number) =>
  ["AA", "KK", "QQ", "JJ", "AKs", "AKo", "AQs", "AQo"].includes((COMBOS[i] as any).cls) ? 1 : w);
report("C · BB range UNCAPPED (preflop raises put back) — does it start leading?",
  await gtowApi.customSolve({ ...base, oopRange: live(uncap), mid: { pos: midPos, range: midChart } } as any));
process.exit(0);
