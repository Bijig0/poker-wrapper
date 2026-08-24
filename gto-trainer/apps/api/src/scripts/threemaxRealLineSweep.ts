/**
 * The REAL-LINE study-answer audit: every node stepped through from preflop.
 *
 * The earlier postflop sweeps proved the solve path on synthetic geometry;
 * this one refuses synthesis. Lines are WALKED out of the actual 3-max
 * asymmetric charts (served by :8777, pulled from R2): each step uses a token
 * the tree itself offers, every preflop decision node is answered from the
 * chart, pot/stack at the flop are derived from that exact line, hero's hand
 * is chosen FROM the acting node's own cells (so it provably takes the line's
 * action), and the postflop solve is seeded by ranges reconstructed from the
 * same charts. Preflop and postflop answers therefore share one coherent
 * history — nothing is assumed that the corpus does not state.
 *
 * Per chart state (spanning depths, asymmetry and both rake sites):
 *   SRP  BTN opens (tree's smallest size), SB folds, BB calls
 *   BvB  BTN folds, SB opens, BB calls
 *   3BP  BTN opens, SB folds, BB 3-bets (tree size), BTN calls
 * Preflop: every decision along each line is asked via fastSolve.
 * Postflop: two flops per line, first-to-act and facing a half-pot bet.
 *
 * Run:  bun run src/scripts/threemaxRealLineSweep.ts
 */
import { appendFileSync } from "node:fs";
import { fetchNode, type HrcNode } from "../services/hrc3max";
import { fastSolve } from "../services/fastSolve";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const OUT = `${import.meta.dir}/threemax_realline.jsonl`;

// Depth/asymmetry/site coverage. D110_s90_sb is the chart the replay sweep
// found terminating early — included deliberately.
const CHARTS = [
  "ign200_3maxasym_D100_s100_eq",
  "ign200_3maxasym_D100_s40_bb",
  "ign200_3maxasym_D95_s80_btn",
  "ign200_3maxasym_D110_s90_sb",
  "ign200_3maxasym_D125_s45_bb",
  "ign500_3maxasym_D100_s100_eq",
];

const SEAT: Record<string, number> = { BTN: 1, SB: 2, BB: 3 };
const BOARDS = [["Kc", "7d", "2h"], ["Qs", "8s", "4d"]];

interface LineStep { pos: string; token: string; label: string }

const node = async (chart: string, line: string): Promise<HrcNode | null> => {
  const n = await fetchNode(chart, line);
  return n === "unreachable" ? null : n;
};

/** Smallest non-allin raise the tree offers here. */
const smallestRaise = (n: HrcNode) =>
  n.actions
    .filter((a) => a.token && /^R[\d.]+$/.test(a.token))
    .sort((a, b) => parseFloat(a.token!.slice(1)) - parseFloat(b.token!.slice(1)))[0] ?? null;

/** A hand class that takes `action` here with real frequency (most committed). */
const classTaking = (n: HrcNode, action: string) =>
  n.cells
    .filter((c) => (c.actions[action] ?? 0) >= 50)
    .sort((a, b) => (b.actions[action] ?? 0) - (a.actions[action] ?? 0))[0]?.hand ?? null;

/** Concrete cards for a class, dodging the board. */
function cardsFor(cls: string, board: string[]): string[] {
  const suits = ["h", "c", "d", "s"];
  const mk = (r1: string, s1: string, r2: string, s2: string) => [r1 + s1, r2 + s2];
  for (const s1 of suits) for (const s2 of suits) {
    let pair: string[] | null = null;
    if (cls.length === 2 && cls[0] === cls[1] && s1 !== s2) pair = mk(cls[0]!, s1, cls[1]!, s2);
    else if (cls.endsWith("s") && s1 === s2) pair = mk(cls[0]!, s1, cls[1]!, s2);
    else if (cls.endsWith("o") && s1 !== s2) pair = mk(cls[0]!, s1, cls[1]!, s2);
    if (pair && !board.includes(pair[0]!) && !board.includes(pair[1]!)) return pair;
  }
  throw new Error(`no cards for ${cls}`);
}

/** Stacks implied by the chart id: the named seat is short, the rest deep. */
function stacksOf(chart: string): Record<number, number> {
  const m = chart.match(/D(\d+)_s(\d+)_(eq|sb|bb|btn)/)!;
  const deep = Number(m[1]), short = Number(m[2]), who = m[3];
  const st: Record<number, number> = { 1: deep, 2: deep, 3: deep };
  if (who !== "eq") st[SEAT[who.toUpperCase()]!] = short;
  return st;
}

