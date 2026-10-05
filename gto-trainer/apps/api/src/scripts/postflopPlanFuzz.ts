/**
 * POSTFLOP PLANNING FUZZ (2026-10-05, Brady: "Need 100% coverage please, be thorough"). Random LEGAL postflop lines at
 * 3-6 seats — checks, bets, raises, calls, folds, short stacks going all-in, on every street — cut at a random point
 * where hero is to act, and put through the PURE planning fastSolve does before any solve:
 *   flop:       planCollapses (fold-outs, ghosts, merges) → else planDeadMoney (dead-money trees / heads-up after folds)
 *   turn/river: planCollapses over every street → else the re-root: the narrowing groups (coverGroups, else the
 *               takeover groups) and the current street's own plan (the seats still in, a collapse, or dead money)
 * Every spot must have a plan. A spot without one is printed with its line. No cloud, no data.
 *
 *   bun run src/scripts/postflopPlanFuzz.ts [--n 20000] [--seed 1]
 */
import { planCollapses, pickCollapses, type SeatTok } from "../services/multiwayCollapse";
import { pickDeadMoney, planDeadMoney } from "../services/deadMoneyCollapse";
import { legacyStreets, moneyThrough, narrowingPlan, takeoverCover, takeoverStreets, walkPlays, type RerootArgs } from "../services/multiwayReroot";

const argv = process.argv.slice(2);
const arg = (k: string): string | null => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] ?? "" : null; };
const N = Number(arg("n") ?? 20000);
// mulberry32 (review 2026-10-05: the old LCG overflowed 2^53 and cycled through ~160 distinct spots)
let seed = (Number(arg("seed") ?? 1) >>> 0) || 1;
const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const ORDER = ["SB", "BB", "UTG", "HJ", "CO", "BTN"];
const r2 = (x: number) => Math.round(x * 100) / 100;

type Spot = { seats: string[]; hero: string; behind: Record<string, number>; streets: string[][]; streetSeats: string[][]; amounts: (number | null)[][]; flopPot: number; allIn: string[] };

/** one random hand to a random hero decision; null when the hand ends before hero acts on a street with 3+ seats in */
function genSpot(): Spot | null {
  const n = 3 + Math.floor(rnd() * 4);
  const seats = ORDER.filter(() => true).sort(() => rnd() - 0.5).slice(0, n).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const hero = pick(seats);
  const behind: Record<string, number> = {};
  for (const p of seats) behind[p] = rnd() < 0.25 ? r2(5 + rnd() * 30) : r2(60 + rnd() * 140);
  const stack = { ...behind };
  const folded = new Set<string>(), allIn = new Set<string>();
  const streets: string[][] = [], streetSeats: string[][] = [], amounts: (number | null)[][] = [];
  let pot = 2 + n;
  const stopStreet = Math.floor(rnd() * 3);
  for (let k = 0; k <= stopStreet; k++) {
    const toks: string[] = [], who: string[] = [], am: (number | null)[] = [];
    streets.push(toks); streetSeats.push(who); amounts.push(am);
    const put: Record<string, number> = {};
    let level = 0, lastIncG = 1;
    // REAL NO-LIMIT: an all-in short of a full raise does not reopen the betting — a seat that has acted since the last
    // FULL raise may only call or fold (review 4: the generator wrote re-raises the table would never allow)
    let actedSinceFull = new Set<string>();
    const active = () => seats.filter((p) => !folded.has(p) && !allIn.has(p));
    if (active().length < 2) return null;
    // the round: walk the order until everyone still active has acted since the last wager and matched it
    let actedSince = new Set<string>();
    let i = 0, guard = 0;
    const stopAt = k === stopStreet ? Math.floor(rnd() * 12) : Infinity;
    let acts = 0;
    while (guard++ < 200) {
      const p = seats[i % seats.length]!; i++;
      if (folded.has(p) || allIn.has(p)) continue;
      const mine = put[p] ?? 0;
      if (actedSince.has(p) && mine >= level - 0.005) {
        if (active().every((q) => actedSince.has(q) && (put[q] ?? 0) >= level - 0.005)) break;
        continue;
      }
      if (p === hero && acts >= stopAt) {
        // hero to act here: the spot, if 3+ seats are still in the hand
        const live = seats.filter((q) => !folded.has(q));
        return live.length >= 3 || streets.length > 1 || seats.length >= 4 ? { seats, hero, behind, streets, streetSeats, amounts, flopPot: 2 + n, allIn: [...allIn] } : null;
      }
      acts++;
      const facing = level - mine;
      const room = stack[p]!;
      const roll = rnd();
      let tok: string, to = mine, amount: number | null = null;
      if (facing <= 0.005) {
        if (roll < 0.55) tok = "X";
        else {
          const size = r2(Math.max(1, pot * pick([0.25, 0.33, 0.5, 0.75, 1, 1.5])));
          if (size >= room - 0.005) { tok = "RAI"; to = mine + room; amount = r2(to); } else { tok = `R${r2(mine + size)}`; to = mine + size; }
        }
      } else if (roll < 0.35) tok = "F";
      else if (roll < 0.8 || facing >= room - 0.005 || actedSinceFull.has(p)) {
        // a call that takes the last chip: the capture writes it as C or (Ignition's all-in button) as RAI
        if (facing >= room - 0.005) { to = mine + room; if (rnd() < 0.5) { tok = "RAI"; amount = r2(to); } else tok = "C"; } else { tok = "C"; to = level; }
      } else {
        // a third of the raises are MIN-raises (review 4: the generator almost never made one) — the last increment
        const raiseTo = rnd() < 0.33 ? r2(level + Math.max(lastIncG, 1)) : r2(level + Math.max(facing, pot * pick([0.5, 0.75, 1])));
        if (raiseTo - mine >= room - 0.005) { tok = "RAI"; to = mine + room; amount = r2(to); } else { tok = `R${raiseTo}`; to = raiseTo; }
      }
      if (tok !== "F" && tok !== "X" && to - level > 0.005 && to - level >= lastIncG - 0.005) { lastIncG = r2(to - level); actedSinceFull = new Set(); }
      actedSinceFull.add(p);
      if (tok === "F") folded.add(p);
      else {
        const paid = r2(to - mine);
        stack[p] = r2(stack[p]! - paid); pot = r2(pot + paid); put[p] = r2(to);
        if (stack[p]! <= 0.005) allIn.add(p);
        if (to > level + 0.005) { level = r2(to); actedSince = new Set(); }
      }
      actedSince.add(p);
      toks.push(tok); who.push(p); am.push(amount);
      if (seats.filter((q) => !folded.has(q)).length < 2) return null;
    }
    // the street closed before hero's stop: on to the next street (its tokens start at the next loop)
    if (k === stopStreet) return null;
    if (folded.has(hero)) return null;
  }
  return null;
}

