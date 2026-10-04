/**
 * STRESS-500 SCENARIOS (2026-10-05). ~520 synthetic hands in families, every one a COMPLETE hand (preflop to the end:
 * a fold, a run-out or a river showdown) built on the strict engine, plus the real hands named by the hand-4587 session.
 *
 * Two halves, crossed on purpose:
 *   PREFLOP-HEAVY (pf_*): odd opens, 3/4/5-bet wars, squeezes, single and multi limps, limp-raises, short limpers (the
 *     pool lock), post-ins, preflop jams with side pots, deep and short stacks, rung edges, thinned tables — then a
 *     postflop that is ordinary (the "crazy preflop → normal postflop" cross) or not.
 *   POSTFLOP-HEAVY (po_*): ordinary preflop, then HU / 3 / 4 / 5-6-way streets with donks, check-raises, min-bets,
 *     overbets, raise wars, folds that shrink the field mid-street, reopened rounds, short all-ins and side pots, two
 *     flop aggressors into the turn, merged pairs and their later folds (the hand-4587 brief's families A-H).
 *
 * Every hand is deterministic from its id (mulberry32 seeded by the family and the index).
 */
import { IllegalAction, r2, Table, type Pos } from "./engine";

// ── randomness ───────────────────────────────────────────────────────────────────────────────────────────────────
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashStr = (s: string): number => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
type Rng = () => number;
const pick = <T,>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const chance = (rng: Rng, p: number): boolean => rng() < p;
const between = (rng: Rng, lo: number, hi: number): number => lo + (hi - lo) * rng();
const shuffle = <T,>(rng: Rng, xs: T[]): T[] => { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };
/** bet sizes in NL200 cents: 0.05bb grid */
const q = (x: number): number => Math.max(0.05, Math.round(x * 20) / 20);

// ── cards ────────────────────────────────────────────────────────────────────────────────────────────────────────
const RANKS = "23456789TJQKA";
const SUITS = "cdhs";
const DECK = [...RANKS].flatMap((r) => [...SUITS].map((s) => r + s));
type Strength = "premium" | "strong" | "medium" | "spec" | "weak" | "any";
const CLASS_BY: Record<Exclude<Strength, "any">, string[]> = {
  premium: ["AA", "KK", "QQ", "AKs", "AKo"],
  strong: ["JJ", "TT", "99", "AQs", "AQo", "AJs", "KQs", "ATs"],
  medium: ["88", "77", "66", "AJo", "KQo", "KJs", "QJs", "JTs", "A5s", "A4s", "KTs", "QTs", "ATo"],
  spec: ["55", "44", "33", "22", "T9s", "98s", "87s", "76s", "65s", "54s", "J9s", "T8s", "K9s", "Q9s", "A2s", "A3s"],
  weak: ["K8o", "Q7o", "J6o", "T5o", "96o", "85o", "74o", "63o", "52o", "K4s", "Q5s", "J4s", "T6o", "97o", "86o", "75o", "64o", "Q8o", "J8o", "K9o"],
};
function comboOf(rng: Rng, cls: string): [string, string] {
  const a = cls[0]!, b = cls[1]!;
  if (cls.length === 2) { const [s1, s2] = shuffle(rng, [...SUITS]); return [a + s1, b + s2!]; }
  if (cls.endsWith("s")) { const s = pick(rng, [...SUITS]); return [a + s, b + s]; }
  const [s1, s2] = shuffle(rng, [...SUITS]); return [a + s1, b + s2!];
}
function heroCardsOf(rng: Rng, strength: Strength): [string, string] {
  if (strength === "any") { const d = shuffle(rng, DECK); return [d[0]!, d[1]!]; }
  return comboOf(rng, pick(rng, CLASS_BY[strength]));
}
function boardOf(rng: Rng, hero: [string, string]): string[] {
  const d = shuffle(rng, DECK.filter((c) => !hero.includes(c)));
  return d.slice(0, 5);
}

// ── the spec every hand carries ──────────────────────────────────────────────────────────────────────────────────
export interface Scenario {
  id: string;
  family: string;
  /** a one-line title of what makes it hard */
  title: string;
  tags: string[];
  /** the wrapper-archive record (hands.data) */
  raw: Record<string, unknown>;
  hero: Pos;
  /** the number of hero decisions (preflop + postflop) — what the run solves */
  heroDecisions: number;
  /** real hands only: the live DB row it came from */
  source?: { clientHandId: string; dbId: number };
}

/** one scripted action: a seat, a verb, and a size (bb TO, or a function of the table) */
type Verb = "f" | "x" | "c" | "r" | "j" | "rai";
type Size = number | ((t: Table) => number);
type Step = [Pos, Verb, Size?];

const sizeOf = (t: Table, s: Size | undefined): number => (typeof s === "function" ? s(t) : (s ?? 0));
/** bet/raise TO helpers */
const potFrac = (f: number) => (t: Table): number => q(t.high + (t.pot() + t.high - Math.min(...t.live().map((p) => t.inStreet[p]!))) * f) ;
const betPot = (f: number) => (t: Table): number => q(Math.max(1, t.pot() * f));
const times = (x: number) => (t: Table): number => q(t.high * x);
const minRaise = (t: Table): number => r2(t.high <= 0 ? 1 : t.high + t.lastInc);

function apply(t: Table, [pos, verb, size]: Step): void {
  // every seat the script skips before `pos` takes the default (fold / check)
  for (let guard = 0; guard < 12; guard++) {
    const n = t.next();
    if (n == null) throw new IllegalAction(`${t.id}: ${pos} is scripted to act but the round is closed (${t.street})`);
    if (n === pos) break;
    t.idle(n);
    if (t.ended) throw new IllegalAction(`${t.id}: the hand ended before ${pos} acted`);
  }
  if (t.next() !== pos) throw new IllegalAction(`${t.id}: ${pos} never came to act`);
  switch (verb) {
    case "f": t.fold(pos); break;
    case "x": t.check(pos); break;
    case "c": t.call(pos); break;
    case "rai": t.call(pos, true); break;
    case "j": t.jam(pos); break;
    case "r": t.raise(pos, sizeOf(t, size)); break;
  }
}
/** the street each table's last scripted step was played on (closeStreet closes that street, never a later one) */
const scriptedStreet = new WeakMap<Table, string>();
function play(t: Table, steps: Step[]): void {
  for (const s of steps) {
    if (t.ended) throw new IllegalAction(`${t.id}: script continues after the hand ended`);
    scriptedStreet.set(t, t.street);
    apply(t, s);
  }
}
/** close the round the script stopped in with defaults (fold / check, or call-or-fold) — a round the script already
 *  closed is left alone, so the next street's plan starts on that street (a script that closes preflop by itself used
 *  to have the flop checked through here, and every later street's plan ran one street late) */
function closeStreet(t: Table, rng: Rng, mode: "idle" | "call"): void {
  const street = scriptedStreet.get(t) ?? t.street;
  if (t.street !== street) return;
  for (let guard = 0; guard < 20 && !t.ended && t.street === street; guard++) {
    const n = t.next();
    if (n == null) break;
    if (mode === "call" && t.toCall(n) > 0) { if (chance(rng, 0.7)) t.call(n); else t.fold(n); }
    else t.idle(n);
  }
}
/** play the hand out to the end: ordinary postflop — checks, a bet now and then, calls and folds */
function calm(t: Table, rng: Rng, opts: { betP?: number; callP?: number } = {}): void {
  const betP = opts.betP ?? 0.35, callP = opts.callP ?? 0.6;
  for (let guard = 0; guard < 80 && !t.ended; guard++) {
    const n = t.next();
    if (n == null) break;
    if (t.toCall(n) > 0.0001) {
      if (t.street === "preflop") { if (chance(rng, 0.5)) t.call(n); else t.fold(n); continue; }
      const price = t.toCall(n) / Math.max(1, t.pot());
      if (chance(rng, price > 0.8 ? callP * 0.5 : callP)) t.call(n); else t.fold(n);
    } else if (t.street !== "preflop" && t.high <= 0 && chance(rng, betP) && t.behind[n]! > 1) {
      t.raise(n, Math.min(q(t.pot() * pick(rng, [0.33, 0.5, 0.66, 0.75])), t.behind[n]!));
    } else t.idle(n);
  }
}

// ── seating helpers ──────────────────────────────────────────────────────────────────────────────────────────────
const PRE: Pos[] = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
const POST: Pos[] = ["SB", "BB", "UTG", "HJ", "CO", "BTN"];
const after = (p: Pos): Pos[] => PRE.slice(PRE.indexOf(p) + 1);
const before = (p: Pos): Pos[] => PRE.slice(0, PRE.indexOf(p));
const full = (stack = 100, over: Partial<Record<Pos, number>> = {}): Partial<Record<Pos, number>> =>
  Object.fromEntries(PRE.map((p) => [p, over[p] ?? stack])) as Partial<Record<Pos, number>>;
const deepRand = (rng: Rng): number => pick(rng, [100, 100, 100, 104.5, 112, 96.5, 120, 135.8, 151.2, 88.4]);

