/**
 * stressPostflopSweep — a generated 3-, 4- and 5-way POSTFLOP stress sweep for the 6-max ring strategy (2026-09-24,
 * Brady: "do all the situations, flop, turns, rivers, check-raises, bets, folds in different positions").
 *
 * Every spot is generated, not hand-written: pot type (single-raised / limped / 3-bet) × hero's seat (first to act,
 * middle, last) × street (flop / turn / river) × the action hero faces (checked to, facing a bet, facing a bet and
 * calls, facing a check-raise after betting, facing a bet after checking = the check-raise decision, a fold that
 * thins the field mid-street, facing a jam). Pot and bet sizes are tracked so every bet is a real fraction of the
 * real pot. Boards are dealt from one deck with hero's cards removed, and every spot is checked for duplicate cards.
 *
 * Beyond the stressSixMax grader (seat, empty mix, all-zero mix, sum) each answer is checked for LEGALITY against
 * what hero actually faces: facing a bet → a fold and a call must be offered and no check; checked to → a check must
 * be offered and no fold. The path that answered (exact 3-way tree, collapse, blend, re-root, last resort) is tallied.
 *
 *   bun src/scripts/stressPostflopSweep.ts --ways 3            # one field size
 *   bun src/scripts/stressPostflopSweep.ts --ways 3,4,5 --out x.json
 *   bun src/scripts/stressPostflopSweep.ts --list              # print the generated spots, solve nothing
 */
import { writeFileSync } from "node:fs";
import type { FastSolveResult } from "../services/fastSolve";
import type { ParsedHand, ParsedAction, Street } from "../feed/parsePanelFeed/parsePanelFeed";

const STRATEGY = "ign200-ring-6max-equilibrium";
const ORDER = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;
type Pos = (typeof ORDER)[number];
type Act = [Pos, "f" | "c" | "x" | "r", number?];

interface SpotSpec {
  id: string;
  family: string;
  /** what makes this one hard — printed next to the grade */
  note: string;
  /** every seat dealt in, with its starting stack in bb; seats omitted are not at the table */
  stacks: Partial<Record<Pos, number>>;
  hero: Pos;
  cards: [string, string];
  /** preflop actions after the blinds, in order */
  pre: Act[];
  /** flop / turn / river cards, when the spot is postflop */
  board?: string[];
  /** postflop actions per street, in order, up to hero's pending decision */
  flop?: Act[];
  turn?: Act[];
  river?: Act[];
}

// --------------------------------------------------------------------------- the table

/**
 * Build the ParsedHand the live path would have seen.
 *
 * The two fields worth getting right, because everything downstream reads them: `committed` is
 * what a seat has put in ON THE CURRENT STREET and `stacks` is what it has BEHIND — the AI preflop
 * shape adds them back together to recover the starting stack, and the chart picker reads stacks as
 * dealt. A raise's `amount` is the TOTAL it makes it, a call's is the INCREMENT, which is what
 * buildPreflopTokens and lineOf both expect.
 */
function buildHand(s: SpotSpec): { hand: ParsedHand; heroPos: Pos } {
  // A FIXTURE THAT DEALS ONE CARD TWICE IS A BUG IN THIS FILE, NOT A SPOT (2026-09-24, multi-07): the API now
  // refuses it as a capture fault, but that reads like a strategy hole in the report. Fail loudly here first.
  {
    const dealt = [s.cards[0], s.cards[1], ...(s.board ?? [])];
    const twice = dealt.find((c, i) => dealt.indexOf(c) !== i);
    if (twice) throw new Error(`${s.id}: fixture deals ${twice} twice (hero ${s.cards.join("")}, board ${(s.board ?? []).join(" ") || "none"})`);
  }
  const seats = ORDER.filter((p) => s.stacks[p] != null);
  const seatId: Record<string, number> = {};
  seats.forEach((p, i) => { seatId[p] = i + 1; });
  const positions: Record<number, string> = {};
  for (const p of seats) positions[seatId[p]!] = p;

  const behind: Record<number, number> = {};
  for (const p of seats) behind[seatId[p]!] = s.stacks[p]!;
  const actions: ParsedAction[] = [];
  const folded = new Set<number>();
  const potByStreet: Partial<Record<Street, number>> = {};

  // --- blinds ---
  const post = (p: Pos, type: "post-sb" | "post-bb", amt: number) => {
    const id = seatId[p];
    if (id == null) return;
    behind[id]! -= amt;
    actions.push({ seatId: id, hero: p === s.hero, type, amount: amt, street: "preflop" });
  };
  let invested: Record<number, number> = {};
  const put = (id: number, amt: number) => { invested[id] = (invested[id] ?? 0) + amt; };
  if (seatId.SB != null) { post("SB", "post-sb", 0.5); put(seatId.SB, 0.5); }
  if (seatId.BB != null) { post("BB", "post-bb", 1); put(seatId.BB, 1); }

  // --- one street of action ---
  const play = (street: Street, acts: Act[]) => {
    for (const [pos, t, to] of acts) {
      const id = seatId[pos];
      if (id == null) throw new Error(`${s.id}: ${pos} is not at the table`);
      const have = invested[id] ?? 0;
      const high = Math.max(0, ...Object.values(invested));
      if (t === "f") { folded.add(id); actions.push({ seatId: id, hero: pos === s.hero, type: "fold", street }); continue; }
      if (t === "x") { actions.push({ seatId: id, hero: pos === s.hero, type: "check", street }); continue; }
      if (t === "c") {
        const inc = Math.min(high - have, behind[id]!);
        behind[id]! -= inc; put(id, inc);
        actions.push({ seatId: id, hero: pos === s.hero, type: "call", amount: Math.round(inc * 100) / 100, street });
        continue;
      }
      const total = to!;
      const inc = Math.min(total - have, behind[id]!);
      behind[id]! -= inc; put(id, inc);
      actions.push({ seatId: id, hero: pos === s.hero, type: street === "preflop" ? "raise" : have > 0 || high > 0 ? "raise" : "bet", amount: total, street });
    }
  };

  play("preflop", s.pre);
  let street: Street = "preflop";
  if (s.board?.length) {
    potByStreet.preflop = Object.values(invested).reduce((a, b) => a + b, 0);
    invested = {};
    street = "flop";
    if (s.flop) play("flop", s.flop);
    if ((s.board.length >= 4)) {
      potByStreet.flop = (potByStreet.flop ?? 0) + Object.values(invested).reduce((a, b) => a + b, 0);
      invested = {}; street = "turn";
      if (s.turn) play("turn", s.turn);
    }
    if (s.board.length >= 5) {
      potByStreet.turn = (potByStreet.turn ?? 0) + Object.values(invested).reduce((a, b) => a + b, 0);
      invested = {}; street = "river";
      if (s.river) play("river", s.river);
    }
  }

  const streetIn = Object.values(invested).reduce((a, b) => a + b, 0);
  const priorPot = Object.values(potByStreet).reduce((a, b) => a + (b ?? 0), 0);
  const heroId = seatId[s.hero]!;
  const high = Math.max(0, ...Object.values(invested));
  const committed: Record<number, number> = {};
  for (const p of seats) committed[seatId[p]!] = invested[seatId[p]!] ?? 0;

  const hand: ParsedHand = {
    handId: 1,
    clientHandId: `stress-${s.id}${Bun.argv.includes("--fresh") ? `-${Date.now()}` : ""}`,
    bbCents: 200,
    heroSeatId: heroId,
    heroCards: [s.cards[0], s.cards[1]],
    board: s.board ?? [],
    street,
    actions,
    liveSeats: seats.map((p) => seatId[p]!).filter((id) => !folded.has(id)),
    committed,
    potByStreet,
    positions,
    stacks: behind,
    currentNode: {
      street,
      toActSeatId: heroId,
      toActIsHero: true,
      pot: Math.round((priorPot + streetIn) * 100) / 100,
      toCall: Math.round(Math.max(0, high - (invested[heroId] ?? 0)) * 100) / 100,
      legalActions: [],
      complete: false,
    },
    ended: false,
  };
  return { hand, heroPos: s.hero };
}

