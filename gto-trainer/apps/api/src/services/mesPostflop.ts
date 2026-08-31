/**
 * Postflop MES overlay: study answers from our own locked exploit solves.
 *
 * The preflop exploit overlay (EXPLOIT_CHART in fastSolve.ts) answers hero's
 * first decision from the pool best-response chart. This is its postflop
 * counterpart: `analysis/pipeline/limp_study/mes_handoff/run_batch_win.py`
 * re-solves whole flop trees with the villain LOCKED to the pool's measured
 * per-hand-class frequencies, and `build_mes_study.py` compiles the hero
 * nodes into `data/mes_postflop.json`. This module answers from that file.
 *
 * Coverage is deliberately narrow and honest about it:
 *   * the modeled families only (M1: SB raises bvb + BB calls, hero SB;
 *     M2: BTN opens + BB calls, hero BTN), 3-handed, single-raised pots;
 *   * FLOP street only — turn/river wait on the .locked.bin extracts;
 *   * 14 solved boards per family — an off-list flop maps to the nearest
 *     texture and the answer is flagged approximate with the mapping named.
 *
 * Every lookup returns BOTH strategies from the SAME solve (MES + the
 * equilibrium baseline of the identical tree/rake), so the MES/GTO tabs
 * compare like with like instead of our solve vs GTO Wizard's tree.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pickWeightedAction, type WeightedPick } from "../utils/pickWeightedAction/pickWeightedAction";

export interface MesActionFreq {
  action: string;
  frequency: number; // percent
  ev?: number;       // bb
  betsize?: string;  // "33% pot"
}

export interface MesPostflopHit {
  family: string;
  board: string;        // the SOLVED board answering
  actualBoard: string;
  exact: boolean;       // canonically the same flop (no texture mapping)
  evGainBb: number;
  notInRange: boolean;
  actions: MesActionFreq[];      // MES strategy for hero's combo
  gtoActions: MesActionFreq[];   // equilibrium baseline, same tree
  exploitDecision: WeightedPick | null;
  chartDecision: WeightedPick | null;
  tag: string;
  warning: string | null;
}

// ---------------------------------------------------------------- data load

interface RawNode {
  h: number[]; p: number; acts: string[];
  mes?: number[][]; mes_ev?: number[][]; gto?: number[][]; gto_ev?: number[][]; w?: number[];
}
interface RawBoard { ev_gain_bb: number; holes: string[]; nodes: RawNode[] }
interface RawFamily {
  hero_player: number; hero_pos: string; pf3: string[];
  pot: number; eff_stack: number; boards: Record<string, RawBoard>;
}
interface RawData { families: Record<string, RawFamily> }

const DATA_PATH = process.env.MES_POSTFLOP ?? join(import.meta.dir, "..", "..", "data", "mes_postflop.json");

let cache: { data: RawData | null; mtimeMs: number } | undefined;
function load(): RawData | null {
  let mtimeMs = 0;
  try { mtimeMs = statSync(DATA_PATH).mtimeMs; } catch { cache = { data: null, mtimeMs: -1 }; return null; }
  if (cache && cache.mtimeMs === mtimeMs) return cache.data;
  try {
    cache = { data: JSON.parse(readFileSync(DATA_PATH, "utf-8")) as RawData, mtimeMs };
  } catch {
    cache = { data: null, mtimeMs };
  }
  return cache!.data;
}

/** Armed = the artifact exists and parsed. */
export function mesPostflopAvailable(): boolean {
  const d = load();
  return !!d && Object.keys(d.families).length > 0;
}

// ------------------------------------------------------------ board matching

const RANK: Record<string, number> = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };

interface Feat { ranks: number[]; paired: number; suitClass: number; span: number }

function parseFlop(b: string): { cards: { r: number; s: string }[] } | null {
  const m = b.match(/^([2-9TJQKA][shdc])([2-9TJQKA][shdc])([2-9TJQKA][shdc])$/);
  if (!m) return null;
  return { cards: [m[1]!, m[2]!, m[3]!].map((c) => ({ r: RANK[c[0]!]!, s: c[1]! })) };
}

function features(cards: { r: number; s: string }[]): Feat {
  const ranks = cards.map((c) => c.r).sort((a, b) => b - a);
  const uniq = new Set(ranks).size;
  const suits = new Set(cards.map((c) => c.s)).size;
  return {
    ranks,
    paired: 3 - uniq,               // 0 unpaired, 1 paired, 2 trips
    suitClass: 3 - suits,           // 0 rainbow, 1 two-tone, 2 monotone
    span: ranks[0]! - ranks[2]!,
  };
}