// ── building one hand ────────────────────────────────────────────────────────────────────────────────────────────
interface Build {
  title: string;
  tags: string[];
  stacks: Partial<Record<Pos, number>>;
  hero: Pos;
  strength?: Strength;
  postIns?: Pos[];
  /** drives the table after the blinds */
  run: (t: Table, rng: Rng) => void;
}

function realise(family: string, idx: number, b: Build, rng: Rng, seed: number): Scenario {
  const heroCards = heroCardsOf(rng, b.strength ?? "any");
  const board = boardOf(rng, heroCards);
  const id = `${family}-${String(idx).padStart(3, "0")}`;
  const t = new Table({ id: `stress-s5-${id}`, stacks: b.stacks, hero: b.hero, heroCards, board, postIns: b.postIns, buttonSeat: 1 + (seed % 6) });
  b.run(t, rng);
  if (!t.ended) calm(t, rng);
  if (!t.ended) throw new IllegalAction(`${id}: the hand did not finish`);
  const heroDecisions = t.actions.filter((a) => a.hero && !/^post/.test(a.type)).length;
  if (!heroDecisions) throw new IllegalAction(`${id}: hero never acted`);
  return { id, family, title: b.title, tags: b.tags, hero: b.hero, heroDecisions, raw: t.toRaw({ handId: 900000 + idx, family, title: b.title, tags: b.tags }) };
}

type Template = (rng: Rng, i: number) => Build;

// =================================================================================================================
// PREFLOP-HEAVY
// =================================================================================================================

/** an ordinary single-raised pot, then one of the postflop flavours */
const pf_srp: Template = (rng) => {
  const o = pick(rng, ["UTG", "HJ", "CO", "BTN", "SB"] as Pos[]);
  const size = pick(rng, [2, 2.2, 2.5, 2.5, 3, 3.5, 4, 2.7]);
  const cands = after(o).filter((p) => p !== "BB");
  const callers = shuffle(rng, cands).slice(0, pick(rng, [0, 0, 1, 1, 2]));
  const bbCalls = o !== "SB" ? chance(rng, 0.6) : true;
  const inHand: Pos[] = [o, ...callers, ...(bbCalls ? ["BB" as Pos] : [])];
  const hero = pick(rng, inHand);
  const flavour = pick(rng, ["calm", "cbet", "xr", "donk", "barrel", "probe"]);
  return {
    title: `${o} opens ${size}bb, ${callers.length ? callers.join("+") + " call" : "no cold-call"}, BB ${bbCalls ? "defends" : "folds"} — ${flavour} postflop (hero ${hero})`,
    tags: ["srp", `open-${size}`, `flavour-${flavour}`, `ways-${inHand.length}`],
    stacks: full(100, { [o]: deepRand(rng) }), hero, strength: pick(rng, ["strong", "medium", "spec"]),
    run: (t, r) => {
      play(t, [[o, "r", size], ...callers.map((c) => [c, "c"] as Step), ...(o !== "SB" ? [["BB", bbCalls ? "c" : "f"] as Step] : [["BB", "c"] as Step])]);
      postflopFlavour(t, r, flavour, o);
    },
  };
};

/** postflop flavours used by the preflop-heavy families: ordinary, so the preflop is what is being tested */
function postflopFlavour(t: Table, rng: Rng, flavour: string, aggressor: Pos | null): void {
  if (t.ended) return;
  const order = POST.filter((p) => t.live().includes(p));
  const agg = aggressor && order.includes(aggressor) ? aggressor : order[order.length - 1]!;
  const first = order[0]!;
  const steps: Step[] = [];
  switch (flavour) {
    case "cbet": // checked to the aggressor, he bets a third, calls and folds
      for (const p of order) { if (p === agg) { steps.push([p, "r", betPot(0.33)]); break; } steps.push([p, "x"]); }
      play(t, steps); closeStreet(t, rng, "call"); break;
    case "xr": // checked to the aggressor, he bets, the first seat check-raises
      if (agg === first) { calm(t, rng); return; }
      for (const p of order) { if (p === agg) { steps.push([p, "r", betPot(0.5)]); break; } steps.push([p, "x"]); }
      play(t, steps);
      if (!t.ended && t.next() !== null) { closeToSeat(t, first); if (!t.ended && t.next() === first) t.raise(first, times(3.2)(t)); }
      closeStreet(t, rng, "call"); break;
    case "donk": // the first seat leads into the aggressor
      if (agg === first) { calm(t, rng); return; }
      play(t, [[first, "r", betPot(pick(rng, [0.25, 0.33, 0.5]))]]); closeStreet(t, rng, "call"); break;
    case "barrel": // the aggressor bets flop and turn
      for (const st of ["flop", "turn"]) {
        if (t.ended || t.street !== st) break;
        const s2: Step[] = [];
        for (const p of POST.filter((x) => t.live().includes(x))) { if (p === agg) { s2.push([p, "r", betPot(st === "flop" ? 0.5 : 0.75)]); break; } s2.push([p, "x"]); }
        if (!t.live().includes(agg) || t.allIn.has(agg)) break;
        play(t, s2); closeStreet(t, rng, "call");
      }
      break;
    case "probe": // the flop checks through, the first seat probes the turn
      while (!t.ended && t.street === "flop") { const n = t.next(); if (n == null) break; t.idle(n); }
      if (!t.ended && t.street === "turn") { const f = POST.find((p) => t.live().includes(p) && !t.allIn.has(p))!; play(t, [[f, "r", betPot(0.66)]]); closeStreet(t, rng, "call"); }
      break;
    default: break;
  }
  calm(t, rng);
}
/** let every seat before `p` take its default, so `p` is next */
function closeToSeat(t: Table, p: Pos): void {
  for (let g = 0; g < 12 && !t.ended; g++) { const n = t.next(); if (n == null || n === p) return; t.idle(n); }
}

/** 3-bet pots: IP / OOP / blinds, min 3-bets and big ones, 4-bets, 5-bet jams, cold calls */
const pf_3bet: Template = (rng) => {
  const o = pick(rng, ["UTG", "HJ", "CO", "BTN", "SB"] as Pos[]);
  const t3 = pick(rng, after(o));
  const open = pick(rng, [2.5, 2.5, 2.2, 3]);
  const kind = pick(rng, ["ip", "big", "min", "std"]);
  const tb = kind === "min" ? q(open * 2) : kind === "big" ? q(open * 5.5) : ["SB", "BB"].includes(t3) ? q(open * 4.2) : q(open * 3.2);
  const ending = pick(rng, ["call", "call", "fold", "4bet-call", "4bet-fold", "4bet-jam", "cold-call"]);
  const cold = ending === "cold-call" ? pick(rng, after(t3).length ? after(t3) : [t3]) : null;
  const inHand: Pos[] = [o, t3, ...(cold && cold !== t3 ? [cold] : [])];
  const hero = pick(rng, inHand);
  return {
    title: `${o} opens ${open}, ${t3} 3-bets to ${tb} (${kind}) — ${ending} (hero ${hero})`,
    tags: ["3bet", `3bet-${kind}`, `end-${ending}`],
    stacks: full(100, { [o]: deepRand(rng), [t3]: deepRand(rng) }), hero, strength: pick(rng, ["premium", "strong", "medium"]),
    run: (t, r) => {
      const s: Step[] = [[o, "r", open], [t3, "r", tb]];
      if (cold && cold !== t3) s.push([cold, "c"]);
      if (ending === "fold") s.push([o, "f"]);
      else if (ending === "call" || ending === "cold-call") s.push([o, "c"]);
      else {
        s.push([o, "r", times(2.3)]);
        if (ending === "4bet-call") s.push([t3, "c"]);
        else if (ending === "4bet-fold") s.push([t3, "f"]);
        else { s.push([t3, "j"]); s.push([o, "c"]); }
      }
      play(t, s);
      closeStreet(t, r, "idle");
      postflopFlavour(t, r, pick(r, ["calm", "cbet", "barrel", "xr"]), t3);
    },
  };
};

/** squeezes: an open, one or two callers, a squeeze, and the answers */
const pf_squeeze: Template = (rng) => {
  const o = pick(rng, ["UTG", "HJ", "CO"] as Pos[]);
  const callers = shuffle(rng, after(o).filter((p) => p !== "BB")).slice(0, pick(rng, [1, 2]));
  const last = callers.reduce((a, b) => (PRE.indexOf(b) > PRE.indexOf(a) ? b : a), callers[0]!);
  const sq = pick(rng, after(last).length ? after(last) : ["BB" as Pos]);
  const reply = pick(rng, ["fold-all", "opener-calls", "caller-calls", "opener-4bets", "two-call"]);
  const hero = pick(rng, [o, ...callers, sq]);
  return {
    title: `${o} opens, ${callers.join("+")} call, ${sq} squeezes — ${reply} (hero ${hero})`,
    tags: ["squeeze", `reply-${reply}`, `callers-${callers.length}`],
    stacks: full(100), hero, strength: pick(rng, ["premium", "strong", "medium", "spec"]),
    run: (t, r) => {
      const s: Step[] = [[o, "r", 2.5], ...callers.map((c) => [c, "c"] as Step), [sq, "r", q(2.5 * (4 + callers.length))]];
      if (reply === "fold-all") s.push([o, "f"], ...callers.map((c) => [c, "f"] as Step));
      else if (reply === "opener-calls") s.push([o, "c"], ...callers.map((c) => [c, "f"] as Step));
      else if (reply === "caller-calls") s.push([o, "f"], [callers[0]!, "c"], ...callers.slice(1).map((c) => [c, "f"] as Step));
      else if (reply === "two-call") s.push([o, "c"], [callers[0]!, "c"], ...callers.slice(1).map((c) => [c, "f"] as Step));
      else { s.push([o, "r", times(2.2)], ...callers.map((c) => [c, "f"] as Step), [sq, pick(r, ["c", "j", "f"] as Verb[])]); }
      play(t, s); closeStreet(t, r, "idle");
      postflopFlavour(t, r, pick(r, ["calm", "cbet", "donk"]), sq);
    },
  };
};