const APPROX_MARKERS: [RegExp, string][] = [
  [/OFF-TREE SIZE/i, "size snapped past τ"],
  [/CALLER CAP/i, "caller borrowed"],
  [/LINE FITTED/i, "line fitted"],
  [/snapped to the tree's sizes/i, "size snapped (clean)"],
  [/collapsed to three/i, "field collapsed to 3"],
  [/RE-ROOTED/i, "re-rooted"],
  [/blended \d+ collapses/i, "collapses blended"],
  [/borrowed/i, "range borrowed"],
  [/answered from/i, "chart fallback"],
  [/dead SB approximated/i, "dead SB modelled"],
  [/past the .*rung|beyond/i, "past the ladder"],
  [/POSTFLOP LAST RESORT/i, "postflop last resort (hero vs aggressor)"],
  [/LAST RESORT/i, "last resort (hero vs aggressor)"],
  [/GTO Wizard AI preflop/i, "answered by AI preflop"],
];

type Grade = "clean" | "approx" | "degenerate" | "FAILED";

function grade(r: FastSolveResult, heroPos: string): { grade: Grade; why: string; flags: string[] } {
  if (!r.ok) return { grade: "FAILED", why: r.reason, flags: [] };
  const flags = APPROX_MARKERS.filter(([re]) => re.test(r.warning ?? "")).map(([, name]) => name);
  const sum = r.actions.reduce((s, a) => s + a.frequency, 0);
  // THE ANSWER MUST BE HERO'S. A mix can be perfectly believable and still belong to another seat — the
  // limp charts' post-iso rotation did exactly that on 2026-09-22 and this grader called it "clean",
  // which is how it survived a 45-spot run unnoticed. Check the seat before anything else.
  if (r.pos && String(r.pos).toUpperCase() !== heroPos.toUpperCase()) {
    return { grade: "degenerate", why: `answered from ${r.pos}'s node, but hero is ${heroPos} — WRONG SEAT`, flags };
  }
  if (!r.actions.length) return { grade: "degenerate", why: "the node offered no actions", flags };
  // notInRange before "no decision": a not-in-range answer has no decision by construction, and the old order
  // reported multi-07's all-zero mix as "actions but no decision rolled" — true, but not the cause.
  if (r.notInRange) return { grade: "degenerate", why: `equilibrium never reaches this node with ${r.heroClass}`, flags };
  if (!r.decision) return { grade: "degenerate", why: "actions but no decision rolled", flags };
  if (r.actions.every((a) => a.frequency <= 0)) return { grade: "degenerate", why: "every action at 0% — an all-zero mix", flags };
  if (sum < 95 || sum > 105) return { grade: "degenerate", why: `frequencies sum to ${sum.toFixed(1)}, not 100`, flags };
  // "answered by AI preflop" is not an approximation — it is the fallback piece doing its job.
  const real = flags.filter((f) => f !== "answered by AI preflop");
  return { grade: real.length ? "approx" : "clean", why: r.decision.action, flags };
}

// --------------------------------------------------------------------------- run

interface Row {
  id: string; family: string; note: string; score: number; band: string; drivers: string[];
  ok: boolean; grade: Grade; why: string; flags: string[];
  source?: string; tier?: string; pick?: string; mix?: string; ms: number;
  gametype?: string; line?: string; warning?: string | null;
}

/**
 * Ask the running API. `heroPos` is passed explicitly because a synthetic hand has no blind-post
 * history for seats that folded pre-blind, and `strategyId` because this harness declares no
 * session — without it the cascade would pick a different preflop piece entirely.
 */
let lastTrace: string | null = null;
/** --trace: print the answer's own timeline (X-Answer-Trace) entries that took over 300 ms */
function printTrace(): void {
  if (!lastTrace) return;
  try {
    const t = JSON.parse(lastTrace) as any;
    const evs: any[] = Array.isArray(t) ? t : t.trace ?? t.events ?? t.spans ?? [];
    let prev = 0;
    for (const e of evs) {
      const at = Number(e.at ?? 0), ms = Number(e.ms ?? 0);
      const gap = at - prev; prev = Math.max(prev, at + ms);
      if (ms >= 300 || gap >= 300) console.log(`     trace at ${String(at).padStart(6)}  ${gap >= 300 ? `(+${gap}ms gap) ` : ""}${ms ? `${ms}ms ` : ""}${String(e.ev ?? "?")}  ${String(e.info ?? "").slice(0, 110)}`);
    }
    if (!evs.length || process.env.SWEEP_TRACE_RAW) console.log(`     trace raw: ${lastTrace.slice(0, 2500)}`);
  } catch { console.log(`     trace (unparsed): ${lastTrace.slice(0, 400)}`); }
}

async function solveVia(api: string, hand: ParsedHand, heroPos: Pos, timeoutMs = 180_000): Promise<FastSolveResult> {
  let res: Response;
  try {
    res = await fetch(`${api}/api/fast-solver`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hand, heroPos, strategyId: STRATEGY, origin: "adhoc" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, reason: `harness: ${e instanceof Error ? e.message : String(e)}` };
  }
  lastTrace = res.headers.get("x-answer-trace");
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok || !body?.ok) return { ok: false, reason: `api ${res.status}: ${body?.error ?? "no body"}` };
  if (body.deferred) return { ok: false, reason: `the API says it is not hero's turn: ${body.deferred}` };
  if (!body.solution) return { ok: false, reason: "the API returned no solution object" };
  return body.solution as FastSolveResult;
}

