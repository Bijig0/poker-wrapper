/**
 * Step B of the profitability backtest: hero's postflop EV per hand class,
 * against the POOL's measured ranges (pool_model.json), by matchup family.
 *
 * One range-vs-range GTOW solve per sampled board; hero's per-combo EVs are
 * read at hero's first decision node (root when hero is OOP, the after-check
 * node when hero is IP — the dominant branch; donk lines are ignored and the
 * bias noted), masked by hero's arrival weight and the board, averaged into
 * class EVs across boards. EV convention (probed): chips collected from the
 * node onward — the accountant subtracts hero's preflop contribution.
 *
 * Families (pot/stack at 100bb, dead money included):
 *   F1 hero BTN open (union) IP  vs pool BB flat        pot 5.5  stack 97.5
 *   F2 hero BB flat (chart) OOP  vs pool BTN open       pot 5.5  stack 97.5
 *   F3 hero SB open (union) OOP  vs pool BB flat (bvb)  pot 6    stack 97
 *   F4 hero BB flat (chart) IP   vs pool SB open (bvb)  pot 6    stack 97
 *   F5 hero BTN open (union) IP  vs pool SB flat        pot 6    stack 97.5
 *
 * Run:  bun run src/scripts/poolEvTables.ts [nBoards]   -> pool_ev_tables.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fetchNode, type HrcNode } from "../services/hrc3max";
import { gtowApi } from "../services/gtowApi";
import { buildRangeArray } from "../utils/buildRangeArray/buildRangeArray";
import { classWeightsToSpec } from "../utils/reconstructFlopRanges/reconstructFlopRanges";
import { comboIndex } from "../utils/comboIndex/comboIndex";

const N_BOARDS = Number(process.argv[2] ?? 14);
const CHART = "ign200_3maxasym_D100_s100_eq";
const MODEL = JSON.parse(readFileSync(
  "C:/Users/Brady/poker/analysis/pipeline/limp_study/pool_model.json", "utf-8"));
const OUT = "C:/Users/Brady/poker/analysis/pipeline/limp_study/pool_ev_tables.json";

let seed = 0xace5;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
const RANKS = "23456789TJQKA".split("");
const SUITS = "shdc".split("");
const ORDER = "AKQJT98765432";

const boardOf = () => {
  const used = new Set<string>();
  while (used.size < 3) used.add(pick(RANKS) + pick(SUITS));
  return [...used];
};

const node = async (line: string): Promise<HrcNode> => {
  const n = await fetchNode(CHART, line);
  if (!n || n === "unreachable") throw new Error(`chart node missing: ${line}`);
  return n;
};

const raiseLabels = (n: HrcNode) =>
  n.actions.map((a) => a.action).filter((l) => /^Raise [\d.]+$/.test(l));

function unionRange(n: HrcNode): Record<string, number> {
  const rl = raiseLabels(n);
  const out: Record<string, number> = {};
  for (const c of n.cells) {
    const w = Math.min(1, rl.reduce((a, l) => a + (c.actions[l] ?? 0), 0) / 100);
    if (w > 0) out[c.hand] = w;
  }
  return out;
}
function callRange(n: HrcNode): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of n.cells) {
    const w = (c.actions["Call"] ?? 0) / 100;
    if (w > 0) out[c.hand] = w;
  }
  return out;
}

/** every concrete combo of a class */
function combosOf(cls: string): [string, string][] {
  const out: [string, string][] = [];
  const [r1, r2] = [cls[0]!, cls[1]!];
  for (const s1 of SUITS) for (const s2 of SUITS) {
    if (r1 === r2 && s1 >= s2) continue;
    if (cls.endsWith("s") && s1 !== s2) continue;
    if (cls.endsWith("o") && s1 === s2) continue;
    out.push([r1 + s1, r2 + s2]);
  }
  return out;
}

const ALL_CLASSES: string[] = [];
for (let i = 0; i < 13; i++) for (let k = i; k < 13; k++) {
  const [r1, r2] = [ORDER[i]!, ORDER[k]!];
  if (i === k) ALL_CLASSES.push(r1 + r2);
  else { ALL_CLASSES.push(r1 + r2 + "s"); ALL_CLASSES.push(r1 + r2 + "o"); }
}

interface Fam {
  name: string; heroIp: boolean; pot: number; stack: number;
  hero: Record<string, number>; villain: Record<string, number>;
  heroPos: string; villainPos: string;
}

