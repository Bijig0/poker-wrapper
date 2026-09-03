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

// Turn-street nodes live in one file per board (data/mes_turn/<fam>_<board>.turn.json,
// ~30MB each, from mes_handoff/extract_turns.py) and are loaded on first use.
interface TurnNode { h: number[]; p: number; acts: string[]; mes?: number[][]; ev?: number[][] }
interface TurnCard { pot: number; w: number[]; nodes: TurnNode[] }
interface TurnFile {
  family: string; board: string; hero_player: number; holes: string[];
  lines: Record<string, { labels: string[]; cards: Record<string, TurnCard> }>;
}
const TURN_DIR = process.env.MES_TURN_DIR ?? join(import.meta.dir, "..", "..", "data", "mes_turn");
const turnCache = new Map<string, TurnFile | null>();
function loadTurn(family: string, board: string): TurnFile | null {
  const key = `${family}_${board}`;
  if (turnCache.has(key)) return turnCache.get(key)!;
  let tf: TurnFile | null = null;
  try { tf = JSON.parse(readFileSync(join(TURN_DIR, `${key}.turn.json`), "utf-8")) as TurnFile; } catch { tf = null; }
  if (turnCache.size >= 6) turnCache.delete(turnCache.keys().next().value!);
  turnCache.set(key, tf);
  return tf;
}