// --------------------------------------------------------------------------- the generator

const arg = (k: string, d?: string) => { const i = Bun.argv.indexOf(k); return i >= 0 ? Bun.argv[i + 1] : d; };
const POST_ORDER: Pos[] = ["SB", "BB", "UTG", "HJ", "CO", "BTN"];
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Preflop lines per field size and pot type; every seat is dealt 100bb, the ones not in the line fold. */
const PREFLOP: Record<number, Record<string, Act[]>> = {
  3: {
    srp: [["UTG", "f"], ["HJ", "f"], ["CO", "r", 2.5], ["BTN", "c"], ["SB", "f"], ["BB", "c"]],
    limp: [["UTG", "f"], ["HJ", "f"], ["CO", "f"], ["BTN", "c"], ["SB", "c"], ["BB", "x"]],
    "3bet": [["UTG", "f"], ["HJ", "f"], ["CO", "r", 2.5], ["BTN", "r", 8], ["SB", "f"], ["BB", "c"], ["CO", "c"]],
  },
  4: {
    srp: [["UTG", "f"], ["HJ", "r", 2.5], ["CO", "c"], ["BTN", "c"], ["SB", "f"], ["BB", "c"]],
    limp: [["UTG", "f"], ["HJ", "f"], ["CO", "c"], ["BTN", "c"], ["SB", "c"], ["BB", "x"]],
    "3bet": [["UTG", "f"], ["HJ", "r", 2.5], ["CO", "c"], ["BTN", "r", 10], ["SB", "f"], ["BB", "c"], ["HJ", "c"], ["CO", "c"]],
  },
  5: {
    srp: [["UTG", "r", 2.5], ["HJ", "c"], ["CO", "f"], ["BTN", "c"], ["SB", "c"], ["BB", "c"]],
    limp: [["UTG", "c"], ["HJ", "c"], ["CO", "f"], ["BTN", "c"], ["SB", "c"], ["BB", "x"]],
    "3bet": [["UTG", "r", 2.5], ["HJ", "c"], ["CO", "c"], ["BTN", "r", 11], ["SB", "f"], ["BB", "c"], ["UTG", "c"], ["HJ", "c"], ["CO", "c"]],
  },
};

/** Chips each seat put in preflop, replaying the line (blinds posted). */
function preflopMoney(pre: Act[]): Record<string, number> {
  const put: Record<string, number> = { SB: 0.5, BB: 1 };
  let level = 1;
  for (const [p, t, to] of pre) {
    if (t === "c") put[p] = level;
    else if (t === "r") { put[p] = to!; level = to!; }
  }
  return put;
}

type Pattern = "checked-to" | "facing-bet" | "facing-bet-calls" | "fold-thins" | "xr-decision" | "faces-checkraise" | "facing-raise" | "facing-jam";
type History = "x-around" | "bet-called" | "bet-one-folds";
interface StreetState { players: Pos[]; hero: Pos; pot: number; behind: Record<string, number> }
interface Ctx { level: number; mine: number; heroTurns: number; bets: number; idx: number; firstToAct: Pos }
type Decide = (p: Pos, c: Ctx) => Act | "STOP" | null;

/**
 * Play one street by simulation: a turn pointer over the live seats; the round ends when every live seat has acted
 * and matched. `decide` picks each action; for hero it returns "STOP" at the decision under test. Returns the actions
 * up to hero's decision (or the whole street when stopAtHero is false), or null when the pattern cannot reach it.
 */
