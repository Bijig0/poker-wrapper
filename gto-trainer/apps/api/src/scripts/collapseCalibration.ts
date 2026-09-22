/**
 * HOW MUCH DOES COLLAPSING A MULTIWAY FLOP COST?  (2026-09-20)
 *
 * GTO Wizard AI solves at most three postflop seats, so a four-way flop has no answer at all. Every candidate
 * fix COLLAPSES the spot to a tree the engine can solve. This harness measures what that collapse costs, one
 * player down — where we CAN see the truth: take a real three-way flop node, solve it exactly (3-player tree),
 * then re-solve it as a heads-up tree under each collapse rule, and score the collapsed strategy inside the
 * true tree.
 *
 *   TRUTH     3-player solve of the real spot.
 *   GHOST(v)  villain v leaves the tree; his chips stay in the pot as dead money. Valid only while v has put
 *             in nothing this street (every token of his is a check) — otherwise his money is unrepresentable.
 *   MERGE     the two villains become ONE seat whose range is the sum of theirs. Needs them ADJACENT in the
 *             rotation (so hero is not between them) and at most one of them wagering.
 *   BLEND     both GHOSTs combined by the monotonicity rules: fold if either ghost folds, bet only as often as
 *             the more pessimistic ghost bets (facing more opponents can only shrink hero's equity share).
 *   UNIFORM   no-information baseline: every legal action at equal frequency. Sets the scale for the rest.
 *
 * Scoring uses the TRUE tree's per-combo EVs, so "loss" is what hero actually gives up in the real three-way
 * game by playing the collapsed strategy: EV(truth's strategy) − EV(collapse's strategy), range-weighted, bb.
 *
 * NOTE THIS IS THE HARD DIRECTION. Collapsing 3→2 removes half of hero's opponents; collapsing 4→3 removes a
 * third, and leaves TWO valid ghosts when facing a bet where 3→2 leaves one. Measured errors here are an
 * upper bound on the 4→3 case we actually want to ship.
 *
 * Run:  bun src/scripts/collapseCalibration.ts        (resumable — appends to collapse_calib.jsonl)
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { solveAiChain, type AiChainSpec } from "../services/aiChain";
import { THREE_WAY_SIZES } from "../services/gtowApi";
import { fetchNode6max } from "../services/hrc6maxDb";
import { reconstructFlopRanges, classWeightsToSpec } from "../utils/reconstructFlopRanges/reconstructFlopRanges";
import { buildRangeArray } from "../utils/buildRangeArray/buildRangeArray";
import { preflopPotStack, POSTFLOP_ORDER } from "../utils/aiStudyLine/aiStudyLine";
import { align, blend, blendMean, readSolved, score, uniform } from "./collapseScore";

const OUT = process.env.OUT ?? join(import.meta.dir, "collapse_calib.jsonl");
const LINES = process.env.LINES ?? join(import.meta.dir, "collapse_lines.jsonl");
const RAKE = { pct_of_pot: 5, cap_in_chips: 2, preflop_rake_type: null }; // Ignition NL200, six dealt
const LIMIT = Number(process.env.LIMIT ?? 1e9);

/** Texture spread: dry high, dry mid, low connected, two-tone connected, two-tone low, broadway two-tone,
 *  paired, monotone. Eight is enough to see whether the collapse error is texture-driven. */
const BOARDS = (process.env.BOARDS ?? "Ah7d2c,Kh9s4d,9c7d5h,Ts9s4h,8h7h2c,AsKd7s,Jh6c6d,Kd9d5d").split(",");

type Seat = { pos: string; range: number[] };
type Tok = { t: "X" | "BET"; seat: 0 | 1 | 2 };
interface NodeDef { id: string; hero: 0 | 1 | 2; prefix: Tok[]; note: string }

/** Hero's decision nodes on a three-way flop: checked to him in each seat, and facing a bet in each seat. */
const NODES: NodeDef[] = [
  { id: "n1", hero: 0, prefix: [], note: "OOP first to act, two behind" },
  { id: "n2", hero: 1, prefix: [{ t: "X", seat: 0 }], note: "checked to the middle seat, one behind" },
  { id: "n3", hero: 2, prefix: [{ t: "X", seat: 0 }, { t: "X", seat: 1 }], note: "checked around to IP" },
  { id: "n4", hero: 1, prefix: [{ t: "BET", seat: 0 }], note: "middle seat faces an OOP bet, one behind" },
  { id: "n5", hero: 2, prefix: [{ t: "X", seat: 0 }, { t: "BET", seat: 1 }], note: "IP faces a bet, one seat already checked" },
  { id: "n6", hero: 0, prefix: [{ t: "X", seat: 0 }, { t: "X", seat: 1 }, { t: "BET", seat: 2 }], note: "OOP faces an IP stab after checking" },
];