/** 4-bet / 5-bet wars, deep and normal */
const pf_4b5b: Template = (rng) => {
  const o = pick(rng, ["HJ", "CO", "BTN", "SB"] as Pos[]);
  const t3 = pick(rng, after(o));
  const deep = chance(rng, 0.5);
  const st = deep ? pick(rng, [160, 185, 210, 250, 300]) : 100;
  const line = pick(rng, ["4b-call", "4b-5bjam-call", "4b-5bjam-fold", "4b-5b-call", "cold4b"]);
  const cold = line === "cold4b" ? pick(rng, after(t3).length ? after(t3) : ["BB" as Pos]) : null;
  const hero = pick(rng, [o, t3, ...(cold && cold !== t3 ? [cold] : [])]);
  return {
    title: `${deep ? `${st}bb deep: ` : ""}${o} opens, ${t3} 3-bets, ${line} (hero ${hero})`,
    tags: ["4bet", `line-${line}`, deep ? "deep" : "100bb"],
    stacks: full(st), hero, strength: pick(rng, ["premium", "premium", "strong", "spec"]),
    run: (t, r) => {
      const s: Step[] = [[o, "r", 2.5], [t3, "r", ["SB", "BB"].includes(t3) ? 11 : 8]];
      if (cold && cold !== t3) { s.push([cold, "r", 21]); s.push([o, pick(r, ["f", "c"] as Verb[])]); s.push([t3, pick(r, ["f", "c", "j"] as Verb[])]); }
      else {
        s.push([o, "r", deep ? 24 : 21]);
        if (line === "4b-call") s.push([t3, "c"]);
        else if (line === "4b-5b-call") { s.push([t3, "r", deep ? 56 : 48]); s.push([o, "c"]); }
        else { s.push([t3, "j"]); s.push([o, line.endsWith("call") ? "c" : "f"]); }
      }
      play(t, s); closeStreet(t, r, "idle");
      postflopFlavour(t, r, pick(r, ["calm", "barrel"]), t3);
    },
  };
};

/** one limper, every way the pot can go on from it; limpers of every depth */
const pf_limp1: Template = (rng) => {
  const L = pick(rng, ["UTG", "HJ", "CO", "BTN"] as Pos[]);
  const lStack = pick(rng, [100, 100, 75, 62, 55, 45, 39, 30, 22, 15]);
  const cont = pick(rng, ["bb-check", "sb-complete", "iso-call", "iso-fold", "iso-limpraise", "bb-iso", "sb-iso"]);
  const behind = after(L).filter((p) => !["SB", "BB"].includes(p));
  const isoer = cont === "bb-iso" ? "BB" : cont === "sb-iso" ? "SB" : (behind.length ? pick(rng, behind) : "SB");
  const inHand: Pos[] = [L, ...(cont.startsWith("iso") || cont.endsWith("-iso") ? [isoer] : cont === "sb-complete" ? ["SB", "BB"] as Pos[] : ["BB" as Pos])];
  const hero = pick(rng, inHand.filter((p) => p !== L).concat(chance(rng, 0.15) ? [L] : []));
  return {
    title: `${L} (${lStack}bb) limps — ${cont} (hero ${hero})`,
    tags: ["limp", "limp-1", `cont-${cont}`, lStack <= 60 ? "short-limper-le60" : lStack <= 85 ? "short-limper-60-85" : "deep-limper"],
    stacks: full(100, { [L]: lStack }), hero, strength: pick(rng, ["strong", "medium", "spec", "weak"]),
    run: (t, r) => {
      const s: Step[] = [[L, "c"]];
      const iso = q(4 + (cont === "sb-complete" ? 1 : 0) + r() * 2);
      if (cont === "bb-check") s.push(["BB", "x"]);
      else if (cont === "sb-complete") s.push(["SB", "c"], ["BB", "x"]);
      else if (cont === "bb-iso") s.push(["BB", "r", iso], [L, "c"]);
      else if (cont === "sb-iso") s.push(["SB", "r", iso], ["BB", "f"], [L, "c"]);
      else {
        s.push([isoer, "r", iso]);
        if (cont === "iso-call") s.push([L, "c"]);
        else if (cont === "iso-fold") s.push([L, "f"]);
        else { s.push([L, "r", times(3)]); s.push([isoer, pick(r, ["c", "f", "j"] as Verb[])]); }
      }
      play(t, s); closeStreet(t, r, "idle");
      postflopFlavour(t, r, pick(r, ["calm", "cbet", "donk", "probe"]), cont.includes("iso") ? isoer : null);
    },
  };
};

/** two to four limpers: limped multiway flops, isos over a crowd, limp-raises, the SB's complete */
const pf_limpN: Template = (rng) => {
  const n = pick(rng, [2, 2, 3, 3, 4]);
  const limpers = PRE.slice(0, 4).filter(() => true);
  const L = shuffle(rng, limpers).slice(0, n).sort((a, b) => PRE.indexOf(a) - PRE.indexOf(b));
  const cont = pick(rng, ["bb-check", "sb-complete", "btn-iso", "bb-iso", "sb-iso", "limp-reraise"]);
  const stacks = full(100, Object.fromEntries(L.map((p) => [p, pick(rng, [100, 100, 85, 60, 42, 25])])));
  const lastLimp = L[L.length - 1]!;
  const isoer: Pos = cont === "btn-iso" && !L.includes("BTN") && PRE.indexOf("BTN") > PRE.indexOf(lastLimp) ? "BTN" : cont === "sb-iso" ? "SB" : "BB";
  const inHand: Pos[] = [...L, ...((cont === "sb-complete" ? ["SB", "BB"] : ["BB"]) as Pos[]), isoer].filter((v, i, a) => a.indexOf(v) === i);
  const hero = pick(rng, inHand);
  return {
    title: `${L.join(", ")} limp (${n} limpers) — ${cont} (hero ${hero})`,
    tags: ["limp", `limp-${n}`, `cont-${cont}`],
    stacks, hero, strength: pick(rng, ["strong", "medium", "spec", "weak"]),
    run: (t, r) => {
      const s: Step[] = L.map((p) => [p, "c"] as Step);
      const iso = q(3 + n + r() * 2);
      if (cont === "bb-check") s.push(["SB", chance(r, 0.5) ? "c" : "f"], ["BB", "x"]);
      else if (cont === "sb-complete") s.push(["SB", "c"], ["BB", "x"]);
      else if (cont === "limp-reraise") { s.push(["BB", "r", iso]); s.push([L[0]!, "r", times(3)]); for (const p of L.slice(1)) s.push([p, "f"]); s.push(["BB", pick(r, ["c", "f"] as Verb[])]); }
      else {
        s.push([isoer, "r", iso]);
        for (const p of L) s.push([p, pick(r, ["c", "c", "f"] as Verb[])]);
      }
      play(t, s); closeStreet(t, r, "idle");
      postflopFlavour(t, r, pick(r, ["calm", "calm", "donk", "cbet"]), null);
    },
  };
};

/** a short limper alone (the GTO Wizard pool lock) and beside others (the charts and the line fit) */
const pf_shortlimp: Template = (rng) => {
  const L = pick(rng, ["UTG", "HJ", "CO", "BTN"] as Pos[]);
  const lStack = pick(rng, [12, 18, 24, 30, 36, 39, 45, 52, 58, 62, 68, 74, 80]);
  const behind = after(L);
  const hero = pick(rng, behind);
  const second = chance(rng, 0.25) ? pick(rng, behind.filter((p) => p !== hero && !["SB", "BB"].includes(p)).concat([])) : undefined;
  const heroAct = pick(rng, ["iso", "check-or-call", "fold", "complete"]);
  return {
    title: `${L} (${lStack}bb) limps${second ? `, ${second} over-limps` : ""}, hero ${hero} — ${heroAct}`,
    tags: ["limp", "short-limp", second ? "limp-2" : "limp-1", lStack < 20 ? "limper-under-20" : lStack <= 60 ? "short-limper-le60" : "short-limper-60-85"],
    stacks: full(100, { [L]: lStack, [hero]: pick(rng, [100, 100, 135, 210]) }), hero, strength: pick(rng, ["strong", "medium", "spec", "weak"]),
    run: (t, r) => {
      const s: Step[] = [[L, "c"]];
      if (second) s.push([second, "c"]);
      if (heroAct === "iso") s.push([hero, "r", q(4 + (second ? 1 : 0) + (hero === "SB" ? 0.5 : 0))]);
      else if (heroAct === "fold" && hero !== "BB") s.push([hero, "f"]);
      else if (hero === "BB") s.push([hero, "x"]);
      else s.push([hero, "c"]);
      play(t, s);
      if (!t.ended && t.street === "preflop") closeStreet(t, r, "call");
      postflopFlavour(t, r, pick(r, ["calm", "donk", "cbet"]), heroAct === "iso" ? hero : null);
    },
  };
};

