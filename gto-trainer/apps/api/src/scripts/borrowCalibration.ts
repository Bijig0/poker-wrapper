/**
 * WHAT DOES THE BORROWED CALLER RANGE COST?  (2026-09-20)
 *
 * A four- or five-way flop has no arrival ranges anywhere. GTO Wizard AI's preflop tree tops out at ONE
 * cold-caller (probed: at "F-R2.5-C" the next seat is offered only F and R — and max_allowed_limps is capped
 * at 2 by the engine, not by us), so it cannot express the line at all. Our own 6-max HRC charts stop at the
 * same caller cap, but reconstructFlopRanges has the BORROWED-CALLER shortcut: a call that is not in the tree
 * is read at the neighbouring node with an earlier caller folded — same seat, same price, one caller fewer.
 * That is the only thing standing between us and a four-way answer, and its range is somewhat too WIDE.
 *
 * This measures the cost, where truth exists. Take a three-way line the charts DO contain (open, one caller,
 * BB call). Reconstruct it twice:
 *
 *   TRUE      all three ranges from the real line.
 *   BORROWED  the last caller's range read the way the shortcut reads it — from the line with the earlier
 *             caller folded — and the other two seats left exactly as they are.
 *
 * Then solve hero's node under each and score the borrowed strategy inside the TRUE tree. The loss is what
 * hero gives up by acting on a borrowed range, in bb.
 *
 * Run:  bun src/scripts/borrowCalibration.ts        (resumable — appends to borrow_calib.jsonl)
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { solveAiChain, type AiChainSpec } from "../services/aiChain";
import { fetchNode6max } from "../services/hrc6maxDb";
import { reconstructFlopRanges, classWeightsToSpec } from "../utils/reconstructFlopRanges/reconstructFlopRanges";
import { buildRangeArray } from "../utils/buildRangeArray/buildRangeArray";
import { preflopPotStack, POSTFLOP_ORDER } from "../utils/aiStudyLine/aiStudyLine";
import { align, readSolved, score } from "./collapseScore";

const OUT = process.env.OUT ?? join(import.meta.dir, "borrow_calib.jsonl");
const RAKE = { pct_of_pot: 5, cap_in_chips: 2, preflop_rake_type: null };
const BOARDS = (process.env.BOARDS ?? "Ah7d2c,Kh9s4d,9c7d5h,Ts9s4h,8h7h2c,AsKd7s,Jh6c6d,Kd9d5d").split(",");
const SRC = process.env.SRC ?? "ign200_6max_D100_o2_5";

/** Three-way lines the charts contain outright: an open, ONE cold-caller, and a blind call. The seat that
 *  BORROWS is the LAST caller — the one whose call would fall past the cap if a further caller existed — and
 *  the donor line is the same walk with the EARLIER caller folded, exactly what the shortcut does.
 *
 *  This is the hard direction, as the collapse study is: the production borrow folds ONE of several callers
 *  out of a crowded node, while here folding the only other caller takes the donor all the way down to a
 *  heads-up defence. The measured cost is therefore an upper bound on the real one. */
const LINES: { tokens: string[] }[] = [
  { tokens: ["F", "F", "R2.5", "C", "F", "C"] },  // CO open, BTN call, BB call
  { tokens: ["F", "R2.5", "C", "F", "F", "C"] },  // HJ open, CO call, BB call
  { tokens: ["R2.5", "F", "C", "F", "F", "C"] },  // UTG open, CO call, BB call
  { tokens: ["F", "R2.5", "F", "C", "F", "C"] },  // HJ open, BTN call, BB call
  { tokens: ["F", "F", "R2.5", "C", "C", "F"] },  // CO open, BTN call, SB call
  { tokens: ["F", "F", "F", "R2.5", "C", "C"] },  // BTN open, SB call, BB call
];

type Tok = { t: "X" | "BET"; seat: 0 | 1 | 2 };
const NODES: { id: string; hero: 0 | 1 | 2; prefix: Tok[]; note: string }[] = [
  { id: "n1", hero: 0, prefix: [], note: "OOP first to act, two behind" },
  { id: "n2", hero: 1, prefix: [{ t: "X", seat: 0 }], note: "checked to the middle seat" },
  { id: "n3", hero: 2, prefix: [{ t: "X", seat: 0 }, { t: "X", seat: 1 }], note: "checked around to IP" },
  { id: "n5", hero: 2, prefix: [{ t: "X", seat: 0 }, { t: "BET", seat: 1 }], note: "IP faces a bet" },
  { id: "n6", hero: 0, prefix: [{ t: "X", seat: 0 }, { t: "X", seat: 1 }, { t: "BET", seat: 2 }], note: "OOP faces an IP stab" },
];

const get = async (l: string) => {
  const x = await fetchNode6max(SRC, l);
  return x === "unreachable" ? null : x;
};

type Ranges = Record<string, number[]>;

/** Both range sets for one line: the real reconstruction, and the one the borrow shortcut would produce for
 *  the seat at `borrowAt` (its call read at the line with the EARLIER caller folded). */