function playStreet(st: StreetState, decide: Decide, stopAtHero: boolean): { acts: Act[]; folded: Pos[]; put: Record<string, number> } | null {
  const live = st.players.slice();
  const put: Record<string, number> = {};
  const acts: Act[] = [];
  const folded: Pos[] = [];
  let level = 0, bets = 0, heroTurns = 0;
  let need = new Set<Pos>(live);
  let seat: Pos = live[0]!;
  for (let guard = 0; guard < 80; guard++) {
    if (!need.size) return stopAtHero ? null : { acts, folded, put };
    const p = seat;
    const at = live.indexOf(p);
    const nextSeat = () => live[(live.indexOf(p) + 1) % live.length]!;
    if (!need.has(p)) { seat = nextSeat(); continue; }
    const mine = put[p] ?? 0;
    const a = decide(p, { level, mine, heroTurns, bets, idx: at, firstToAct: st.players[0]! });
    if (p === st.hero) heroTurns++;
    if (a === "STOP") return stopAtHero ? { acts, folded, put } : null;
    if (a === null) return null;
    const t = a[1];
    if (t === "x" && level > mine) return null;
    if (t === "c" && level <= mine) return null;
    // a bet or raise never exceeds the actor's stack: past it, it is an all-in for what is left
    const act: Act = t === "r" ? [p, "r", r2(Math.min(a[2]!, st.behind[p]!))] : a;
    if (t === "r" && act[2]! <= level) return null;
    acts.push(act);
    need.delete(p);
    if (t === "f") {
      folded.push(p);
      const nxt = live[(at + 1) % live.length]!;
      live.splice(at, 1);
      seat = nxt;
      continue;
    }
    if (t === "c") put[p] = Math.min(level, st.behind[p]!);
    if (t === "r") {
      const tot = act[2]!;
      put[p] = tot; level = tot; bets++;
      need = new Set(live.filter((q) => q !== p && st.behind[q]! - (put[q] ?? 0) > 0));
    }
    seat = nextSeat();
  }
  return null;
}

const betOf = (pot: number, f: number) => r2(Math.max(1, pot * f));

/** The decision-street policies. */
function policy(pat: Pattern, st: StreetState): Decide {
  const P = st.pot, hero = st.hero;
  let foldedOne = false;
  return (p, c) => {
    const isHero = p === hero;
    switch (pat) {
      case "checked-to":
        return isHero ? "STOP" : [p, "x"];
      case "facing-bet":
        if (isHero) return c.level > 0 ? "STOP" : null;
        return c.level === 0 ? [p, "r", betOf(P, 0.5)] : [p, "f"];
      case "facing-bet-calls":
        if (isHero) return c.level > 0 ? "STOP" : null;
        return c.level === 0 ? [p, "r", betOf(P, 0.33)] : [p, "c"];
      case "fold-thins":
        // a big bet, the NEXT seat folds, everyone else calls: the field thins mid-street before hero acts
        if (isHero) return c.level > 0 && foldedOne ? "STOP" : null;
        if (c.level === 0) return [p, "r", betOf(P, 0.75)];
        if (!foldedOne) { foldedOne = true; return [p, "f"]; }
        return [p, "c"];
      case "xr-decision":
        // hero checks, a later seat bets, the rest call: hero's check-raise / call / fold decision
        if (isHero) return c.heroTurns === 0 ? (c.level === 0 ? [p, "x"] : null) : (c.level > c.mine ? "STOP" : null);
        if (c.level === 0) return c.heroTurns > 0 ? [p, "r", betOf(P, 0.5)] : [p, "x"];
        return [p, "c"];
      case "faces-checkraise":
        // checked to hero, hero bets, the seats behind call, the first seat check-raises, the seats between fold
        if (isHero) return c.heroTurns === 0 ? (c.level === 0 ? [p, "r", betOf(P, 0.5)] : null) : (c.level > c.mine ? "STOP" : null);
        if (c.level === 0) return [p, "x"];
        if (c.bets === 1 && p === c.firstToAct) return [p, "r", r2(betOf(P, 0.5) * 3)];
        return c.bets === 1 ? [p, "c"] : [p, "f"];
      case "facing-raise":
        // a bet and a raise in front of hero, anyone else folds
        if (isHero) return c.bets === 2 ? "STOP" : null;
        if (c.level === 0) return [p, "r", betOf(P, 0.5)];
        if (c.bets === 1) return [p, "r", r2(betOf(P, 0.5) * 3)];
        return [p, "f"];
      case "facing-jam":
        if (isHero) return c.level > 0 ? "STOP" : null;
        return c.level === 0 ? [p, "r", r2(st.behind[p]!)] : [p, "f"];
    }
  };
}

/** Earlier-street policies: how the field reaches the decision street. */
function historyPolicy(h: History, st: StreetState): Decide {
  const P = st.pot;
  const last = st.players[st.players.length - 1]!;
  return (p, c) => {
    if (h === "x-around") return [p, "x"];
    if (c.level === 0) return [p, "r", betOf(P, 0.33)];
    if (h === "bet-one-folds" && p === last && p !== st.hero) return [p, "f"];
    return [p, "c"];
  };
}

const FLOPS = [["Kd", "7c", "2h"], ["Jh", "Ts", "9h"], ["7d", "7s", "4c"], ["Qh", "8h", "4h"], ["5c", "3d", "2s"], ["Ac", "9d", "6s"], ["Td", "8c", "6d"], ["Ks", "Qd", "Jc"]];
const TURNS = ["3s", "Ah", "8d", "2c", "Kc", "9s", "Jd", "4d"];
const RIVERS = ["6h", "Qc", "5s", "Th", "2d", "7h", "3c", "As"];
const HANDS: [string, string][] = [["Ah", "Kd"], ["Qs", "Qc"], ["9c", "8c"], ["Jd", "Tc"], ["7h", "6h"], ["Ad", "5d"], ["Kh", "Qh"], ["6c", "5c"], ["As", "Js"], ["Tc", "9c"], ["8s", "8d"], ["Kc", "Jc"]];

const PATTERNS: Pattern[] = ["checked-to", "facing-bet", "facing-bet-calls", "fold-thins", "xr-decision", "faces-checkraise", "facing-raise"];
const POTS = ["srp", "limp", "3bet"];
const SLOTS = ["first", "middle", "last"] as const;