/** post-ins: a seat posts 1bb to come in; checks his option (read as a limp) or raises */
const pf_postin: Template = (rng) => {
  const P = pick(rng, ["UTG", "HJ", "CO", "BTN"] as Pos[]);
  const act = pick(rng, ["check", "check", "raise", "fold-to-raise"]);
  const hero = pick(rng, ["SB", "BB", ...after(P).filter((p) => !["SB", "BB"].includes(p))] as Pos[]);
  return {
    title: `${P} posts in; ${act} (hero ${hero})`,
    tags: ["post-in", `postin-${act}`],
    stacks: full(100, { [P]: pick(rng, [100, 60, 35]) }), hero, postIns: [P], strength: pick(rng, ["medium", "spec", "weak"]),
    run: (t, r) => {
      if (act === "raise") play(t, [[P, "r", 3.5]]);
      else if (act === "fold-to-raise") { play(t, [[hero, "r", 4]]); }
      play(t, []);
      closeStreet(t, r, "call");
      postflopFlavour(t, r, "calm", null);
    },
  };
};

/** short stacks jamming preflop, two-way and three-way all-ins with side pots */
const pf_shove: Template = (rng) => {
  const j = pick(rng, ["UTG", "HJ", "CO", "BTN", "SB"] as Pos[]);
  const jStack = pick(rng, [6.5, 8, 10, 12.5, 15, 18, 22]);
  const kind = pick(rng, ["open-jam", "3bet-jam", "open-jam-2callers", "two-shorts-jam"]);
  const others = after(j);
  const c1 = pick(rng, others);
  const c2 = pick(rng, after(c1).length ? after(c1) : others.filter((p) => p !== c1));
  const second = kind === "two-shorts-jam" ? c1 : null;
  const hero = pick(rng, [j, c1, ...(kind.includes("2callers") ? [c2] : [])]);
  return {
    title: `${j} (${jStack}bb) ${kind}${second ? `, ${second} (short) jams over` : ""} (hero ${hero})`,
    tags: ["preflop-allin", `kind-${kind}`, kind.includes("2callers") || second ? "side-pot" : "hu-allin"],
    stacks: full(100, { [j]: jStack, ...(second ? { [second]: pick(rng, [14, 19, 26]) } : {}) }), hero, strength: pick(rng, ["premium", "strong", "medium", "spec"]),
    run: (t, r) => {
      const s: Step[] = [];
      if (kind === "3bet-jam") { const o = before(j).length ? pick(r, before(j)) : null; if (o) s.push([o, "r", 2.5]); s.push([j, "j"]); if (o) s.push([o, pick(r, ["c", "f"] as Verb[])]); }
      else if (kind === "open-jam") { s.push([j, "j"]); s.push([c1, "c"]); }
      else if (kind === "open-jam-2callers") { s.push([j, "j"]); s.push([c1, "c"]); if (c2 !== c1) s.push([c2, "c"]); }
      else { s.push([j, "j"]); s.push([c1, "j"]); if (c2 !== c1 && !t.ended) s.push([c2, pick(r, ["c", "f"] as Verb[])]); }
      play(t, s); closeStreet(t, r, "idle");
      calm(t, r, { betP: 0.5 });
    },
  };
};

/** deep stacks (cap 250) and stacks at the chart rungs' edges (the gap gate's bounds) */
const pf_stacks: Template = (rng) => {
  const kind = pick(rng, ["deep", "rung-edge", "two-short", "hero-short"]);
  const o = pick(rng, ["UTG", "HJ", "CO", "BTN"] as Pos[]);
  const t3 = pick(rng, after(o));
  const st = kind === "deep" ? pick(rng, [175, 220, 250, 310]) : kind === "rung-edge" ? pick(rng, [45, 48, 52, 58, 62, 68, 72, 78, 88, 92, 110, 130]) : 100;
  const stacks = kind === "two-short" ? full(100, { [o]: pick(rng, [25, 33]), [t3]: pick(rng, [42, 55]) })
    : kind === "hero-short" ? full(100) : full(st);
  const hero = pick(rng, [o, t3]);
  if (kind === "hero-short") stacks[hero] = pick(rng, [35, 48, 63, 72]);
  const line = pick(rng, ["open-call", "open-3bet-call", "open-3bet-4bet", "open-3bet-jam"]);
  return {
    title: `${kind} (${kind === "two-short" ? `${o} ${stacks[o]}bb, ${t3} ${stacks[t3]}bb` : kind === "hero-short" ? `hero ${stacks[hero]}bb` : `${st}bb`}): ${o} opens, ${line} by ${t3} (hero ${hero})`,
    tags: ["stacks", `stacks-${kind}`, `line-${line}`],
    stacks, hero, strength: pick(rng, ["premium", "strong", "medium"]),
    run: (t, r) => {
      const s: Step[] = [[o, "r", 2.5]];
      if (line === "open-call") s.push([t3, "c"]);
      else {
        s.push([t3, "r", ["SB", "BB"].includes(t3) ? 11 : 8]);
        if (line === "open-3bet-call") s.push([o, "c"]);
        else if (line === "open-3bet-4bet") { s.push([o, "r", times(2.3)]); s.push([t3, pick(r, ["c", "f", "j"] as Verb[])]); }
        else { s.push([o, "j"]); s.push([t3, pick(r, ["c", "f"] as Verb[])]); }
      }
      play(t, s); closeStreet(t, r, "idle");
      postflopFlavour(t, r, pick(r, ["calm", "cbet", "barrel"]), t3);
    },
  };
};

/** thinned tables: 2-5 handed */
const pf_thin: Template = (rng) => {
  const n = pick(rng, [2, 3, 4, 5, 5, 4]);
  const seats: Pos[] = n === 2 ? ["SB", "BB"] : n === 3 ? ["BTN", "SB", "BB"] : n === 4 ? ["CO", "BTN", "SB", "BB"] : ["HJ", "CO", "BTN", "SB", "BB"];
  const stacks = Object.fromEntries(seats.map((p) => [p, pick(rng, [100, 100, 85, 120, 60])])) as Partial<Record<Pos, number>>;
  const first = seats[0]!;
  const line = pick(rng, ["open-call", "open-3bet", "limp-check", "limp-iso", "bvb-raise", "bvb-limp"]);
  const hero = pick(rng, seats);
  return {
    title: `${n}-handed (${seats.join("/")}): ${line} (hero ${hero})`,
    tags: ["thin", `thin-${n}`, `line-${line}`],
    stacks, hero, strength: pick(rng, ["strong", "medium", "spec", "weak"]),
    run: (t, r) => {
      const s: Step[] = [];
      if (line.startsWith("bvb") || n === 2) {
        if (line === "bvb-limp") s.push(["SB", "c"], ["BB", pick(r, ["x", "r"] as Verb[]), 4]);
        else s.push(["SB", "r", 3], ["BB", pick(r, ["c", "f", "r"] as Verb[]), 9]);
      } else if (line === "open-call") s.push([first, "r", 2.5], ["BB", "c"]);
      else if (line === "open-3bet") s.push([first, "r", 2.5], [pick(r, seats.slice(1)), "r", 9], [first, pick(r, ["c", "f"] as Verb[])]);
      else if (line === "limp-check") s.push([first, "c"], ["BB", "x"]);
      else s.push([first, "c"], ["BB", "r", 4.5], [first, "c"]);
      // a raise step carries its size; a check/call/fold ignores it
      play(t, s.map(([p, v, x]) => (v === "r" ? [p, v, x ?? 4] : [p, v]) as Step));
      closeStreet(t, r, "idle");
      postflopFlavour(t, r, pick(r, ["calm", "cbet", "xr"]), null);
    },
  };
};