function texDist(a: Feat, b: Feat): number {
  return (
    3.0 * Math.abs(a.paired - b.paired) +
    1.6 * Math.abs(a.suitClass - b.suitClass) +
    0.7 * Math.abs(a.ranks[0]! - b.ranks[0]!) +
    0.35 * Math.abs(a.ranks[1]! - b.ranks[1]!) +
    0.2 * Math.abs(a.ranks[2]! - b.ranks[2]!) +
    0.3 * Math.abs(Math.min(a.span, 9) - Math.min(b.span, 9))
  );
}

/** Injective suit map actual->solved by role (count desc, then high card). */
function suitMap(actual: { r: number; s: string }[], solved: { r: number; s: string }[]): Record<string, string> {
  const roles = (cs: { r: number; s: string }[]) => {
    const by: Record<string, number[]> = {};
    for (const c of cs) (by[c.s] ??= []).push(c.r);
    return Object.entries(by)
      .map(([s, rs]) => ({ s, n: rs.length, hi: Math.max(...rs) }))
      .sort((x, y) => y.n - x.n || y.hi - x.hi)
      .map((x) => x.s);
  };
  const all = ["s", "h", "d", "c"];
  const ra = roles(actual), rs = roles(solved);
  const map: Record<string, string> = {};
  const used = new Set<string>();
  ra.forEach((s, i) => {
    const t = rs[i] && !used.has(rs[i]!) ? rs[i]! : all.find((x) => !used.has(x))!;
    map[s] = t; used.add(t);
  });
  for (const s of all) if (!(s in map)) { const t = all.find((x) => !used.has(x))!; map[s] = t; used.add(t); }
  return map;
}

// ----------------------------------------------------------------- the walk

const AMT = /\((\d+(?:\.\d+)?)\)/;
const amountOf = (label: string): number | null => {
  const m = label.match(AMT);
  return m ? parseFloat(m[1]!) : null;
};

/** Observed flop token -> action index on this node, with a size snap. */
function resolveToken(tok: string, acts: string[]): { idx: number; snapped: boolean } | null {
  const findByPrefix = (p: string) => acts.findIndex((a) => a.startsWith(p));
  if (tok === "X") { const i = findByPrefix("Check"); return i >= 0 ? { idx: i, snapped: false } : null; }
  if (tok === "F") { const i = findByPrefix("Fold"); return i >= 0 ? { idx: i, snapped: false } : null; }
  if (tok === "C") { const i = findByPrefix("Call"); return i >= 0 ? { idx: i, snapped: false } : null; }
  const sized = acts
    .map((a, i) => ({ i, amt: amountOf(a), aggr: /^(Bet|Raise|AllIn)/.test(a) }))
    .filter((x) => x.aggr && x.amt != null) as { i: number; amt: number; aggr: boolean }[];
  if (!sized.length) return null;
  if (tok === "RAI") {
    const ai = acts.findIndex((a) => a.startsWith("AllIn"));
    return { idx: ai >= 0 ? ai : sized[sized.length - 1]!.i, snapped: ai < 0 };
  }
  const m = tok.match(/^R([\d.]+)$/);
  if (!m) return null;
  const chips = parseFloat(m[1]!) * 100; // bb -> chips
  let best = sized[0]!, bd = Infinity;
  for (const s of sized) {
    const d = Math.abs(Math.log(s.amt / chips));
    if (d < bd) { bd = d; best = s; }
  }
  return { idx: best.i, snapped: bd > 0.05 };
}

// ---------------------------------------------------------------- main entry