async function rangesFor(tokens: string[]): Promise<{ trueR: Ranges; borrowed: Ranges; donor: string } | string> {
  const real = await reconstructFlopRanges(tokens, get, { maxPlayers: 6 });
  if (!real.ok) return `true line: ${real.reason}`;
  const borrowAt = tokens.lastIndexOf("C");
  const earlier = tokens.findIndex((t, i) => t === "C" && i < borrowAt);
  if (borrowAt < 0 || earlier < 0) return "line has fewer than two callers — nothing to borrow";
  const alt = tokens.slice();
  alt[earlier] = "F";
  const donor = await reconstructFlopRanges(alt, get, { maxPlayers: 6 });
  if (!donor.ok) return `donor line: ${donor.reason}`;
  // which seat sits at borrowAt? replay the rotation the same way preflopPotStack does
  const SEATS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
  let active = [...SEATS], p = 0, who: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    if (active.length < 2) break;
    p = p % active.length;
    const seat = active[p]!;
    if (i === borrowAt) { who = seat; break; }
    if (tokens[i] === "F") { active = active.filter((s) => s !== seat); continue; }
    p += 1;
  }
  if (!who) return "could not identify the borrowing seat";
  const donorRange = Object.entries(donor.ranges).find(([q]) => q.toUpperCase() === who!.toUpperCase())?.[1];
  if (!donorRange) return `${who} is not in the donor line's flop field`;
  const arr = (r: Record<string, number>) => buildRangeArray(classWeightsToSpec(r));
  const trueR: Ranges = {}, borrowed: Ranges = {};
  for (const [q, r] of Object.entries(real.ranges)) {
    trueR[q] = arr(r);
    borrowed[q] = q.toUpperCase() === who.toUpperCase() ? arr(donorRange) : arr(r);
  }
  return { trueR, borrowed, donor: who };
}

function specFor(ordered: string[], R: Ranges, node: (typeof NODES)[number], board: string, pot: number, stack: number): AiChainSpec {
  const bet = Math.round(pot * 0.33 * 100) / 100;
  return {
    oopPos: ordered[0]!, midPos: ordered[1]!, ipPos: ordered[2]!,
    oopRange: R[ordered[0]!]!, midRange: R[ordered[1]!]!, ipRange: R[ordered[2]!]!,
    heroSeat: node.hero === 0 ? "oop" : node.hero === 1 ? "mid" : "ip",
    flopPot: pot, flopStack: stack, board,
    streets: [node.prefix.map((x) => (x.t === "X" ? "X" : `R${bet}`))],
    streetSeats: [node.prefix.map((x) => ordered[x.seat]!)],
    heroComboIdx: null, rake: RAKE,
  };
}

const done = new Set<string>();
if (existsSync(OUT)) {
  for (const l of readFileSync(OUT, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { done.add(JSON.parse(l).key); } catch { /* partial line */ }
  }
}

for (const board of BOARDS) {
  for (const L of LINES) {
    const rs = await rangesFor(L.tokens);
    if (typeof rs === "string") { console.error(`SKIP ${L.tokens.join("-")}: ${rs}`); continue; }
    const ordered = Object.keys(rs.trueR).sort(
      (a, b) => POSTFLOP_ORDER.indexOf(a.toUpperCase()) - POSTFLOP_ORDER.indexOf(b.toUpperCase()));
    if (ordered.length !== 3) { console.error(`SKIP ${L.tokens.join("-")}: ${ordered.length} seats`); continue; }
    const { pot, stack } = preflopPotStack(L.tokens, 100);
    const mT = rs.trueR[rs.donor]!.reduce((s, x) => s + x, 0);
    const mB = rs.borrowed[rs.donor]!.reduce((s, x) => s + x, 0);
    for (const node of NODES) {
      const key = `${L.tokens.join("-")}|${board}|${node.id}`;
      if (done.has(key)) continue;
      const t0 = Date.now();
      const rec: any = {
        key, src: SRC, line: L.tokens.join("-"), seats: ordered, board, node: node.id, note: node.note,
        pot, stack, donor: rs.donor, hero: ordered[node.hero],
        donorMass: { true: Math.round(mT * 10) / 10, borrowed: Math.round(mB * 10) / 10, ratio: Math.round((mB / Math.max(1e-9, mT)) * 1000) / 1000 },
      };
      const tr = await solveAiChain(specFor(ordered, rs.trueR, node, board, pot, stack));
      const truth = readSolved(tr, board);
      if (!truth) {
        rec.truth = { ok: false, why: tr.ok ? "no actions" : tr.why };
        appendFileSync(OUT, JSON.stringify(rec) + "\n");
        console.error(`  x ${key}: ${rec.truth.why}`);
        continue;
      }
      rec.truth = { ok: true, codes: truth.codes, potNode: truth.potNode, ...score(truth, truth.strat, truth.potNode) };
      const br = await solveAiChain(specFor(ordered, rs.borrowed, node, board, pot, stack));
      const bs = readSolved(br, board);
      const al = bs && align(truth, bs);
      rec.borrowed = al ? { ok: true, ...score(truth, al, truth.potNode) }
        : { ok: false, why: bs ? "menu differs" : (br as any).why ?? "no actions" };
      rec.ms = Date.now() - t0;
      appendFileSync(OUT, JSON.stringify(rec) + "\n");
      console.error(`  ${key} donor=${rs.donor} x${rec.donorMass.ratio} (${rec.ms}ms) ` +
        `${rec.borrowed.ok ? `loss=${rec.borrowed.loss.toFixed(4)} tv=${rec.borrowed.tv.toFixed(3)}` : "x"}`);
    }
  }
}
console.error("done");
