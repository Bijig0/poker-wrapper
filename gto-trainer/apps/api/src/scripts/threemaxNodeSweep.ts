/**
 * 1,000 REAL 3-handed study-answer nodes, closest-chart selection included.
 *
 * Each context is a 3-handed table with ARBITRARY, realistic stacks — off the
 * chart rungs on purpose (87.3/104.6/41.9, the way Zone actually deals) — so
 * every ask exercises the same closest-chart reduction the live pipeline
 * runs (chartFor: sort, cap, snap to the rung ladder, keep the short seat's
 * identity). The chart is then WALKED with its own tree tokens: preflop
 * decisions are answered from the HRC 3-max charts (R2-backed via :8777),
 * hero's hand is drawn from the acting node's own cells, and postflop nodes
 * inherit the exact line — pot, stacks and ranges all from one history,
 * solved by the GTO Wizard AI.
 *
 * Line shapes per context (walkable subset): single-raised pot, blind battle,
 * 3-bet pot, SB flat, and the LIMPED pot — the asym trees have real limp
 * branches, the node class the 6-max corpus cannot answer at all.
 *
 * Resumable: rows append to threemax_nodes.jsonl keyed by deterministic ids;
 * rerun to continue. ~125 contexts x ~8 asks each = ~1,000 rows.
 *
 * Run:  bun run src/scripts/threemaxNodeSweep.ts [maxRows]
 */
import { appendFileSync } from "node:fs";
import { chartFor, fetchNode, type HrcNode } from "../services/hrc3max";
import { fastSolve } from "../services/fastSolve";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const OUT = `${import.meta.dir}/threemax_nodes.jsonl`;
const MAX_ROWS = Number(process.argv[2] ?? 1000);
const N_CTX = 140;

// ── deterministic RNG ────────────────────────────────────────────────────────
let seed = 0x3a3a;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;

const SEAT: Record<string, number> = { BTN: 1, SB: 2, BB: 3 };
const POSN = ["BTN", "SB", "BB"];
const RANKS = "23456789TJQKA".split("");
const SUITS = "shdc".split("");

/** Realistic Zone stack: mode near 100, a real short-stack tail, never on a
 *  rung boundary (the .1-.9 fraction is the point — the snap must move it). */
const zoneStack = () => {
  const base = rnd() < 0.25 ? 20 + rnd() * 60 : 60 + rnd() * 90; // short tail
  return Math.round((base + 0.1 + rnd() * 0.8) * 10) / 10;
};

const boardOf = () => {
  const used = new Set<string>();
  while (used.size < 3) used.add(pick(RANKS) + pick(SUITS));
  return [...used];
};

const node = async (chart: string, line: string): Promise<HrcNode | null> => {
  const n = await fetchNode(chart, line);
  return n === "unreachable" ? null : n;
};

const raises = (n: HrcNode) =>
  n.actions.filter((a) => a.token && /^R[\d.]+$/.test(a.token))
    .sort((a, b) => parseFloat(a.token!.slice(1)) - parseFloat(b.token!.slice(1)));
const tokenOf = (n: HrcNode, name: string) =>
  n.actions.find((a) => a.action === name && a.token)?.token ?? null;

// The class MOST inclined to this action — argmax, not a >=50% gate. Mixed
// nodes (rare open sizes, limps) often have no class above 50%, and the gate
// made the harness give up before ever asking the pipeline: 44 of the first
// run's 80 "failures" were this picker, not the study answer.
const classTaking = (n: HrcNode, actionLabel: string) =>
  n.cells.filter((c) => (c.actions[actionLabel] ?? 0) >= 5)
    .sort((a, b) => (b.actions[actionLabel] ?? 0) - (a.actions[actionLabel] ?? 0))[0]?.hand ?? null;