interface Collapse { kind: string; spec: AiChainSpec }

/** Tokens as GTOW strings, with the bet sized at 33% of the flop pot (a size every grid here contains). */
function tokenize(prefix: Tok[], pot: number): { toks: string[]; seats: number[] } {
  const bet = Math.round(pot * 0.33 * 100) / 100;
  return { toks: prefix.map((p) => (p.t === "X" ? "X" : `R${bet}`)), seats: prefix.map((p) => p.seat) };
}

function truthSpec(seats: Seat[], node: NodeDef, board: string, pot: number, stack: number): AiChainSpec {
  const { toks, seats: acts } = tokenize(node.prefix, pot);
  return {
    oopPos: seats[0]!.pos, midPos: seats[1]!.pos, ipPos: seats[2]!.pos,
    oopRange: seats[0]!.range, midRange: seats[1]!.range, ipRange: seats[2]!.range,
    heroSeat: node.hero === 0 ? "oop" : node.hero === 1 ? "mid" : "ip",
    flopPot: pot, flopStack: stack, board,
    streets: [toks], streetSeats: [acts.map((i) => seats[i]!.pos)],
    heroComboIdx: null, rake: RAKE,
  };
}

/** GHOST: drop villain `v`. Only legal while v has committed nothing this street. */
function ghostSpec(seats: Seat[], node: NodeDef, board: string, pot: number, stack: number, v: 0 | 1 | 2): Collapse | null {
  if (v === node.hero) return null;
  if (node.prefix.some((p) => p.seat === v && p.t !== "X")) return null; // his chips would vanish from the pot
  const keep = ([0, 1, 2] as const).filter((i) => i !== v);
  const kept = keep.map((i) => seats[i]!);
  const { toks, seats: acts } = tokenize(node.prefix, pot);
  const idx = node.prefix.map((_, i) => i).filter((i) => node.prefix[i]!.seat !== v);
  return {
    kind: `ghost:${seats[v]!.pos}`,
    spec: {
      oopPos: kept[0]!.pos, ipPos: kept[1]!.pos, oopRange: kept[0]!.range, ipRange: kept[1]!.range,
      heroSeat: keep[0] === node.hero ? "oop" : "ip",
      flopPot: pot, flopStack: stack, board,
      streets: [idx.map((i) => toks[i]!)],
      streetSeats: [idx.map((i) => seats[acts[i]!]!.pos)],
      heroComboIdx: null, rake: RAKE, huGrid: THREE_WAY_SIZES,
    },
  };
}

/** MERGE: the two villains become one seat. Needs them adjacent (hero not between) and at most one wagering. */
function mergeSpec(seats: Seat[], node: NodeDef, board: string, pot: number, stack: number): Collapse | null {
  const vs = ([0, 1, 2] as const).filter((i) => i !== node.hero);
  if (Math.abs(vs[0]! - vs[1]!) !== 1) return null; // hero sits between them
  const wagers = node.prefix.filter((p) => p.t !== "X" && p.seat !== node.hero);
  if (wagers.length > 1) return null;
  const compIP = node.hero < vs[0]!; // both villains act after hero
  // the composite is named for the seat whose action it carries (the wagerer, else the one next to hero)
  const carrier = wagers.length ? wagers[0]!.seat : compIP ? vs[0]! : vs[1]!;
  const range = seats[vs[0]!]!.range.map((w, i) => w + (seats[vs[1]!]!.range[i] ?? 0));
  const comp: Seat = { pos: seats[carrier]!.pos, range };
  const hero = seats[node.hero]!;
  const bet = Math.round(pot * 0.33 * 100) / 100;
  // hero's own tokens stay; the villains' collapse into one action (the wager if there is one, else a check)
  const toks: string[] = [];
  const acts: string[] = [];
  let villainDone = false;
  for (const p of node.prefix) {
    if (p.seat === node.hero) { toks.push(p.t === "X" ? "X" : `R${bet}`); acts.push(hero.pos); continue; }
    if (villainDone) continue;
    villainDone = true;
    toks.push(wagers.length ? `R${bet}` : "X");
    acts.push(comp.pos);
  }
  return {
    kind: "merge",
    spec: {
      oopPos: compIP ? hero.pos : comp.pos, ipPos: compIP ? comp.pos : hero.pos,
      oopRange: compIP ? hero.range : comp.range, ipRange: compIP ? comp.range : hero.range,
      heroSeat: compIP ? "oop" : "ip",
      flopPot: pot, flopStack: stack, board,
      streets: [toks], streetSeats: [acts], heroComboIdx: null, rake: RAKE, huGrid: THREE_WAY_SIZES,
    },
  };
}