interface GenSpot extends SpotSpec { ways: number; street: Street; pattern: Pattern; slot: string; pot: string; history: string; toCallExpected: number; left: number }

function generate(ways: number): GenSpot[] {
  const out: GenSpot[] = [];
  let k = 0;
  for (const street of ["flop", "turn", "river"] as Street[]) {
    const pats: Pattern[] = street === "river" ? [...PATTERNS, "facing-jam"] : PATTERNS;
    for (const pat of pats) {
      // round-robin the pot type and hero's seat; when a pattern cannot reach this seat, try the next combination
      let made = false;
      for (let t = 0; t < 9 && !made; t++) {
        const pot = POTS[(k + t) % 3]!;
        const slot = SLOTS[(k + Math.floor(t / 3) + t) % 3]!;
        const pre = PREFLOP[ways]![pot]!;
        const money = preflopMoney(pre);
        const inHand = POST_ORDER.filter((p) => !pre.some(([q, a]) => q === p && a === "f"));
        if (inHand.length !== ways) throw new Error(`preflop ${ways}/${pot} leaves ${inHand.length} in`);
        const hero = slot === "first" ? inHand[0]! : slot === "last" ? inHand[inHand.length - 1]! : inHand[Math.floor(inHand.length / 2)]!;
        const behind: Record<string, number> = {};
        for (const p of POST_ORDER) behind[p] = r2(100 - (money[p] ?? 0));
        let potNow = r2(Object.values(money).reduce((a, b) => a + b, 0));
        const flop = FLOPS[k % FLOPS.length]!;
        const board = [...flop, ...(street !== "flop" ? [TURNS[k % TURNS.length]!] : []), ...(street === "river" ? [RIVERS[k % RIVERS.length]!] : [])];
        if (new Set(board).size !== board.length) continue;
        const cards = HANDS.map((_, j) => HANDS[(k + j) % HANDS.length]!).find((h) => !h.some((c) => board.includes(c)))!;
        let players = inHand.slice();
        const hist: History[] = street === "flop" ? [] : street === "turn" ? [k % 2 ? "x-around" : "bet-called"]
          : [k % 2 ? "bet-called" : "x-around", k % 3 === 0 ? "bet-one-folds" : "bet-called"];
        const streetActs: Act[][] = [];
        let ok = true;
        for (const h of hist) {
          const st: StreetState = { players, hero, pot: potNow, behind: { ...behind } };
          const res = playStreet(st, historyPolicy(h, st), false);
          if (!res) { ok = false; break; }
          streetActs.push(res.acts);
          for (const [p, v] of Object.entries(res.put)) { behind[p] = r2(behind[p]! - v); potNow = r2(potNow + v); }
          players = players.filter((p) => !res.folded.includes(p));
        }
        if (!ok || !players.includes(hero)) continue;
        const st: StreetState = { players, hero, pot: potNow, behind: { ...behind } };
        const res = playStreet(st, policy(pat, st), true);
        if (!res) continue;
        const level = Math.max(0, ...Object.values(res.put));
        const toCall = r2(Math.min(level - (res.put[hero] ?? 0), behind[hero]!));
        const left = players.length - res.folded.length;
        const stacks: Partial<Record<Pos, number>> = {};
        for (const p of ORDER) stacks[p] = 100;
        out.push({
          id: `w${ways}-${street}-${pat}`, family: `${ways}-way`, ways, street, pattern: pat, slot, pot, left,
          history: hist.join(" / ") || "—",
          note: `${ways}-way ${pot} pot, ${street}, hero ${hero} (${slot} to act), ${pat}${hist.length ? `; earlier streets: ${hist.join(" / ")}` : ""}; ${left} still in`,
          stacks, hero, cards, pre, board,
          ...(street === "flop" ? { flop: res.acts } : { flop: streetActs[0] }),
          ...(street === "turn" ? { turn: res.acts } : street === "river" ? { turn: streetActs[1] } : {}),
          ...(street === "river" ? { river: res.acts } : {}),
          toCallExpected: toCall,
        });
        made = true;
      }
      if (!made) console.error(`(no reachable seat for ${ways}-way ${street} ${pat})`);
      k++;
    }
  }
  return out;
}

// --------------------------------------------------------------------------- hand-built edge spots (--edge)
// Side pots after an all-in, and multiway postflop 3-bets / 4-bets. Hand-built because they need uneven stacks and
// raise wars the generator's policies do not make. Every amount is a street TOTAL, the way buildHand reads "r".

const S100: Partial<Record<Pos, number>> = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };
const withStacks = (x: Partial<Record<Pos, number>>) => ({ ...S100, ...x });
const SRP3: Act[] = [["UTG", "f"], ["HJ", "f"], ["CO", "r", 2.5], ["BTN", "c"], ["SB", "f"], ["BB", "c"]];
const SRP4: Act[] = [["UTG", "f"], ["HJ", "r", 2.5], ["CO", "c"], ["BTN", "c"], ["SB", "f"], ["BB", "c"]];
const SRP5: Act[] = [["UTG", "r", 2.5], ["HJ", "c"], ["CO", "f"], ["BTN", "c"], ["SB", "c"], ["BB", "c"]];
const LIMP3: Act[] = [["UTG", "f"], ["HJ", "f"], ["CO", "f"], ["BTN", "c"], ["SB", "c"], ["BB", "x"]];
const LIMP4: Act[] = [["UTG", "f"], ["HJ", "f"], ["CO", "c"], ["BTN", "c"], ["SB", "c"], ["BB", "x"]];
const LIMP5: Act[] = [["UTG", "c"], ["HJ", "c"], ["CO", "f"], ["BTN", "c"], ["SB", "c"], ["BB", "x"]];