interface RawNode {
  h: number[]; p: number; acts: string[];
  mes?: number[][]; mes_ev?: number[][]; gto?: number[][]; gto_ev?: number[][]; w?: number[];
}
interface RawBoard { ev_gain_bb: number; holes: string[]; nodes: RawNode[] }
interface RawFamily {
  hero_player: number; hero_pos: string; pf3: string[];
  pot: number; eff_stack: number; boards: Record<string, RawBoard>;
  /** villain's flop actions before hero's first decision (M2: ["Check"]);
   *  node histories are relative to this spot line */
  line?: string[];
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

export interface MesPostflopInfo {
  path: string;
  exists: boolean;
  mtimeMs: number | null;
  sizeBytes: number | null;
  meta: Record<string, unknown> | null;
  families: {
    id: string;
    heroPos: string;
    pf3: string[];
    boards: { board: string; evGainBb: number; gen: string | null }[];
    generations: Record<string, number>;
  }[];
}

/** What the served artifact contains — the Sources registry's MES card. */
export function mesPostflopInfo(): MesPostflopInfo {
  let mtimeMs: number | null = null, sizeBytes: number | null = null, exists = false;
  try { const st = statSync(DATA_PATH); mtimeMs = st.mtimeMs; sizeBytes = st.size; exists = true; } catch { /* missing */ }
  const d = load() as (RawData & { _meta?: Record<string, unknown> }) | null;
  const families = d
    ? Object.entries(d.families).map(([id, f]) => {
        const boards = Object.entries(f.boards).map(([board, b]) => ({
          board,
          evGainBb: b.ev_gain_bb,
          gen: (b as RawBoard & { gen?: string }).gen ?? null,
        }));
        const generations: Record<string, number> = {};
        for (const b of boards) generations[b.gen ?? "unknown"] = (generations[b.gen ?? "unknown"] ?? 0) + 1;
        return { id, heroPos: f.hero_pos, pf3: f.pf3, boards, generations };
      })
    : [];
  return { path: DATA_PATH, exists, mtimeMs, sizeBytes, meta: d?._meta ?? null, families };
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

export interface MesNodeArgs {
  positions: string[];
  heroPos: string | null;
  pf3Tokens: string[];
  flopTokens: string[];
  /** observed turn actions so far — present only when a turn card is dealt and
   *  the answer is wanted on the turn (served from the per-board turn file) */
  turnTokens?: string[];
  board: string[];
  heroCards: string[];
}

interface ResolvedMesNode {
  famId: string; fam: RawFamily; board: string; rb: RawBoard; node: RawNode;
  exact: boolean; snapped: boolean; mapped: string[]; idx: number | undefined;
  pot: number; bd: number; inRange: boolean; onTurn: boolean;
}

/**
 * Family → nearest solved board → walk the observed flop line → hero's node,
 * plus hero's combo index in that node (suit-mapped when texture-matched).
 * Shared by the live lookup and the dashboard's node viewer, so what the
 * viewer shows is exactly what answered.
 */
function resolveMesNode(args: MesNodeArgs): ResolvedMesNode | null {
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
  // Consume the spot prefix: with an IP hero the flop opens with villain's
  // action(s) (BB checks) that the dump does not contain. They must match the
  // modeled line — a BB donk-bet is a different spot and is not covered.
  const prefix = fam.line ?? [];
  const flopToks = [...args.flopTokens];
  for (const want of prefix) {
    const got = flopToks.shift();
    const ok = got != null && (want === "Check" ? got === "X" : want === "Call" ? got === "C" : /^R/.test(got));
    if (!ok) return null;
  }
  let h: number[] = [];
  let snapped = false;
  const pot0 = fam.pot;
  let pot = pot0;
  const committed: Record<number, number> = { 0: 0, 1: 0 };
  for (const tok of flopToks) {
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
  const onTurn = args.board.length >= 4 && args.turnTokens != null;
  let node: RawNode | undefined;
  let holesList: string[] = rb.holes;
  if (!onTurn) {
    node = byH.get(h.join(","));
    if (!node || node.p !== fam.hero_player || !node.mes) return null;
  } else {
    // The flop line must be COMPLETE (its next node is the chance node), and
    // the turn card is served from the per-board turn file — only the flop
    // lines that carry ~97% of hero's reach were extracted.
    if (byH.has(h.join(","))) return null;              // flop action still pending
    const tf = loadTurn(famId, board);
    if (!tf) return null;
    const line = tf.lines[h.join(",")];
    if (!line) return null;                              // rare flop line: not extracted
    // turn card suit-mapped into the solved board's suit roles
    const smapT = suitMap(actual.cards, solvedCards);
    const tc = args.board[3]!;
    const tcard = tc[0]! + (smapT[tc[1]!] ?? tc[1]!);
    const card = line.cards[tcard] ?? line.cards[tc];
    if (!card) return null;
    const tByH = new Map(card.nodes.map((n) => [n.h.join(","), n]));
    let th: number[] = [];
    let tpot = card.pot;
    const tcomm: Record<number, number> = { 0: 0, 1: 0 };
    for (const tok of args.turnTokens!) {
      const tn = tByH.get(th.join(","));
      if (!tn) return null;
      const r = resolveToken(tok, tn.acts);
      if (!r) return null;
      snapped ||= r.snapped;
      const label = tn.acts[r.idx]!;
      const amt = amountOf(label);
      if (amt != null) { tpot += amt - tcomm[tn.p]!; tcomm[tn.p] = amt; }
      else if (label.startsWith("Call")) { const to = Math.max(tcomm[0]!, tcomm[1]!); tpot += to - tcomm[tn.p]!; tcomm[tn.p] = to; }
      th = [...th, r.idx];
    }
    const tn = tByH.get(th.join(","));
    if (!tn || tn.p !== fam.hero_player || !tn.mes) return null;
    node = { h: th, acts: tn.acts, p: tn.p, mes: tn.mes, mes_ev: tn.ev, w: card.w };
    holesList = tf.holes;
    pot = tpot;
  }

  // hero combo -> index (suit-mapped when the board was texture-matched)
  const smap = suitMap(actual.cards, solvedCards);
  const mapped = args.heroCards.map((c) => c[0]! + (smap[c[1]!] ?? c[1]!));
  const key = (cs: string[]) => [...cs].sort().join("");
  const holeIdx = new Map(holesList.map((hs, i) => [key([hs.slice(0, 2), hs.slice(2, 4)]), i]));
  const idx = holeIdx.get(key(mapped));
  // A combo absent from the holes list never entered this line's range at all
  // (e.g. the exploit preflop scheme LIMPS AA/KK/AK bvb, so they can't reach
  // the "SB raised" flop) — same treatment as a zero-weight combo, but say so.
  const inRange = idx != null && (node.w?.[idx] ?? 0) > 0;
  return { famId, fam, board, rb, node, exact, snapped, mapped, idx, pot, bd, inRange, onTurn };
}

export interface MesNodeDetail {
  family: string;
  heroPos: string;
  board: string;
  actualBoard: string;
  exact: boolean;
  snapped: boolean;
  evGainBb: number;
  potChips: number;
  effStackChips: number;
  history: number[];
  /** Action labels at hero's node, in solver order. */
  acts: string[];
  holes: string[];
  weights: number[];
  mes: number[][] | undefined;
  gto: number[][] | undefined;
  mesEv: number[][] | undefined;
  gtoEv: number[][] | undefined;
  heroIdx: number | null;
  heroMapped: string[];
}

/** The whole hero node the overlay answered from — every combo's MES and GTO mix. */
export function mesNodeDetail(args: MesNodeArgs): MesNodeDetail | null {
  const r = resolveMesNode(args);
  if (!r) return null;
  return {
    family: r.famId, heroPos: r.fam.hero_pos, board: r.board, actualBoard: args.board.slice(0, 3).join(""),
    exact: r.exact, snapped: r.snapped, evGainBb: r.rb.ev_gain_bb,
    potChips: r.fam.pot, effStackChips: r.fam.eff_stack, history: r.node.h,
    acts: r.node.acts, holes: r.rb.holes, weights: r.node.w ?? [],
    mes: r.node.mes, gto: r.node.gto, mesEv: r.node.mes_ev, gtoEv: r.node.gto_ev,
    heroIdx: r.idx ?? null, heroMapped: r.mapped,
  };
}

export function mesPostflopLookup(args: {
  positions: string[];          // e.g. ["BTN","SB","BB"] — must be exactly 3-max
  heroPos: string | null;
  pf3Tokens: string[];          // positional [BTN, SB, BB] preflop tokens
  flopTokens: string[];         // observed flop actions (complete if a turn was dealt)
  turnTokens?: string[];        // observed turn actions so far (hero to act next)
  board: string[];              // short cards, at least the flop
  heroCards: string[];
}): MesPostflopHit | null {
  const r = resolveMesNode(args);
  if (!r) return null;
  const { famId, board, rb, node, exact, snapped, idx, pot, bd, inRange, onTurn } = r;

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

  const actions = idx != null && node.mes ? toFreqs(node.mes, node.mes_ev) : [];
  const gtoActions = idx != null && node.gto ? toFreqs(node.gto, node.gto_ev) : [];
  const warning = [
    exact ? null : `Flop ${args.board.slice(0, 3).join("")} answered from nearest solved texture ${board} (dist ${bd.toFixed(1)}) — approximate.`,
    snapped ? "An observed bet size was snapped to the solved tree's nearest size." : null,
    idx == null ? "Hero's combo never reaches this line under the exploit preflop scheme (it takes a different preflop action)." : null,
    onTurn ? "Turn answer from the same locked tree as the flop (MES continuation); the GTO pair is not stored for turn nodes." : null,
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

// ---------------------------------------------------------- server-side helpers

/** Nearest solved board (and its ev_gain) for a family + flop — the dashboard
 *  uses this to price a hand's arrival without re-running a full lookup. */
export function mesBoardFor(familyId: string, flop: string[]):
    { board: string; evGainBb: number; exact: boolean; dist: number } | null {
  const data = load();
  const fam = data?.families[familyId];
  const actual = parseFlop(flop.slice(0, 3).join(""));
  if (!fam || !actual) return null;
  const fa = features(actual.cards);
  let best: string | null = null, bd = Infinity, bc: { r: number; s: string }[] = [];
  for (const b of Object.keys(fam.boards)) {
    const pc = parseFlop(b);
    if (!pc) continue;
    const d = texDist(fa, features(pc.cards));
    if (d < bd) { bd = d; best = b; bc = pc.cards; }
  }
  if (!best) return null;
  const exact = bd === 0 &&
    actual.cards.map((c) => c.r).sort().join() === bc.map((c) => c.r).sort().join();
  return { board: best, evGainBb: fam.boards[best]!.ev_gain_bb, exact, dist: bd };
}

/** Which modeled family a hand's positional preflop tokens + hero seat are, if
 *  any — same shape test the answer path uses, exposed for arrival counting. */
export function mesFamilyFor(pf3Tokens: string[], heroPos: string | null): string | null {
  const data = load();
  if (!data || !heroPos || pf3Tokens.length !== 3) return null;
  for (const [id, f] of Object.entries(data.families)) {
    if (f.hero_pos !== heroPos.toUpperCase()) continue;
    const ok = f.pf3.every((want, i) => {
      const got = pf3Tokens[i]!;
      return want === "R" ? /^R[\d.]+$/.test(got) : got === want;
    });
    if (ok) return id;
  }
  return null;
}

// ------------------------------------------------------------- river context

export interface MesRiverContext {
  family: string; board: string; heroPlayer: number; holes: string[];
  /** solver labels from the flop root: spot prefix + flop actions + turn card
   *  + turn actions + river card (cards suit-mapped into the solved board) */
  line: string[];
  heroCardsMapped: string[];
  evGainBb: number; exact: boolean; snapped: boolean; bd: number;
}

/** Everything mesRiver.ts needs to extract hero's river node on demand: the
 *  same family/board match and flop+turn walks as the flop/turn answers, but
 *  returning LABELS (extract.exe walks labels) and requiring both earlier
 *  streets to be complete. Null = not a modeled spot / line not extracted. */
export function mesRiverContext(args: MesNodeArgs & { riverCard: string }): MesRiverContext | null {
  const data = load();
  if (!data || !args.heroPos || args.heroCards.length !== 2) return null;
  const posSet = new Set(args.positions.map((p) => p.toUpperCase()));
  if (posSet.size !== 3 || !posSet.has("BTN") || !posSet.has("SB") || !posSet.has("BB")) return null;
  const famId = mesFamilyFor(args.pf3Tokens, args.heroPos);
  if (!famId) return null;
  const fam = data.families[famId]!;
  const actual = parseFlop(args.board.slice(0, 3).join(""));
  if (!actual) return null;
  const nb = mesBoardFor(famId, args.board);
  if (!nb) return null;
  const rb = fam.boards[nb.board]!;
  const solved = parseFlop(nb.board)!;
  const smap = suitMap(actual.cards, solved.cards);
  const mapCard = (c: string) => c[0]! + (smap[c[1]!] ?? c[1]!);

  // flop: consume the spot prefix, then walk the relative dump to a street end
  const prefix = fam.line ?? [];
  const flopToks = [...args.flopTokens];
  for (const want of prefix) {
    const got = flopToks.shift();
    const ok = got != null && (want === "Check" ? got === "X" : want === "Call" ? got === "C" : /^R/.test(got));
    if (!ok) return null;
  }
  const byH = new Map(rb.nodes.map((n) => [n.h.join(","), n]));
  const labels: string[] = [...prefix];
  let h: number[] = [];
  let snapped = false;
  for (const tok of flopToks) {
    const node = byH.get(h.join(","));
    if (!node) return null;
    const r = resolveToken(tok, node.acts);
    if (!r) return null;
    snapped ||= r.snapped;
    labels.push(node.acts[r.idx]!);
    h = [...h, r.idx];
  }
  if (byH.has(h.join(","))) return null;            // flop not finished

  // turn: the extracted line for this flop history, then walk its nodes
  const tf = loadTurn(famId, nb.board);
  if (!tf) return null;
  const tline = tf.lines[h.join(",")];
  if (!tline) return null;
  const tc = mapCard(args.board[3]!);
  const card = tline.cards[tc] ?? tline.cards[args.board[3]!];
  if (!card) return null;
  labels.push(tc);
  const tByH = new Map(card.nodes.map((n) => [n.h.join(","), n]));
  let th: number[] = [];
  for (const tok of args.turnTokens ?? []) {
    const tn = tByH.get(th.join(","));
    if (!tn) return null;
    const r = resolveToken(tok, tn.acts);
    if (!r) return null;
    snapped ||= r.snapped;
    labels.push(tn.acts[r.idx]!);
    th = [...th, r.idx];
  }
  if (tByH.has(th.join(","))) return null;          // turn not finished
  labels.push(mapCard(args.riverCard));

  return {
    family: famId, board: nb.board, heroPlayer: fam.hero_player, holes: tf.holes,
    line: labels, heroCardsMapped: args.heroCards.map(mapCard),
    evGainBb: rb.ev_gain_bb, exact: nb.exact, snapped, bd: nb.dist,
  };
}

// ------------------------------------------------------------ walkthrough API

/** Every solved spot: family x board, for the registry's clickable list. */
export function mesSpots() {
  const d = load();
  if (!d) return [];
  const out: { family: string; heroPos: string; pf3: string[]; line: string[]; board: string;
               evGainBb: number; gen: string | undefined; pot: number; effStack: number; hasTurn: boolean }[] = [];
  for (const [fid, f] of Object.entries(d.families)) {
    for (const [b, rb] of Object.entries(f.boards)) {
      let hasTurn = false;
      try { hasTurn = statSync(join(TURN_DIR, `${fid}_${b}.turn.json`)).size > 0; } catch {}
      out.push({ family: fid, heroPos: f.hero_pos, pf3: f.pf3, line: f.line ?? [], board: b,
                 evGainBb: rb.ev_gain_bb, gen: (rb as any).gen, pot: f.pot, effStack: f.eff_stack, hasTurn });
    }
  }
  return out;
}

/** One flop node of a solved board by relative history, with everything the
 *  walker renders: action labels, per-combo MES/GTO mixes + EVs, weights,
 *  the hole list, and the child histories that exist (to know where the
 *  street ends). */
export function mesFlopNode(family: string, board: string, hist: number[]) {
  const d = load();
  const f = d?.families[family]; const rb = f?.boards[board];
  if (!f || !rb) return null;
  const byH = new Map(rb.nodes.map((n) => [n.h.join(","), n]));
  const n = byH.get(hist.join(","));
  if (!n) return null;
  const children = n.acts.map((_, a) => byH.has([...hist, a].join(",")));
  // path labels for the breadcrumb
  const path: string[] = [...(f.line ?? [])];
  let h: number[] = [];
  for (const a of hist) { const pn = byH.get(h.join(",")); if (pn) path.push(pn.acts[a]!); h = [...h, a]; }
  return { family, board, heroPlayer: f.hero_player, heroPos: f.hero_pos, pot: f.pot, evGainBb: rb.ev_gain_bb,
           spotLine: f.line ?? [], path, hist, player: n.p, acts: n.acts, children, isHero: n.p === f.hero_player,
           holes: rb.holes, w: n.w ?? null, mes: n.mes ?? null, gto: n.gto ?? null, mesEv: n.mes_ev ?? null, gtoEv: n.gto_ev ?? null };
}

/** Turn: the extracted lines for a board (which flop histories reached the
 *  turn), and one turn node by (flop history, card, turn history). */
export function mesTurnLines(family: string, board: string) {
  const tf = loadTurn(family, board);
  if (!tf) return null;
  return Object.entries(tf.lines).map(([k, v]) => ({ hist: k.split(",").filter(Boolean).map(Number), labels: v.labels, cards: Object.keys(v.cards) }));
}
export function mesTurnNode(family: string, board: string, flopHist: number[], card: string, hist: number[]) {
  const tf = loadTurn(family, board);
  const line = tf?.lines[flopHist.join(",")];
  const tc = line?.cards[card];
  if (!tf || !line || !tc) return null;
  const byH = new Map(tc.nodes.map((n) => [n.h.join(","), n]));
  const n = byH.get(hist.join(","));
  if (!n) return null;
  const children = n.acts.map((_, a) => byH.has([...hist, a].join(",")));
  const path: string[] = [];
  let h: number[] = [];
  for (const a of hist) { const pn = byH.get(h.join(",")); if (pn) path.push(pn.acts[a]!); h = [...h, a]; }
  return { family, board, card, flopLabels: line.labels, pot: tc.pot, heroPlayer: tf.hero_player, path, hist,
           player: n.p, acts: n.acts, children, isHero: n.p === tf.hero_player, holes: tf.holes, w: tc.w,
           mes: n.mes ?? null, mesEv: n.ev ?? null };
}