/** preflop chaos: three cold-callers, raise wars before hero, odd sizes, limp-iso-3bet-4bet */
const pf_chaos: Template = (rng) => {
  const kind = pick(rng, ["3-coldcalls", "war-before-hero", "odd-sizes", "limp-iso-3bet-4bet", "min-raise-war", "open-3bet-coldcall-4bet", "5way-raised"]);
  let hero: Pos = "BB";
  let title = kind;
  let run: Build["run"];
  switch (kind) {
    case "3-coldcalls": {
      hero = pick(rng, ["SB", "BB", "BTN"] as Pos[]);
      title = `UTG opens 2.5, HJ CO BTN cold-call, hero ${hero}`;
      run = (t, r) => { play(t, [["UTG", "r", 2.5], ["HJ", "c"], ["CO", "c"], ...(hero !== "BTN" ? [["BTN", "c"] as Step] : [])]); closeStreet(t, r, "call"); postflopFlavour(t, r, pick(r, ["calm", "donk", "cbet"]), "UTG"); };
      break;
    }
    case "war-before-hero": {
      hero = pick(rng, ["BTN", "SB", "BB"] as Pos[]);
      title = `UTG opens, HJ 3-bets, CO 4-bets — hero ${hero} acts behind the war`;
      run = (t, r) => { play(t, [["UTG", "r", 2.5], ["HJ", "r", 8], ["CO", "r", 19]]); closeStreet(t, r, "idle"); calm(t, r); };
      break;
    }
    case "odd-sizes": {
      const o = pick(rng, ["UTG", "HJ", "CO"] as Pos[]);
      hero = pick(rng, after(o));
      const open = pick(rng, [2.1, 6, 7, 1.5 + 0.6, 4.5]);
      title = `${o} opens ${open}bb (odd), hero ${hero}`;
      run = (t, r) => { play(t, [[o, "r", open]]); closeStreet(t, r, "call"); postflopFlavour(t, r, "calm", o); };
      break;
    }
    case "limp-iso-3bet-4bet": {
      hero = pick(rng, ["UTG", "BTN", "BB"] as Pos[]);
      title = `UTG limps, BTN isos, BB 3-bets, UTG 4-bets (hero ${hero})`;
      run = (t, r) => { play(t, [["UTG", "c"], ["BTN", "r", 5], ["BB", "r", 17], ["UTG", "r", 38]]); closeStreet(t, r, "call"); calm(t, r); };
      break;
    }
    case "min-raise-war": {
      hero = pick(rng, ["CO", "BTN", "BB"] as Pos[]);
      title = `HJ opens 2, CO min-3bets to 4, BTN min-4bets to 6 (hero ${hero})`;
      run = (t, r) => { play(t, [["HJ", "r", 2], ["CO", "r", 4], ["BTN", "r", 6]]); closeStreet(t, r, "call"); calm(t, r); };
      break;
    }
    case "open-3bet-coldcall-4bet": {
      hero = pick(rng, ["HJ", "CO", "BTN"] as Pos[]);
      title = `HJ opens, CO 3-bets, BTN cold-calls, HJ 4-bets (hero ${hero})`;
      run = (t, r) => { play(t, [["HJ", "r", 2.5], ["CO", "r", 8], ["BTN", "c"], ["HJ", "r", 24]]); closeStreet(t, r, "call"); calm(t, r); };
      break;
    }
    default: {
      hero = pick(rng, ["UTG", "CO", "BB"] as Pos[]);
      title = `5-way raised pot: UTG opens, HJ CO BTN call, BB calls (hero ${hero})`;
      run = (t, r) => { play(t, [["UTG", "r", 2.5], ["HJ", "c"], ["CO", "c"], ["BTN", "c"], ["SB", "f"], ["BB", "c"]]); postflopFlavour(t, r, pick(r, ["calm", "donk", "cbet"]), "UTG"); };
    }
  }
  return { title, tags: ["chaos", `chaos-${kind}`], stacks: full(100, { BTN: deepRand(rng) }), hero, strength: pick(rng, ["premium", "strong", "medium", "spec"]), run };
};

// =================================================================================================================
// POSTFLOP-HEAVY
// =================================================================================================================

/** the preflop that sets up a postflop family: who sees the flop (in postflop order) and who led */
interface Setup { inHand: Pos[]; aggressor: Pos | null; steps: Step[]; stacks: Partial<Record<Pos, number>>; label: string }
function setupPot(rng: Rng, ways: number, kind: "srp" | "limped" | "3bp" | "any" = "any"): Setup {
  const k = kind === "any" ? pick(rng, ways >= 4 ? ["srp", "limped", "limped"] : ["srp", "srp", "limped", "3bp"]) as "srp" | "limped" | "3bp" : kind;
  const stacks = full(100);
  for (const p of PRE) if (chance(rng, 0.25)) stacks[p] = pick(rng, [60, 80, 120, 150]);
  if (k === "limped") {
    // limpers from the front, then SB complete / BB check
    const pool = shuffle(rng, ["UTG", "HJ", "CO", "BTN"] as Pos[]).slice(0, Math.max(1, ways - 2)).sort((a, b) => PRE.indexOf(a) - PRE.indexOf(b));
    const sbIn = pool.length + 2 <= ways || chance(rng, 0.6);
    const inHand = [...pool, ...(sbIn ? ["SB" as Pos] : []), "BB" as Pos].slice(0, Math.max(2, ways));
    const steps: Step[] = [...pool.map((p) => [p, "c"] as Step), ...(inHand.includes("SB") ? [["SB", "c"] as Step] : []), ["BB", "x"]];
    return { inHand, aggressor: null, steps, stacks, label: `limped ${inHand.length}-way` };
  }
  if (k === "3bp") {
    const o = pick(rng, ["HJ", "CO", "BTN"] as Pos[]);
    const t3 = pick(rng, after(o));
    const callers = ways > 2 ? shuffle(rng, after(t3).filter((p) => p !== "SB")).slice(0, ways - 2) : [];
    const steps: Step[] = [[o, "r", 2.5], [t3, "r", ["SB", "BB"].includes(t3) ? 11 : 8], ...callers.map((c) => [c, "c"] as Step), [o, "c"]];
    return { inHand: [o, t3, ...callers], aggressor: t3, steps, stacks, label: `3-bet pot ${2 + callers.length}-way` };
  }
  const o = pick(rng, ways >= 4 ? (["UTG", "HJ"] as Pos[]) : (["UTG", "HJ", "CO", "BTN"] as Pos[]));
  const others = after(o).filter((p) => p !== "BB");
  const callers = shuffle(rng, others).slice(0, Math.max(0, ways - 2)).sort((a, b) => PRE.indexOf(a) - PRE.indexOf(b));
  const steps: Step[] = [[o, "r", pick(rng, [2.5, 2.5, 2.2, 3])], ...callers.map((c) => [c, "c"] as Step), ["BB", "c"]];
  return { inHand: [o, ...callers, ...(callers.includes("SB") ? [] : []), "BB"], aggressor: o, steps, stacks, label: `single-raised ${2 + callers.length}-way` };
}
const order = (xs: Pos[]): Pos[] => POST.filter((p) => xs.includes(p));

/** what hero faces at his first postflop turn on a street, and what follows — the procedural street */
type Facing = "checked-to" | "bet" | "bet-call" | "bet-raise" | "bet-raise-call" | "bet-call-call" | "min-bet-calls" | "overbet" | "jam-call"
  | "donk-raise" | "rai-then-raise" | "hero-first" | "hero-bets-faces-raise" | "hero-checks-faces-bet";
const FACINGS_MULTI: Facing[] = ["checked-to", "bet", "bet-call", "bet-raise", "bet-raise-call", "bet-call-call", "min-bet-calls", "overbet", "jam-call", "donk-raise", "hero-bets-faces-raise", "hero-checks-faces-bet", "hero-first"];

/**
 * Play one street so that hero faces `facing` at his first turn, then hero takes `heroAct`, then the rest of the street
 * plays by `afterHero` (calls, a raise behind, folds that shrink the field).
 */