interface EdgeSpec extends SpotSpec { ways: number; street: Street; pattern: string }
const EDGE: EdgeSpec[] = [
  // ---- side pots
  { id: "sp-3w-jam-call", family: "side-pot", ways: 3, street: "flop", pattern: "facing a short jam and a call (no side pot yet)",
    note: "3-way SRP flop: BTN (30bb) jams over CO's bet, BB calls — hero CO facing the jam and the call",
    stacks: withStacks({ BTN: 30 }), hero: "CO", cards: ["Ah", "Kc"], pre: SRP3, board: ["Kd", "7c", "2h"],
    flop: [["BB", "x"], ["CO", "r", 5], ["BTN", "r", 27.5], ["BB", "c"]] },
  { id: "sp-3w-jam-overraise", family: "side-pot", ways: 3, street: "flop", pattern: "short jam, then a raise over it: a SIDE POT",
    note: "3-way SRP flop: BTN (30bb) jams, BB raises to 70 over it — hero CO facing 70 with a side pot",
    stacks: withStacks({ BTN: 30 }), hero: "CO", cards: ["Qs", "Qc"], pre: SRP3, board: ["Kd", "7c", "2h"],
    flop: [["BB", "x"], ["CO", "r", 5], ["BTN", "r", 27.5], ["BB", "r", 70]] },
  { id: "sp-4w-turn-allin-sits", family: "side-pot", ways: 4, street: "turn", pattern: "a player all-in from the flop sits out the turn betting",
    note: "4-way SRP: CO (20bb) jammed the flop, three called; turn BB checks, HJ bets 20 — hero BTN, side pot live",
    stacks: withStacks({ CO: 20 }), hero: "BTN", cards: ["As", "Js"], pre: SRP4, board: ["Jh", "Ts", "9h", "3s"],
    flop: [["BB", "x"], ["HJ", "r", 4], ["CO", "r", 17.5], ["BTN", "c"], ["BB", "c"], ["HJ", "c"]],
    turn: [["BB", "x"], ["HJ", "r", 20]] },
  { id: "sp-4w-river-allin-checked", family: "side-pot", ways: 4, street: "river", pattern: "checked to hero with an all-in player in the hand",
    note: "4-way SRP: CO (20bb) all-in on the flop; turn checked through; river BB and HJ check — hero BTN",
    stacks: withStacks({ CO: 20 }), hero: "BTN", cards: ["8c", "7c"], pre: SRP4, board: ["Jh", "Ts", "9h", "3s", "2d"],
    flop: [["BB", "x"], ["HJ", "r", 4], ["CO", "r", 17.5], ["BTN", "c"], ["BB", "c"], ["HJ", "c"]],
    turn: [["BB", "x"], ["HJ", "x"], ["BTN", "x"]], river: [["BB", "x"], ["HJ", "x"]] },
  { id: "sp-5w-two-allins", family: "side-pot", ways: 5, street: "flop", pattern: "two all-ins at different sizes: two side pots",
    note: "5-way SRP flop: SB (25bb) jams, BB (40bb) jams over it — hero UTG facing both, HJ and BTN still to act",
    stacks: withStacks({ SB: 25, BB: 40 }), hero: "UTG", cards: ["Ac", "Qd"], pre: SRP5, board: ["Qh", "8h", "4h"],
    flop: [["SB", "r", 22.5], ["BB", "r", 37.5]] },
  { id: "sp-5w-turn-two-allins-sit", family: "side-pot", ways: 5, street: "turn", pattern: "two players all-in from the flop, three still betting",
    note: "5-way SRP: SB (25bb) and BB (40bb) jammed the flop, UTG/HJ/BTN called; turn UTG bets 20 — hero BTN after HJ folds",
    stacks: withStacks({ SB: 25, BB: 40 }), hero: "BTN", cards: ["Kh", "Qc"], pre: SRP5, board: ["Qh", "8h", "4h", "2c"],
    flop: [["SB", "r", 22.5], ["BB", "r", 37.5], ["UTG", "c"], ["HJ", "c"], ["BTN", "c"]],
    turn: [["UTG", "r", 20], ["HJ", "f"]] },
  { id: "sp-4w-hero-short", family: "side-pot", ways: 4, street: "flop", pattern: "hero SHORT: the raise is more than hero has — fold or call all-in only",
    note: "4-way SRP flop: hero BTN has 35bb; HJ bets 8, CO raises to 40 — hero can only fold or call all-in",
    stacks: withStacks({ BTN: 35 }), hero: "BTN", cards: ["8s", "8d"], pre: SRP4, board: ["7d", "7s", "4c"],
    flop: [["BB", "x"], ["HJ", "r", 8], ["CO", "r", 40]] },
  { id: "sp-3w-turn-jam-call", family: "side-pot", ways: 3, street: "turn", pattern: "short stack jams the turn, a caller, hero last",
    note: "3-way SRP: BB (30bb) jams the turn, CO calls — hero BTN facing the jam and the call",
    stacks: withStacks({ BB: 30 }), hero: "BTN", cards: ["Ks", "Qs"], pre: SRP3, board: ["5c", "3d", "2s", "Kc"],
    flop: [["BB", "x"], ["CO", "x"], ["BTN", "x"]], turn: [["BB", "r", 27.5], ["CO", "c"]] },
  // ---- postflop 3-bets and 4-bets
  { id: "3b-3w-hero-raised", family: "postflop-3bet", ways: 3, street: "flop", pattern: "hero raised, gets 3-bet",
    note: "3-way SRP flop: BB bets 3, hero CO raises to 9, BTN 3-bets to 25, BB folds — hero CO",
    stacks: S100, hero: "CO", cards: ["Ah", "Kd"], pre: SRP3, board: ["Ac", "9d", "6s"],
    flop: [["BB", "r", 3], ["CO", "r", 9], ["BTN", "r", 25], ["BB", "f"]] },
  { id: "3b-4w-cold", family: "postflop-3bet", ways: 4, street: "flop", pattern: "cold 3-bet in front of hero",
    note: "4-way SRP flop: BB bets 3.5, HJ raises to 10, CO 3-bets to 26 — hero BTN cold",
    stacks: S100, hero: "BTN", cards: ["Jd", "9d"], pre: SRP4, board: ["Td", "8c", "6d"],
    flop: [["BB", "r", 3.5], ["HJ", "r", 10], ["CO", "r", 26]] },
  { id: "3b-4w-turn-4bet-jam", family: "postflop-3bet", ways: 4, street: "turn", pattern: "hero 3-bet, faces a 4-bet jam",
    note: "4-way limped pot, turn: hero CO bets 3, BTN raises to 9, SB calls, BB folds, hero 3-bets to 25, BTN jams 99 — hero CO",
    stacks: S100, hero: "CO", cards: ["Ah", "Td"], pre: LIMP4, board: ["Ks", "Qd", "Jc", "4d"],
    flop: [["SB", "x"], ["BB", "x"], ["CO", "x"], ["BTN", "x"]],
    turn: [["SB", "x"], ["BB", "x"], ["CO", "r", 3], ["BTN", "r", 9], ["SB", "c"], ["BB", "f"], ["CO", "r", 25], ["BTN", "r", 99], ["SB", "f"]] },
  { id: "3b-5w-cold-callers-behind", family: "postflop-3bet", ways: 5, street: "flop", pattern: "cold 3-bet with players still to act behind hero",
    note: "5-way SRP flop: SB checks, BB bets 4, UTG raises to 12, HJ 3-bets to 30 — hero BTN, SB/BB/UTG still to act",
    stacks: S100, hero: "BTN", cards: ["6h", "4h"], pre: SRP5, board: ["5c", "3d", "2s"],
    flop: [["SB", "x"], ["BB", "r", 4], ["UTG", "r", 12], ["HJ", "r", 30]] },
  { id: "3b-3w-river-4bet", family: "postflop-3bet", ways: 3, street: "river", pattern: "river raise war: hero raised, faces a 4-bet",
    note: "3-way limped pot, river: SB bets 2, BB raises to 6, hero BTN 3-bets to 15, SB 4-bets to 45, BB folds — hero BTN",
    stacks: S100, hero: "BTN", cards: ["Kh", "9c"], pre: LIMP3, board: ["Ac", "9d", "6s", "9s", "7h"],
    flop: [["SB", "x"], ["BB", "x"], ["BTN", "x"]], turn: [["SB", "x"], ["BB", "x"], ["BTN", "x"]],
    river: [["SB", "r", 2], ["BB", "r", 6], ["BTN", "r", 15], ["SB", "r", 45], ["BB", "f"]] },
  { id: "3b-5w-turn-hero-raised", family: "postflop-3bet", ways: 5, street: "turn", pattern: "hero raised a bet and a call, gets 3-bet, a caller still behind",
    note: "5-way limped pot, turn: SB bets 2, BB calls, hero UTG raises to 7, HJ calls, BTN 3-bets to 20, SB/BB fold — hero UTG, HJ still to act",
    stacks: S100, hero: "UTG", cards: ["Kd", "Qc"], pre: LIMP5, board: ["Jh", "Ts", "9h", "2c"],
    flop: [["SB", "x"], ["BB", "x"], ["UTG", "x"], ["HJ", "x"], ["BTN", "x"]],
    turn: [["SB", "r", 2], ["BB", "c"], ["UTG", "r", 7], ["HJ", "c"], ["BTN", "r", 20], ["SB", "f"], ["BB", "f"]] },
];

