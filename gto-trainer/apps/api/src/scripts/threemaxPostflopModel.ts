/**
 * The MODEL side of the postflop pool comparison (pool_postflop.py measures
 * the population; this measures what our chart-seeded solves say the same
 * nodes should look like).
 *
 * For the two dominant SRP families, at the modal geometry, over a sample of
 * random flops: solve the root (OOP first action), the node after a check
 * (IP c-bet or check back), and the node after the c-bet (OOP response), and
 * average the AGGREGATE action frequencies (action_solutions total_frequency,
 * range-weighted) across boards — the solver-model analogue of the pool's
 * board-averaged rates.
 *
 *   P1  BTN opened 2.5x, SB folded, BB called   (chart line R2.5-F-C)
 *   P2  BTN folded, SB opened 3x, BB called     (chart line F-R3-C)
 *
 * Ranges come off the same 3-max chart the study answers use, EXACT
 * conditioning both sides (this is the equilibrium model the pool is being
 * compared against).
 *
 * Run:  bun run src/scripts/threemaxPostflopModel.ts [nBoards]
 */
import { appendFileSync } from "node:fs";
import { fetchNode, type HrcNode } from "../services/hrc3max";
import { gtowApi } from "../services/gtowApi";
import { buildRangeArray } from "../utils/buildRangeArray/buildRangeArray";
import { reconstructFlopRanges, classWeightsToSpec } from "../utils/reconstructFlopRanges/reconstructFlopRanges";

const OUT = `${import.meta.dir}/postflop_model.jsonl`;
const N_BOARDS = Number(process.argv[2] ?? 24);
const CHART = "ign200_3maxasym_D100_s100_eq";

let seed = 0xf10b;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
const RANKS = "23456789TJQKA".split("");
const SUITS = "shdc".split("");
const boardOf = () => {
  const used = new Set<string>();
  while (used.size < 3) used.add(pick(RANKS) + pick(SUITS));
  return [...used].join("");
};

const node = async (line: string): Promise<HrcNode | null> => {
  const n = await fetchNode(CHART, line);
  return n === "unreachable" ? null : n;
};

interface Fam { name: string; line: string; oop: string; ip: string; pot: number; stack: number }
const FAMS: Fam[] = [
  { name: "P1", line: "R2.5-F-C", oop: "BB", ip: "BTN", pot: 5.5, stack: 97.5 },
  { name: "P2", line: "F-R3-C", oop: "SB", ip: "BB", pot: 6, stack: 97 },
];

const bucket = (fracOfPot: number) =>
  fracOfPot <= 0.40 ? "<=40% pot" : fracOfPot <= 0.60 ? "40-60%" : fracOfPot <= 0.85 ? "60-85%" : "85%+";

function aggregate(sol: any, pot: number) {
  const out: Record<string, number> = {};
  const sizes: Record<string, number> = {};
  let betTotal = 0;
  for (const a of sol?.action_solutions ?? []) {
    const name = String(a?.action?.display_name ?? "").toUpperCase();
    let f = Number(a?.total_frequency ?? 0);
    if (f > 1.5) f /= 100; // some responses report percent
    if (name.includes("CHECK")) out["check"] = (out["check"] ?? 0) + f;
    else if (name.includes("FOLD")) out["fold"] = (out["fold"] ?? 0) + f;
    else if (name.includes("CALL")) out["call"] = (out["call"] ?? 0) + f;
    else if (name.includes("RAISE")) out["raise"] = (out["raise"] ?? 0) + f;
    else { // BET / ALLIN
      out["bet"] = (out["bet"] ?? 0) + f;
      const sz = parseFloat(a?.action?.betsize);
      if (sz > 0) { sizes[bucket(sz / pot)] = (sizes[bucket(sz / pot)] ?? 0) + f; betTotal += f; }
    }
  }
  if (betTotal > 0) for (const k of Object.keys(sizes)) sizes[k]! /= betTotal;
  return { out, sizes };
}