async function familyTables(fams: Fam[]) {
  const tables: Record<string, Record<string, number>> = {};
  for (const fam of fams) {
    const heroArr = buildRangeArray(classWeightsToSpec(fam.hero));
    const villArr = buildRangeArray(classWeightsToSpec(fam.villain));
    const sums: Record<string, number> = {}, wts: Record<string, number> = {};
    let boardsOk = 0;
    for (let bi = 0; bi < N_BOARDS; bi++) {
      seed = 0xace5 + bi * 8221;
      const board = boardOf();
      const tree = {
        board: board.join(""), pot: fam.pot, stack: fam.stack,
        oopRange: fam.heroIp ? villArr : heroArr,
        ipRange: fam.heroIp ? heroArr : villArr,
        oopPos: fam.heroIp ? fam.villainPos : fam.heroPos,
        ipPos: fam.heroIp ? fam.heroPos : fam.villainPos,
        startingStreet: "FLOP", flopActions: fam.heroIp ? "X" : "",
        turnActions: "", riverActions: "",
      };
      try {
        const res: any = await gtowApi.customSolve(tree as any);
        if (!res?.ok) throw new Error(String(res?.error));
        const sol = res.data;
        for (const cls of ALL_CLASSES) {
          if (!(cls in fam.hero)) continue;
          for (const [c1, c2] of combosOf(cls)) {
            if (board.includes(c1) || board.includes(c2)) continue;
            const idx = comboIndex(c1, c2);
            const w = (fam.heroIp ? heroArr : heroArr)[idx] ?? 0;
            if (w <= 0) continue;
            let mix = 0, freq = 0;
            for (const a of sol.action_solutions ?? []) {
              const f = a.strategy?.[idx] ?? 0;
              const e = a.evs?.[idx];
              if (e != null) { mix += f * e; freq += f; }
            }
            if (freq < 0.5) continue; // zero-weight/garbage guard
            sums[cls] = (sums[cls] ?? 0) + w * mix;
            wts[cls] = (wts[cls] ?? 0) + w;
          }
        }
        boardsOk++;
      } catch (e) {
        console.log(`  ${fam.name} board ${board.join("")}: ${String((e as Error).message).slice(0, 80)}`);
      }
    }
    tables[fam.name] = Object.fromEntries(
      Object.keys(sums).map((c) => [c, sums[c]! / wts[c]!]));
    console.log(`${fam.name}: ${boardsOk}/${N_BOARDS} boards, ${Object.keys(tables[fam.name]!).length} classes`);
  }
  return tables;
}

/** Modal raise token at a node by combo-mass (mirrors the accountant). */
function modalRaiseTok(n: HrcNode): string {
  let best = 0, tok = "";
  for (const a of n.actions) {
    if (!/^Raise [\d.]+$/.test(a.action)) continue;
    const f = n.cells.reduce((s, c) => s + (c.actions[a.action] ?? 0), 0);
    if (f > best) { best = f; tok = a.token!; }
  }
  return tok;
}
const tokSize = (t: string) => parseFloat(t.slice(1));

const root = await node("");
const nF = await node("F");
const nSbResp = await node("R2.5");
const nBbResp = await node("R2.5-F");
const nBbVsSb = await node("F-R3");
const heroBtnOpen = unionRange(root);
const heroSbOpen = unionRange(nF);
const heroBbFlatVsBtn = callRange(nBbResp);
const heroBbFlatVsSb = callRange(nBbVsSb);

// 3-bet pot inputs: modal 3-bet size per node, hero's 3-bet unions and
// facing-3-bet call ranges from the chart
const sb3 = modalRaiseTok(nSbResp);   // pool/hero SB 3-bet size vs BTN 2.5x
const bb3 = modalRaiseTok(nBbResp);
const bvb3 = modalRaiseTok(nBbVsSb);
const heroSb3bet = unionRange(nSbResp);
const heroBb3bet = unionRange(nBbResp);
const heroBb3betBvb = unionRange(nBbVsSb);
const heroBtnCallVsSb3 = callRange(await node(`R2.5-${sb3}`));
const heroBtnCallVsBb3 = callRange(await node(`R2.5-F-${bb3}`));
const heroSbCallVsBvb3 = callRange(await node(`F-R3-${bvb3}`));
console.log(`3-bet tokens: sb3=${sb3} bb3=${bb3} bvb3=${bvb3}`);