const done = new Set<string>();
if (existsSync(OUT)) {
  for (const l of readFileSync(OUT, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { done.add(JSON.parse(l).key); } catch { /* half-written line */ }
  }
}

const lines: { tokens: string[]; seats: string[]; pot: number; stack: number; p: number; src: string }[] =
  readFileSync(LINES, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

/** Reconstruct every line's three flop-entering ranges once, up front — the chart read is local and cheap,
 *  and the run below is ordered BOARD-MAJOR so that a partial run is still a representative sample. */
interface Prepped { lineId: string; src: string; tokens: string[]; ordered: string[]; seats: Seat[]; pot: number; stack: number; p: number }
const prepped: Prepped[] = [];
for (const line of lines) {
  const recon = await reconstructFlopRanges(line.tokens, async (l) => {
    const x = await fetchNode6max(line.src, l);
    return x === "unreachable" ? null : x;
  }, { maxPlayers: 3, borrowCaller: true });
  if (!recon.ok) { console.error(`SKIP ${line.tokens.join("-")} (${line.src}): ${recon.reason}`); continue; }
  const ordered = Object.keys(recon.ranges).sort(
    (a, b) => POSTFLOP_ORDER.indexOf(a.toUpperCase()) - POSTFLOP_ORDER.indexOf(b.toUpperCase()));
  if (ordered.length !== 3) { console.error(`SKIP ${line.tokens.join("-")}: ${ordered.length} seats`); continue; }
  const { pot, stack } = preflopPotStack(line.tokens, 100);
  prepped.push({
    lineId: `${line.src}|${line.tokens.join("-")}`, src: line.src, tokens: line.tokens, ordered, pot, stack, p: line.p,
    seats: ordered.map((q) => ({ pos: q, range: buildRangeArray(classWeightsToSpec(recon.ranges[q]!)) })),
  });
}
console.error(`${prepped.length}/${lines.length} lines prepped, ${BOARDS.length} boards, ${NODES.length} nodes each`);

let n = 0;
for (const board of BOARDS) {
  for (const L of prepped) {
    const { seats, pot, stack } = L;
    for (const node of NODES) {
      const key = `${L.lineId}|${board}|${node.id}`;
      if (done.has(key)) continue;
      if (++n > LIMIT) { console.error("LIMIT reached"); process.exit(0); }
      const t0 = Date.now();
      const rec: any = {
        key, src: L.src, line: L.tokens.join("-"), seats: L.ordered, p: L.p,
        pot, stack, board, node: node.id, hero: seats[node.hero]!.pos, note: node.note,
      };
      const tr = await solveAiChain(truthSpec(seats, node, board, pot, stack));
      const truth = readSolved(tr, board);
      if (!truth) {
        rec.truth = { ok: false, why: tr.ok ? "no actions" : tr.why };
        appendFileSync(OUT, JSON.stringify(rec) + "\n");
        console.error(`  x ${key}: ${rec.truth.why}`);
        continue;
      }
      rec.truth = { ok: true, codes: truth.codes, potNode: truth.potNode, ...score(truth, truth.strat, truth.potNode) };
      rec.results = {};
      const ghosts: number[][][] = [];
      for (const v of [0, 1, 2] as const) {
        const g = ghostSpec(seats, node, board, pot, stack, v);
        if (!g) continue;
        const gr = await solveAiChain(g.spec);
        const gs = readSolved(gr, board);
        if (!gs) { rec.results[g.kind] = { ok: false, why: gr.ok ? "no actions" : gr.why }; continue; }
        const al = align(truth, gs);
        if (!al) { rec.results[g.kind] = { ok: false, why: `menu ${gs.codes.join("/")} vs ${truth.codes.join("/")}` }; continue; }
        rec.results[g.kind] = { ok: true, ...score(truth, al, truth.potNode) };
        ghosts.push(al);
      }
      const m = mergeSpec(seats, node, board, pot, stack);
      if (m) {
        const mr = await solveAiChain(m.spec);
        const ms = readSolved(mr, board);
        const al = ms && align(truth, ms);
        rec.results.merge = al ? { ok: true, ...score(truth, al, truth.potNode) }
          : { ok: false, why: ms ? "menu differs" : (mr as any).why ?? "no actions" };
      }
      if (ghosts.length >= 2) {
        rec.results.blend = { ok: true, ...score(truth, blend(truth, ghosts), truth.potNode) };
        rec.results["blend-mean"] = { ok: true, ...score(truth, blendMean(truth, ghosts), truth.potNode) };
      }
      rec.results.uniform = { ok: true, ...score(truth, uniform(truth), truth.potNode) };
      rec.ms = Date.now() - t0;
      appendFileSync(OUT, JSON.stringify(rec) + "\n");
      const str = Object.entries(rec.results).map(([k, v]: any) => `${k}=${v.ok ? v.loss.toFixed(3) : "x"}`).join(" ");
      console.error(`  [${n}] ${key} (${rec.ms}ms) ${str}`);
    }
  }
}
console.error("done");