function scriptStreet(t: Table, rng: Rng, hero: Pos, facing: Facing, heroAct: "call" | "fold" | "raise" | "check" | "bet" | "jam", afterHero: "calls" | "raise-behind" | "folds" | "mixed"): void {
  if (t.ended) return;
  const street = t.street;
  const ord = order(t.live()).filter((p) => !t.allIn.has(p));
  const hi = ord.indexOf(hero);
  if (hi < 0) { calm(t, rng); return; }
  const pre = ord.slice(0, hi);
  // hero first to act: the situations that need seats before him become hero-first lines
  const f: Facing = pre.length === 0 && !["hero-bets-faces-raise", "hero-checks-faces-bet", "hero-first"].includes(facing) ? "hero-first" : facing;
  const potF = (x: number) => betPot(x);
  const act = (p: Pos, v: Verb, s?: Size) => { if (!t.ended && t.street === street) apply(t, [p, v, s]); };
  const preActs = (): void => {
    if (f === "checked-to" || f === "hero-first" || f === "hero-bets-faces-raise" || f === "hero-checks-faces-bet") { for (const p of pre) act(p, "x"); return; }
    const bettor = pre[f === "donk-raise" ? 0 : Math.floor(rng() * pre.length)]!;
    for (const p of pre) {
      if (p === bettor) {
        if (f === "min-bet-calls") act(p, "r", 1);
        else if (f === "overbet") act(p, "r", potF(pick(rng, [1.25, 1.6, 2.2])));
        else if (f === "jam-call") act(p, "j");
        else act(p, "r", potF(pick(rng, [0.25, 0.33, 0.5, 0.66, 0.75])));
      } else if (PRE.indexOf(p) >= 0 && pre.indexOf(p) < pre.indexOf(bettor)) act(p, "x");
      else {
        const k = pre.indexOf(p) - pre.indexOf(bettor);
        if ((f === "bet-raise" || f === "bet-raise-call" || f === "donk-raise") && k === 1) act(p, "r", times(pick(rng, [2.5, 3, 3.5])));
        else if (f === "rai-then-raise" && k === 1) { if (t.behind[p]! <= t.toCall(p)) act(p, "rai"); else act(p, "c"); }
        else if (f === "bet" || (f === "bet-raise" && k > 1)) act(p, "f");
        else act(p, "c");
      }
    }
  };
  preActs();
  if (t.ended || t.street !== street || t.next() !== hero) { closeStreet(t, rng, "call"); return; }
  // hero's act
  const owe = t.toCall(hero);
  if (f === "hero-bets-faces-raise") {
    act(hero, "r", potF(0.5));
    // a later seat raises, the rest call or fold, and hero faces it
    const later = order(t.live()).filter((p) => p !== hero && !t.allIn.has(p));
    const raiser = later.length ? pick(rng, later) : null;
    for (let g = 0; g < 10 && !t.ended && t.street === street; g++) {
      const n = t.next(); if (n == null || n === hero) break;
      if (n === raiser && t.canRaise(n)) act(n, "r", times(3)); else act(n, chance(rng, 0.5) ? "c" : "f");
    }
    if (!t.ended && t.street === street && t.next() === hero) act(hero, heroAct === "fold" ? "f" : heroAct === "jam" ? "j" : "c");
  } else if (f === "hero-checks-faces-bet") {
    act(hero, "x");
    const later = order(t.live()).filter((p) => p !== hero);
    const bettor = later.length ? pick(rng, later) : null;
    for (let g = 0; g < 10 && !t.ended && t.street === street; g++) {
      const n = t.next(); if (n == null || n === hero) break;
      if (n === bettor && t.high <= 0) act(n, "r", potF(0.66)); else if (t.toCall(n) > 0) act(n, chance(rng, 0.6) ? "c" : "f"); else act(n, "x");
    }
    if (!t.ended && t.street === street && t.next() === hero) {
      if (heroAct === "raise" || heroAct === "bet") act(hero, "r", times(3)); else act(hero, heroAct === "fold" ? "f" : heroAct === "jam" ? "j" : "c");
    }
  } else if (owe <= 0) {
    if (heroAct === "bet" || heroAct === "raise") act(hero, "r", potF(pick(rng, [0.33, 0.5, 0.75])));
    else if (heroAct === "jam") act(hero, "j");
    else act(hero, "x");
  } else {
    if (heroAct === "raise" && t.canRaise(hero)) act(hero, "r", times(3));
    else if (heroAct === "jam") act(hero, "j");
    else if (heroAct === "fold") act(hero, "f");
    else act(hero, "c");
  }
  // the rest of the street
  for (let g = 0; g < 14 && !t.ended && t.street === street; g++) {
    const n = t.next(); if (n == null) break;
    if (n === hero) { act(hero, t.toCall(hero) > 0 ? (chance(rng, 0.6) ? "c" : "f") : "x"); continue; }
    if (t.toCall(n) <= 0) { act(n, "x"); continue; }
    if (afterHero === "raise-behind" && t.canRaise(n) && chance(rng, 0.5)) { act(n, "r", times(2.8)); continue; }
    if (afterHero === "folds") { act(n, "f"); continue; }
    act(n, afterHero === "calls" ? "c" : chance(rng, 0.55) ? "c" : "f");
  }
}

const HERO_ACTS = ["call", "call", "fold", "raise", "check", "bet", "jam"] as const;
const AFTERS = ["calls", "raise-behind", "folds", "mixed"] as const;

/** postflop: HU / 3 / 4 / 5-6 ways, a facing per street, chosen per hand */
function poTemplate(ways: number[], potKinds: ("srp" | "limped" | "3bp" | "any")[], facings: Facing[], streetsScripted: number): Template {
  return (rng) => {
    const w = pick(rng, ways);
    const su = setupPot(rng, w, pick(rng, potKinds));
    const hero = pick(rng, su.inHand);
    const plan = [0, 1, 2].slice(0, streetsScripted).map(() => ({ facing: pick(rng, facings), act: pick(rng, HERO_ACTS), after: pick(rng, AFTERS) }));
    return {
      title: `${su.label}: ${plan.map((p, k) => `${["flop", "turn", "river"][k]} ${p.facing} → hero ${p.act}${p.after !== "calls" ? ` (${p.after})` : ""}`).join("; ")} (hero ${hero})`,
      tags: [`ways-${su.inHand.length}`, su.label.split(" ")[0]!, ...plan.map((p, k) => `${["flop", "turn", "river"][k]}-${p.facing}`)],
      stacks: su.stacks, hero, strength: pick(rng, ["strong", "medium", "spec", "weak"]),
      run: (t, r) => {
        play(t, su.steps); closeStreet(t, r, "call");
        for (const p of plan) {
          if (t.ended || t.street === "preflop") break;
          if (!t.live().includes(hero) || t.allIn.has(hero)) break;
          // keep hero in the hand through the scripted streets: a fold only on the last scripted street
          const act = p.act === "fold" && p !== plan[plan.length - 1] ? "call" : p.act;
          scriptStreet(t, r, hero, p.facing, act, p.after);
          if (!t.ended && t.street !== "river" && (t.street === "flop" || t.street === "turn")) { /* the next street begins */ }
        }
        calm(t, r);
      },
    };
  };
}