// --------------------------------------------------------------------------- legality + path

function legality(r: FastSolveResult, toCall: number, behind = Infinity): string | null {
  if (!r.ok) return null;
  const names = r.actions.map((a) => String(a.action).toUpperCase());
  const has = (re: RegExp) => names.some((n) => re.test(n));
  // hero covered: the bet is all he has (or more) — the only choices are fold and call all-in, never a raise
  if (toCall > 0 && behind <= toCall + 0.01 && has(/^(RAISE|BET)/)) return `ILLEGAL MENU: hero has ${behind}bb facing ${toCall}bb but a RAISE is offered (${names.join(", ")})`;
  if (toCall > 0) {
    if (!has(/^FOLD/)) return `ILLEGAL MENU: facing ${toCall}bb but no FOLD offered (${names.join(", ")})`;
    if (!has(/^(CALL|ALLIN|ALL-IN)/)) return `ILLEGAL MENU: facing ${toCall}bb but no CALL offered (${names.join(", ")})`;
    if (has(/^CHECK/)) return `ILLEGAL MENU: facing ${toCall}bb but CHECK offered (${names.join(", ")})`;
  } else {
    if (!has(/^CHECK/)) return `ILLEGAL MENU: checked to hero but no CHECK offered (${names.join(", ")})`;
    if (has(/^FOLD/)) return `ILLEGAL MENU: checked to hero but FOLD offered (${names.join(", ")})`;
  }
  return null;
}

function pathOf(w: string | null | undefined): string {
  const s = w ?? "";
  if (/POSTFLOP LAST RESORT/i.test(s)) return "last resort (hero vs aggressor)";
  if (/RE-ROOTED/i.test(s)) return "re-rooted";
  if (/blended \d+ collapses/i.test(s)) return "collapses blended";
  if (/collapsed to three/i.test(s)) return "collapsed to 3";
  return "exact tree";
}

// --------------------------------------------------------------------------- main