type Verdict = { ok: true; how: string } | { ok: false; why: string };

/** A narrowing walk's earlier street: legal in rotation, and CLOSED at its end (every seat still in matched or all in). */
function checkStreetCloses(order: string[], kept: string[], toks: string[], who: string[], behind: (p: string) => number | undefined, pre: Record<string, number>): string | null {
  const seats = order.filter((p) => kept.includes(p));
  const cap = (p: string) => (behind(p) ?? Infinity) - (pre[p] ?? 0);
  const put: Record<string, number> = {}; let level = 0, lastInc = 1;
  const out = new Set<string>(), allin = new Set<string>(seats.filter((p) => cap(p) <= 0.005));
  let acted = new Set<string>(), at = 0;
  const nextFrom = (i: number) => { for (let k = 0; k < seats.length; k++) { const p = seats[(i + k) % seats.length]!; if (!out.has(p) && !allin.has(p)) return { p, i: (i + k) % seats.length }; } return null; };
  const closed = () => seats.filter((p) => !out.has(p) && !allin.has(p)).every((p) => acted.has(p) && (put[p] ?? 0) >= level - 0.005);
  for (let j = 0; j < toks.length; j++) {
    const t = toks[j]!, p = who[j]!;
    const nx = nextFrom(at);
    if (!nx) return `nobody to act at ${p}:${t}`;
    if (j > 0 && closed()) return `closed before ${p}:${t}`;
    if (nx.p !== p) return `${p}:${t} out of turn (${nx.p})`;
    const mine = put[p] ?? 0;
    if (t === "F") out.add(p);
    else if (t === "X") { if (level > mine + 0.005) return `${p} checks facing a bet`; }
    else {
      const to = t === "C" ? Math.min(level, cap(p)) : t === "RAI" ? cap(p) : Math.min(parseFloat(t.slice(1)), cap(p));
      if (t !== "C" && to > level + 0.005 && to < cap(p) - 0.005 && to - level < lastInc - 0.005) return `${p}:${t} raises by less than the minimum ${lastInc}`;
      put[p] = to;
      if (to > level + 0.005) { if (to - level >= lastInc - 0.005) lastInc = to - level; level = to; acted = new Set(); }
      if (to >= cap(p) - 0.005) allin.add(p);
    }
    acted.add(p); at = nx.i + 1;
  }
  if (seats.filter((p) => !out.has(p)).length >= 2 && !closed()) return "the street does not close";
  return null;
}