// ── the hand-4587 brief's explicit families (A-H), stacks and sizes varied around the named lines ─────────────────
const briefA: Template = (rng, i) => {
  // A: dead-money core
  const v = i % 4;
  const hero: Pos = v === 0 ? "HJ" : v === 1 ? "HJ" : v === 2 ? "CO" : "BB";
  const shortRaiser = pick(rng, [12, 17.4, 22, 30]);
  if (v === 0) return {
    title: `4587-shape: 5-way flop, CO bets, BTN (${shortRaiser}bb) raises, SB calls, BB folds → hero HJ`, tags: ["brief-A", "dead-money", "ways-5"],
    stacks: full(100, { BTN: shortRaiser + 3, HJ: 138.8, SB: 85 }), hero, strength: pick(rng, ["medium", "strong"]),
    run: (t, r) => { play(t, [["HJ", "r", 2.5], ["CO", "c"], ["BTN", "c"], ["SB", "c"], ["BB", "c"]]); play(t, [["SB", "x"], ["BB", "x"], ["HJ", "x"], ["CO", "r", 3], ["BTN", "j"], ["SB", "c"], ["BB", "f"]]); calm(t, r); },
  };
  if (v === 1) return {
    title: `4-way: SB X, HJ X, CO bets 3, BTN calls, SB calls → hero HJ`, tags: ["brief-A", "dead-money", "ways-4"],
    stacks: full(100), hero, strength: pick(rng, ["medium", "spec"]),
    run: (t, r) => { play(t, [["HJ", "r", 2.5], ["CO", "c"], ["BTN", "c"], ["SB", "c"], ["BB", "f"]]); play(t, [["SB", "x"], ["HJ", "x"], ["CO", "r", betPot(0.3)], ["BTN", "c"], ["SB", "c"]]); calm(t, r); },
  };
  if (v === 2) return {
    title: `bet-raise-call: deep caller, short raiser → hero CO`, tags: ["brief-A", "dead-money", "short-raiser"],
    stacks: full(100, { BTN: pick(rng, [20, 28]), SB: 180 }), hero, strength: pick(rng, ["medium", "strong"]),
    run: (t, r) => { play(t, [["CO", "r", 2.5], ["BTN", "c"], ["SB", "c"], ["BB", "c"]]); play(t, [["SB", "r", betPot(0.4)], ["BB", "f"], ["CO", "c"], ["BTN", "j"]]); calm(t, r); },
  };
  return {
    title: `bet-call-call-call at 6-way → hero BB`, tags: ["brief-A", "dead-money", "ways-6"],
    stacks: full(100), hero, strength: pick(rng, ["medium", "spec"]),
    run: (t, r) => { play(t, [["UTG", "c"], ["HJ", "c"], ["CO", "c"], ["BTN", "c"], ["SB", "c"], ["BB", "x"]]); play(t, [["SB", "r", 2], ["BB", "c"], ["UTG", "c"], ["HJ", "c"], ["CO", "c"], ["BTN", "r", 9]]); calm(t, r); },
  };
};
const briefB: Template = (rng, i) => {
  const v = i % 3;
  if (v === 0) return {
    title: `SB bets 4, BB folds, hero HJ calls, CO raises 14, SB folds → hero HU facing 10`, tags: ["brief-B", "folds-shrink"],
    stacks: full(100), hero: "HJ", strength: pick(rng, ["medium", "strong"]),
    run: (t, r) => { play(t, [["HJ", "r", 2.5], ["CO", "c"], ["SB", "c"], ["BB", "c"]]); play(t, [["SB", "r", 4], ["BB", "f"], ["HJ", "c"], ["CO", "r", 14], ["SB", "f"]]); calm(t, r); },
  };
  if (v === 1) return {
    title: `5-way: SB bets 4, BB raises 12, HJ calls, CO 3-bets 36, SB folds, BB folds → hero HJ`, tags: ["brief-B", "folds-shrink", "ways-5"],
    stacks: full(100), hero: "HJ", strength: pick(rng, ["strong", "medium"]),
    run: (t, r) => { play(t, [["HJ", "r", 2.5], ["CO", "c"], ["BTN", "c"], ["SB", "c"], ["BB", "c"]]); play(t, [["SB", "r", 4], ["BB", "r", 12], ["HJ", "c"], ["CO", "r", 36], ["BTN", "f"], ["SB", "f"], ["BB", "f"]]); calm(t, r); },
  };
  return {
    title: `turn shrink: flop bet-call-call, turn a flop caller folds → hero`, tags: ["brief-B", "folds-shrink", "turn"],
    stacks: full(100), hero: "BTN", strength: pick(rng, ["medium", "strong"]),
    run: (t, r) => {
      play(t, [["HJ", "r", 2.5], ["BTN", "c"], ["SB", "f"], ["BB", "c"]]);
      play(t, [["BB", "x"], ["HJ", "r", betPot(0.5)], ["BTN", "c"], ["BB", "c"]]);
      play(t, [["BB", "x"], ["HJ", "r", betPot(0.6)], ["BTN", "c"], ["BB", "f"]]);
      calm(t, r);
    },
  };
};
const briefC: Template = (rng, i) => (i % 2 === 0 ? {
  title: `reopened: SB X, hero HJ bets 4, CO BTN call, SB check-raises 12, hero calls, CO calls, BTN raises 30 → hero`, tags: ["brief-C", "reopened", "cut"],
  stacks: full(100, { BTN: 140 }), hero: "HJ", strength: pick(rng, ["strong", "medium"]),
  run: (t, r) => { play(t, [["HJ", "r", 2.5], ["CO", "c"], ["BTN", "c"], ["SB", "c"], ["BB", "f"]]); play(t, [["SB", "x"], ["HJ", "r", 4], ["CO", "c"], ["BTN", "c"], ["SB", "r", 12], ["HJ", "c"], ["CO", "c"], ["BTN", "r", 30]]); calm(t, r); },
} : {
  title: `kept players check around, HJ bets 2, CO raises 7, SB calls, BB raises 19, UTG raises 40.5 → hero SB`, tags: ["brief-C", "reopened", "ways-5"],
  stacks: full(100, { UTG: 120 }), hero: "SB", strength: pick(rng, ["strong", "premium"]),
  run: (t, r) => { play(t, [["UTG", "c"], ["HJ", "c"], ["CO", "c"], ["BTN", "f"], ["SB", "c"], ["BB", "x"]]); play(t, [["SB", "x"], ["BB", "x"], ["UTG", "x"], ["HJ", "r", 2], ["CO", "r", 7], ["SB", "c"], ["BB", "r", 19], ["UTG", "r", 40.5], ["HJ", "f"], ["CO", "f"]]); calm(t, r); },
});
const briefD: Template = (rng, i) => {
  const v = i % 3;
  if (v === 0) return {
    title: `SB X, BB bets 1.75, UTG calls, HJ all-in 8.18, BTN calls, SB raises 28.33, BB calls, UTG folds, BTN raises 69.22, SB jams → hero BB`,
    tags: ["brief-D", "side-pot", "short-allin"], stacks: full(100, { HJ: 9.18 + 1, SB: 79, BTN: 110 }), hero: "BB", strength: pick(rng, ["strong", "medium"]),
    run: (t, r) => { play(t, [["UTG", "c"], ["HJ", "c"], ["CO", "f"], ["BTN", "c"], ["SB", "c"], ["BB", "x"]]); play(t, [["SB", "x"], ["BB", "r", 1.75], ["UTG", "c"], ["HJ", "j"], ["BTN", "c"], ["SB", "r", 28.33], ["BB", "c"], ["UTG", "f"], ["BTN", "r", 69.22], ["SB", "j"]]); calm(t, r); },
  };
  if (v === 1) return {
    title: `all-in call for less written as RAI: SB X, BB bets 5, CO calls, BTN calls, SB raises 20, BB raises 50, CO RAI 12 → hero BTN`,
    tags: ["brief-D", "rai", "side-pot"], stacks: full(100, { CO: 15 }), hero: "BTN", strength: pick(rng, ["strong", "medium"]),
    run: (t, r) => { play(t, [["CO", "r", 2.5], ["BTN", "c"], ["SB", "c"], ["BB", "c"]]); play(t, [["SB", "x"], ["BB", "r", 5], ["CO", "c"], ["BTN", "c"], ["SB", "r", 20], ["BB", "r", 50], ["CO", "rai"]]); calm(t, r); },
  };
  return {
    title: `preflop jammer + two callers; the callers play on postflop (hero a caller)`, tags: ["brief-D", "preflop-allin", "side-pot"],
    stacks: full(100, { UTG: pick(rng, [9, 12, 15]) }), hero: pick(rng, ["CO", "BB"] as Pos[]), strength: pick(rng, ["strong", "premium"]),
    run: (t, r) => { play(t, [["UTG", "j"], ["HJ", "f"], ["CO", "c"], ["BTN", "f"], ["SB", "f"], ["BB", "c"]]); calm(t, r, { betP: 0.6 }); },
  };
};
const briefE: Template = (rng, i) => (i % 2 === 0 ? {
  title: `4921735317-shape: flop UTG bets 2, BTN raises 4, SB calls, hero BB calls, UTG calls; turn UTG bets 19, BTN folds, SB calls → hero`,
  tags: ["brief-E", "reroot", "two-aggressors"], stacks: full(100), hero: "BB", strength: pick(rng, ["medium", "spec"]),
  run: (t, r) => { play(t, [["UTG", "c"], ["HJ", "f"], ["CO", "f"], ["BTN", "c"], ["SB", "c"], ["BB", "x"]]); play(t, [["SB", "x"], ["BB", "x"], ["UTG", "r", 2], ["BTN", "r", 4], ["SB", "c"], ["BB", "c"], ["UTG", "c"]]); play(t, [["SB", "x"], ["BB", "x"], ["UTG", "r", 19], ["BTN", "f"], ["SB", "c"]]); calm(t, r); },
} : {
  title: `4922305100-shape: flop UTG bets 1, HJ calls, BTN calls, SB raises 10.2, all call; turn SB bets 31.4, BB calls, UTG folds → hero HJ`,
  tags: ["brief-E", "reroot", "mis-press-class"], stacks: full(100, { HJ: 210.6 }), hero: "HJ", strength: pick(rng, ["medium", "strong"]),
  run: (t, r) => { play(t, [["UTG", "c"], ["HJ", "c"], ["CO", "f"], ["BTN", "c"], ["SB", "c"], ["BB", "x"]]); play(t, [["SB", "x"], ["BB", "x"], ["UTG", "r", 1], ["HJ", "c"], ["BTN", "c"], ["SB", "r", 10.2], ["BB", "c"], ["UTG", "c"], ["HJ", "c"], ["BTN", "c"]]); play(t, [["SB", "r", 31.4], ["BB", "c"], ["UTG", "f"]]); calm(t, r); },
});
const briefF: Template = (rng) => ({
  title: `merge then a member folds: flop SB X, hero BB X, UTG X, CO bets 3.2, BTN folds, SB calls, hero calls, UTG folds; turn/river`,
  tags: ["brief-F", "merge-fold"], stacks: full(100), hero: "BB", strength: pick(rng, ["medium", "spec"]),
  run: (t, r) => { play(t, [["UTG", "c"], ["HJ", "f"], ["CO", "c"], ["BTN", "c"], ["SB", "c"], ["BB", "x"]]); play(t, [["SB", "x"], ["BB", "x"], ["UTG", "x"], ["CO", "r", 3.2], ["BTN", "f"], ["SB", "c"], ["BB", "c"], ["UTG", "f"]]); calm(t, r, { betP: 0.5 }); },
});
const briefG: Template = (rng, i) => {
  const v = i % 4;
  if (v === 0) return { title: `donk + check-raise war 4-way`, tags: ["brief-G", "wars", "ways-4"], stacks: full(100), hero: "CO", strength: pick(rng, ["strong", "medium"]),
    run: (t, r) => { play(t, [["HJ", "r", 2.5], ["CO", "c"], ["SB", "c"], ["BB", "c"]]); play(t, [["SB", "r", betPot(0.33)], ["BB", "r", times(3)], ["HJ", "c"], ["CO", "r", times(2.4)]]); calm(t, r); } };
  if (v === 1) return { title: `river overbet 2x pot into 3 players`, tags: ["brief-G", "overbet", "ways-3"], stacks: full(100), hero: "BTN", strength: pick(rng, ["strong", "medium"]),
    run: (t, r) => { play(t, [["CO", "r", 2.5], ["BTN", "c"], ["BB", "c"]]); play(t, [["BB", "x"], ["CO", "x"], ["BTN", "x"]]); play(t, [["BB", "x"], ["CO", "x"], ["BTN", "x"]]); play(t, [["BB", "r", betPot(2)], ["CO", "c"]]); calm(t, r); } };
  if (v === 2) return { title: `limped 6-way, a 1bb min-bet and two callers → hero`, tags: ["brief-G", "min-bet", "ways-6"], stacks: full(100), hero: "BTN", strength: pick(rng, ["spec", "medium"]),
    run: (t, r) => { play(t, [["UTG", "c"], ["HJ", "c"], ["CO", "c"], ["BTN", "c"], ["SB", "c"], ["BB", "x"]]); play(t, [["SB", "x"], ["BB", "r", 1], ["UTG", "c"], ["HJ", "c"], ["CO", "f"]]); calm(t, r); } };
  return { title: `multiway river jam with a caller ahead of hero`, tags: ["brief-G", "river-jam", "ways-4"], stacks: full(100, { UTG: 60 }), hero: "BTN", strength: pick(rng, ["strong", "medium"]),
    run: (t, r) => { play(t, [["UTG", "r", 2.5], ["CO", "c"], ["BTN", "c"], ["BB", "c"]]); play(t, [["BB", "x"], ["UTG", "r", betPot(0.33)], ["CO", "c"], ["BTN", "c"], ["BB", "c"]]); play(t, [["BB", "x"], ["UTG", "x"], ["CO", "x"], ["BTN", "x"]]); play(t, [["BB", "x"], ["UTG", "j"], ["CO", "c"]]); calm(t, r); } };
};
const briefH: Template = (rng) => ({
  title: `merged pair carrying a check-raise: turn/river after a 4-way flop`, tags: ["brief-H", "merge-xr"], stacks: full(100), hero: "BTN", strength: pick(rng, ["strong", "medium"]),
  run: (t, r) => {
    play(t, [["HJ", "r", 2.5], ["CO", "c"], ["BTN", "c"], ["BB", "c"]]);
    play(t, [["BB", "x"], ["HJ", "x"], ["CO", "x"], ["BTN", "x"]]);
    play(t, [["BB", "x"], ["HJ", "r", betPot(0.5)], ["CO", "c"], ["BTN", "c"], ["BB", "r", times(3.2)]]);
    calm(t, r);
  },
});
/** hero leaves his own pick: a tiny donk, a call of a river overbet with air, a min-raise */
const poDeviate: Template = (rng, i) => {
  const v = i % 3;
  const su = setupPot(rng, pick(rng, [2, 3]), "srp");
  const hero = pick(rng, su.inHand);
  return {
    title: `hero deviates (${["tiny donk", "calls a river overbet with air", "min-raises the flop"][v]}) — ${su.label}`,
    tags: ["deviate", `deviate-${v}`], stacks: su.stacks, hero, strength: v === 1 ? "weak" : "any",
    run: (t, r) => {
      play(t, su.steps); closeStreet(t, r, "call");
      if (t.ended) return;
      if (v === 0) { closeToSeat(t, hero); if (!t.ended && t.next() === hero && t.toCall(hero) <= 0) t.raise(hero, 1); closeStreet(t, r, "call"); }
      else if (v === 2) { closeToSeat(t, hero); if (!t.ended && t.next() === hero) { if (t.toCall(hero) > 0 && t.canRaise(hero)) t.raise(hero, minRaise(t)); else if (t.toCall(hero) <= 0) t.raise(hero, betPot(0.5)(t)); } closeStreet(t, r, "call"); }
      else {
        while (!t.ended && t.street !== "river") { const n = t.next(); if (n == null) break; t.idle(n); }
        if (!t.ended && t.street === "river") { const f = order(t.live()).find((p) => p !== hero); if (f) { closeToSeat(t, f); if (!t.ended && t.next() === f && t.toCall(f) <= 0) t.raise(f, betPot(2.2)(t)); } closeToSeat(t, hero); if (!t.ended && t.next() === hero && t.toCall(hero) > 0) t.call(hero); }
      }
      calm(t, r);
    },
  };
};