interface Sim {
  committed: Record<number, number>;
  maxBet: number;
  folded: Set<number>;
  actions: ParsedHand["actions"];
}

function simulate(steps: LineStep[]): Sim {
  const committed: Record<number, number> = { 2: 0.5, 3: 1 };
  let maxBet = 1;
  const folded = new Set<number>();
  const actions: ParsedHand["actions"] = [
    { seatId: 2, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 3, hero: false, type: "post-bb", amount: 1, street: "preflop" },
  ];
  for (const s of steps) {
    const seat = SEAT[s.pos]!;
    if (s.token === "F") {
      folded.add(seat);
      actions.push({ seatId: seat, hero: false, type: "fold", street: "preflop" });
    } else if (s.token === "C") {
      const inc = maxBet - (committed[seat] ?? 0);
      committed[seat] = maxBet;
      actions.push({ seatId: seat, hero: false, type: "call", amount: inc, street: "preflop" });
    } else {
      const to = parseFloat(s.token.slice(1));
      committed[seat] = to;
      maxBet = to;
      actions.push({ seatId: seat, hero: false, type: "raise", amount: to, street: "preflop" });
    }
  }
  return { committed, maxBet, folded, actions };
}

function handAt(
  chart: string, steps: LineStep[], heroPos: string, heroCards: string[],
  extra: { street: ParsedHand["street"]; board: string[]; flopActs?: ParsedHand["actions"]; toCall: number; pot: number }
): ParsedHand {
  const sim = simulate(steps);
  const stacks = stacksOf(chart);
  const heroSeat = SEAT[heroPos]!;
  const remaining: Record<number, number> = {};
  for (const s of [1, 2, 3]) remaining[s] = (stacks[s] ?? 100) - (sim.committed[s] ?? 0);
  const acts = [...sim.actions, ...(extra.flopActs ?? [])].map((a) => ({ ...a, hero: a.seatId === heroSeat }));
  return {
    handId: 1,
    bbCents: chart.startsWith("ign500") ? 500 : 200,
    heroSeatId: heroSeat,
    heroCards,
    board: extra.board,
    street: extra.street,
    actions: acts,
    liveSeats: [1, 2, 3].filter((s) => !sim.folded.has(s)),
    committed: sim.committed,
    potByStreet: {},
    positions: { 1: "BTN", 2: "SB", 3: "BB" },
    stacks: remaining,
    currentNode: {
      street: extra.street, toActSeatId: heroSeat, toActIsHero: true,
      pot: extra.pot, toCall: extra.toCall, legalActions: [], complete: false,
    },
    ended: false,
  };
}

let pfOk = 0, pfBad = 0, postOk = 0, postBad = 0, postApprox = 0;
const rows: any[] = [];

async function preflopAsk(chart: string, steps: LineStep[], k: number): Promise<void> {
  // hero decides step k, having seen steps 0..k-1
  const prefix = steps.slice(0, k);
  const line = prefix.map((s) => s.token).join("-");
  const n = await node(chart, line);
  const step = steps[k]!;
  const row: any = { kind: "preflop", chart, line: line || "(root)", pos: step.pos, take: step.token };
  if (!n || n.terminal || !n.pos) { row.ok = false; row.reason = "node missing/terminal"; pfBad++; rows.push(row); return; }
  const label = n.actions.find((a) => a.token === step.token)?.action;
  const cls = label ? classTaking(n, label) : null;
  if (!cls) { row.ok = false; row.reason = `no class takes ${step.token} >=50%`; pfBad++; rows.push(row); return; }
  const sim = simulate(prefix);
  const heroSeat = SEAT[step.pos]!;
  const hand = handAt(chart, prefix, step.pos, cardsFor(cls, []), {
    street: "preflop", board: [],
    toCall: Math.max(0, sim.maxBet - (sim.committed[heroSeat] ?? 0)),
    pot: Object.values(sim.committed).reduce((a, b) => a + b, 0),
  });
  const sol = await fastSolve(hand, step.pos);
  row.cls = cls;
  row.ok = sol.ok === true && sol.source === "hrc-3max-preflop" && !!sol.decision;
  if (sol.ok) { row.source = sol.source; row.decision = sol.decision?.action; }
  else row.reason = (sol as any).reason;
  row.ok ? pfOk++ : pfBad++;
  rows.push(row);
}