/**
 * A DEAD-MONEY PLAN IS RIGHT, not only present: walked as the tree walks it (its seats in rotation, each token by the
 * seat whose turn it is, the round open at the end with hero to act), its pot at hero's node — the street's entering
 * pot + the plan's dead chips + the kept seats' chips — and hero's amount to call must be the table's.
 */
function checkPlan(order: string[], hero: string, plan: { seats: { pos: string }[]; streets: SeatTok[][]; dead: number; preload?: Record<string, number> },
    table: SeatTok[], amounts: (number | null)[] | null | undefined, behind: (p: string) => number | undefined, potIn: number): string | null {
  const capOf = (p: string) => behind(p) ?? Infinity;
  // the table: every seat's chips on the street, the level, hero's call
  const tPut: Record<string, number> = {}; let tLevel = 0;
  table.forEach((t, j) => {
    const mine = tPut[t.seat] ?? 0;
    let to = mine;
    if (t.tok === "C") to = Math.min(tLevel, capOf(t.seat));
    else if (t.tok === "RAI") to = amounts?.[j] ?? capOf(t.seat);
    else if (/^R/.test(t.tok)) to = Math.min(parseFloat(t.tok.slice(1)), capOf(t.seat));
    tPut[t.seat] = to; tLevel = Math.max(tLevel, to);
  });
  // the pot HERO CAN WIN: every seat's chips on the street up to what hero can put in (a side pot between deeper
  // seats is not his)
  const H = capOf(hero);
  const eligible = (all: Record<string, number>) => Object.values(all).reduce((a, b) => a + Math.min(b, H), 0);
  const tPot = potIn + eligible(tPut);
  const tCall = Math.min(tLevel, capOf(hero)) - (tPut[hero] ?? 0);
  // the tree: its seats in rotation, folds and all-ins leave the rotation; a cut's preload is off each seat's stack
  const pre = plan.preload ?? {};
  const capT = (p: string) => capOf(p) - (pre[p] ?? 0);
  const seats = order.filter((p) => plan.seats.some((x) => x.pos === p));
  const st = plan.streets[plan.streets.length - 1]!;
  const put: Record<string, number> = {}; let level = 0, lastInc = 1;
  const out = new Set<string>(), allin = new Set<string>();
  let acted = new Set<string>();
  let at = 0;
  for (const p of seats) if (capT(p) <= 0.005) allin.add(p);
  const nextFrom = (i: number) => { for (let k = 0; k < seats.length; k++) { const p = seats[(i + k) % seats.length]!; if (!out.has(p) && !allin.has(p)) return { p, i: (i + k) % seats.length }; } return null; };
  for (let j = 0; j < st.length; j++) {
    const t = st[j]!;
    const nx = nextFrom(at);
    if (!nx) return `tree: nobody left to act at token ${j}`;
    const live = seats.filter((p) => !out.has(p) && !allin.has(p));
    if (live.every((p) => acted.has(p) && (put[p] ?? 0) >= level - 0.005)) return `tree: the round closed before ${t.seat}:${t.tok}`;
    if (nx.p !== t.seat) return `tree: ${t.seat}:${t.tok} out of turn (${nx.p} to act)`;
    const mine = put[t.seat] ?? 0;
    if (t.tok === "F") out.add(t.seat);
    else if (t.tok === "X") { if (level > mine + 0.005) return `tree: ${t.seat} checks facing ${level - mine}`; }
    else {
      let to = t.tok === "C" ? Math.min(level, capT(t.seat)) : t.tok === "RAI" ? capT(t.seat) : Math.min(parseFloat(t.tok.slice(1)), capT(t.seat));
      // an all-in in the tree is the seat's whole TREE stack: the table's amount less what a cut put in the pot for him
      if (t.tok === "RAI") { const j2 = table.findIndex((x) => x.seat === t.seat && x.tok === "RAI"); if (j2 >= 0 && amounts?.[j2] != null) to = Math.min(amounts[j2]! - (pre[t.seat] ?? 0), capT(t.seat)); }
      if (t.tok !== "C" && to <= level + 0.005 && to < capT(t.seat) - 0.005) return `tree: ${t.seat}:${t.tok} is no raise over ${level}`;
      if (t.tok !== "C" && to > level + 0.005 && to < capT(t.seat) - 0.005 && to - level < lastInc - 0.005) return `tree: ${t.seat}:${t.tok} raises by less than the minimum ${lastInc}`;
      put[t.seat] = to;
      if (to > level + 0.005) { if (to - level >= lastInc - 0.005) lastInc = to - level; level = to; acted = new Set(); }
      if (to >= capT(t.seat) - 0.005) allin.add(t.seat);
    }
    acted.add(t.seat);
    at = nx.i + 1;
  }
  const nx = nextFrom(at);
  if (!nx || nx.p !== hero) return `tree: the line ends with ${nx?.p ?? "nobody"} to act, not hero`;
  // HERO NEVER LEADS WHAT HE ONLY CALLED (stress-500 brief_B-002): a wager of hero's in the tree needs one at the table
  const heroWagered = table.some((t) => t.seat === hero && (t.tok === "RAI" || /^R/.test(t.tok)));
  if (!heroWagered && st.some((t) => t.seat === hero && (t.tok === "RAI" || /^R/.test(t.tok)))) return "range: hero wagers in the tree where he only called";
  const whole: Record<string, number> = {};
  for (const p of seats) whole[p] = (pre[p] ?? 0) + (put[p] ?? 0);
  const pot = potIn + plan.dead + eligible(whole);
  const call = Math.min(level, capT(hero)) - (put[hero] ?? 0);
  if (Math.abs(pot - tPot) > 0.02) return `price: tree pot ${r2(pot)} vs table ${r2(tPot)}`;
  if (Math.abs(call - tCall) > 0.02) return `price: tree call ${r2(call)} vs table ${r2(tCall)}`;
  return null;
}
function planSpot(s: Spot): Verdict {
  const cur = s.streets.length - 1;
  const flopBehind = s.behind;
  const toks: SeatTok[][] = s.streets.map((st, i) => st.map((tok, j) => ({ tok, seat: s.streetSeats[i]![j]! })));
  const R = () => new Array(1326).fill(1);
  const cSeats = s.seats.map((pos) => ({ pos, range: R() }));
  if (s.seats.length === 3) return { ok: true, how: "3-way exact" };
  if (s.seats.length < 3) return { ok: true, how: "heads-up" };
  const picked = pickCollapses(planCollapses(cSeats, s.hero, toks));
  if (picked) return { ok: true, how: picked.plans[0]!.steps === 0 ? "exact after folds" : "collapse" };
  if (cur === 0) {
    const dm = planDeadMoney({ seats: cSeats, heroPos: s.hero, street: toks[0]!, amounts: s.amounts[0], behind: (p) => flopBehind[p] });
    for (const pl of dm.plans) { const bad = checkPlan(s.seats, s.hero, pl, toks[0]!, s.amounts[0], (p) => flopBehind[p], s.flopPot); if (bad) return { ok: false, why: `flop plan ${pl.kind}: ${bad}` }; }
    const dp = pickDeadMoney(dm.plans);
    return dp ? { ok: true, how: (dp.plans[0] as any).headsUp ? "heads-up after folds" : "dead-money" } : { ok: false, why: `flop: ${dm.why}` };
  }
  // the re-root (rerootCollapse's planning, without its cloud walks)
  const a: RerootArgs = { ordered: s.seats, heroPos: s.hero, arr: R, streets: s.streets, streetSeats: s.streetSeats, flopPot: s.flopPot, flopStack: 100,
    board: "", heroComboIdx: null, rake: null, specOf: (() => { throw new Error("unused"); }) as any, behind: flopBehind, amounts: s.amounts,
    allIn: new Set(s.allIn) };
  const m = moneyThrough(a, cur);
  if (m.stack <= 0.5) return { ok: true, how: "everyone (near) all-in — nothing to decide" };
  const plan = narrowingPlan(a, cur, m);
  const live = plan.live;
  if (!live.includes(s.hero)) return { ok: false, why: "hero folded earlier (generator bug)" };
  const curFolded = new Set<string>();
  s.streets[cur]!.forEach((t, j) => { if (t === "F") curFolded.add(s.streetSeats[cur]![j]!); });
  let groups = plan.groups, how = "re-root";
  // as rerootCollapse: a coverGroups walk the tree cannot play sends the hand to the takeover narrowing
  if (groups) {
    const capAt = (i: number) => { const b = moneyThrough(a, i).behind; return (p: string) => b[p]; };
    if (groups.some((g) => { const k = s.seats.filter((p) => g.includes(p)); const lg = legacyStreets(a, cur, m.folded, k); return walkPlays(s.seats, k, lg.streets, lg.seats, capAt) != null; })) groups = null;
    // and the legacy walks that stay must close every earlier street (stress-500 brief_D-001 slipped through here)
    for (const g of groups ?? []) {
      const k = s.seats.filter((p) => g.includes(p)); const lg = legacyStreets(a, cur, m.folded, k);
      for (let i = 0; i < cur; i++) { const bad = checkStreetCloses(s.seats, k, lg.streets[i]!, lg.seats[i]!, (p) => moneyThrough(a, i).behind[p], {}); if (bad) return { ok: false, why: `legacy narrowing group ${k.join("/")} ${["flop", "turn", "river"][i]}: ${bad}` }; }
    }
  }
  if (!groups) {
    const cov = takeoverCover(a, cur, live, new Set([...m.aggressors].filter((p) => !plan.allIn.has(p))), live.filter((p) => p !== s.hero && !curFolded.has(p)));
    groups = cov?.groups ?? [];
    how = !cov ? "re-root (no narrowing: arrival ranges)" : cov.uncovered.length ? "re-root (takeover narrowing, some arrival ranges)" : "re-root (takeover narrowing)";
    for (const g of groups) {
      const t = takeoverStreets(a, cur, g);
      if (!t) return { ok: false, why: `narrowing group ${g.join("/")} chosen but not walkable` };
      for (let i = 0; i < cur; i++) {
        const pre: Record<string, number> = {};
        for (const x of t.preloadBy.slice(i)) for (const [q, v] of Object.entries(x)) pre[q] = (pre[q] ?? 0) + v;
        const bad = checkStreetCloses(s.seats, g, t.streets[i]!, t.seats[i]!, (p) => moneyThrough(a, i).behind[p], pre);
        if (bad) return { ok: false, why: `narrowing group ${g.join("/")} ${["flop", "turn", "river"][i]}: ${bad}` };
      }
    }
  }
  const curToks = [toks[cur]!];
  const probe = live.map((pos) => ({ pos, range: R() }));
  let committedFold = false;
  { const put = new Set<string>(); for (const t of curToks[0]!) { if (t.tok !== "X" && t.tok !== "F") put.add(t.seat); else if (t.tok === "F" && put.has(t.seat)) committedFold = true; } }
  if (probe.length <= 3 && !committedFold) return { ok: true, how: `${how}: the seats still in` };
  if (probe.length > 3 && pickCollapses(planCollapses(probe, s.hero, curToks))) return { ok: true, how: `${how}: collapse` };
  const dm = planDeadMoney({ seats: probe, heroPos: s.hero, street: curToks[0]!, amounts: s.amounts[cur], behind: (p) => m.behind[p] });
  for (const pl of dm.plans) { const bad = checkPlan(live, s.hero, pl, curToks[0]!, s.amounts[cur], (p) => m.behind[p], m.pot); if (bad) return { ok: false, why: `${["flop", "turn", "river"][cur]} plan ${pl.kind}: ${bad}` }; }
  if (pickDeadMoney(dm.plans)) return { ok: true, how: `${how}: dead-money` };
  return { ok: false, why: `${["flop", "turn", "river"][cur]}: current street — ${dm.why}` };
}