const fams: Fam[] = [
  { name: "F1_heroBTN_vs_poolBBflat", heroIp: true, pot: 5.5, stack: 97.5,
    hero: heroBtnOpen, villain: MODEL.ranges.bb_flat_vs_btn, heroPos: "BTN", villainPos: "BB" },
  { name: "F2_heroBBflat_vs_poolBTNopen", heroIp: false, pot: 5.5, stack: 97.5,
    hero: heroBbFlatVsBtn, villain: MODEL.ranges.btn_open, heroPos: "BB", villainPos: "BTN" },
  { name: "F3_heroSBopen_vs_poolBBflat", heroIp: false, pot: 6, stack: 97,
    hero: heroSbOpen, villain: MODEL.ranges.bb_flat_vs_sb, heroPos: "SB", villainPos: "BB" },
  { name: "F4_heroBBflat_vs_poolSBopen", heroIp: true, pot: 6, stack: 97,
    hero: heroBbFlatVsSb, villain: MODEL.ranges.sb_open_bvb, heroPos: "BB", villainPos: "SB" },
  { name: "F5_heroBTN_vs_poolSBflat", heroIp: true, pot: 6, stack: 97.5,
    hero: heroBtnOpen, villain: MODEL.ranges.sb_flat_vs_btn, heroPos: "BTN", villainPos: "SB" },
  // ---- 3-bet pots (tightening pass). Geometry at the modal 3-bet size. ----
  { name: "F6_heroBB3bet_vs_poolBTNcall", heroIp: false,
    pot: 2 * tokSize(bb3) + 0.5, stack: 100 - tokSize(bb3),
    hero: heroBb3bet, villain: MODEL.ranges.btn_call_vs_3bet, heroPos: "BB", villainPos: "BTN" },
  { name: "F7_heroSB3bet_vs_poolBTNcall", heroIp: false,
    pot: 2 * tokSize(sb3) + 1, stack: 100 - tokSize(sb3),
    hero: heroSb3bet, villain: MODEL.ranges.btn_call_vs_3bet, heroPos: "SB", villainPos: "BTN" },
  { name: "F8a_heroBTNcall_vs_poolSB3bet", heroIp: true,
    pot: 2 * tokSize(sb3) + 1, stack: 100 - tokSize(sb3),
    hero: heroBtnCallVsSb3, villain: MODEL.ranges.sb_3bet_vs_btn, heroPos: "BTN", villainPos: "SB" },
  { name: "F8b_heroBTNcall_vs_poolBB3bet", heroIp: true,
    pot: 2 * tokSize(bb3) + 0.5, stack: 100 - tokSize(bb3),
    hero: heroBtnCallVsBb3, villain: MODEL.ranges.bb_3bet_vs_btn, heroPos: "BTN", villainPos: "BB" },
  { name: "F9a_heroSBcall_vs_poolBB3bet_bvb", heroIp: false,
    pot: 2 * tokSize(bvb3), stack: 100 - tokSize(bvb3),
    hero: heroSbCallVsBvb3, villain: MODEL.ranges.bb_3bet_vs_sb, heroPos: "SB", villainPos: "BB" },
  { name: "F9b_heroBB3bet_bvb_vs_poolSBcall", heroIp: true,
    pot: 2 * tokSize(bvb3), stack: 100 - tokSize(bvb3),
    hero: heroBb3betBvb, villain: MODEL.ranges.sb_call_vs_3bet_bvb, heroPos: "BB", villainPos: "SB" },
];

// Merge with the existing artifact: only solve families not already present,
// so the SRP tables (F1-F5) are not burned again on a tightening run.
let existing: Record<string, Record<string, number>> = {};
try {
  existing = JSON.parse(readFileSync(OUT, "utf-8")).tables ?? {};
} catch { /* first run */ }
const todo = fams.filter((f) => !(f.name in existing) || !Object.keys(existing[f.name]!).length);
console.log(`families to solve: ${todo.map((f) => f.name).join(", ") || "(none)"}`);

const tables = { ...existing, ...(await familyTables(todo)) };
writeFileSync(OUT, JSON.stringify({
  nBoards: N_BOARDS, chart: CHART,
  tokens: { sb3, bb3, bvb3 }, tables,
}, null, 1));
console.log(`wrote ${OUT}`);