export function mesPostflopLookup(args: {
  positions: string[];          // e.g. ["BTN","SB","BB"] — must be exactly 3-max
  heroPos: string | null;
  pf3Tokens: string[];          // positional [BTN, SB, BB] preflop tokens
  flopTokens: string[];         // observed flop actions so far (hero to act next)
  board: string[];              // short cards, at least the flop
  heroCards: string[];
}): MesPostflopHit | null {
  const data = load();
  if (!data || !args.heroPos || args.heroCards.length !== 2) return null;
  const posSet = new Set(args.positions.map((p) => p.toUpperCase()));
  if (posSet.size !== 3 || !posSet.has("BTN") || !posSet.has("SB") || !posSet.has("BB")) return null;
  if (args.pf3Tokens.length !== 3) return null;

  // family whose preflop shape + hero seat this hand IS
  let famId: string | null = null, fam: RawFamily | null = null;
  for (const [id, f] of Object.entries(data.families)) {
    if (f.hero_pos !== args.heroPos.toUpperCase()) continue;
    const ok = f.pf3.every((want, i) => {
      const got = args.pf3Tokens[i]!;
      return want === "R" ? /^R[\d.]+$/.test(got) : got === want;
    });
    if (ok) { famId = id; fam = f; break; }
  }
  if (!famId || !fam) return null;

  const actual = parseFlop(args.board.slice(0, 3).join(""));
  if (!actual) return null;
  const fa = features(actual.cards);

  // nearest solved board
  let board: string | null = null, bd = Infinity, solvedCards: { r: number; s: string }[] = [];
  for (const b of Object.keys(fam.boards)) {
    const p = parseFlop(b);
    if (!p) continue;
    const d = texDist(fa, features(p.cards));
    if (d < bd) { bd = d; board = b; solvedCards = p.cards; }
  }
  if (!board) return null;
  const rb = fam.boards[board]!;
  const exact = bd === 0 &&
    actual.cards.map((c) => c.r).sort().join() === solvedCards.map((c) => c.r).sort().join();

  // walk the observed flop line through the solved tree
  const byH = new Map(rb.nodes.map((n) => [n.h.join(","), n]));
  let h: number[] = [];
  let snapped = false;
  const pot0 = fam.pot;
  let pot = pot0;
  const committed: Record<number, number> = { 0: 0, 1: 0 };
  for (const tok of args.flopTokens) {
    const node = byH.get(h.join(","));
    if (!node) return null;
    const r = resolveToken(tok, node.acts);
    if (!r) return null;
    snapped ||= r.snapped;
    const label = node.acts[r.idx]!;
    const amt = amountOf(label);
    if (amt != null) { pot += amt - committed[node.p]!; committed[node.p] = amt; }
    else if (label.startsWith("Call")) {
      const to = Math.max(committed[0]!, committed[1]!);
      pot += to - committed[node.p]!; committed[node.p] = to;
    }
    h = [...h, r.idx];
  }
  const node = byH.get(h.join(","));
  if (!node || node.p !== fam.hero_player || !node.mes) return null;

  // hero combo -> index (suit-mapped when the board was texture-matched)
  const smap = suitMap(actual.cards, solvedCards);
  const mapped = args.heroCards.map((c) => c[0]! + (smap[c[1]!] ?? c[1]!));
  const key = (cs: string[]) => [...cs].sort().join("");
  const holeIdx = new Map(rb.holes.map((hs, i) => [key([hs.slice(0, 2), hs.slice(2, 4)]), i]));
  const idx = holeIdx.get(key(mapped));
  // A combo absent from the holes list never entered this line's range at all
  // (e.g. the exploit preflop scheme LIMPS AA/KK/AK bvb, so they can't reach
  // the "SB raised" flop) — same treatment as a zero-weight combo, but say so.
  const inRange = idx != null && (node.w?.[idx] ?? 0) > 0;
  const ci = idx ?? -1; // only read when idx != null
  const toFreqs = (strat: number[][], evs?: number[][]): MesActionFreq[] =>
    node.acts.map((a, ai) => {
      const amt = amountOf(a);
      const bb = amt != null ? amt / 100 : null;
      const pct = amt != null && pot > 0 ? Math.round((amt / pot) * 100) : null;
      const verb = a.replace(/\(.*/, "");
      return {
        action: bb != null ? `${verb} ${+bb.toFixed(2)}bb` : verb,
        frequency: (strat[ai]?.[ci] ?? 0) * 100,
        ev: evs?.[ai]?.[ci] != null ? +(evs[ai]![ci]! / 100).toFixed(2) : undefined,
        ...(pct != null ? { betsize: `${pct}% pot` } : {}),
      };
    });

  const actions = idx != null ? toFreqs(node.mes, node.mes_ev) : [];
  const gtoActions = idx != null && node.gto ? toFreqs(node.gto, node.gto_ev) : [];
  const warning = [
    exact ? null : `Flop ${args.board.slice(0, 3).join("")} answered from nearest solved texture ${board} (dist ${bd.toFixed(1)}) — approximate.`,
    snapped ? "An observed bet size was snapped to the solved tree's nearest size." : null,
    idx == null ? "Hero's combo never reaches this line under the exploit preflop scheme (it takes a different preflop action)." : null,
  ].filter(Boolean).join(" ") || null;

  return {
    family: famId, board, actualBoard: args.board.slice(0, 3).join(""), exact,
    evGainBb: rb.ev_gain_bb, notInRange: !inRange,
    actions, gtoActions,
    exploitDecision: inRange && actions.length ? pickWeightedAction(actions) : null,
    chartDecision: inRange && gtoActions.length ? pickWeightedAction(gtoActions) : null,
    tag: `${famId} @ ${board}${exact ? "" : "~"} (+${rb.ev_gain_bb}bb pool MES)`,
    warning,
  };
}