const hows: Record<string, number> = {};
const fails: { why: string; s: Spot }[] = [];
let spots = 0, tries = 0;
const distinct = new Set<string>();
while (spots < N && tries < N * 20) {
  tries++;
  const s = genSpot();
  if (!s) continue;
  spots++;
  distinct.add(JSON.stringify([s.hero, s.behind, s.streets, s.streetSeats]));
  let v: Verdict;
  try { v = planSpot(s); } catch (e) { v = { ok: false, why: `THREW ${(e as Error).message}` }; }
  if (v.ok) hows[v.how] = (hows[v.how] ?? 0) + 1;
  else { fails.push({ why: v.why, s }); hows["NO PLAN"] = (hows["NO PLAN"] ?? 0) + 1; }
}
console.log(`${spots} random spots, ${distinct.size} distinct (${tries} hands generated)`);
for (const [k, v] of Object.entries(hows).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(6)}  ${k}`);
const byWhy: Record<string, { n: number; ex: Spot }> = {};
for (const f of fails) { const k = f.why.replace(/[\d.]+/g, "#").slice(0, 160); (byWhy[k] ??= { n: 0, ex: f.s }).n++; }
for (const [k, v] of Object.entries(byWhy).sort((a, b) => b[1].n - a[1].n).slice(0, 15)) {
  console.log(`\nNO PLAN ×${v.n}: ${k}\n  hero ${v.ex.hero} · seats ${v.ex.seats.join("/")} · behind ${JSON.stringify(v.ex.behind)}`);
  v.ex.streets.forEach((st, i) => console.log(`  ${["flop", "turn", "river"][i]}: ${st.map((t, j) => `${v.ex.streetSeats[i]![j]}:${t}${v.ex.amounts[i]![j] != null ? `(${v.ex.amounts[i]![j]})` : ""}`).join(" ")}`));
}
process.exit(0);