async function main() {
  const ways = (arg("--ways", "3,4,5") ?? "").split(",").map(Number).filter(Boolean);
  const out = arg("--out");
  const api = arg("--api", "http://127.0.0.1:2000")!;
  const ids = (arg("--id") ?? "").split(",").filter(Boolean);
  const edgeOnly = Bun.argv.includes("--edge-only");
  let spots: (SpotSpec & { ways: number; toCallExpected?: number })[] = [
    ...(edgeOnly ? [] : ways.flatMap(generate)),
    ...(edgeOnly || Bun.argv.includes("--edge") ? EDGE : []),
  ];
  if (ids.length) spots = spots.filter((s) => ids.includes(s.id));
  for (const s of spots) buildHand(s); // throws on a card dealt twice before anything is sent
  const show = (a?: Act[]) => (a ?? []).map((x) => `${x[0]}:${x[1]}${x[2] ?? ""}`).join(" ");
  if (Bun.argv.includes("--list")) {
    for (const s of spots) {
      console.log(`${s.id.padEnd(28)} ${s.note}`);
      console.log(`     hero ${s.cards.join("")} | board ${s.board!.join(" ")} | pre ${show(s.pre)}`);
      const h = buildHand(s).hand;
      console.log(`     flop ${show(s.flop)}${s.turn ? ` | turn ${show(s.turn)}` : ""}${s.river ? ` | river ${show(s.river)}` : ""}  → pot ${h.currentNode.pot}, to call ${h.currentNode.toCall}, hero behind ${h.stacks?.[h.heroSeatId]}`);
    }
    console.log(`${spots.length} spots`);
    return;
  }
  console.log(`${spots.length} spots · ${ways.join("/")}-way · API ${api}\n`);
  const rows: any[] = [];
  for (const s of spots) {
    const { hand } = buildHand(s);
    // --warm: LIVE PLAY WARMS THE STREET WHEN ITS CARD LANDS (fastSolve.warmPostflop6max from the poller's ingest
    // tick). Mimic it: solve the same hand at the start of the decision street with no action on it yet — the
    // narrowing walks and the street's trees land in the cache — and time only the real decision after.
    if (Bun.argv.includes("--warm") && s.board?.length) {
      const st = hand.street;
      const pre = { ...s, [st]: [] } as typeof s;
      const w = buildHand(pre).hand;
      const tw = Date.now();
      await solveVia(api, w, s.hero, 240_000);
      console.log(`     (warm at ${st} start: ${Date.now() - tw} ms)`);
    }
    const t0 = Date.now();
    // OTHER SESSIONS RESTART THE API (POST /api/build/restart) to pick up their edits; a dropped socket or a refused
    // connection is that, not this spot. Wait for /api/build to answer again and ask once more (up to 3 times).
    let r = await solveVia(api, hand, s.hero);
    for (let retry = 0; retry < 3 && !r.ok && /^harness: /.test(r.reason); retry++) {
      console.log(`     (API unreachable — ${r.reason.slice(9, 70)} — waiting for it to come back)`);
      for (let w = 0; w < 60; w++) {
        const up = await fetch(`${api}/api/build`, { signal: AbortSignal.timeout(3000) }).then((x) => x.ok).catch(() => false);
        if (up) break;
        await Bun.sleep(3000);
      }
      await Bun.sleep(4000);
      r = await solveVia(api, hand, s.hero);
    }
    const ms = Date.now() - t0;
    if (Bun.argv.includes("--trace")) printTrace();
    const g = grade(r, s.hero);
    const illegal = legality(r, hand.currentNode.toCall, hand.stacks?.[hand.heroSeatId] ?? Infinity);
    const gradeF: Grade = illegal ? "degenerate" : g.grade;
    const path = r.ok ? pathOf(r.warning) : "—";
    const row = {
      id: s.id, ways: s.ways, street: (s as any).street, pattern: (s as any).pattern, slot: (s as any).slot, pot: (s as any).pot, left: (s as any).left, hero: s.hero, cards: s.cards.join(""),
      board: s.board!.join(" "), note: s.note, family: s.family, grade: gradeF, why: illegal ?? g.why, flags: g.flags, path, ms, ok: r.ok, toCall: hand.currentNode.toCall,
      mix: r.ok ? r.actions.map((a) => `${a.action} ${a.frequency.toFixed(1)}`).join(" / ") : null,
      pick: r.ok ? r.decision?.action ?? null : null, warning: r.ok ? r.warning ?? null : null, reason: r.ok ? null : r.reason,
      lines: { flop: show(s.flop), turn: show(s.turn), river: show(s.river) },
    };
    rows.push(row);
    if (!r.ok && Bun.argv.includes("--trace")) console.log(`     reason: ${r.reason.slice(0, 900)}`);
    const mark = gradeF === "clean" ? "OK  " : gradeF === "approx" ? "APX " : gradeF === "degenerate" ? "DEG " : "FAIL";
    console.log(`${mark} ${s.id.padEnd(28)} ${s.hero.padEnd(3)} ${String(ms).padStart(6)}ms  ${path.padEnd(32)} ` +
      `${gradeF === "clean" || gradeF === "approx" ? (row.mix ?? "").slice(0, 80) : row.why.slice(0, 170)}`);
    if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
  }
  console.log("\n" + "=".repeat(100));
  for (const fam of [...new Set(rows.map((r) => r.family))]) {
    const f = rows.filter((r) => r.family === fam);
    if (!f.length) continue;
    const bad = f.filter((r) => r.grade === "FAILED" || r.grade === "degenerate");
    const paths: Record<string, number> = {};
    for (const r of f) paths[r.path] = (paths[r.path] ?? 0) + 1;
    const ms = f.map((r) => r.ms).sort((a, b) => a - b);
    console.log(`${fam}: ${f.length - bad.length}/${f.length} answered legally · paths: ${Object.entries(paths).map(([k, v]) => `${k} ${v}`).join(", ")} · p50 ${ms[Math.floor(ms.length / 2)]}ms · slowest ${ms[ms.length - 1]}ms`);
    for (const b of bad) console.log(`   ${b.grade} ${b.id}: ${String(b.why).slice(0, 220)}`);
  }
}

await main();