function cardsFor(cls: string, board: string[]): string[] | null {
  for (const s1 of SUITS) for (const s2 of SUITS) {
    let p: string[] | null = null;
    if (cls.length === 2 && cls[0] === cls[1] && s1 !== s2) p = [cls[0]! + s1, cls[1]! + s2];
    else if (cls.endsWith("s") && s1 === s2) p = [cls[0]! + s1, cls[1]! + s2];
    else if (cls.endsWith("o") && s1 !== s2) p = [cls[0]! + s1, cls[1]! + s2];
    if (p && !board.includes(p[0]!) && !board.includes(p[1]!)) return p;
  }
  return null;
}

interface LineStep { pos: string; token: string; label: string }

function simulate(steps: LineStep[]) {
  const committed: Record<number, number> = { 2: 0.5, 3: 1 };
  let maxBet = 1;
  const folded = new Set<number>();
  const actions: ParsedHand["actions"] = [
    { seatId: 2, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 3, hero: false, type: "post-bb", amount: 1, street: "preflop" },
  ];
  for (const s of steps) {
    const seat = SEAT[s.pos]!;
    if (s.token === "F") { folded.add(seat); actions.push({ seatId: seat, hero: false, type: "fold", street: "preflop" }); }
    else if (s.token === "C" && s.label === "Limp") { committed[seat] = maxBet; actions.push({ seatId: seat, hero: false, type: "call", amount: maxBet - 0, street: "preflop" }); }
    else if (s.token === "C" || s.label === "Call") { const inc = maxBet - (committed[seat] ?? 0); committed[seat] = maxBet; actions.push({ seatId: seat, hero: false, type: "call", amount: inc, street: "preflop" }); }
    else if (s.label === "Check") { actions.push({ seatId: seat, hero: false, type: "check", street: "preflop" }); }
    else { const to = parseFloat(s.token.slice(1)); if (Number.isFinite(to)) { committed[seat] = to; maxBet = to; } actions.push({ seatId: seat, hero: false, type: "raise", amount: to, street: "preflop" }); }
  }
  return { committed, maxBet, folded, actions };
}

function handAt(
  stacks: Record<number, number>, bbCents: number, steps: LineStep[], heroPos: string,
  heroCards: string[],
  x: { street: ParsedHand["street"]; board: string[]; flopActs?: ParsedHand["actions"]; toCall: number; pot: number }
): ParsedHand {
  const sim = simulate(steps);
  const heroSeat = SEAT[heroPos]!;
  const remaining: Record<number, number> = {};
  for (const s of [1, 2, 3]) remaining[s] = Math.round(((stacks[s] ?? 100) - (sim.committed[s] ?? 0)) * 10) / 10;
  const acts = [...sim.actions, ...(x.flopActs ?? [])].map((a) => ({ ...a, hero: a.seatId === heroSeat }));
  return {
    handId: 1, bbCents, heroSeatId: heroSeat, heroCards, board: x.board, street: x.street,
    actions: acts, liveSeats: [1, 2, 3].filter((s) => !sim.folded.has(s)),
    committed: sim.committed, potByStreet: {}, positions: { 1: "BTN", 2: "SB", 3: "BB" },
    stacks: remaining,
    currentNode: { street: x.street, toActSeatId: heroSeat, toActIsHero: true,
                   pot: x.pot, toCall: x.toCall, legalActions: [], complete: false },
    ended: false,
  };
}

// ── resume ───────────────────────────────────────────────────────────────────
const done = new Set<string>();
try {
  for (const l of (await Bun.file(OUT).text()).split("\n"))
    if (l.trim()) done.add(JSON.parse(l).id);
} catch {}

let written = done.size;
let pfOk = 0, pfBad = 0, postOk = 0, postBad = 0;
const write = (row: any) => { appendFileSync(OUT, JSON.stringify(row) + "\n"); written++; };