for (const fam of FAMS) {
  const recon = await reconstructFlopRanges(fam.line.split("-"), (l) => node(l));
  if (!recon.ok) { console.log(`${fam.name}: recon failed: ${recon.reason}`); continue; }
  const oopArr = buildRangeArray(classWeightsToSpec(recon.ranges[fam.oop]!));
  const ipArr = buildRangeArray(classWeightsToSpec(recon.ranges[fam.ip]!));

  const acc = { first: {} as Record<string, number>, cbet: {} as Record<string, number>,
                size: {} as Record<string, number>, resp: {} as Record<string, number> };
  let nb = 0;
  const add = (dst: Record<string, number>, src: Record<string, number>) => {
    for (const [k, v] of Object.entries(src)) dst[k] = (dst[k] ?? 0) + v;
  };

  for (let bi = 0; bi < N_BOARDS; bi++) {
    seed = 0xf10b + bi * 7717;
    const board = boardOf();
    const tree = {
      board, pot: fam.pot, stack: fam.stack,
      oopRange: oopArr, ipRange: ipArr, oopPos: fam.oop, ipPos: fam.ip,
      startingStreet: "FLOP", flopActions: "", turnActions: "", riverActions: "",
    };
    try {
      const root: any = await gtowApi.customSolve(tree as any);
      if (!root?.ok) throw new Error(String(root?.error ?? "root solve failed"));
      const rootAgg = aggregate(root.data, fam.pot);
      add(acc.first, rootAgg.out);

      // after OOP checks -> IP node
      const ipSol: any = await gtowApi.customSolve({ ...tree, flopActions: "X" } as any);
      if (ipSol?.ok) {
        const ipAgg = aggregate(ipSol.data, fam.pot);
        add(acc.cbet, ipAgg.out);
        add(acc.size, ipAgg.sizes);

        // after IP's (most frequent) bet -> OOP response node
        const bets = (ipSol.data?.action_solutions ?? [])
          .filter((a: any) => /^(BET|ALLIN)/i.test(a?.action?.display_name ?? ""))
          .sort((a: any, b: any) => (b.total_frequency ?? 0) - (a.total_frequency ?? 0));
        const code = bets[0]?.action?.code;
        if (code) {
          const resp: any = await gtowApi.customSolve({ ...tree, flopActions: `X-${code}` } as any);
          if (resp?.ok) add(acc.resp, aggregate(resp.data, fam.pot).out);
        }
      }
      nb++;
      appendFileSync(OUT, JSON.stringify({ fam: fam.name, board, ok: true }) + "\n");
    } catch (e) {
      appendFileSync(OUT, JSON.stringify({ fam: fam.name, board, ok: false,
        error: String((e as Error)?.message).slice(0, 140) }) + "\n");
    }
    if ((bi + 1) % 6 === 0) console.log(`${fam.name}: ${bi + 1}/${N_BOARDS} boards`);
  }

  const show = (label: string, dst: Record<string, number>) => {
    const tot = Object.values(dst).reduce((a, b) => a + b, 0);
    if (!tot) { console.log(`  ${label}: no data`); return; }
    const parts = Object.entries(dst).sort(([, a], [, b]) => b - a)
      .map(([k, v]) => `${k} ${(100 * v / nb).toFixed(1)}%`);
    console.log(`  ${label}: ${parts.join(" · ")}`);
  };
  console.log(`\n== MODEL ${fam.name} (${fam.line}, ${nb} boards averaged) ==`);
  show("OOP first action", acc.first);
  show("IP after check", acc.cbet);
  const st = Object.values(acc.size).reduce((a, b) => a + b, 0);
  if (st) console.log("  c-bet sizes: " + Object.entries(acc.size).sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k} ${(100 * v / st).toFixed(1)}%`).join(" · "));
  show("OOP vs c-bet", acc.resp);
}
console.log("\nDONE");