async function postflopAsk(
  chart: string, steps: LineStep[], oop: string, ip: string, board: string[], facing: boolean
): Promise<void> {
  const sim = simulate(steps);
  const pot = Object.values(sim.committed).reduce((a, b) => a + b, 0);
  const heroPos = facing ? ip : oop;
  const heroSeat = SEAT[heroPos]!;
  const villainSeat = SEAT[facing ? oop : ip]!;
  const bet = facing ? Math.round(pot * 50) / 100 : 0;
  // hero's postflop hand: the class that CALLED preflop reaches the flop
  const callerNodeLine = steps.slice(0, steps.length - 1).map((s) => s.token).join("-");
  const cn = await node(chart, callerNodeLine);
  const cls = cn ? classTaking(cn, "Call") : null;
  const row: any = { kind: "postflop", chart, line: steps.map((s) => s.token).join("-"),
                     board: board.join(""), node: facing ? "facing half-pot" : "first to act", pos: heroPos };
  if (!cls) { row.ok = false; row.reason = "no caller class"; postBad++; rows.push(row); return; }
  const flopActs: ParsedHand["actions"] = facing
    ? [{ seatId: villainSeat, hero: false, type: "bet", amount: bet, street: "flop" }]
    : [];
  const hand = handAt(chart, steps, heroPos, cardsFor(cls, board), {
    street: "flop", board, flopActs, toCall: bet, pot: pot + bet,
  });
  // street commitment is flop-local for toCall; committed map stays preflop —
  // fastSolve postflop reads pot/stack from currentNode + stacks, as live.
  const sol = await fastSolve(hand, heroPos);
  row.cls = cls;
  row.ok = sol.ok === true && sol.source === "gtow-api-postflop" && !!sol.actions?.length;
  if (sol.ok) {
    row.source = sol.source;
    row.decision = sol.decision?.action ?? null;
    row.warning = sol.warning ?? null;
    if (sol.warning) postApprox++;
  } else row.reason = (sol as any).reason;
  row.ok ? postOk++ : postBad++;
  rows.push(row);
}

for (const chart of CHARTS) {
  const root = await node(chart, "");
  if (!root) { rows.push({ kind: "chart", chart, ok: false, reason: "root unreachable" }); continue; }
  const open = smallestRaise(root);
  if (!open) { rows.push({ kind: "chart", chart, ok: false, reason: "no raise at root" }); continue; }

  // build the three lines from the tree's own tokens
  const lines: { name: string; steps: LineStep[]; oop: string; ip: string }[] = [];
  lines.push({ name: "srp", oop: "BB", ip: "BTN", steps: [
    { pos: "BTN", token: open.token!, label: open.action },
    { pos: "SB", token: "F", label: "Fold" },
    { pos: "BB", token: "C", label: "Call" },
  ]});
  const bvbNode = await node(chart, "F");
  const bvbOpen = bvbNode && !bvbNode.terminal ? smallestRaise(bvbNode) : null;
  if (bvbOpen) lines.push({ name: "bvb", oop: "SB", ip: "BB", steps: [
    { pos: "BTN", token: "F", label: "Fold" },
    { pos: "SB", token: bvbOpen.token!, label: bvbOpen.action },
    { pos: "BB", token: "C", label: "Call" },
  ]});
  const bbNode = await node(chart, `${open.token}-F`);
  const threebet = bbNode && !bbNode.terminal ? smallestRaise(bbNode) : null;
  if (threebet) lines.push({ name: "3bp", oop: "BB", ip: "BTN", steps: [
    { pos: "BTN", token: open.token!, label: open.action },
    { pos: "SB", token: "F", label: "Fold" },
    { pos: "BB", token: threebet.token!, label: threebet.action },
    { pos: "BTN", token: "C", label: "Call" },
  ]});

  for (const l of lines) {
    console.log(`${chart} ${l.name}: ${l.steps.map((s) => s.token).join("-")}`);
    for (let k = 0; k < l.steps.length; k++) await preflopAsk(chart, l.steps, k);
    for (const board of BOARDS) {
      await postflopAsk(chart, l.steps, l.oop, l.ip, board, false);
      await postflopAsk(chart, l.steps, l.oop, l.ip, board, true);
    }
    console.log(`  so far: preflop ${pfOk}ok/${pfBad}bad, postflop ${postOk}ok/${postBad}bad`);
  }
}

for (const r of rows) appendFileSync(OUT, JSON.stringify(r) + "\n");
console.log(`\nDONE. preflop ${pfOk}/${pfOk + pfBad} · postflop ${postOk}/${postOk + postBad}` +
            ` (${postApprox} with warnings)`);
const bad = rows.filter((r) => !r.ok);
for (const b of bad.slice(0, 15))
  console.log(`  FAIL ${b.kind} ${b.chart} ${b.line ?? ""} ${b.pos ?? ""}: ${b.reason}`);