outer:
for (let ci = 0; ci < N_CTX; ci++) {
  if (written >= MAX_ROWS) break;
  seed = 0x3a3a + ci * 9973;
  const stacks: Record<number, number> = { 1: zoneStack(), 2: zoneStack(), 3: zoneStack() };
  const bbCents = rnd() < 0.15 ? 500 : 200;
  const ctx = `c${String(ci).padStart(3, "0")}`;

  // The SAME closest-chart selection the live pipeline runs.
  const probe = handAt(stacks, bbCents, [], "BTN", ["Ah", "Kh"],
                       { street: "preflop", board: [], toCall: 0, pot: 1.5 });
  const chart = chartFor(probe, "BTN");
  const root = await node(chart.id, "");
  if (!root) { write({ id: `${ctx}-chart`, kind: "chart", ctx, chart: chart.id, ok: false, reason: "root unreachable" }); continue; }

  // build walkable lines from the tree's own tokens
  const lines: { name: string; steps: LineStep[]; oop: string; ip: string }[] = [];
  const rs = raises(root);
  const open = rs.length ? pick(rs) : null;
  if (open) {
    lines.push({ name: "srp", oop: "BB", ip: "BTN", steps: [
      { pos: "BTN", token: open.token!, label: open.action },
      { pos: "SB", token: "F", label: "Fold" }, { pos: "BB", token: "C", label: "Call" }]});
    const sbN = await node(chart.id, open.token!);
    if (sbN && !sbN.terminal && tokenOf(sbN, "Call")) {
      lines.push({ name: "sbflat", oop: "SB", ip: "BTN", steps: [
        { pos: "BTN", token: open.token!, label: open.action },
        { pos: "SB", token: "C", label: "Call" }, { pos: "BB", token: "F", label: "Fold" }]});
    }
    const bbN = await node(chart.id, `${open.token}-F`);
    const tb = bbN && !bbN.terminal ? raises(bbN) : [];
    if (tb.length) lines.push({ name: "3bp", oop: "BB", ip: "BTN", steps: [
      { pos: "BTN", token: open.token!, label: open.action },
      { pos: "SB", token: "F", label: "Fold" },
      { pos: "BB", token: pick(tb).token!, label: "Raise" },
      { pos: "BTN", token: "C", label: "Call" }]});
  }
  const bvbN = await node(chart.id, "F");
  const bvbR = bvbN && !bvbN.terminal ? raises(bvbN) : [];
  if (bvbR.length) lines.push({ name: "bvb", oop: "SB", ip: "BB", steps: [
    { pos: "BTN", token: "F", label: "Fold" },
    { pos: "SB", token: pick(bvbR).token!, label: "Raise" }, { pos: "BB", token: "C", label: "Call" }]});
  const limpTok = tokenOf(root, "Limp");
  if (limpTok) {
    const afterLimp = await node(chart.id, limpTok);
    if (afterLimp && !afterLimp.terminal) {
      const sbF = await node(chart.id, `${limpTok}-F`);
      const checkTok = sbF && !sbF.terminal ? (tokenOf(sbF, "Check") ?? tokenOf(sbF, "Call")) : null;
      if (checkTok) lines.push({ name: "limped", oop: "BB", ip: "BTN", steps: [
        { pos: "BTN", token: limpTok, label: "Limp" },
        { pos: "SB", token: "F", label: "Fold" },
        { pos: "BB", token: checkTok, label: "Check" }]});
    }
  }

  const line = lines.length ? pick(lines) : null;
  if (!line) { write({ id: `${ctx}-chart`, kind: "chart", ctx, chart: chart.id, ok: false, reason: "no walkable line" }); continue; }

  // ---- preflop: every decision node along the line -------------------------
  for (let k = 0; k < line.steps.length; k++) {
    const id = `${ctx}-pf${k}`;
    if (done.has(id)) continue;
    if (written >= MAX_ROWS) break outer;
    const prefix = line.steps.slice(0, k);
    const lineStr = prefix.map((s) => s.token).join("-");
    const n = await node(chart.id, lineStr);
    const step = line.steps[k]!;
    const row: any = { id, kind: "preflop", ctx, chart: chart.id,
                       stacks: [stacks[1], stacks[2], stacks[3]], line: lineStr || "(root)",
                       pos: step.pos, take: step.token };
    if (!n || n.terminal || !n.pos) { row.ok = false; row.reason = "node missing/terminal"; pfBad++; write(row); continue; }
    const label = n.actions.find((a) => a.token === step.token)?.action ?? step.label;
    const cls = classTaking(n, label);
    const cards = cls ? cardsFor(cls, []) : null;
    if (!cls || !cards) { row.ok = false; row.reason = `no class takes ${label}`; pfBad++; write(row); continue; }
    const sim = simulate(prefix);
    const heroSeat = SEAT[step.pos]!;
    const hand = handAt(stacks, bbCents, prefix, step.pos, cards, {
      street: "preflop", board: [],
      toCall: Math.max(0, sim.maxBet - (sim.committed[heroSeat] ?? 0)),
      pot: Object.values(sim.committed).reduce((a, b) => a + b, 0),
    });
    try {
      const sol = await fastSolve(hand, step.pos);
      row.cls = cls;
      row.solvedChart = (sol as any).gametype ?? null;
      row.ok = sol.ok === true && sol.source === "hrc-3max-preflop" && !!sol.decision;
      if (!row.ok) row.reason = (sol as any).reason ?? `source=${(sol as any).source}`;
      else row.decision = sol.decision?.action;
    } catch (e) { row.ok = false; row.reason = String((e as Error)?.message).slice(0, 160); }
    row.ok ? pfOk++ : pfBad++;
    write(row);
  }

  // ---- postflop: two flops x (first-to-act, facing half-pot) --------------
  const sim = simulate(line.steps);
  const pot = Math.round(Object.values(sim.committed).reduce((a, b) => a + b, 0) * 10) / 10;
  const callerLine = line.steps.slice(0, -1).map((s) => s.token).join("-");
  const cn = await node(chart.id, callerLine);
  const lastLabel = line.steps[line.steps.length - 1]!.label;
  const cls = cn ? classTaking(cn, lastLabel === "Check" ? "Check" : "Call") : null;
  for (let bi = 0; bi < 2; bi++) {
    const board = boardOf();
    for (const facing of [false, true]) {
      const id = `${ctx}-po${bi}${facing ? "f" : "x"}`;
      if (done.has(id)) continue;
      if (written >= MAX_ROWS) break outer;
      const heroPos = facing ? line.ip : line.oop;
      const villainSeat = SEAT[facing ? line.oop : line.ip]!;
      const bet = facing ? Math.round(pot * 50) / 100 : 0;
      const row: any = { id, kind: "postflop", ctx, chart: chart.id,
                         stacks: [stacks[1], stacks[2], stacks[3]],
                         line: line.steps.map((s) => s.token).join("-"), lineName: line.name,
                         board: board.join(""), node: facing ? "facing" : "first", pos: heroPos };
      const cards = cls ? cardsFor(cls, board) : null;
      if (!cls || !cards) { row.ok = false; row.reason = "no flop-reaching class"; postBad++; write(row); continue; }
      const hand = handAt(stacks, bbCents, line.steps, heroPos, cards, {
        street: "flop", board,
        flopActs: facing ? [{ seatId: villainSeat, hero: false, type: "bet", amount: bet, street: "flop" }] : [],
        toCall: bet, pot: pot + bet,
      });
      try {
        const sol = await fastSolve(hand, heroPos);
        row.cls = cls;
        row.ok = sol.ok === true && sol.source === "gtow-api-postflop" && !!sol.actions?.length;
        if (row.ok) { row.decision = sol.decision?.action ?? null; row.warning = sol.warning ?? null; }
        else row.reason = (sol as any).reason ?? `source=${(sol as any).source}`;
      } catch (e) { row.ok = false; row.reason = String((e as Error)?.message).slice(0, 160); }
      row.ok ? postOk++ : postBad++;
      write(row);
    }
  }
  if (ci % 5 === 4)
    console.log(`${written} rows (${ci + 1} ctx): preflop ${pfOk}ok/${pfBad}bad · postflop ${postOk}ok/${postBad}bad`);
}

console.log(`DONE this run: ${written} total rows · preflop ${pfOk}/${pfOk + pfBad} · postflop ${postOk}/${postOk + postBad}`);