// =================================================================================================================
// THE CATALOGUE
// =================================================================================================================
export const FAMILIES: { family: string; count: number; tpl: Template; about: string }[] = [
  { family: "pf_srp", count: 30, tpl: pf_srp, about: "single-raised pots, odd open sizes, then ordinary postflop flavours" },
  { family: "pf_3bet", count: 36, tpl: pf_3bet, about: "3-bet pots IP/OOP, min and big 3-bets, 4-bets, 5-bet jams, cold calls" },
  { family: "pf_squeeze", count: 18, tpl: pf_squeeze, about: "an open, one or two callers, a squeeze and every answer" },
  { family: "pf_4b5b", count: 18, tpl: pf_4b5b, about: "4-bet and 5-bet wars, 100bb and 160-300bb deep (the 250 cap)" },
  { family: "pf_limp1", count: 26, tpl: pf_limp1, about: "one limper of every depth: BB check, SB complete, isos, limp-raises" },
  { family: "pf_limpN", count: 26, tpl: pf_limpN, about: "two to four limpers: limped multiway flops, isos over a crowd, limp-reraises" },
  { family: "pf_shortlimp", count: 30, tpl: pf_shortlimp, about: "a short limper alone (the pool lock) or beside an over-limper (charts + line fit)" },
  { family: "pf_postin", count: 10, tpl: pf_postin, about: "post-ins checking their option (read as limps) or raising" },
  { family: "pf_shove", count: 22, tpl: pf_shove, about: "short stacks jamming preflop, 2- and 3-way all-ins, side pots" },
  { family: "pf_stacks", count: 24, tpl: pf_stacks, about: "deep (cap 250), rung edges (the gap gate), two short seats, a short hero" },
  { family: "pf_thin", count: 22, tpl: pf_thin, about: "2-5 handed tables: opens, 3-bets, limps, blind vs blind" },
  { family: "pf_chaos", count: 28, tpl: pf_chaos, about: "three cold-callers, raise wars before hero, odd sizes, limp-iso-3bet-4bet, min-raise wars, 5-way raised" },
  { family: "po_hu", count: 30, tpl: poTemplate([2], ["srp", "3bp", "limped"], ["checked-to", "bet", "bet-raise", "overbet", "min-bet-calls", "jam-call", "donk-raise", "hero-first", "hero-bets-faces-raise", "hero-checks-faces-bet"], 3), about: "heads-up: c-bets, check-raises, donks, overbets, min-bets, raise wars, river jams" },
  { family: "po_3way", count: 36, tpl: poTemplate([3], ["srp", "limped", "3bp"], FACINGS_MULTI, 3), about: "3-way: bet-call, bet-raise, check-raise into two, folds to heads-up, min-bets, jams" },
  { family: "po_4way", count: 36, tpl: poTemplate([4], ["srp", "limped"], FACINGS_MULTI, 3), about: "4-way: dead money, folds shrinking the field on every street, merges, ghosts" },
  { family: "po_56way", count: 22, tpl: poTemplate([5, 6], ["limped"], FACINGS_MULTI, 3), about: "5-6 way limped pots to the river: min-bets, raises, folds" },
  { family: "brief_A", count: 16, tpl: briefA, about: "dead-money core (hand 4587's shape, bet-raise-call, bet-call-call-call)" },
  { family: "brief_B", count: 12, tpl: briefB, about: "folds that shrink the field after a raise, flop and turn" },
  { family: "brief_C", count: 10, tpl: briefC, about: "reopened rounds (the cut)" },
  { family: "brief_D", count: 18, tpl: briefD, about: "short all-ins, side pots, the all-in call for less (RAI), preflop jam + callers" },
  { family: "brief_E", count: 12, tpl: briefE, about: "turn/river re-root with two flop aggressors (4921735317, 4922305100 shapes)" },
  { family: "brief_F", count: 8, tpl: briefF, about: "a merged member folding on a later street (4922575177 shape)" },
  { family: "brief_G", count: 16, tpl: briefG, about: "donk + check-raise wars, overbets, min-bets into big pots, multiway river jams" },
  { family: "brief_H", count: 8, tpl: briefH, about: "merged pairs carrying a check-raise into the turn and river" },
  { family: "po_deviate", count: 12, tpl: poDeviate, about: "hero leaves his own pick: tiny donks, overbet calls with air, min-raises" },
];

/** every synthetic scenario; a template whose draw is illegal tries the next seed (yield is reported) */
export function buildCatalogue(log = (s: string) => console.log(s)): Scenario[] {
  const out: Scenario[] = [];
  for (const f of FAMILIES) {
    let made = 0, tries = 0;
    const errors = new Map<string, number>();
    for (let k = 0; made < f.count && tries < f.count * 25; k++, tries++) {
      const seed = hashStr(`${f.family}#${k}`);
      const rng = mulberry32(seed);
      try {
        const b = f.tpl(rng, made);
        const sc = realise(f.family, made + 1, b, rng, seed);
        out.push(sc);
        made++;
      } catch (e) {
        const m = e instanceof Error ? e.message.replace(/^stress-s5-[^:]+: /, "").replace(/[\d.]+/g, "#").slice(0, 90) : String(e);
        errors.set(m, (errors.get(m) ?? 0) + 1);
        if (!(e instanceof IllegalAction)) throw e;
      }
    }
    log(`${f.family.padEnd(13)} ${made}/${f.count} (${tries} draws)${errors.size ? ` · rejected: ${[...errors].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, n]) => `${n}× ${m}`).join(" | ")}` : ""}`);
  }
  return out;
}
